//! SFTP read/save operations used by the remote editor.

use russh_sftp::client::SftpSession;

use super::read_limits::parse_file_read_request;
use super::{encode_msg_error, sftp_temporary_sibling};
use crate::server::protocol;
use crate::server::terminal::ssh_limits::{
    read_bounded, BoundedReadError, SFTP_FILE_READ_LIMIT, SFTP_FILE_READ_TIMEOUT,
    SFTP_OPERATION_TIMEOUT,
};

#[cfg(test)]
#[path = "sftp_save_tests.rs"]
mod save_tests;

/// Handle MsgFileReadRequest via SFTP.
/// Request: JSON `{ "path": "...", "max_bytes": 123 }` (`max_bytes` is optional).
/// Response: MsgFileReadResponse + `[8B size BE][content]`.
pub async fn handle_sftp_file_read(payload: &[u8], sftp: &SftpSession) -> Vec<u8> {
    let (path, read_limit) = match parse_file_read_request(payload, SFTP_FILE_READ_LIMIT) {
        Ok(request) => request,
        Err(error) => return encode_msg_error("INVALID_REQUEST", &error),
    };

    let attrs =
        match tokio::time::timeout(SFTP_OPERATION_TIMEOUT, sftp.metadata(path.clone())).await {
            Ok(Ok(attrs)) => attrs,
            Ok(Err(error)) => {
                return encode_msg_error("NOT_FOUND", &format!("File not found: {}", error))
            }
            Err(_) => return encode_msg_error("READ_TIMEOUT", "SFTP metadata request timed out"),
        };
    if attrs.is_dir() {
        return encode_msg_error("IS_DIRECTORY", "Cannot open a directory in editor");
    }
    if attrs.size.unwrap_or(0) > read_limit as u64 {
        return encode_msg_error(
            "FILE_TOO_LARGE",
            &format!("File exceeds {} byte limit", read_limit),
        );
    }

    let mut file = match tokio::time::timeout(SFTP_OPERATION_TIMEOUT, sftp.open(path)).await {
        Ok(Ok(file)) => file,
        Ok(Err(error)) => return encode_msg_error("READ_FAILED", &format!("open: {}", error)),
        Err(_) => return encode_msg_error("READ_TIMEOUT", "SFTP open request timed out"),
    };
    match read_bounded(&mut file, read_limit, SFTP_FILE_READ_TIMEOUT).await {
        Ok(content) => {
            let size = content.len() as u64;
            let mut response = Vec::with_capacity(8 + content.len());
            response.extend_from_slice(&size.to_be_bytes());
            response.extend_from_slice(&content);
            protocol::encode_message(protocol::MSG_FILE_READ_RESPONSE, &response)
        }
        Err(BoundedReadError::TooLarge { .. }) => encode_msg_error(
            "FILE_TOO_LARGE",
            &format!("File exceeds {} byte limit", read_limit),
        ),
        Err(BoundedReadError::TimedOut { .. }) => {
            encode_msg_error("READ_TIMEOUT", "SFTP file read timed out")
        }
        Err(BoundedReadError::Io(error)) => {
            encode_msg_error("READ_FAILED", &format!("read: {}", error))
        }
    }
}

