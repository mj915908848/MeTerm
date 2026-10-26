//! Authentication middleware — token validation and management.
//!
//! Mirrors Go `api/auth.go`. Supports two authentication methods:
//! 1. `Authorization: Bearer <token>` header
//! 2. `Sec-WebSocket-Protocol: bearer.<token>` (for WebSocket upgrades)

use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use std::sync::{Arc, RwLock};

use super::private_file::atomic_write_private;

/// Transport property established by the connection acceptor.
///
/// This must come from the socket/TLS handling path rather than request headers:
/// `Host`, `Forwarded`, and similar headers are controlled by the client.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TransportSecurity {
    Plaintext,
    Tls,
}

/// Trusted ingress identity set by the socket/tunnel acceptor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConnectionOrigin {
    Direct,
}

/// Unforgeable ingress classification computed by the socket/tunnel acceptor.
/// Request headers never influence it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TrustedIngress {
    DirectLoopback,
    DirectRemote,
}

impl TrustedIngress {
    pub(crate) fn from_connection(origin: ConnectionOrigin, peer: std::net::SocketAddr) -> Self {
        match origin {
            ConnectionOrigin::Direct if peer.ip().is_loopback() => Self::DirectLoopback,
            ConnectionOrigin::Direct => Self::DirectRemote,
        }
    }

    pub(crate) fn is_direct_loopback(self) -> bool {
        matches!(self, Self::DirectLoopback)
    }
}

/// Authenticated identity injected into every protected request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AuthPrincipal {
    Owner {
        /// Process-local credential generation. It rotates with every owner
        /// token change so already-upgraded sockets can be invalidated without
        /// treating the long-lived token string as connection identity.
        generation: uuid::Uuid,
    },
}

impl AuthPrincipal {
    pub(crate) fn generation(&self) -> uuid::Uuid {
        let Self::Owner { generation } = self;
        *generation
    }
}

/// Token-based authenticator.
pub struct Authenticator {
    owner: RwLock<OwnerCredential>,
    /// Owner token 落盘路径，只供本机桌面前端使用。
    token_file: Option<String>,
}

#[derive(Clone)]
struct OwnerCredential {
    token: String,
    generation: uuid::Uuid,
}

pub(crate) fn validate_owner_token(token: &str) -> Result<(), String> {
    if token.len() < 32 || token.len() > 128 || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(
            "owner token must be 32-128 visible ASCII characters without whitespace".to_string(),
        );
    }
    Ok(())
}

impl Authenticator {
    pub fn new(token: String) -> Self {
        Self {
            owner: RwLock::new(OwnerCredential {
                token,
                generation: uuid::Uuid::new_v4(),
            }),
            token_file: None,
        }
    }

    /// 带持久化的构造:文件存在且非空则复用旧 token(跨重启保持配对),
    /// 否则用传入的新 token 并写盘。
    pub fn new_persistent(fresh_token: String, token_file: String) -> Self {
        let token = match std::fs::read_to_string(&token_file) {
            Ok(token) if validate_owner_token(&token).is_ok() => token,
            _ => {
                if let Err(error) = Self::write_token_file(&token_file, &fresh_token) {
                    eprintln!("[auth] persist initial token failed: {}", error);
                }
                fresh_token
            }
        };
        Self {
            owner: RwLock::new(OwnerCredential {
                token,
                generation: uuid::Uuid::new_v4(),
            }),
            token_file: Some(token_file),
        }
    }

    fn write_token_file(path: &str, token: &str) -> Result<(), String> {
        atomic_write_private(std::path::Path::new(path), token.as_bytes())
    }

    pub fn get_token(&self) -> String {
        self.owner.read().unwrap().token.clone()
    }

    pub(crate) fn current_owner_generation(&self) -> uuid::Uuid {
        self.owner.read().unwrap().generation
    }

    /// Replace the owner token and rotate its process-local generation.
    ///
    /// Returns the retired generation so the caller can disconnect only
    /// sockets authenticated by the old owner credential. The write lock also
    /// serializes persistence with the in-memory swap, avoiding two concurrent
    /// rotations leaving disk and memory on different tokens.
    pub(crate) fn set_token(&self, t: String) -> Result<uuid::Uuid, String> {
        validate_owner_token(&t)?;
        let mut owner = self.owner.write().unwrap();
        self.replace_owner_locked(&mut owner, t)
    }

    fn replace_owner_locked(
        &self,
        owner: &mut OwnerCredential,
        token: String,
    ) -> Result<uuid::Uuid, String> {
        if let Some(ref f) = self.token_file {
            Self::write_token_file(f, &token)?;
        }
        let retired_generation = owner.generation;
        *owner = OwnerCredential {
            token,
            generation: uuid::Uuid::new_v4(),
        };
        Ok(retired_generation)
    }

    /// Revalidate the exact credential generation used for a prior auth
    /// decision. Generations are process-local, so a token rotation
    /// immediately makes an earlier auth decision stale.
    pub(crate) fn is_principal_current(&self, principal: &AuthPrincipal) -> bool {
        let AuthPrincipal::Owner { generation } = principal;
        self.owner.read().unwrap().generation == *generation
    }

    fn authenticate_token(&self, candidate: &str) -> Option<AuthPrincipal> {
        let owner = self.owner.read().unwrap();
        let owner_matches = !owner.token.is_empty()
            && constant_time_eq(candidate.as_bytes(), owner.token.as_bytes());
        owner_matches.then_some(AuthPrincipal::Owner {
            generation: owner.generation,
        })
    }

