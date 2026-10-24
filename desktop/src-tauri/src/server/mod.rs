//! In-process HTTP/WebSocket server — replaces the Go sidecar.
//!
//! The server is started inside the Tauri process during `setup()`.
//! It exposes the same HTTP API and WebSocket endpoints that the Go
//! `meterm-server` binary did, so the TypeScript frontend keeps working
//! without any changes.

pub mod auth;
mod auth_body;
pub mod connections;
#[cfg(all(
    debug_assertions,
    feature = "development-mobile-control",
    target_os = "macos"
))]
pub(crate) mod dev_app_identity;
pub mod dispatch;
pub mod encoding;
pub mod executor;
pub mod file_handler;
pub mod file_search;
pub mod handlers;
pub mod jumpserver;
pub mod osc_filter;
pub(crate) mod private_file;
pub mod protocol;
pub mod secret_vault;
pub mod server_info;
pub mod session;
pub mod ssh_saved_session;
pub mod terminal;
mod transport;

use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::routing::{get, post};
use axum::{middleware, Router};
use tokio_util::sync::CancellationToken;
use tower_http::cors::{AllowOrigin, CorsLayer};

use auth::Authenticator;
use connections::ConnectionRegistry;
use session::manager::SessionManager;
use session::SessionConfig;

/// Configuration for the server, mirrors Go's CLI flags.
pub struct ServerConfig {
    pub session_ttl: std::time::Duration,
    pub reconnect_grace: std::time::Duration,
    pub ring_buffer_size: usize,
    pub log_dir: String,
    pub verbose: bool,
    /// token 持久化文件(app 数据目录下);空 = 每次启动随机(旧行为)。
    /// 有值时跨重启复用 token,已配对手机不因电脑重启而失效。
    pub token_file: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            session_ttl: std::time::Duration::from_secs(300),
            reconnect_grace: std::time::Duration::from_secs(60),
            ring_buffer_size: 256 * 1024,
            log_dir: String::new(),
            verbose: false,
            token_file: String::new(),
        }
    }
}

/// Core shared state — replaces the old `MeTermProcess` (sidecar manager).
pub struct ServerState {
    pub port: u16,
    pub ready: AtomicBool,
    pub config: ServerConfig,
    pub session_manager: Arc<SessionManager>,
    pub authenticator: Arc<Authenticator>,
    /// Metadata-only bindings for sessions created by the fixed JumpServer
    /// broker. Koko connection credentials never enter this registry.
    pub(crate) jumpserver_sessions: jumpserver::ssh_session::JumpServerSessionRegistry,
    /// SSH 连接同步的元数据注册表(密钥另存钥匙串,见 `secret_vault`)。
    pub connections: Arc<ConnectionRegistry>,
    /// When true, all outgoing HTTP requests bypass system proxy (direct connection).
    pub bypass_proxy: AtomicBool,
}

impl ServerState {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn is_running(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub fn token(&self) -> Option<String> {
        Some(self.authenticator.get_token())
    }

    pub fn update_token(&self, new_token: String) -> Result<(), String> {
        let retired_generation = self.authenticator.set_token(new_token)?;
        self.disconnect_owner_generation(retired_generation);
        Ok(())
    }

    fn disconnect_owner_generation(&self, retired_generation: uuid::Uuid) {
        self.session_manager
            .disconnect_owner_generation(retired_generation);
        jumpserver::remove_owner_generation(retired_generation);
    }
}

/// Generate a cryptographically random token (32 bytes, base64url, ~44 chars).
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64_url_encode(&bytes)
}

fn base64_url_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut result = String::with_capacity((data.len() * 4).div_ceil(3));
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i + 1 < data.len() {
            data[i + 1] as u32
        } else {
            0
        };
        let b2 = if i + 2 < data.len() {
            data[i + 2] as u32
        } else {
            0
        };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if i + 1 < data.len() {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        }
        if i + 2 < data.len() {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        }
        i += 3;
    }
    result
}

