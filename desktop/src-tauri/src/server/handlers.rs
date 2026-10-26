//! HTTP API handlers shared by the SSH routes.

use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use super::ServerState;

/// Format SystemTime as ISO 8601 string (e.g. "2026-03-23T15:04:05Z").
fn format_system_time(t: &std::time::SystemTime) -> String {
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => {
            let secs = d.as_secs();
            let (days, rem) = (secs / 86400, secs % 86400);
            let (hours, rem) = (rem / 3600, rem % 3600);
            let (mins, s) = (rem / 60, rem % 60);

            // Days since epoch → year/month/day (simplified Gregorian)
            let mut y = 1970i64;
            let mut remaining_days = days as i64;
            loop {
                let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                    366
                } else {
                    365
                };
                if remaining_days < days_in_year {
                    break;
                }
                remaining_days -= days_in_year;
                y += 1;
            }
            let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
            let month_days = [
                31,
                if leap { 29 } else { 28 },
                31,
                30,
                31,
                30,
                31,
                31,
                30,
                31,
                30,
                31,
            ];
            let mut m = 0usize;
            while m < 12 && remaining_days >= month_days[m] {
                remaining_days -= month_days[m];
                m += 1;
            }
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                y,
                m + 1,
                remaining_days + 1,
                hours,
                mins,
                s
            )
        }
        Err(_) => "1970-01-01T00:00:00Z".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Ping (no auth)
// ---------------------------------------------------------------------------

pub async fn ping() -> impl IntoResponse {
    Json(serde_json::json!({ "service": "meterm" }))
}

/// Return only the host-key fields that are part of the public SSH API.
///
/// The SSH transport serializes a host-key challenge into its error string so
/// it can cross the executor boundary.  Never forward the parsed object as-is:
/// keeping an explicit allow-list prevents a future transport field (for
/// example a path or proxy diagnostic) from becoming remotely observable.
pub(super) fn sanitized_host_key_challenge(error: &str) -> Option<serde_json::Value> {
    let parsed = serde_json::from_str::<serde_json::Value>(error).ok()?;
    let error = parsed.get("error")?.as_str()?;
    if !matches!(error, "host_key_unknown" | "host_key_mismatch") {
        return None;
    }
    let hostname = parsed.get("hostname")?.as_str()?;
    let fingerprint = parsed.get("fingerprint")?.as_str()?;
    let key_type = parsed.get("key_type")?.as_str()?;
    Some(serde_json::json!({
        "error": error,
        "hostname": hostname,
        "fingerprint": fingerprint,
        "key_type": key_type,
    }))
}

/// Collapse transport/authentication diagnostics into a small public error
/// vocabulary.  The caller may log `error` locally, but must send only the
/// returned static code to HTTP clients.
pub(super) fn classify_ssh_connect_error(error: &str) -> (StatusCode, &'static str) {
    let normalized = error.to_ascii_lowercase();

    // Check this first: authentication and channel timeouts also contain auth
    // or credential keywords, but callers need one consistent timeout result.
    if normalized.contains("timed out") || normalized.contains("timeout") {
        return (StatusCode::GATEWAY_TIMEOUT, "ssh_connect_timeout");
    }

    if normalized.contains("cannot determine home directory")
        || normalized.contains("private key path ")
        || normalized.contains("read private key ")
        || normalized.contains("invalid key:")
        || normalized.contains("no usable ssh identity found")
    {
        return (StatusCode::UNPROCESSABLE_ENTITY, "credential_unavailable");
    }

    if normalized.contains("authentication failed")
        || normalized.contains("password auth:")
        || normalized.contains("key auth:")
        || normalized.contains("permission denied")
    {
        // The desktop API credential remains valid; it is the upstream SSH
        // authentication that failed, so do not return HTTP 401 here.
        return (StatusCode::BAD_GATEWAY, "ssh_auth_failed");
    }

    (StatusCode::BAD_GATEWAY, "ssh_connect_failed")
}

