use super::{
    auth_middleware, has_bearer_credentials, is_remote_plaintext, trusted_embedded_origin,
    validate_owner_token, Authenticator, ConnectionOrigin, TransportSecurity, TrustedIngress,
};
use axum::{
    body::Body,
    extract::{ConnectInfo, Request},
    http::{header, HeaderValue, StatusCode},
    middleware,
    routing::get,
    Router,
};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use tower::ServiceExt;

#[test]
fn owner_token_policy_requires_long_visible_ascii() {
    assert!(validate_owner_token(&"a".repeat(32)).is_ok());
    assert!(validate_owner_token(&"A".repeat(128)).is_ok());
    assert!(validate_owner_token(&"a".repeat(31)).is_err());
    assert!(validate_owner_token(&"a".repeat(129)).is_err());
    assert!(validate_owner_token(&format!("{} ", "a".repeat(31))).is_err());
    assert!(validate_owner_token(&format!("{}\n", "a".repeat(31))).is_err());
    assert!(validate_owner_token(&format!("{}é", "a".repeat(31))).is_err());
}

#[test]
fn persistent_owner_token_replaces_and_reloads_privately() {
    let directory =
        std::env::temp_dir().join(format!("meterm-owner-token-test-{}", uuid::Uuid::new_v4()));
    let path = directory.join("owner-token");
    let path_string = path.to_string_lossy().to_string();
    let first = "A".repeat(43);
    let second = "B".repeat(32);

    let authenticator = Authenticator::new_persistent(first, path_string.clone());
    authenticator.set_token(second.clone()).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), second);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let reloaded = Authenticator::new_persistent("C".repeat(43), path_string);
    assert_eq!(reloaded.get_token(), second);
    assert!(reloaded.set_token("too-short".to_string()).is_err());
    assert_eq!(reloaded.get_token(), "B".repeat(32));

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn owner_rotation_invalidates_retired_owner_generation() {
    let first = "A".repeat(32);
    let second = "B".repeat(32);
    let authenticator = Authenticator::new(first.clone());
    let old_owner = authenticator.authenticate_token(&first).unwrap();

    let retired = authenticator.set_token(second.clone()).unwrap();
    assert!(matches!(
        &old_owner,
        super::AuthPrincipal::Owner { generation } if *generation == retired
    ));
    assert!(!authenticator.is_principal_current(&old_owner));

    let new_owner = authenticator.authenticate_token(&second).unwrap();
    assert!(authenticator.is_principal_current(&new_owner));
    assert_ne!(old_owner, new_owner);
    assert!(authenticator.authenticate_token(&first).is_none());
}

fn request(
    peer: Option<IpAddr>,
    transport: Option<TransportSecurity>,
    authorization: Option<&str>,
    websocket_protocol: Option<&str>,
) -> Request {
    let mut request = Request::new(Body::empty());
    if let Some(peer) = peer {
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(peer, 12345)));
        request.extensions_mut().insert(ConnectionOrigin::Direct);
        request.extensions_mut().insert(if peer.is_loopback() {
            TrustedIngress::DirectLoopback
        } else {
            TrustedIngress::DirectRemote
        });
    }
    if let Some(transport) = transport {
        request.extensions_mut().insert(transport);
    }
    if let Some(value) = authorization {
        request
            .headers_mut()
            .insert(header::AUTHORIZATION, HeaderValue::from_str(value).unwrap());
    }
    if let Some(value) = websocket_protocol {
        request.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_str(value).unwrap(),
        );
    }
    request
}

#[test]
fn remote_plaintext_is_untrusted() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Plaintext),
        None,
        None,
    );

    assert!(is_remote_plaintext(&request));
}

#[test]
fn loopback_plaintext_remains_allowed() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        Some("Bearer secret"),
        None,
    );

    assert!(!is_remote_plaintext(&request));
}

