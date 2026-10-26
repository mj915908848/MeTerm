use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::State;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufWriter};
use tokio_util::sync::CancellationToken;

use crate::server::dispatch::{validate_download_offset, validate_path, wait_download_ctrl};
use crate::server::session::downloads::DownloadOwner;
use crate::server::session::transfer::{
    finalize_local_upload, finalize_sftp_upload, UploadLeaseOwner,
};
use crate::server::session::{DownloadSignal, Session, UploadSignal};
use crate::server::ServerState;

const LOCAL_DOWNLOAD_CHUNK_SIZE: usize = 1024 * 1024;
const LOCAL_UPLOAD_CHUNK_SIZE: usize = 1024 * 1024;
const DOWNLOAD_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const UPLOAD_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const DOWNLOAD_WRITE_BUFFER_SIZE: usize = 4 * 1024 * 1024;
const UPLOAD_WRITE_BUFFER_SIZE: usize = 4 * 1024 * 1024;
const SFTP_DOWNLOAD_MAX_INFLIGHT_BYTES: usize = 32 * 1024 * 1024;
/// Each upload chunk is sent as pipelined SFTP writes, so one round-trip per
/// chunk instead of one per 32 KiB packet.
const SFTP_UPLOAD_CHUNK_SIZE: usize = 4 * 1024 * 1024;
const ASYNC_SFTP_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const SFTP_UNAVAILABLE: &str = "SFTP is not available for this session";
const SFTP_READY_TIMEOUT: Duration = Duration::from_secs(15);
const SFTP_READY_POLL_INTERVAL: Duration = Duration::from_millis(100);
const SESSION_UPLOAD_CANCEL_GRACE: Duration = Duration::from_secs(30);

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionDownloadEvent {
    Started {
        transfer_id: u32,
        total_size: u64,
    },
    Progress {
        transfer_id: u32,
        written: u64,
        total_size: u64,
    },
    Completed {
        transfer_id: u32,
        total_size: u64,
        save_path: String,
    },
    Failed {
        transfer_id: u32,
        message: String,
    },
    Cancelled {
        transfer_id: u32,
    },
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionUploadEvent {
    Started {
        transfer_id: u32,
        total_size: u64,
    },
    Progress {
        transfer_id: u32,
        written: u64,
        total_size: u64,
    },
    Completed {
        transfer_id: u32,
        total_size: u64,
        remote_path: String,
    },
    Failed {
        transfer_id: u32,
        message: String,
    },
    Cancelled {
        transfer_id: u32,
    },
}

#[derive(Clone, Copy)]
enum DownloadOutcome {
    Completed { total_size: u64 },
    Cancelled,
}

#[derive(Clone, Copy)]
enum UploadOutcome {
    Completed,
    Cancelled,
}

fn send_event(
    channel: &tauri::ipc::Channel<SessionDownloadEvent>,
    event: SessionDownloadEvent,
) -> Result<(), String> {
    channel.send(event).map_err(|e| e.to_string())
}

fn send_upload_event(
    channel: &tauri::ipc::Channel<SessionUploadEvent>,
    event: SessionUploadEvent,
) -> Result<(), String> {
    channel.send(event).map_err(|e| e.to_string())
}

async fn remove_partial_file(save_path: &str) {
    let _ = tokio::fs::remove_file(save_path).await;
}

/// 本机路径校验:在 `validate_path` 之外,Windows 还接受 `C:\...` 这类带盘符的绝对路径
/// (`validate_path` 是给远端 POSIX 路径用的,只认 `/` 开头)。
/// Local-path check: like `validate_path`, but on Windows also accepts drive-letter
/// absolute paths such as `C:\...` (`validate_path` targets remote POSIX paths).
fn validate_local_path(path: &str) -> Result<(), &'static str> {
    #[cfg(windows)]
    if Path::new(path).is_absolute() {
        return if path.len() > 4096 {
            Err("path too long")
        } else {
            Ok(())
        };
    }
    validate_path(path)
}

fn ensure_save_path(save_path: &str) -> Result<(), String> {
    if save_path.is_empty() {
        return Err("save path is required".to_string());
    }

    let target = Path::new(save_path);
    let parent = target
        .parent()
        .ok_or_else(|| "save path must include a parent directory".to_string())?;

    if !parent.exists() {
        return Err("save path parent directory does not exist".to_string());
    }

    Ok(())
}

struct ProgressReporter<'a> {
    channel: &'a tauri::ipc::Channel<SessionDownloadEvent>,
    transfer_id: u32,
    total_size: u64,
    last_emit_at: Instant,
    last_emit_written: u64,
}

