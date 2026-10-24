//! In-process HTTP/WebSocket server startup and background task orchestration.

use super::*;

/// Start the in-process HTTP/WebSocket server.
pub async fn start(config: ServerConfig) -> Result<Arc<ServerState>, String> {
    let port = if config.log_dir.is_empty() {
        allocate_port()?
    } else {
        allocate_port_persistent(&config.log_dir)?
    };
    let token = generate_token();

    // SSH 连接同步注册表:位于 app_data_dir,空目录时传空路径
    // (ConnectionRegistry 读写失败静默忽略)。
    let connections_path = if config.log_dir.is_empty() {
        std::path::PathBuf::new()
    } else {
        std::path::PathBuf::from(&config.log_dir).join("ssh-connections.json")
    };
    let connections = Arc::new(ConnectionRegistry::new(connections_path)?);
    // Starting the local terminal/server must never enumerate or mutate saved
    // credential items. Legacy SSH/ACL maintenance is an explicit,
    // owner-confirmed recovery operation; normal use loads only the exact
    // connection selected by the user. This also prevents a denied Keychain
    // ACL from causing an authorization-dialog loop on every launch.

    let session_config = SessionConfig {
        session_ttl: config.session_ttl,
        reconnect_grace: config.reconnect_grace,
        ring_buffer_size: config.ring_buffer_size,
        log_dir: config.log_dir.clone(),
    };

    let authenticator = Arc::new(if config.token_file.is_empty() {
        Authenticator::new(token)
    } else {
        Authenticator::new_persistent(token, config.token_file.clone())
    });
    let session_manager = SessionManager::new(session_config);

    // Sharing (LAN access, mDNS discovery, phone relay/push) has been removed:
    // the server only serves this app's own windows over loopback, so it needs
    // no TLS identity, no discovery advertisement and no relay tunnel.

    let state = Arc::new(ServerState {
        port,
        ready: AtomicBool::new(false),
        config,
        session_manager,
        authenticator,
        jumpserver_sessions: jumpserver::ssh_session::JumpServerSessionRegistry::new(),
        connections,
        bypass_proxy: AtomicBool::new(true),
    });

    let addr = format!("127.0.0.1:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("bind {}: {}", addr, e))?;

    // Spawn the serve loop inside a supervisor that auto-restarts on
    // panic, error, or unexpected exit. Without this, a single panic in
    // the serve loop silently kills the server and ALL WebSocket sessions
    // fail with "Socket is not connected".
    //
    let state_for_serve = state.clone();
    let addr_for_restart = addr.clone();
    tokio::spawn(async move {
        // First run uses the already-bound listener.
        let app = build_router(state_for_serve.clone());
        log_serve_exit(tokio::spawn(run_accept_loop(listener, app)).await);

        // Auto-restart loop: rebind to the same port and rebuild the router.
        loop {
            eprintln!("[meterm-server] restarting in 500ms...");
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            let listener = match tokio::net::TcpListener::bind(&addr_for_restart).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!(
                        "[meterm-server] rebind {} failed: {} — retrying",
                        addr_for_restart, e
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    continue;
                }
            };

            let app = build_router(state_for_serve.clone());
            eprintln!("[meterm-server] restarted on {}", addr_for_restart);

            log_serve_exit(tokio::spawn(run_accept_loop(listener, app)).await);
        }
    });

    state.ready.store(true, Ordering::SeqCst);
    eprintln!("[meterm-server] ready on 127.0.0.1:{}", port);

    Ok(state)
}