/// Log the reason the axum serve task exited.
fn log_serve_exit(result: Result<Result<(), std::io::Error>, tokio::task::JoinError>) {
    match result {
        Ok(Ok(())) => eprintln!("[meterm-server] serve returned Ok unexpectedly"),
        Ok(Err(e)) => eprintln!("[meterm-server] serve error: {}", e),
        Err(e) if e.is_panic() => {
            // Extract panic message for diagnostics
            let panic_val = e.into_panic();
            let msg = panic_val
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic_val.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| format!("{:?}", panic_val));
            eprintln!("[meterm-server] PANIC in serve task: {}", msg);
        }
        Err(e) => eprintln!("[meterm-server] serve task cancelled: {}", e),
    }
}

/// accept 循环:每条本机连接 spawn 一个 `serve_connection`(明文 HTTP,喂同一 Router)。
/// 瞬时错误退避重试;致命错误返回 `Err`,交由上层监督者重建监听(保留原自动重启语义)。
async fn run_accept_loop(listener: tokio::net::TcpListener, app: Router) -> std::io::Result<()> {
    let connection_slots = transport::connection_slots();
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                // Sharing was removed: only this machine may connect. Reject
                // anything else before it consumes a pre-auth permit.
                if !peer.ip().is_loopback() {
                    drop(stream);
                    continue;
                }
                let permit = match connection_slots.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        drop(stream);
                        continue;
                    }
                };
                let app = app.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    transport::serve_connection(stream, peer, app).await;
                });
            }
            Err(e) => {
                if transport::is_transient_accept_error(&e) {
                    eprintln!("[meterm-server] transient accept error: {} — retrying", e);
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    continue;
                }
                eprintln!("[meterm-server] fatal accept error: {}", e);
                return Err(e);
            }
        }
    }
}

fn allocate_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("port allocation failed: {}", e))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

/// 优先复用上次端口(state_dir/preferred-port):token 已跨重启持久,
/// 端口再漂移的话手机存的 host:port 依旧失效,持久化才算闭环。
/// 上次端口被占(如双实例)则回退随机分配,并把新端口写回。
fn allocate_port_persistent(state_dir: &str) -> Result<u16, String> {
    // 标准开发入口使用独立 bundle id/app_data_dir；文件名仍按构建类型区分，
    // 防止绕过标准入口直接启动 Debug 时覆盖正式版持久端口。
    let name = if cfg!(debug_assertions) {
        "preferred-port-dev"
    } else {
        "preferred-port"
    };
    let port_file = format!("{}/{}", state_dir, name);
    if let Ok(saved) = std::fs::read_to_string(&port_file) {
        if let Ok(p) = saved.trim().parse::<u16>() {
            if p >= 1024 && TcpListener::bind(("127.0.0.1", p)).is_ok() {
                return Ok(p);
            }
        }
    }
    let port = allocate_port()?;
    let _ = std::fs::write(&port_file, port.to_string());
    Ok(port)
}