/// Handle MsgFileSaveRequest via SFTP.
/// Request: binary `[4B pathLen BE][path UTF-8][content]`.
pub async fn handle_sftp_file_save(payload: &[u8], sftp: &SftpSession) -> Vec<u8> {
    use tokio::io::AsyncWriteExt;

    if payload.len() < 4 {
        return encode_msg_error("INVALID_REQUEST", "payload too short");
    }
    let path_len = u32::from_be_bytes(payload[0..4].try_into().unwrap_or([0; 4])) as usize;
    if path_len == 0 || payload.len() < 4 + path_len {
        return encode_msg_error("INVALID_REQUEST", "invalid path length");
    }
    let raw_path = String::from_utf8_lossy(&payload[4..4 + path_len]).to_string();
    let content = &payload[4 + path_len..];

    let path = match sftp.read_link(raw_path.clone()).await {
        Ok(target) if target.starts_with('/') => target,
        Ok(target) => {
            let parent = raw_path
                .rfind('/')
                .map(|index| &raw_path[..index])
                .unwrap_or(".");
            format!("{}/{}", parent, target)
        }
        Err(_) => raw_path,
    };
    // Each save owns its staging file. Exclusive creation also prevents an
    // existing sibling file (or symlink) from being truncated accidentally.
    let tmp_path = sftp_temporary_sibling(&path, "edit.tmp");
    let original_attrs = match sftp.metadata(path.clone()).await {
        Ok(attrs) if attrs.is_dir() => {
            return encode_msg_error("IS_DIRECTORY", "Cannot save a directory in editor");
        }
        Ok(attrs) => Some(attrs),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
        {
            None
        }
        Err(error) => {
            return encode_msg_error("WRITE_FAILED", &format!("inspect target: {}", error))
        }
    };
    let flags = russh_sftp::protocol::OpenFlags::WRITE
        | russh_sftp::protocol::OpenFlags::CREATE
        | russh_sftp::protocol::OpenFlags::EXCLUDE;
    match sftp.open_with_flags(tmp_path.clone(), flags).await {
        Ok(mut file) => {
            let written = async {
                file.write_all(content).await?;
                file.flush().await?;
                // Await CLOSE: dropping the handle only schedules its close,
                // and some servers reject renaming a still-open file.
                file.shutdown().await
            }
            .await;
            if let Err(error) = written {
                let _ = file.shutdown().await;
                drop(file);
                let _ = sftp.remove_file(tmp_path).await;
                return encode_msg_error("WRITE_FAILED", &format!("write/close: {}", error));
            }
            drop(file);
            if let Some(original) = original_attrs {
                // Retain the access mode without requiring chown privileges
                // when editing another user's file in a shared directory.
                // The new inode keeps the SFTP account's default ownership.
                let mut attrs = russh_sftp::protocol::FileAttributes::empty();
                attrs.permissions = original.permissions;
                if let Err(error) = sftp.set_metadata(tmp_path.clone(), attrs).await {
                    let _ = sftp.remove_file(tmp_path).await;
                    return encode_msg_error(
                        "WRITE_FAILED",
                        &format!("preserve attributes: {}", error),
                    );
                }
            }
            if let Err(error) = replace_editor_file(sftp, &tmp_path, &path).await {
                let _ = sftp.remove_file(tmp_path).await;
                return encode_msg_error("RENAME_FAILED", &error);
            }
            let response = serde_json::json!({"success": true, "operation": "save"});
            protocol::encode_message(
                protocol::MSG_FILE_OPERATION_RESP,
                serde_json::to_vec(&response).unwrap_or_default().as_slice(),
            )
        }
        Err(error) => encode_msg_error("WRITE_FAILED", &format!("create: {}", error)),
    }
}

/// Standard SFTP rename does not replace an existing target on every server.
/// Move that target aside before retrying, and retain the last good copy if
/// either the commit or rollback fails. Never unlink the original as a retry.
async fn replace_editor_file(sftp: &SftpSession, staged: &str, target: &str) -> Result<(), String> {
    let first_error = match sftp.rename(staged.to_string(), target.to_string()).await {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    let attrs = sftp
        .symlink_metadata(target.to_string())
        .await
        .map_err(|error| format!("rename: {first_error}; inspect target: {error}"))?;
    if !attrs.is_regular() && !attrs.is_symlink() {
        return Err("existing editor target is not a file".to_string());
    }
    let backup = sftp_temporary_sibling(target, "edit.backup");
    sftp.rename(target.to_string(), backup.clone())
        .await
        .map_err(|error| format!("preserve original before replacement: {error}"))?;
    match sftp.rename(staged.to_string(), target.to_string()).await {
        Ok(()) => {
            if let Err(error) = sftp.remove_file(backup.clone()).await {
                eprintln!("[editor] saved {target}, original backup retained at {backup}: {error}");
            }
            Ok(())
        }
        Err(error) => match sftp.rename(backup.clone(), target.to_string()).await {
            Ok(()) => Err(format!("rename: {error}; original restored")),
            Err(restore_error) => Err(format!(
                "rename: {error}; original preserved at {backup}; restore failed: {restore_error}"
            )),
        },
    }
}