impl<'a> ProgressReporter<'a> {
    fn new(
        channel: &'a tauri::ipc::Channel<SessionDownloadEvent>,
        transfer_id: u32,
        total_size: u64,
    ) -> Self {
        Self {
            channel,
            transfer_id,
            total_size,
            last_emit_at: Instant::now(),
            last_emit_written: 0,
        }
    }

    fn emit_if_needed(&mut self, written: u64, force: bool) -> Result<(), String> {
        if !force
            && written == self.last_emit_written
            && self.last_emit_at.elapsed() < DOWNLOAD_PROGRESS_INTERVAL
        {
            return Ok(());
        }

        if !force && self.last_emit_at.elapsed() < DOWNLOAD_PROGRESS_INTERVAL {
            return Ok(());
        }

        send_event(
            self.channel,
            SessionDownloadEvent::Progress {
                transfer_id: self.transfer_id,
                written,
                total_size: self.total_size,
            },
        )?;
        self.last_emit_at = Instant::now();
        self.last_emit_written = written;
        Ok(())
    }
}

struct UploadProgressReporter<'a> {
    channel: &'a tauri::ipc::Channel<SessionUploadEvent>,
    transfer_id: u32,
    total_size: u64,
    last_emit_at: Instant,
    last_emit_written: u64,
}

impl<'a> UploadProgressReporter<'a> {
    fn new(
        channel: &'a tauri::ipc::Channel<SessionUploadEvent>,
        transfer_id: u32,
        total_size: u64,
    ) -> Self {
        Self {
            channel,
            transfer_id,
            total_size,
            last_emit_at: Instant::now(),
            last_emit_written: 0,
        }
    }

    fn emit_if_needed(&mut self, written: u64, force: bool) -> Result<(), String> {
        if !force
            && written == self.last_emit_written
            && self.last_emit_at.elapsed() < UPLOAD_PROGRESS_INTERVAL
        {
            return Ok(());
        }

        if !force && self.last_emit_at.elapsed() < UPLOAD_PROGRESS_INTERVAL {
            return Ok(());
        }

        send_upload_event(
            self.channel,
            SessionUploadEvent::Progress {
                transfer_id: self.transfer_id,
                written,
                total_size: self.total_size,
            },
        )?;
        self.last_emit_at = Instant::now();
        self.last_emit_written = written;
        Ok(())
    }
}

fn ensure_local_source_path(local_path: &str) -> Result<(), String> {
    if local_path.is_empty() {
        return Err("local path is required".to_string());
    }

    let source = Path::new(local_path);
    if !source.exists() {
        return Err("local path does not exist".to_string());
    }
    if !source.is_file() {
        return Err("local path must be a file".to_string());
    }

    Ok(())
}

async fn wait_upload_ctrl(ctrl: &mut tokio::sync::mpsc::Receiver<UploadSignal>) -> bool {
    match ctrl.try_recv() {
        Ok(UploadSignal::Cancel) => true,
        Ok(UploadSignal::Pause) => loop {
            match ctrl.recv().await {
                Some(UploadSignal::Continue) => return false,
                Some(UploadSignal::Cancel) => return true,
                None => return true,
                _ => {}
            }
        },
        _ => false,
    }
}

async fn cleanup_sftp_part_file(
    sftp: &Arc<russh_sftp::client::SftpSession>,
    remote_part_path: &str,
) {
    let _ = sftp.remove_file(remote_part_path.to_string()).await;
}

/// The SFTP client a transfer should use, or `None` for a local session.
///
/// SSH and JumpServer sessions both transfer over the session's own russh SFTP
/// client, so no second login is made per transfer. An SSH session sets that
/// client up in the background right after connecting; a transfer started in
/// that window waits for it rather than failing.
async fn session_sftp(
    session: &Session,
) -> Result<Option<Arc<russh_sftp::client::SftpSession>>, String> {
    let deadline = Instant::now() + SFTP_READY_TIMEOUT;
    loop {
        if let Some(sftp) = session.sftp.lock().unwrap().clone() {
            return Ok(Some(sftp));
        }
        if *session.executor_type.lock().unwrap() != "ssh" {
            return Ok(None);
        }
        if session.sftp_init_error.lock().unwrap().is_some() || Instant::now() >= deadline {
            return Err(SFTP_UNAVAILABLE.to_string());
        }
        tokio::time::sleep(SFTP_READY_POLL_INTERVAL).await;
    }
}