/// 共享的"建会话 + connect(含未知主机密钥判定)+ 起 I/O + 后台 SFTP"流程。
/// `create_ssh_session`(临时连接)与 `ssh_saved_session::create_ssh_session_from_saved`
/// (已存连接中转,见同名兄弟模块)复用同一套逻辑,保证两者的成功、主机密钥挑战
/// 与稳定失败码完全一致。`pub(super)`——只在 `server` 模块内跨文件复用,不对外暴露。
pub(super) async fn connect_and_start_ssh_session(
    state: Arc<ServerState>,
    config: super::terminal::ssh::SshConfig,
) -> (StatusCode, Json<serde_json::Value>) {
    // Do not publish a Session until the complete SSH handshake/auth/channel
    // setup has succeeded.  A pre-registered `created` session is observable by
    // the desktop remote-session poller; on any failure it used to become a
    // ghost tab and retain a clone of the credential bundle indefinitely.
    let terminal = match tokio::time::timeout(
        super::terminal::ssh_limits::SSH_SESSION_CONNECT_TIMEOUT,
        super::terminal::ssh::SshTerminal::connect(&config, 80, 24),
    )
    .await
    {
        Ok(Ok(terminal)) => terminal,
        Ok(Err(e)) => {
            if let Some(challenge) = sanitized_host_key_challenge(&e) {
                return (StatusCode::CONFLICT, Json(challenge));
            }
            eprintln!("[ssh] connect failed: {}", e);
            let (status, code) = classify_ssh_connect_error(&e);
            return (status, Json(serde_json::json!({ "error": code })));
        }
        Err(_) => {
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({ "error": "ssh_connect_timeout" })),
            );
        }
    };

    // Commit the now-usable terminal to the session registry in one short,
    // infallible sequence. Creator/type/config are installed before any client
    // can discover the id.
    let pending_session = state.session_manager.prepare_connected_ssh(config.clone());
    let session = pending_session.session();

    {
        let ssh_handle = terminal.session_handle.clone();
        let sftp_config = config.clone();
        *session.ssh_exec_handle.lock().await = Some(Box::new(ssh_handle.clone()));

        // Start terminal I/O immediately (fast path — no SFTP blocking)
        super::session::Session::start_terminal(session.clone(), Box::new(terminal)).await;

        // No async cancellation point is allowed between publishing the
        // session and returning its id. Until this line PendingSession::drop
        // cancels the private session and no list/poller can observe it.
        let session = pending_session.commit();

        // Initialize SFTP in background — does not block terminal usability.
        // Same dual-strategy + fallback as the Tauri create_ssh_session path:
        // multiplex on the existing channel for JumpServer; otherwise prefer a
        // dedicated session but fall back to multiplex when the server refuses
        // a second auth (e.g. private-key rate limiting, MaxAuthTries=1).
        let session_bg = session.clone();
        let multiplex = sftp_config.multiplex_sftp;
        let ssh_handle_for_sftp = ssh_handle.clone();
        tokio::spawn(async move {
            let result = if multiplex {
                super::terminal::ssh::SshTerminal::init_sftp(&ssh_handle_for_sftp).await
            } else {
                match super::terminal::ssh::SshTerminal::connect_sftp(&sftp_config).await {
                    Ok(sftp) => Ok(sftp),
                    Err(dedicated_err) => {
                        eprintln!(
                            "[ssh] dedicated SFTP failed ({}), falling back to multiplexed channel",
                            dedicated_err
                        );
                        eprintln!(
                                "[ssh] sftp diag: auth_method={:?} has_private_key={} has_password={} has_passphrase={} trusted_fp={} proxy={}",
                                sftp_config.auth_method,
                                !sftp_config.private_key.is_empty(),
                                !sftp_config.password.is_empty(),
                                !sftp_config.passphrase.is_empty(),
                                !sftp_config.trusted_fingerprint.is_empty(),
                                if sftp_config.proxy_type.is_empty() { "none" } else { &sftp_config.proxy_type },
                            );
                        match super::terminal::ssh::SshTerminal::init_sftp(&ssh_handle_for_sftp)
                            .await
                        {
                            Ok(sftp) => {
                                eprintln!("[ssh] multiplexed SFTP fallback succeeded");
                                Ok(sftp)
                            }
                            Err(mux_err) => Err(format!(
                                "dedicated SFTP failed: {}; multiplex fallback also failed: {}",
                                dedicated_err, mux_err
                            )),
                        }
                    }
                }
            };
            match result {
                Ok(sftp_client) => {
                    *session_bg.sftp.lock().unwrap() = Some(sftp_client);
                }
                Err(e) => {
                    eprintln!("[ssh] SFTP setup failed: {}", e);
                    // This value is later sent over the session WebSocket by
                    // the file-policy guard. Keep the raw diagnostic in the
                    // local log only; paths/proxy details must not cross WS.
                    *session_bg.sftp_init_error.lock().unwrap() =
                        Some("sftp_init_failed".to_string());
                }
            }
        });
    }

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": session.id,
            "created_at": format_system_time(&session.created_at_system),
            "state": session.state_string(),
            "executor_type": "ssh",
        })),
    )
}

#[cfg(test)]
#[path = "handlers_tests.rs"]
mod tests;
