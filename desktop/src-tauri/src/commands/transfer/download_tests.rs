use super::*;
use crate::server::{events::EventBus, session::SessionConfig};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("meterm-download-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str, contents: &[u8]) -> String {
        let path = self.0.join(name);
        std::fs::write(&path, contents).unwrap();
        path.to_str().unwrap().to_owned()
    }
    fn assert_clean(&self) {
        assert!(std::fs::read_dir(&self.0).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".meterm.download-")));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn download(
    source: String,
    dest: String,
    offset: u64,
    channel: &tauri::ipc::Channel<SessionDownloadEvent>,
    cancellation: CancellationToken,
) -> Result<DownloadOutcome, String> {
    let session = Arc::new(Session::new(
        "download-test".into(),
        SessionConfig {
            session_ttl: Duration::from_secs(60),
            reconnect_grace: Duration::from_secs(10),
            ring_buffer_size: 1024,
            log_dir: String::new(),
        },
        EventBus::new(),
    ));
    let (_tx, rx) = tokio::sync::mpsc::channel(8);
    run_session_download(session, source, dest, offset, rx, 1, channel, cancellation).await
}
fn event(body: tauri::ipc::InvokeResponseBody) -> serde_json::Value {
    match body {
        tauri::ipc::InvokeResponseBody::Json(json) => serde_json::from_str(&json).unwrap(),
        _ => panic!("expected JSON"),
    }
}

#[tokio::test]
async fn download_cancel_before_open_preserves_existing_destination() {
    let fixture = Fixture::new();
    let source = fixture.file("source", b"new contents");
    let dest = fixture.file("destination", b"keep original");
    let cancellation = CancellationToken::new();
    let cancel = cancellation.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        if event(body)["kind"] == "started" {
            cancel.cancel();
        }
        Ok(())
    });
    assert!(matches!(
        download(source, dest.clone(), 0, &channel, cancellation)
            .await
            .unwrap(),
        DownloadOutcome::Cancelled
    ));
    assert_eq!(std::fs::read(&dest).unwrap(), b"keep original");
    fixture.assert_clean();
}

#[tokio::test]
async fn download_keeps_destination_until_completion() {
    let fixture = Fixture::new();
    let source = fixture.file("source", b"new contents");
    let dest = fixture.file("destination", b"keep original");
    let check_dest = dest.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        let event = event(body);
        if event["kind"] == "progress" {
            assert_eq!(std::fs::read(&check_dest).unwrap(), b"keep original");
        }
        if event["kind"] == "completed" {
            assert_eq!(event["save_path"], check_dest);
            assert_eq!(std::fs::read(&check_dest).unwrap(), b"new contents");
        }
        Ok(())
    });
    download(source, dest.clone(), 0, &channel, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(std::fs::read(dest).unwrap(), b"new contents");
    fixture.assert_clean();
}

#[tokio::test]
async fn download_offset_retains_prefix_without_stale_tail() {
    let fixture = Fixture::new();
    let source = fixture.file("source", b"ABCDEF");
    let dest = fixture.file("destination", b"ABCdiscarded");
    download(
        source,
        dest.clone(),
        3,
        &tauri::ipc::Channel::new(|_| Ok(())),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(dest).unwrap(), b"ABCDEF");
    fixture.assert_clean();
}

#[tokio::test]
async fn download_same_source_and_failed_source_preserve_originals() {
    let fixture = Fixture::new();
    let source = fixture.file("source", b"keep original");
    let channel = tauri::ipc::Channel::new(|_| Ok(()));
    assert!(download(
        source.clone(),
        source.clone(),
        0,
        &channel,
        CancellationToken::new()
    )
    .await
    .is_err());
    assert_eq!(std::fs::read(&source).unwrap(), b"keep original");
    assert!(download(
        fixture.0.join("missing").to_str().unwrap().to_owned(),
        source.clone(),
        0,
        &channel,
        CancellationToken::new()
    )
    .await
    .is_err());
    assert_eq!(std::fs::read(&source).unwrap(), b"keep original");
    fixture.assert_clean();
}