#[test]
fn remote_tls_remains_allowed() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Tls),
        Some("Bearer secret"),
        None,
    );

    assert!(!is_remote_plaintext(&request));
}

#[test]
fn missing_transport_marker_fails_closed_for_remote_peer() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        None,
        Some("Bearer secret"),
        None,
    );

    assert!(is_remote_plaintext(&request));
}

#[test]
fn missing_peer_metadata_fails_closed_for_plaintext() {
    let request = request(
        None,
        Some(TransportSecurity::Plaintext),
        Some("Bearer secret"),
        None,
    );

    assert!(is_remote_plaintext(&request));
}

#[test]
fn both_supported_bearer_forms_are_detected() {
    let authorization = request(None, None, Some("Bearer secret"), None);
    let websocket = request(None, None, None, Some("meterm.v1, bearer.secret"));

    assert!(has_bearer_credentials(&authorization));
    assert!(has_bearer_credentials(&websocket));
}

#[test]
fn unrelated_credentials_are_not_misclassified() {
    let request = request(None, None, Some("Basic credentials"), Some("meterm.v1"));

    assert!(!has_bearer_credentials(&request));
}

#[test]
fn ambiguous_bearer_headers_do_not_authenticate_or_fall_through() {
    let authenticator = Authenticator::new("owner-secret".to_string());

    let mut duplicate_authorization = request(
        None,
        None,
        Some("Bearer owner-secret"),
        Some("meterm.v1, bearer.owner-secret"),
    );
    duplicate_authorization.headers_mut().append(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer owner-secret"),
    );
    assert!(authenticator
        .authenticate_request(&duplicate_authorization)
        .is_none());

    let conflicting_protocols = request(
        None,
        None,
        None,
        Some("meterm.v1, bearer.owner-secret, bearer.other"),
    );
    assert!(authenticator
        .authenticate_request(&conflicting_protocols)
        .is_none());

    let mut duplicate_protocol_headers =
        request(None, None, None, Some("meterm.v1, bearer.owner-secret"));
    duplicate_protocol_headers.headers_mut().append(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static("bearer.owner-secret"),
    );
    assert!(authenticator
        .authenticate_request(&duplicate_protocol_headers)
        .is_none());
}

#[test]
fn browser_origins_are_exact_and_loopback_bound() {
    let mut tauri = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        None,
        None,
    );
    tauri.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("tauri://localhost"),
    );
    assert!(trusted_embedded_origin(&tauri, 8022));

    let mut same_server = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        None,
        None,
    );
    same_server.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("https://127.0.0.1:8022"),
    );
    assert!(trusted_embedded_origin(&same_server, 8022));

    let mut attacker = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        None,
        None,
    );
    attacker.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("https://attacker.example"),
    );
    assert!(!trusted_embedded_origin(&attacker, 8022));

    let mut forged_remote = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Tls),
        None,
        None,
    );
    forged_remote.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("tauri://localhost"),
    );
    assert!(!trusted_embedded_origin(&forged_remote, 8022));
}

fn protected_app_with(authenticator: Arc<Authenticator>) -> Router {
    let auth_layer = middleware::from_fn(move |request, next| {
        let authenticator = authenticator.clone();
        async move { auth_middleware(axum::extract::Extension(authenticator), request, next).await }
    });

    Router::new()
        .route("/", get(|| async { StatusCode::NO_CONTENT }))
        .layer(auth_layer)
}

fn protected_app() -> Router {
    protected_app_with(Arc::new(Authenticator::new("secret".to_string())))
}

#[tokio::test]
async fn auth_middleware_blocks_remote_plaintext_bearer() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Plaintext),
        Some("Bearer secret"),
        None,
    );

    let response = protected_app().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn auth_middleware_allows_loopback_plaintext_bearer() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        Some("Bearer secret"),
        None,
    );

    let response = protected_app().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn owner_token_is_rejected_on_lan_tls() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Tls),
        Some("Bearer secret"),
        None,
    );

    let response = protected_app().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
