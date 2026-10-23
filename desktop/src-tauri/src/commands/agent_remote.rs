// ─── Agent file tools over SFTP ───────────────────────────────
// read_file / write_file / edit_file on SSH panes. These go through the
// session's SFTP client instead of the terminal, so nothing is typed into
// the user's shell, the exact bytes survive, and a busy terminal (a TUI,
// a running build) does not block them.
//
// Paths are taken as given: absolute, or relative to the SFTP login
// directory (normally $HOME). The TS side resolves `~` and the pane cwd.

use std::sync::Arc;

use russh_sftp::client::SftpSession;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::fs::{
    apply_text_edit, read_lines_from, AgentEditResult, AgentReadResult, AGENT_EDIT_MAX_BYTES,
};
use crate::server::ServerState;

/// Largest remote file read_file loads; bigger files report too_large.
const READ_MAX_BYTES: u64 = 10 * 1024 * 1024;

fn sftp_for(state: &ServerState, session_id: &str) -> Result<Arc<SftpSession>, String> {
    let session = state
        .session_manager
        .get(session_id)
        .ok_or_else(|| "session not found".to_string())?;
    let sftp = session.sftp.lock().unwrap().clone();
    sftp.ok_or_else(|| "SFTP not available for this session".to_string())
}

async fn read_remote_bytes(sftp: &SftpSession, path: &str, cap: u64) -> Result<Vec<u8>, String> {
    let meta = sftp
        .metadata(path.to_string())
        .await
        .map_err(|e| format!("cannot access {}: {}", path, e))?;
    if meta.is_dir() {
        return Err(format!("{} is a directory", path));
    }
    if meta.size.unwrap_or(0) > cap {
        return Err(format!("too large: {} bytes", meta.size.unwrap_or(0)));
    }
    let mut file = sftp
        .open(path.to_string())
        .await
        .map_err(|e| format!("open failed: {}", e))?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| format!("read failed: {}", e))?;
    if bytes.len() as u64 > cap {
        return Err(format!("too large: more than {} bytes", cap));
    }
    Ok(bytes)
}

/// Truncate and rewrite `path` in place, so the file keeps its owner,
/// mode and any links pointing at it.
async fn write_remote_bytes(sftp: &SftpSession, path: &str, data: &[u8]) -> Result<(), String> {
    let mut file = sftp
        .create(path.to_string())
        .await
        .map_err(|e| format!("open for writing failed: {}", e))?;
    file.write_all(data)
        .await
        .map_err(|e| format!("write failed: {}", e))?;
    file.shutdown()
        .await
        .map_err(|e| format!("close failed: {}", e))?;
    Ok(())
}

/// `mkdir -p` for the parent of `path`.
async fn create_parent_dirs(sftp: &SftpSession, path: &str) -> Result<(), String> {
    let Some((parent, _)) = path.rsplit_once('/') else {
        return Ok(());
    };
    let mut prefix = String::new();
    for (i, part) in parent.split('/').enumerate() {
        if i > 0 {
            prefix.push('/');
        }
        prefix.push_str(part);
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        if sftp.try_exists(prefix.clone()).await.unwrap_or(false) {
            continue;
        }
        sftp.create_dir(prefix.clone())
            .await
            .map_err(|e| format!("failed to create directory {}: {}", prefix, e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    path: String,
    start_line: Option<u64>,
    max_lines: u64,
) -> Result<AgentReadResult, String> {
    let sftp = sftp_for(&state, &session_id)?;
    let bytes = match read_remote_bytes(&sftp, &path, READ_MAX_BYTES).await {
        Ok(bytes) => bytes,
        Err(e) if e.starts_with("too large") => {
            let size = sftp
                .metadata(path.clone())
                .await
                .ok()
                .and_then(|m| m.size)
                .unwrap_or(0);
            return Ok(AgentReadResult {
                content: None,
                size,
                is_binary: false,
                too_large: true,
                truncated: false,
                total_lines: None,
            });
        }
        Err(e) => return Err(e),
    };
    let size = bytes.len() as u64;
    read_lines_from(
        bytes.as_slice(),
        size,
        start_line.unwrap_or(1),
        max_lines,
        READ_MAX_BYTES,
    )
}

#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    path: String,
    content: String,
) -> Result<u64, String> {
    let sftp = sftp_for(&state, &session_id)?;
    create_parent_dirs(&sftp, &path).await?;
    write_remote_bytes(&sftp, &path, content.as_bytes()).await?;
    Ok(content.len() as u64)
}

#[tauri::command]
pub async fn sftp_edit_file(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<AgentEditResult, String> {
    let sftp = sftp_for(&state, &session_id)?;
    let bytes = read_remote_bytes(&sftp, &path, AGENT_EDIT_MAX_BYTES).await?;
    let content =
        String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 text".to_string())?;
    let (edited, result) = apply_text_edit(
        &content,
        &old_string,
        &new_string,
        replace_all.unwrap_or(false),
    )?;
    write_remote_bytes(&sftp, &path, edited.as_bytes()).await?;
    Ok(result)
}
