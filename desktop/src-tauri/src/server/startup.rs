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

    let ban_file = if config.log_dir.is_empty() {
        None
    } else {
        Some(format!("{}/banned-ips.json", config.log_dir))
    };

    // SSH 连接同步注册表:与 ban_file 同一个 app_data_dir,空目录时传空路径
    // (ConnectionRegistry 读写失败静默忽略,等价于 BanManager 的 None 分支)。
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

    let ban_manager = Arc::new(BanManager::new(ban_file));
    let mut authenticator = if config.token_file.is_empty() {
        Authenticator::new(token)
    } else {
        Authenticator::new_persistent(token, config.token_file.clone())
    };
    // 审查发现:ban_manager 此前从未挂到 Authenticator(封禁检查是死代码),接上
    authenticator.set_ban_manager(ban_manager.clone());
    let authenticator = Arc::new(authenticator);
    // 桌面级事件总线(终端通知 Phase 1):先建好,注入 SessionManager(→ 每个 Session),
    // 再原样存进 ServerState——同一条 channel,SessionManager 与 ServerState 各持一份 clone。
    let event_bus = EventBus::new();
    // hook secret 注册表:先建好注入 SessionManager(reap 清理会话 secret),再存进 ServerState
    // (同源 clone)——修 M1 的 reap secret 泄漏。
    let hook_secrets = HookSecretRegistry::new();
    let session_manager =
        SessionManager::new(session_config, event_bus.clone(), hook_secrets.clone());
    let pairing_manager = PairingManager::new(
        authenticator.clone(),
        session_manager.clone(),
        ban_manager.clone(),
    );

    // 设备 ID:有 state_dir 就持久化(见 load_or_create_device_id),否则临时生成
    // (与 allocate_port 在空 log_dir 时退化为非持久端口的模式一致)。
    let device_id = if config.log_dir.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        load_or_create_device_id(&config.log_dir)
    };

    // Sharing (LAN access, mDNS discovery, phone relay/push) has been removed:
    // the server only serves this app's own windows over loopback, so it needs
    // no TLS identity, no discovery advertisement and no relay tunnel.

    let state = Arc::new(ServerState {
        port,
        ready: AtomicBool::new(false),
        config,
        session_manager,
        authenticator,
        ban_manager,
        pairing_manager,
        jumpserver_sessions: jumpserver::ssh_session::JumpServerSessionRegistry::new(),
        connections,
        bypass_proxy: AtomicBool::new(true),
        device_name: std::sync::Mutex::new(String::new()),
        device_id,
        event_bus,
        presence: PresenceRegistry::new(),
        agents: agent::AgentManager::new(),
        hook_secrets,
        mirrors: agent::MirrorRegistry::new(),
        permission_bridge: agent::PermissionBridge::new(),
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
