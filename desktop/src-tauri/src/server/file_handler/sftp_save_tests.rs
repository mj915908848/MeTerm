use super::super::operation_tests::{sftp_pair, SftpTestConfig, TestDir};
use super::handle_sftp_file_save;
use crate::server::protocol;

fn request(path: &std::path::Path, content: &[u8]) -> Vec<u8> {
    let path = path.to_str().unwrap().as_bytes();
    let mut payload = (path.len() as u32).to_be_bytes().to_vec();
    payload.extend_from_slice(path);
    payload.extend_from_slice(content);
    payload
}

fn response_json(frame: &[u8]) -> serde_json::Value {
    serde_json::from_slice(&frame[1..]).unwrap()
}

#[tokio::test]
async fn remote_editor_overwrites_legal_long_basename_on_legacy_server() {
    let dir = TestDir::new();
    let target = dir.path.join("x".repeat(220));
    std::fs::write(&target, b"original").unwrap();
    // Reject replacing existing files to exercise both the staging and backup
    // names; neither may extend the destination's already long basename.
    let sftp = sftp_pair(SftpTestConfig {
        reject_existing: true,
        ..Default::default()
    })
    .await;
    let response = handle_sftp_file_save(&request(&target, b"replacement"), &sftp).await;
    assert_eq!(
        response[0],
        protocol::MSG_FILE_OPERATION_RESP,
        "{}",
        response_json(&response)
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"replacement");
    assert_eq!(std::fs::read_dir(&dir.path).unwrap().count(), 1);
}

#[tokio::test]
#[cfg(unix)]
async fn remote_editor_preserves_mode_without_requiring_chown_privilege() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let dir = TestDir::new();
    let target = dir.path.join("shared-config");
    std::fs::write(&target, b"original").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o660)).unwrap();
    let metadata = std::fs::metadata(&target).unwrap();
    // Model a writable file owned by another user in a shared directory. The
    // server permits chmod, but refuses chown requests from this SFTP account.
    let sftp = sftp_pair(SftpTestConfig {
        reported_uid_gid: Some((metadata.uid().checked_add(1).unwrap(), metadata.gid())),
        reject_ownership_changes: true,
        reject_existing: true,
        ..Default::default()
    })
    .await;
    let response = handle_sftp_file_save(&request(&target, b"replacement"), &sftp).await;
    assert_eq!(
        response[0],
        protocol::MSG_FILE_OPERATION_RESP,
        "{}",
        response_json(&response)
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"replacement");
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o660
    );
    assert_eq!(std::fs::read_dir(&dir.path).unwrap().count(), 1);
}

#[tokio::test]
async fn remote_editor_staging_collision_does_not_truncate_or_remove_existing_file() {
    let dir = TestDir::new();
    let target = dir.path.join("config");
    std::fs::write(&target, b"original").unwrap();
    let sftp = sftp_pair(SftpTestConfig {
        occupy_stage_on_open: true,
        ..Default::default()
    })
    .await;
    let response = handle_sftp_file_save(&request(&target, b"replacement"), &sftp).await;
    assert_eq!(response[0], protocol::MSG_ERROR);
    assert_eq!(std::fs::read(&target).unwrap(), b"original");
    let staged = std::fs::read_dir(&dir.path)
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| entry.path() != target)
        .unwrap();
    assert_eq!(std::fs::read(staged.path()).unwrap(), b"occupied staging");
}

#[tokio::test]
async fn failed_remote_editor_write_keeps_original_and_cleans_owned_stage() {
    let dir = TestDir::new();
    let target = dir.path.join("config");
    std::fs::write(&target, b"original").unwrap();
    let sftp = sftp_pair(SftpTestConfig {
        fail_write_after: Some(0),
        ..Default::default()
    })
    .await;
    let response = handle_sftp_file_save(&request(&target, b"replacement"), &sftp).await;
    assert_eq!(response[0], protocol::MSG_ERROR);
    assert_eq!(std::fs::read(&target).unwrap(), b"original");
    assert_eq!(std::fs::read_dir(&dir.path).unwrap().count(), 1);
}

#[tokio::test]
async fn remote_editor_creates_new_file_and_overwrites_on_standard_server() {
    let dir = TestDir::new();
    let target = dir.path.join("new-file");
    let sftp = sftp_pair(SftpTestConfig::default()).await;
    for content in [b"first".as_slice(), b"second complete save".as_slice()] {
        let response = handle_sftp_file_save(&request(&target, content), &sftp).await;
        assert_eq!(response[0], protocol::MSG_FILE_OPERATION_RESP);
        assert_eq!(response_json(&response)["success"], true);
        assert_eq!(std::fs::read(&target).unwrap(), content);
        assert_eq!(std::fs::read_dir(&dir.path).unwrap().count(), 1);
    }
}