async fn open_download_target(
    save_path: &str,
    start_offset: u64,
) -> Result<tokio::fs::File, String> {
    let mut opts = tokio::fs::OpenOptions::new();
    opts.create(true).write(true);
    if start_offset == 0 {
        opts.truncate(true);
    }

    let mut file = opts
        .open(save_path)
        .await
        .map_err(|e| format!("open local file: {}", e))?;
    if start_offset > 0 {
        file.seek(std::io::SeekFrom::Start(start_offset))
            .await
            .map_err(|e| format!("seek local file: {}", e))?;
    }
    Ok(file)
}

async fn finish_cancelled_download(
    save_path: &str,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionDownloadEvent>,
) -> Result<DownloadOutcome, String> {
    remove_partial_file(save_path).await;
    send_event(on_event, SessionDownloadEvent::Cancelled { transfer_id })?;
    Ok(DownloadOutcome::Cancelled)
}

async fn run_local_session_download(
    path: String,
    save_path: String,
    start_offset: u64,
    mut ctrl: tokio::sync::mpsc::Receiver<DownloadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionDownloadEvent>,
    cancellation: CancellationToken,
) -> Result<DownloadOutcome, String> {
    validate_local_path(&path).map_err(|e| e.to_string())?;
    ensure_save_path(&save_path)?;

    if path == save_path {
        return Err("source path and save path must be different".to_string());
    }

    let meta = tokio::select! {
        _ = cancellation.cancelled() => {
            return finish_cancelled_download(&save_path, transfer_id, on_event).await;
        }
        result = tokio::fs::metadata(&path) => {
            result.map_err(|e| format!("stat source file: {}", e))?
        }
    };
    let total_size = meta.len();
    validate_download_offset(start_offset, total_size).map_err(str::to_string)?;

    send_event(
        on_event,
        SessionDownloadEvent::Started {
            transfer_id,
            total_size,
        },
    )?;

    let mut source = tokio::select! {
        _ = cancellation.cancelled() => {
            return finish_cancelled_download(&save_path, transfer_id, on_event).await;
        }
        result = tokio::fs::File::open(&path) => {
            result.map_err(|e| format!("open source file: {}", e))?
        }
    };
    if start_offset > 0 {
        tokio::select! {
            _ = cancellation.cancelled() => {
                return finish_cancelled_download(&save_path, transfer_id, on_event).await;
            }
            result = source.seek(std::io::SeekFrom::Start(start_offset)) => {
                result.map_err(|e| format!("seek source file: {}", e))?;
            }
        }
    }

    let target = tokio::select! {
        _ = cancellation.cancelled() => {
            return finish_cancelled_download(&save_path, transfer_id, on_event).await;
        }
        result = open_download_target(&save_path, start_offset) => result?,
    };
    let mut writer = BufWriter::with_capacity(DOWNLOAD_WRITE_BUFFER_SIZE, target);
    let mut reporter = ProgressReporter::new(on_event, transfer_id, total_size);
    let mut written = start_offset;
    let mut buf = vec![0u8; LOCAL_DOWNLOAD_CHUNK_SIZE];

    loop {
        if wait_download_ctrl(&mut ctrl, &cancellation, || false).await {
            drop(writer);
            return finish_cancelled_download(&save_path, transfer_id, on_event).await;
        }

        let n = tokio::select! {
            _ = cancellation.cancelled() => {
                drop(writer);
                return finish_cancelled_download(&save_path, transfer_id, on_event).await;
            }
            result = source.read(&mut buf) => {
                result.map_err(|e| format!("read source file: {}", e))?
            }
        };
        if n == 0 {
            break;
        }

        let write_result = tokio::select! {
            _ = cancellation.cancelled() => None,
            result = writer.write_all(&buf[..n]) => Some(result),
        };
        let Some(write_result) = write_result else {
            drop(writer);
            return finish_cancelled_download(&save_path, transfer_id, on_event).await;
        };
        write_result.map_err(|e| format!("write local file: {}", e))?;
        written += n as u64;
        reporter.emit_if_needed(written, written >= total_size)?;
    }

    let flush_result = tokio::select! {
        _ = cancellation.cancelled() => None,
        result = writer.flush() => Some(result),
    };
    let Some(flush_result) = flush_result else {
        drop(writer);
        return finish_cancelled_download(&save_path, transfer_id, on_event).await;
    };
    flush_result.map_err(|e| format!("flush local file: {}", e))?;
    reporter.emit_if_needed(written, true)?;
    if written != total_size {
        return Err("source file changed during download".to_string());
    }
    Ok(DownloadOutcome::Completed { total_size })
}