    /// Validate a request against the stored token.
    ///
    /// Checks (in order):
    /// 1. `Authorization: Bearer <token>`
    /// 2. `Sec-WebSocket-Protocol` containing `bearer.<token>`
    fn authenticate_request_with_token(&self, req: &Request) -> Option<(AuthPrincipal, String)> {
        // Method 1: Authorization header. Its presence is authoritative: an
        // invalid or duplicated value must not fall through to a second
        // credential carried in the WebSocket protocol list.
        let mut authorization = req.headers().get_all(header::AUTHORIZATION).iter();
        if let Some(auth) = authorization.next() {
            if authorization.next().is_some() {
                return None;
            }
            let auth_str = auth.to_str().ok()?;
            let token = auth_str.strip_prefix("Bearer ")?;
            if token.is_empty() || token.bytes().any(|byte| byte.is_ascii_whitespace()) {
                return None;
            }
            let principal = self.authenticate_token(token)?;
            return Some((principal, token.to_string()));
        }

        // Method 2: WebSocket sub-protocol. Require exactly one header field
        // and exactly one bearer entry so intermediaries cannot create a
        // client/server disagreement by appending another credential.
        let mut protocols = req.headers().get_all(header::SEC_WEBSOCKET_PROTOCOL).iter();
        let proto = protocols.next()?;
        if protocols.next().is_some() {
            return None;
        }
        let mut bearer = None;
        for part in proto.to_str().ok()?.split(',') {
            let trimmed = part.trim();
            if let Some(token) = trimmed.strip_prefix("bearer.") {
                if bearer.is_some()
                    || token.is_empty()
                    || token.bytes().any(|byte| byte.is_ascii_whitespace())
                {
                    return None;
                }
                bearer = Some(token);
            }
        }
        let token = bearer?;
        let principal = self.authenticate_token(token)?;
        Some((principal, token.to_string()))
    }

    pub(crate) fn authenticate_request(&self, req: &Request) -> Option<AuthPrincipal> {
        self.authenticate_request_with_token(req)
            .map(|(principal, _)| principal)
    }

    /// Compatibility helper for callers that only need a boolean result.
    pub fn validate_request(&self, req: &Request) -> bool {
        self.authenticate_request(req).is_some()
    }
}

/// Treat a request as remote cleartext unless the connection layer proves that
/// it arrived over TLS or from a loopback peer. Missing metadata fails closed.
fn is_remote_plaintext(req: &Request) -> bool {
    if matches!(
        req.extensions().get::<TransportSecurity>(),
        Some(TransportSecurity::Tls)
    ) {
        return false;
    }

    !req.extensions()
        .get::<TrustedIngress>()
        .is_some_and(|ingress| ingress.is_direct_loopback())
}

fn is_direct_loopback(req: &Request) -> bool {
    req.extensions()
        .get::<TrustedIngress>()
        .is_some_and(|ingress| ingress.is_direct_loopback())
}

/// Whether this request carries either credential form accepted by [`Authenticator`].
fn has_bearer_credentials(req: &Request) -> bool {
    let has_authorization_bearer = req
        .headers()
        .get_all(header::AUTHORIZATION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split_ascii_whitespace().next())
        .any(|scheme| scheme.eq_ignore_ascii_case("bearer"));

    if has_authorization_bearer {
        return true;
    }

    req.headers()
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|protocols| {
            protocols.split(',').any(|protocol| {
                protocol
                    .trim()
                    .get(..7)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer."))
            })
        })
}

fn trusted_embedded_origin(req: &Request, server_port: u16) -> bool {
    if !is_direct_loopback(req) {
        return false;
    }
    let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return true;
    };
    matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:5175"
            | "http://127.0.0.1:5175"
    ) || origin == format!("http://127.0.0.1:{server_port}")
        || origin == format!("https://127.0.0.1:{server_port}")
        || origin == format!("http://localhost:{server_port}")
        || origin == format!("https://localhost:{server_port}")
}

/// Browser requests are accepted only from the embedded Tauri/Vite origins on
/// a connection-proven loopback socket. Native mobile clients do not send an
/// Origin header and remain unaffected. This is an explicit DNS-rebinding/CORS
/// boundary; it never treats Host or forwarding headers as transport proof.
pub(crate) async fn trusted_origin_middleware(
    server_port: u16,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if req.headers().contains_key(header::ORIGIN) && !trusted_embedded_origin(&req, server_port) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(req).await)
}

/// Axum middleware that checks authentication.
///
/// Endpoints that don't require auth (e.g., /api/ping, /api/pair) should
/// be registered outside the auth layer.
pub async fn auth_middleware(
    axum::extract::Extension(auth): axum::extract::Extension<Arc<Authenticator>>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // A remote cleartext client must never be allowed to exercise a bearer
    // credential. Loopback HTTP remains supported for the embedded frontend.
    if has_bearer_credentials(&req) && is_remote_plaintext(&req) {
        return Err(StatusCode::FORBIDDEN);
    }

    let principal = auth
        .authenticate_request(&req)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    // The owner token is a local desktop capability, not a remote credential.
    // ConnectionOrigin must prove that this is a direct local socket.
    if !is_direct_loopback(&req) {
        return Err(StatusCode::FORBIDDEN);
    }
    let body = std::mem::take(req.body_mut());
    *req.body_mut() = super::auth_body::revocation_aware(body, auth, principal.clone());
    req.extensions_mut().insert(principal);

    Ok(next.run(req).await)
}

/// Constant-time byte comparison to prevent timing attacks on token validation.
/// Mirrors Go's `subtle.ConstantTimeCompare`.
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut result: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        result |= x ^ y;
    }
    result == 0
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
