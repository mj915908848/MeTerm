//! WebSocket handler — handles WS upgrade and message loop.
//!
//! Message dispatch logic lives in `dispatch.rs` (shared with IPC commands).

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Extension, Path, Query, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{broadcast, oneshot};

use super::auth::{AuthPrincipal, TrustedIngress};
use super::protocol;
use super::session::client::{Client, ClientSecurityContext, WsReceivers};
use super::session::state::ClientRole;
use super::ServerState;

/// Session messages include 1 MiB transfer chunks and, for the editor protocol, an
/// in-memory file plus a short path header. Full downloads remain chunked (0x0F).
const SESSION_WS_MAX_MESSAGE_SIZE: usize = 17 * 1024 * 1024;

#[derive(Deserialize)]
pub struct WsQuery {
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

/// WebSocket upgrade handler.
pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Extension(ingress): Extension<TrustedIngress>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Path(session_id): Path<String>,
    Query(query): Query<WsQuery>,
) -> axum::response::Response {
    let Some(session) = state.session_manager.get(&session_id) else {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    };
    if !super::device_access::can_access_session(&state.authenticator, &principal, &session) {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    let remote_addr = addr.ip().to_string();
    let security = ClientSecurityContext { ingress, principal };
    ws.max_message_size(SESSION_WS_MAX_MESSAGE_SIZE)
        .max_frame_size(SESSION_WS_MAX_MESSAGE_SIZE)
        .protocols(["meterm.v1"])
        .on_upgrade(move |socket| {
            handle_ws(socket, state, session_id, query, remote_addr, security)
        })
        .into_response()
}

/// Main WebSocket handler — runs after upgrade.
async fn handle_ws(
    socket: WebSocket,
    state: Arc<ServerState>,
    session_id: String,
    query: WsQuery,
    remote_addr: String,
    security: ClientSecurityContext,
) {
    eprintln!(
        "[ws] new connection for session={}, client_id={:?}, mode={:?}",
        session_id, query.client_id, query.mode
    );

    // 1. Find session
    let session = match state.session_manager.get(&session_id) {
        Some(s) => s,
        None => {
            let err = protocol::encode_error(protocol::ERR_SESSION_NOT_FOUND, "session not found");
            let (mut sender, _) = socket.split();
            let _ = sender.send(Message::Binary(err.into())).await;
            return;
        }
    };

    // 2. Handle reconnect or create new client
    let (client, receivers, conn_gen) = if let Some(ref cid) = query.client_id {
        // Attempt reconnect
        match session.reconnect_client(
            cid,
            remote_addr.clone(),
            security.clone(),
            state.config.reconnect_grace,
        ) {
            Ok(bound) => bound,
            Err(_) => match create_new_client(&session, &query, &remote_addr, security.clone()) {
                Ok(created) => created,
                Err(error) => {
                    let err = protocol::encode_error(protocol::ERR_SESSION_PRIVATE, &error);
                    let (mut sender, _) = socket.split();
                    let _ = sender.send(Message::Binary(err.into())).await;
                    return;
                }
            },
        }
    } else {
        match create_new_client(&session, &query, &remote_addr, security) {
            Ok(created) => created,
            Err(error) => {
                let err = protocol::encode_error(protocol::ERR_SESSION_PRIVATE, &error);
                let (mut sender, _) = socket.split();
                let _ = sender.send(Message::Binary(err.into())).await;
                return;
            }
        }
    };

    let client_id = client.id.clone();
    // The generation is bound to these receivers during registration. Reading
    // client.conn_gen() here would let an overlapping reconnect substitute its
    // newer generation and make this handler disconnect that newer connection.
    // Both authentication and the direct-LAN accept lease happened before the
    // WebSocket upgrade. Revalidate after registration so neither credential
    // revocation nor LAN shutdown can leave a late, unscanned socket alive.
    if !keep_session_registration(&state, &session, &client, conn_gen) {
        return;
    }
    let registered_security = client.security_context();
    let registered_principal = registered_security.principal;
    if !state
        .authenticator
        .is_principal_current(&registered_principal)
    {
        session.remove_client(&client_id, conn_gen);
        return;
    }
    // A reconnect may arrive before H0's writer notices its replaced channel.
    // Retire only H0 Active uploads before H1 can resume; Finalizing uploads
    // retain their path lease until their commit finishes.
    session.cleanup_stale_ws_uploads(&client_id, conn_gen).await;
    session
        .download_registry
        .cancel_stale_ws_generations(&client_id, conn_gen);
    let actual_role = if session.master() == client_id {
        "master"
    } else {
        client.role.as_str()
    };
    eprintln!(
        "[ws] client={} role={} master={}",
        client_id,
        actual_role,
        session.master()
    );

    let (mut sender, mut receiver) = socket.split();

    // 3. Send Hello
    let hello = protocol::encode_hello(
        &client_id,
        actual_role,
        1,
        *session.last_cols.lock().unwrap(),
        *session.last_rows.lock().unwrap(),
        conn_gen,
    );
    if sender.send(Message::Binary(hello.into())).await.is_err() {
        session.remove_client(&client_id, conn_gen);
        return;
    }

    // 4. Send role change
    let role_byte = if session.master() == client_id {
        super::session::state::ClientRole::Master as u8
    } else {
        client.role as u8
    };
    let role_msg = protocol::encode_role_change(role_byte);
    if sender.send(Message::Binary(role_msg.into())).await.is_err() {
        session.remove_client(&client_id, conn_gen);
        return;
    }

    // 5. 先 spawn writer(**writer-before-attach**),使下面步骤6的 agent 历史回放期间
    //    priority 通道被并发排空。这是背压回放的前提:attach 的 `send_async` 在通道满时
    //    等待,writer 排空后才继续——若 writer 尚未起,回放会一直阻塞。hello / role
    //    (步骤3/4)已直接经 sender 发出,writer 接管 sender 后先排 priority 再排 bulk,
    //    故手机收到序:hello → role → 历史帧 → live 帧,顺序正确。
    let WsReceivers {
        mut priority_rx,
        mut bulk_rx,
    } = receivers;
    let (writer_done_tx, mut writer_done_rx) = oneshot::channel::<()>();
    let writer = tokio::spawn(async move {
        let mut priority_open = true;
        let mut bulk_open = true;

        while priority_open || bulk_open {
            tokio::select! {
                biased;
                msg = priority_rx.recv(), if priority_open => {
                    match msg {
                        Some(data) => {
                            if sender.send(Message::Binary(data.into())).await.is_err() {
                                break;
                            }
                            while let Ok(data) = priority_rx.try_recv() {
                                if sender.send(Message::Binary(data.into())).await.is_err() {
                                    let _ = writer_done_tx.send(());
                                    return;
                                }
                            }
                        }
                        None => priority_open = false,
                    }
                }
                msg = bulk_rx.recv(), if bulk_open => {
                    match msg {
                        Some(data) => {
                            if sender.send(Message::Binary(data.into())).await.is_err() {
                                break;
                            }
                        }
                        None => bulk_open = false,
                    }
                }
            }
        }

        let _ = writer_done_tx.send(());
    });

    // 6. 回放终端环形缓冲(在 writer 之后)。
    session.flush_ring_buffer(&client, conn_gen);

    // 7. Bidirectional message loop
    // (conn_gen 已在 step2 之后捕获 H0 自己的代次 G0——见上方说明,cleanup 用它精确一次清理。)
    loop {
        tokio::select! {
            _ = &mut writer_done_rx => break,
            // Incoming: WebSocket client → session
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        if data.is_empty() {
                            continue;
                        }
                        let msg_type = data[0];
                        let payload = &data[1..];
                        super::dispatch::dispatch_message(
                            &session,
                            &client_id,
                            conn_gen,
                            msg_type,
                            payload,
                            &state,
                        ).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    // Cleanup
    session
        .cleanup_ws_uploads_for_connection(&client_id, conn_gen)
        .await;
    session
        .download_registry
        .cancel_ws_generation(&client_id, conn_gen);
    session.remove_client(&client_id, conn_gen);
    writer.abort();
}

fn create_new_client(
    session: &super::session::Session,
    query: &WsQuery,
    remote_addr: &str,
    security: ClientSecurityContext,
) -> Result<(Arc<Client>, WsReceivers, u64), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let role = match query.mode.as_deref() {
        Some("readonly") => ClientRole::ReadOnly,
        _ => ClientRole::Viewer,
    };
    let (client, rx) = Client::new(id, remote_addr.to_string(), role, security);
    let client = Arc::new(client);
    let conn_gen = client.conn_gen();
    session.add_client(client.clone())?;
    Ok((client, rx, conn_gen))
}

fn keep_session_registration(
    state: &ServerState,
    session: &super::session::Session,
    client: &Client,
    conn_gen: u64,
) -> bool {
    if state.registered_ingress_allowed(client.security_context().ingress) {
        return true;
    }
    session.remove_client(&client.id, conn_gen);
    false
}

#[cfg(test)]
mod lan_registration_tests {
    use super::*;

    #[tokio::test]
    async fn late_direct_registrations_are_removed_but_relay_registrations_survive() {
        let state = Arc::new(crate::server::create_dummy_state());

        let session = state.session_manager.create();
        let (direct, _direct_receivers) = Client::new(
            "late-direct".to_string(),
            "192.0.2.10".to_string(),
            ClientRole::Viewer,
            ClientSecurityContext::test_device(TrustedIngress::DirectRemote, "phone-direct"),
        );
        let direct = Arc::new(direct);
        session.add_client(direct.clone()).unwrap();
        let direct_generation = direct.conn_gen();
        assert!(!keep_session_registration(
            &state,
            &session,
            &direct,
            direct_generation
        ));
        assert!(!direct.is_connected());

        let (relay, _relay_receivers) = Client::new(
            "late-relay".to_string(),
            "127.0.0.1".to_string(),
            ClientRole::Viewer,
            ClientSecurityContext::test_device(TrustedIngress::Relay, "phone-relay"),
        );
        let relay = Arc::new(relay);
        session.add_client(relay.clone()).unwrap();
        assert!(keep_session_registration(
            &state,
            &session,
            &relay,
            relay.conn_gen()
        ));
        assert!(relay.is_connected());
    }
}

#[cfg(test)]
mod reconnect_binding_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn reconnect_handler_cleanup_uses_its_own_generation_after_overlap() {
        let state = crate::server::create_dummy_state();
        let session = state.session_manager.create();
        let security = ClientSecurityContext::direct_loopback_owner();
        let (client, _initial_receivers) = Client::new(
            "stable".into(),
            "127.0.0.1".into(),
            ClientRole::Master,
            security.clone(),
        );
        let client = Arc::new(client);
        session.add_client(client.clone()).unwrap();

        // H0 returns from registration, then H1 registers before H0 reads conn_gen.
        let (_h0_client, _h0_receivers, generation_used_by_h0_handler) = session
            .reconnect_client(
                "stable",
                "127.0.0.1".into(),
                security.clone(),
                Duration::from_secs(60),
            )
            .unwrap();
        let (_h1_client, _h1_receivers, h1_generation) = session
            .reconnect_client(
                "stable",
                "127.0.0.1".into(),
                security,
                Duration::from_secs(60),
            )
            .unwrap();

        assert_eq!(generation_used_by_h0_handler, 1);
        assert_eq!(h1_generation, 2);
        session.remove_client("stable", generation_used_by_h0_handler);
        assert!(client.is_connected(), "H0 cleanup must not disconnect H1");
    }
}