#[allow(clippy::too_many_arguments)]
async fn run_sftp_session_download(
    sftp: Arc<russh_sftp::client::SftpSession>,
    path: String,
    save_path: String,
    start_offset: u64,
    ctrl: tokio::sync::mpsc::Receiver<DownloadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionDownloadEvent>,
    cancellation: CancellationToken,
) -> Result<DownloadOutcome, String> {
    validate_path(&path).map_err(|e| e.to_string())?;
    ensure_save_path(&save_path)?;

    let meta_result = tokio::select! {
        _ = cancellation.cancelled() => {
            return finish_cancelled_download(&save_path, transfer_id, on_event).await;
        }
        result = tokio::time::timeout(
            ASYNC_SFTP_OPERATION_TIMEOUT,
            sftp.metadata(path.clone()),
        ) => result,
    };
    let meta = meta_result
        .map_err(|_| "stat remote file timed out".to_string())?
        .map_err(|e| format!("stat remote file: {}", e))?;
    let total_size = meta.size.unwrap_or(0);
    validate_download_offset(start_offset, total_size).map_err(str::to_string)?;

    send_event(
        on_event,
        SessionDownloadEvent::Started {
            transfer_id,
            total_size,
        },
    )?;

    let open_result = tokio::select! {
        _ = cancellation.cancelled() => {
            return finish_cancelled_download(&save_path, transfer_id, on_event).await;
        }
        result = tokio::time::timeout(
            ASYNC_SFTP_OPERATION_TIMEOUT,
            sftp.open(path),
        ) => result,
    };
    let mut remote = open_result
        .map_err(|_| "open remote file timed out".to_string())?
        .map_err(|e| format!("open remote file: {}", e))?;
    if start_offset > 0 {
        let seek_result = tokio::select! {
            _ = cancellation.cancelled() => {
                return finish_cancelled_download(&save_path, transfer_id, on_event).await;
            }
            result = tokio::time::timeout(
                ASYNC_SFTP_OPERATION_TIMEOUT,
                remote.seek(std::io::SeekFrom::Start(start_offset)),
            ) => result,
        };
        seek_result
            .map_err(|_| "seek remote file timed out".to_string())?
            .map_err(|e| format!("seek remote file: {}", e))?;
    }

    let target = tokio::select! {
        _ = cancellation.cancelled() => {
            return finish_cancelled_download(&save_path, transfer_id, on_event).await;
        }
        result = open_download_target(&save_path, start_offset) => result?,
    };
    let writer = Arc::new(tokio::sync::Mutex::new(BufWriter::with_capacity(
        DOWNLOAD_WRITE_BUFFER_SIZE,
        target,
    )));
    let progress_state = Arc::new(tokio::sync::Mutex::new(ProgressReporter::new(
        on_event,
        transfer_id,
        total_size,
    )));
    let written = Arc::new(AtomicU64::new(start_offset));
    let cancelled = Arc::new(AtomicBool::new(false));
    let ctrl = Arc::new(tokio::sync::Mutex::new(ctrl));
    let remaining_bytes = total_size.saturating_sub(start_offset) as usize;
    let max_inflight_bytes = remaining_bytes.clamp(1, SFTP_DOWNLOAD_MAX_INFLIGHT_BYTES);

    if total_size == 0 {
        let flush_result = tokio::select! {
            _ = cancellation.cancelled() => None,
            result = async {
                writer.lock().await.flush().await
            } => Some(result),
        };
        let Some(flush_result) = flush_result else {
            drop(writer);
            return finish_cancelled_download(&save_path, transfer_id, on_event).await;
        };
        flush_result.map_err(|e| format!("flush local file: {}", e))?;
        return Ok(DownloadOutcome::Completed { total_size });
    }

    let read = remote.read_pipelined_streaming_each(max_inflight_bytes, {
        let ctrl = Arc::clone(&ctrl);
        let writer = Arc::clone(&writer);
        let progress_state = Arc::clone(&progress_state);
        let written = Arc::clone(&written);
        let cancelled = Arc::clone(&cancelled);
        let cancellation = cancellation.clone();
        move |chunk| {
            let ctrl = Arc::clone(&ctrl);
            let writer = Arc::clone(&writer);
            let progress_state = Arc::clone(&progress_state);
            let written = Arc::clone(&written);
            let cancelled = Arc::clone(&cancelled);
            let cancellation = cancellation.clone();
            async move {
                let mut ctrl = ctrl.lock().await;
                if wait_download_ctrl(&mut ctrl, &cancellation, || false).await {
                    cancelled.store(true, Ordering::Relaxed);
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "download cancelled",
                    ));
                }
                drop(ctrl);

                tokio::select! {
                    _ = cancellation.cancelled() => {
                        cancelled.store(true, Ordering::Relaxed);
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "download cancelled",
                        ));
                    }
                    result = async {
                        writer.lock().await.write_all(&chunk).await
                    } => {
                        result.map_err(|e| {
                            std::io::Error::other(e.to_string())
                        })?;
                    }
                }

                let written_now =
                    written.fetch_add(chunk.len() as u64, Ordering::Relaxed) + chunk.len() as u64;
                tokio::select! {
                    _ = cancellation.cancelled() => {
                        cancelled.store(true, Ordering::Relaxed);
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "download cancelled",
                        ));
                    }
                    result = async {
                        progress_state
                            .lock()
                            .await
                            .emit_if_needed(written_now, written_now >= total_size)
                    } => {
                        result.map_err(|e| {
                            std::io::Error::other(e)
                        })?;
                    }
                }
                Ok(())
            }
        }
    });
    tokio::pin!(read);
    let emitted = tokio::select! {
        _ = cancellation.cancelled() => {
            cancelled.store(true, Ordering::Relaxed);
            Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "download cancelled",
            ))
        }
        result = &mut read => result,
    };

    if let Err(err) = emitted {
        if cancelled.load(Ordering::Relaxed) && err.kind() == std::io::ErrorKind::Interrupted {
            drop(writer);
            return finish_cancelled_download(&save_path, transfer_id, on_event).await;
        }
        remove_partial_file(&save_path).await;
        return Err(format!("read remote file: {}", err));
    }

    let flush_result = tokio::select! {
        _ = cancellation.cancelled() => None,
        result = async {
            writer.lock().await.flush().await
        } => Some(result),
    };
    let Some(flush_result) = flush_result else {
        drop(writer);
        return finish_cancelled_download(&save_path, transfer_id, on_event).await;
    };
    flush_result.map_err(|e| format!("flush local file: {}", e))?;
    let written = written.load(Ordering::Relaxed);
    progress_state.lock().await.emit_if_needed(written, true)?;

    if written < total_size {
        remove_partial_file(&save_path).await;
        return Err("remote file ended unexpectedly".to_string());
    }
    Ok(DownloadOutcome::Completed { total_size })
}