#[tokio::test]
async fn download_event_failure_preserves_committed_file() {
    let fixture = Fixture::new();
    let source = fixture.file("source", b"new contents");
    let dest = fixture.file("destination", b"keep original");
    let channel = tauri::ipc::Channel::new(|body| {
        if event(body)["kind"] == "completed" {
            return Err(std::io::Error::other("channel closed").into());
        }
        Ok(())
    });
    assert!(
        download(source, dest.clone(), 0, &channel, CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(dest).unwrap(), b"new contents");
    fixture.assert_clean();
}

#[cfg(unix)]
#[tokio::test]
async fn download_preserves_target_symlink_and_private_permissions() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let fixture = Fixture::new();
    let source = fixture.file("source", b"new contents");
    let target = fixture.file("target", b"keep original");
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = fixture.0.join("link");
    symlink(&target, &link).unwrap();
    download(
        source,
        link.to_str().unwrap().into(),
        0,
        &tauri::ipc::Channel::new(|_| Ok(())),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(std::fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(target).unwrap(), b"new contents");
    assert_eq!(
        std::fs::metadata(link).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fixture.assert_clean();
}

#[tokio::test]
async fn download_invalid_resume_preserves_destination() {
    let fixture = Fixture::new();
    let source = fixture.file("source", b"new contents");
    let dest = fixture.file("destination", b"old");
    assert!(download(
        source,
        dest.clone(),
        4,
        &tauri::ipc::Channel::new(|_| Ok(())),
        CancellationToken::new()
    )
    .await
    .is_err());
    assert_eq!(std::fs::read(dest).unwrap(), b"old");
    fixture.assert_clean();
}

#[tokio::test]
async fn download_sftp_success_and_preopen_failure_preserve_destination() {
    use crate::server::file_handler::operation_tests::{sftp_pair, SftpTestConfig};
    let fixture = Fixture::new();
    let source = fixture.file("source", b"remote contents");
    let dest = fixture.file("destination", b"keep original");
    let session = Arc::new(Session::new(
        "sftp-download-test".into(),
        SessionConfig {
            session_ttl: Duration::from_secs(60),
            reconnect_grace: Duration::from_secs(10),
            ring_buffer_size: 1024,
            log_dir: String::new(),
        },
        EventBus::new(),
    ));
    *session.sftp.lock().unwrap() = Some(sftp_pair(SftpTestConfig::default()).await);
    let channel = tauri::ipc::Channel::new(|_| Ok(()));
    let (_tx, rx) = tokio::sync::mpsc::channel(8);
    assert!(run_session_download(
        session.clone(),
        fixture.0.join("missing").to_str().unwrap().into(),
        dest.clone(),
        0,
        rx,
        1,
        &channel,
        CancellationToken::new()
    )
    .await
    .is_err());
    assert_eq!(std::fs::read(&dest).unwrap(), b"keep original");
    let (_tx, rx) = tokio::sync::mpsc::channel(8);
    run_session_download(
        session,
        source,
        dest.clone(),
        0,
        rx,
        1,
        &channel,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(dest).unwrap(), b"remote contents");
    fixture.assert_clean();
}

#[tokio::test]
async fn download_accepts_long_valid_filename() {
    let fixture = Fixture::new();
    let source = fixture.file("source", b"new contents");
    let dest = fixture.file(&"d".repeat(220), b"original");
    download(
        source,
        dest.clone(),
        0,
        &tauri::ipc::Channel::new(|_| Ok(())),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(dest).unwrap(), b"new contents");
    fixture.assert_clean();
}

#[tokio::test]
async fn download_cancel_during_transfer_preserves_destination() {
    let fixture = Fixture::new();
    let source = fixture.file("source", &vec![b'x'; LOCAL_DOWNLOAD_CHUNK_SIZE * 2]);
    let dest = fixture.file("destination", b"original");
    let cancellation = CancellationToken::new();
    let cancel = cancellation.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        if event(body)["kind"] == "progress" {
            cancel.cancel();
        }
        Ok(())
    });
    assert!(matches!(
        download(source, dest.clone(), 0, &channel, cancellation)
            .await
            .unwrap(),
        DownloadOutcome::Cancelled
    ));
    assert_eq!(std::fs::read(dest).unwrap(), b"original");
    fixture.assert_clean();
}