#[tokio::test]
async fn concurrent_remote_editor_saves_keep_staging_contents_separate() {
    let dir = TestDir::new();
    let target = dir.path.join("config");
    std::fs::write(&target, b"original").unwrap();
    let sftp = sftp_pair(SftpTestConfig::default()).await;
    let a = vec![b'A'; 128 * 1024];
    let b = vec![b'B'; 128 * 1024];
    let request_a = request(&target, &a);
    let request_b = request(&target, &b);
    let (result_a, result_b) = tokio::join!(
        handle_sftp_file_save(&request_a, &sftp),
        handle_sftp_file_save(&request_b, &sftp),
    );
    assert_eq!(result_a[0], protocol::MSG_FILE_OPERATION_RESP);
    assert_eq!(result_b[0], protocol::MSG_FILE_OPERATION_RESP);
    let actual = std::fs::read(&target).unwrap();
    assert!(
        actual == a || actual == b,
        "committed content must be one complete save"
    );
    assert_eq!(std::fs::read_dir(&dir.path).unwrap().count(), 1);
}

#[tokio::test]
async fn failed_remote_editor_save_never_unlinks_original() {
    let dir = TestDir::new();
    let target = dir.path.join("config");
    std::fs::write(&target, b"original configuration").unwrap();
    let sftp = sftp_pair(SftpTestConfig {
        rename_failures: vec![1, 2],
        ..Default::default()
    })
    .await;
    let response = handle_sftp_file_save(&request(&target, b"replacement"), &sftp).await;
    assert_eq!(response[0], protocol::MSG_ERROR);
    assert_eq!(
        std::fs::read(&target).ok().as_deref(),
        Some(b"original configuration".as_slice()),
        "failed rename must leave the original at its original path"
    );
}

#[tokio::test]
async fn failed_remote_editor_commit_restores_original() {
    let dir = TestDir::new();
    let target = dir.path.join("config");
    std::fs::write(&target, b"original configuration").unwrap();
    let sftp = sftp_pair(SftpTestConfig {
        rename_failures: vec![1, 3],
        ..Default::default()
    })
    .await;
    let response = handle_sftp_file_save(&request(&target, b"replacement"), &sftp).await;
    assert_eq!(response[0], protocol::MSG_ERROR);
    assert_eq!(std::fs::read(&target).unwrap(), b"original configuration");
}

#[tokio::test]
async fn failed_remote_editor_rollback_retains_recoverable_backup() {
    let dir = TestDir::new();
    let target = dir.path.join("config");
    std::fs::write(&target, b"original configuration").unwrap();
    let sftp = sftp_pair(SftpTestConfig {
        rename_failures: vec![1, 3, 4],
        ..Default::default()
    })
    .await;
    let response = handle_sftp_file_save(&request(&target, b"replacement"), &sftp).await;
    assert_eq!(response[0], protocol::MSG_ERROR);
    let message = response_json(&response)["message"]
        .as_str()
        .unwrap()
        .to_string();
    let backups: Vec<_> = std::fs::read_dir(&dir.path)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains(".meterm.edit.backup-")
        })
        .collect();
    assert_eq!(backups.len(), 1, "last good copy must remain recoverable");
    assert_eq!(
        std::fs::read(backups[0].path()).unwrap(),
        b"original configuration"
    );
    assert!(
        message.contains(backups[0].path().to_str().unwrap()),
        "response must name recovery path"
    );
}

#[tokio::test]
#[cfg(unix)]
async fn legacy_remote_editor_overwrite_preserves_mode_and_unrelated_staging_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TestDir::new();
    let target = dir.path.join("config");
    let legacy_stage = dir.path.join("config.meterm.edit.tmp");
    std::fs::write(&target, b"original").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
    std::fs::write(&legacy_stage, b"unrelated save in progress").unwrap();
    let sftp = sftp_pair(SftpTestConfig {
        reject_existing: true,
        ..Default::default()
    })
    .await;
    let response = handle_sftp_file_save(&request(&target, b"replacement"), &sftp).await;
    assert_eq!(
        response[0],
        protocol::MSG_FILE_OPERATION_RESP,
        "{}",
        response_json(&response)
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"replacement");
    assert_eq!(
        std::fs::read(&legacy_stage).unwrap(),
        b"unrelated save in progress"
    );
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o640
    );
}