/// Owns only an exclusively created staging file; cleanup never targets the
/// user's chosen destination, including failures before the backend opens it.
struct DownloadStagingFile(PathBuf);

impl Drop for DownloadStagingFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl DownloadStagingFile {
    async fn prepare(destination: &str, offset: u64) -> Result<Self, String> {
        ensure_save_path(destination)?;
        let path = Path::new(destination)
            .parent()
            .ok_or("download target has no parent")?
            .join(format!(".meterm.download-{}", uuid::Uuid::new_v4()));
        // Construct ownership synchronously with exclusive creation, so a
        // cancelled async open cannot leave an unowned staging file behind.
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("create download temp: {e}"))?;
        let staged = Self(path);
        match std::fs::metadata(destination) {
            Ok(metadata) => std::fs::set_permissions(&staged.0, metadata.permissions())
                .map_err(|e| format!("preserve download permissions: {e}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("inspect download target: {error}")),
        }
        let mut target = tokio::fs::File::from_std(file);
        if offset > 0 {
            let source = tokio::fs::File::open(destination)
                .await
                .map_err(|e| format!("open download prefix: {e}"))?;
            let mut prefix = source.take(offset);
            let copied = tokio::io::copy(&mut prefix, &mut target)
                .await
                .map_err(|e| format!("copy download prefix: {e}"))?;
            if copied != offset {
                return Err("existing download is shorter than resume offset".into());
            }
        }
        target
            .flush()
            .await
            .map_err(|e| format!("flush download prefix: {e}"))?;
        Ok(staged)
    }
}

fn reject_same_local_download(source: &str, destination: &str) -> Result<(), String> {
    let same_path = source == destination
        || match (
            std::fs::canonicalize(source),
            std::fs::canonicalize(destination),
        ) {
            (Ok(source), Ok(destination)) => source == destination,
            _ => false,
        };
    #[cfg(unix)]
    let same_path = same_path || {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(source), std::fs::metadata(destination)) {
            (Ok(source), Ok(destination)) => {
                source.dev() == destination.dev() && source.ino() == destination.ino()
            }
            _ => false,
        }
    };
    if same_path {
        Err("source path and save path must be different".into())
    } else {
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_session_download(
    session: Arc<Session>,
    path: String,
    save_path: String,
    start_offset: u64,
    ctrl: tokio::sync::mpsc::Receiver<DownloadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionDownloadEvent>,
    cancellation: CancellationToken,
) -> Result<DownloadOutcome, String> {
    let is_local =
        *session.executor_type.lock().unwrap() != "ssh" && session.sftp.lock().unwrap().is_none();
    if is_local {
        reject_same_local_download(&path, &save_path)?;
    }
    if cancellation.is_cancelled() {
        send_event(on_event, SessionDownloadEvent::Cancelled { transfer_id })?;
        return Ok(DownloadOutcome::Cancelled);
    }
    // Preserve save-through-symlink behavior while publishing atomically at
    // the resolved target, and keep the requested path in completion events.
    let destination = match std::fs::canonicalize(&save_path) {
        Ok(path) => path
            .to_str()
            .ok_or("invalid download target path")?
            .to_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => save_path.clone(),
        Err(error) => return Err(format!("resolve download target: {error}")),
    };
    let staged = tokio::select! {
        result = DownloadStagingFile::prepare(&destination, start_offset) => result?,
        _ = cancellation.cancelled() => {
            send_event(on_event, SessionDownloadEvent::Cancelled { transfer_id })?;
            return Ok(DownloadOutcome::Cancelled);
        }
    };
    let staged_path = staged
        .0
        .to_str()
        .ok_or("invalid download temp path")?
        .to_string();
    let outcome = run_session_download_to_stage(
        session,
        path,
        staged_path.clone(),
        start_offset,
        ctrl,
        transfer_id,
        on_event,
        cancellation.clone(),
    )
    .await?;
    if let DownloadOutcome::Completed { total_size } = outcome {
        if cancellation.is_cancelled() {
            send_event(on_event, SessionDownloadEvent::Cancelled { transfer_id })?;
            return Ok(DownloadOutcome::Cancelled);
        }
        finalize_local_upload(&staged_path, &destination).await?;
        // A delivery failure after commit must not remove the published file.
        send_event(
            on_event,
            SessionDownloadEvent::Completed {
                transfer_id,
                total_size,
                save_path,
            },
        )?;
    }
    Ok(outcome)
}

#[allow(clippy::too_many_arguments)]
async fn run_session_download_to_stage(
    session: Arc<Session>,
    path: String,
    save_path: String,
    start_offset: u64,
    ctrl: tokio::sync::mpsc::Receiver<DownloadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionDownloadEvent>,
    cancellation: CancellationToken,
) -> Result<DownloadOutcome, String> {
    if let Some(sftp) = session_sftp(&session).await? {
        run_sftp_session_download(
            sftp,
            path,
            save_path,
            start_offset,
            ctrl,
            transfer_id,
            on_event,
            cancellation,
        )
        .await
    } else {
        run_local_session_download(
            path,
            save_path,
            start_offset,
            ctrl,
            transfer_id,
            on_event,
            cancellation,
        )
        .await
    }
}

#[tauri::command]
pub async fn start_session_file_download(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    remote_path: String,
    save_path: String,
    transfer_id: u32,
    offset: Option<u64>,
    on_event: tauri::ipc::Channel<SessionDownloadEvent>,
) -> Result<(), String> {
    if transfer_id == 0 {
        return Err("transferId must be non-zero".to_string());
    }

    let session = state
        .session_manager
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;
    let start_offset = offset.unwrap_or(0);

    let (ctrl_tx, ctrl_rx) = tokio::sync::mpsc::channel::<DownloadSignal>(8);
    let registration = session
        .download_registry
        .register(DownloadOwner::ipc(transfer_id), ctrl_tx)
        .map_err(|error| error.to_string())?;
    let cancellation = registration.cancellation_token();

    let session_clone = session.clone();
    let path_clone = remote_path.clone();
    let save_path_clone = save_path.clone();
    tokio::spawn(async move {
        let _download_guard = session_clone.download_registry.task_guard(registration);
        let result = run_session_download(
            session_clone.clone(),
            path_clone,
            save_path_clone.clone(),
            start_offset,
            ctrl_rx,
            transfer_id,
            &on_event,
            cancellation,
        )
        .await;

        if let Err(err) = result {
            let _ = send_event(
                &on_event,
                SessionDownloadEvent::Failed {
                    transfer_id,
                    message: err,
                },
            );
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn control_session_file_download(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    transfer_id: u32,
    signal: String,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;

    let sig = match signal.as_str() {
        "pause" => DownloadSignal::Pause,
        "continue" => DownloadSignal::Continue,
        "cancel" => DownloadSignal::Cancel,
        _ => return Err("invalid download signal".to_string()),
    };

    if session
        .download_registry
        .signal_owner(&DownloadOwner::ipc(transfer_id), sig)
    {
        Ok(())
    } else {
        Err("download transfer not found or cannot accept control".to_string())
    }
}

async fn run_local_session_upload(
    local_path: String,
    remote_path: String,
    mut ctrl: tokio::sync::mpsc::Receiver<UploadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionUploadEvent>,
) -> Result<UploadOutcome, String> {
    validate_path(&remote_path).map_err(|e| e.to_string())?;
    ensure_local_source_path(&local_path)?;

    if local_path == remote_path {
        return Err("source path and target path must be different".to_string());
    }

    let total_size = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("stat local file: {}", e))?
        .len();
    send_upload_event(
        on_event,
        SessionUploadEvent::Started {
            transfer_id,
            total_size,
        },
    )?;

    let mut source = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("open local file: {}", e))?;
    let remote_part_path = format!("{}.meterm.part", remote_path);
    let target = open_download_target(&remote_part_path, 0).await?;
    let mut writer = BufWriter::with_capacity(UPLOAD_WRITE_BUFFER_SIZE, target);
    let mut reporter = UploadProgressReporter::new(on_event, transfer_id, total_size);
    let mut written = 0u64;
    let mut buf = vec![0u8; LOCAL_UPLOAD_CHUNK_SIZE];

    loop {
        if wait_upload_ctrl(&mut ctrl).await {
            drop(writer);
            remove_partial_file(&remote_part_path).await;
            send_upload_event(on_event, SessionUploadEvent::Cancelled { transfer_id })?;
            return Ok(UploadOutcome::Cancelled);
        }

        let n = source
            .read(&mut buf)
            .await
            .map_err(|e| format!("read local file: {}", e))?;
        if n == 0 {
            break;
        }

        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("write target file: {}", e))?;
        written += n as u64;
        reporter.emit_if_needed(written, written >= total_size)?;
    }

    writer
        .flush()
        .await
        .map_err(|e| format!("flush target file: {}", e))?;
    drop(writer);
    finalize_local_upload(&remote_part_path, &remote_path).await?;
    reporter.emit_if_needed(written, true)?;

    send_upload_event(
        on_event,
        SessionUploadEvent::Completed {
            transfer_id,
            total_size,
            remote_path,
        },
    )?;
    Ok(UploadOutcome::Completed)
}

async fn run_sftp_session_upload(
    sftp: Arc<russh_sftp::client::SftpSession>,
    local_path: String,
    remote_path: String,
    mut ctrl: tokio::sync::mpsc::Receiver<UploadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionUploadEvent>,
) -> Result<UploadOutcome, String> {
    validate_path(&remote_path).map_err(|e| e.to_string())?;
    ensure_local_source_path(&local_path)?;

    let total_size = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("stat local file: {}", e))?
        .len();
    send_upload_event(
        on_event,
        SessionUploadEvent::Started {
            transfer_id,
            total_size,
        },
    )?;

    let mut source = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("open local file: {}", e))?;
    let remote_part_path = format!("{}.meterm.part", remote_path);
    let mut remote = sftp
        .create(remote_part_path.clone())
        .await
        .map_err(|e| format!("create remote part file: {}", e))?;
    let mut reporter = UploadProgressReporter::new(on_event, transfer_id, total_size);
    let mut written = 0u64;
    let mut buf = vec![0u8; SFTP_UPLOAD_CHUNK_SIZE];

    loop {
        if wait_upload_ctrl(&mut ctrl).await {
            drop(remote);
            cleanup_sftp_part_file(&sftp, &remote_part_path).await;
            send_upload_event(on_event, SessionUploadEvent::Cancelled { transfer_id })?;
            return Ok(UploadOutcome::Cancelled);
        }

        let n = source
            .read(&mut buf)
            .await
            .map_err(|e| format!("read local file: {}", e))?;
        if n == 0 {
            break;
        }

        remote
            .write_all_pipelined(&buf[..n])
            .await
            .map_err(|e| format!("write remote file: {}", e))?;
        written += n as u64;
        reporter.emit_if_needed(written, written >= total_size)?;
    }

    remote
        .flush()
        .await
        .map_err(|e| format!("flush remote file: {}", e))?;
    drop(remote);
    finalize_sftp_upload(&sftp, &remote_part_path, &remote_path).await?;
    reporter.emit_if_needed(written, true)?;

    send_upload_event(
        on_event,
        SessionUploadEvent::Completed {
            transfer_id,
            total_size,
            remote_path,
        },
    )?;
    Ok(UploadOutcome::Completed)
}

async fn run_session_upload(
    session: Arc<Session>,
    local_path: String,
    remote_path: String,
    ctrl: tokio::sync::mpsc::Receiver<UploadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionUploadEvent>,
) -> Result<UploadOutcome, String> {
    if let Some(sftp) = session_sftp(&session).await? {
        run_sftp_session_upload(sftp, local_path, remote_path, ctrl, transfer_id, on_event).await
    } else {
        run_local_session_upload(local_path, remote_path, ctrl, transfer_id, on_event).await
    }
}

#[tauri::command]
pub async fn start_session_file_upload(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: u32,
    on_event: tauri::ipc::Channel<SessionUploadEvent>,
) -> Result<(), String> {
    if transfer_id == 0 {
        return Err("transferId must be non-zero".to_string());
    }

    let session = state
        .session_manager
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;

    let (ctrl_tx, ctrl_rx) = tokio::sync::mpsc::channel::<UploadSignal>(8);
    let session_cancel_tx = ctrl_tx.clone();
    {
        let mut ctrls = session.upload_ctrls.lock().await;
        if ctrls.contains_key(&transfer_id) {
            return Err("upload transfer already exists".to_string());
        }
        ctrls.insert(transfer_id, ctrl_tx);
    }
    let upload_lease = match session
        .upload_path_leases
        .acquire(&remote_path, UploadLeaseOwner::Ipc(transfer_id))
    {
        Ok(lease) => lease,
        Err(error) => {
            session.upload_ctrls.lock().await.remove(&transfer_id);
            return Err(error);
        }
    };

    let session_clone = session.clone();
    let local_path_clone = local_path.clone();
    let remote_path_clone = remote_path.clone();
    tokio::spawn(async move {
        let cancellation = session_clone.cancellation_token();
        let mut upload = Box::pin(run_session_upload(
            session_clone.clone(),
            local_path_clone,
            remote_path_clone.clone(),
            ctrl_rx,
            transfer_id,
            &on_event,
        ));
        let mut cancel_signal = Box::pin(async {
            cancellation.cancelled().await;
            let _ = session_cancel_tx.send(UploadSignal::Cancel).await;
        });
        let mut poisoned = false;
        let result = tokio::select! {
            result = &mut upload => result,
            _ = &mut cancel_signal => {
                match tokio::time::timeout(SESSION_UPLOAD_CANCEL_GRACE, &mut upload).await {
                    Ok(result) => result,
                    Err(_) => {
                        poisoned = true;
                        Err("session closed before upload stopped; destination remains locked".to_string())
                    }
                }
            }
        };

        if poisoned {
            // The blocking SSH2 worker or a remote write may still complete
            // after its future is dropped. Do not let another transfer reuse
            // the fixed `.meterm.part` path in this Session.
            session_clone.upload_path_leases.poison(&upload_lease);
        } else {
            session_clone.upload_path_leases.release(&upload_lease);
        }
        session_clone.upload_ctrls.lock().await.remove(&transfer_id);

        if let Err(err) = result {
            let _ = send_upload_event(
                &on_event,
                SessionUploadEvent::Failed {
                    transfer_id,
                    message: err,
                },
            );
        }
    });

    Ok(())
}

// ─── SFTP remote stat (used by agent upload_file pre-check) ───

#[derive(serde::Serialize)]
pub struct SftpStatResult {
    pub exists: bool,
    pub size: Option<u64>,
    pub is_dir: bool,
}

/// Stat a remote path via the session's dedicated SFTP connection.
/// Returns { exists: false } when the path does not exist; never errors
/// on "file not found" — only on connection/session failures.
#[tauri::command]
pub async fn sftp_stat_remote(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    remote_path: String,
) -> Result<SftpStatResult, String> {
    let session = state
        .session_manager
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;

    let sftp = session
        .sftp
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "SFTP not available for this session".to_string())?;

    match sftp.metadata(remote_path).await {
        Ok(meta) => {
            let is_dir = meta.file_type().is_dir();
            let size = meta.size;
            Ok(SftpStatResult {
                exists: true,
                size,
                is_dir,
            })
        }
        Err(_) => {
            // Any error (NotFound, permission, etc.) → treat as "does not exist".
            // The upload will surface a proper error if it's a permission issue.
            Ok(SftpStatResult {
                exists: false,
                size: None,
                is_dir: false,
            })
        }
    }
}

#[tauri::command]
pub async fn control_session_file_upload(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    transfer_id: u32,
    signal: String,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;

    let tx = {
        let ctrls = session.upload_ctrls.lock().await;
        ctrls
            .get(&transfer_id)
            .cloned()
            .ok_or_else(|| "upload transfer not found".to_string())?
    };

    let sig = match signal.as_str() {
        "pause" => UploadSignal::Pause,
        "continue" => UploadSignal::Continue,
        "cancel" => UploadSignal::Cancel,
        _ => return Err("invalid upload signal".to_string()),
    };

    tx.send(sig)
        .await
        .map_err(|_| "upload transfer control channel closed".to_string())
}

#[cfg(test)]
mod download_tests;