/// Build the axum router for the endpoints the local frontend calls.
fn build_router(state: Arc<ServerState>) -> Router {
    let auth_layer = middleware::from_fn({
        let auth = state.authenticator.clone();
        move |req, next| {
            let auth = auth.clone();
            async move { auth::auth_middleware(axum::extract::Extension(auth), req, next).await }
        }
    });

    // Routes that DON'T require authentication
    let public_routes = Router::new().route("/api/ping", get(handlers::ping));

    // Everything else is used only by the local desktop frontend, which
    // authenticates with the owner token.
    let owner_routes = Router::new()
        .route(
            "/api/sessions/ssh/saved",
            post(ssh_saved_session::create_ssh_session_from_saved),
        )
        .route(
            "/api/sessions/ssh/saved/test",
            post(ssh_saved_session::test_ssh_session_from_saved),
        )
        .route("/api/jumpserver/auth", post(jumpserver::handler::auth))
        .route("/api/jumpserver/mfa", post(jumpserver::handler::mfa))
        .route(
            "/api/jumpserver/token-auth",
            post(jumpserver::handler::token_auth),
        )
        .route(
            "/api/jumpserver/assets",
            get(jumpserver::handler::get_assets),
        )
        .route("/api/jumpserver/nodes", get(jumpserver::handler::get_nodes))
        .route(
            "/api/jumpserver/accounts",
            get(jumpserver::handler::get_accounts),
        )
        .route(
            "/api/jumpserver/test",
            post(jumpserver::handler::test_connection),
        )
        // Credential refresh reuses the session's existing SSH secret while
        // allowing the username/password fields to change.
        .route(
            "/api/sessions/{id}/refresh-sftp",
            post(jumpserver::ssh_session::refresh_jumpserver_sftp_session),
        )
        .route(
            "/api/jumpserver/ssh-session",
            post(jumpserver::ssh_session::create_jumpserver_ssh_session),
        )
        .layer(auth_layer);

    let trusted_origin_guard = middleware::from_fn({
        let server_port = state.port;
        move |request, next| async move {
            auth::trusted_origin_middleware(server_port, request, next).await
        }
    });
    let authed_routes = owner_routes.layer(trusted_origin_guard);

    let allowed_origins = [
        "tauri://localhost".parse().unwrap(),
        "http://tauri.localhost".parse().unwrap(),
        "https://tauri.localhost".parse().unwrap(),
        "http://localhost:5175".parse().unwrap(),
        "http://127.0.0.1:5175".parse().unwrap(),
        format!("http://127.0.0.1:{}", state.port).parse().unwrap(),
        format!("https://127.0.0.1:{}", state.port).parse().unwrap(),
        format!("http://localhost:{}", state.port).parse().unwrap(),
        format!("https://localhost:{}", state.port).parse().unwrap(),
    ];
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed_origins))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::header::CACHE_CONTROL,
            axum::http::header::PRAGMA,
        ])
        .max_age(std::time::Duration::from_secs(600));

    let router = Router::new().merge(public_routes).merge(authed_routes);

    // Ingress guard: sharing was removed, so direct remote sockets are never
    // served.
    let ingress_guard = middleware::from_fn(
        |req: axum::extract::Request, next: middleware::Next| async move {
            let allowed = matches!(
                req.extensions().get::<auth::TrustedIngress>(),
                Some(auth::TrustedIngress::DirectLoopback)
            );
            if !allowed {
                return Err(axum::http::StatusCode::FORBIDDEN);
            }
            Ok(next.run(req).await)
        },
    );

    router
        .layer(cors)
        .layer(ingress_guard)
        .layer(axum::Extension(state))
        .layer(middleware::from_fn(auth_body::idle_timeout_middleware))
}

/// Create a dummy ServerState (used when in-process server fails to start).
pub fn create_dummy_state() -> ServerState {
    let auth = Arc::new(Authenticator::new(String::new()));
    let sm = SessionManager::new(SessionConfig {
        session_ttl: std::time::Duration::from_secs(300),
        reconnect_grace: std::time::Duration::from_secs(60),
        ring_buffer_size: 256 * 1024,
        log_dir: String::new(),
    });
    ServerState {
        port: 0,
        ready: AtomicBool::new(false),
        config: ServerConfig::default(),
        session_manager: sm,
        authenticator: auth,
        jumpserver_sessions: jumpserver::ssh_session::JumpServerSessionRegistry::new(),
        // dummy state 无 app_data_dir,空路径即可(读写静默失败)。
        connections: Arc::new(
            ConnectionRegistry::new(std::path::PathBuf::new())
                .expect("empty in-memory connection registry"),
        ),
        bypass_proxy: AtomicBool::new(true),
    }
}

mod startup;
pub use startup::start;
