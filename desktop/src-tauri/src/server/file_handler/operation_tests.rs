//! Real file-operation regressions over an in-process SFTP wire transport.
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Packet, Status, StatusCode, Version,
};

pub struct TestDir {
    pub path: PathBuf,
}
impl TestDir {
    pub fn new() -> Self {
        let path = std::env::temp_dir().join(format!("meterm-file-ops-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self { path }
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[derive(Default)]
pub struct SftpTestConfig {
    pub reject_existing: bool,
    pub rename_failures: Vec<usize>,
    pub advertise_posix: bool,
    pub occupy_stage_on_open: bool,
    pub fail_write_after: Option<usize>,
    pub reported_uid_gid: Option<(u32, u32)>,
    pub reject_ownership_changes: bool,
}

struct FsServer {
    config: SftpTestConfig,
    handles: HashMap<String, std::fs::File>,
    renames: usize,
    writes: usize,
}
fn io_status(error: std::io::Error) -> StatusCode {
    match error.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}
fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
impl FsServer {
    fn rename_file(
        &mut self,
        id: u32,
        old: String,
        new: String,
        posix: bool,
    ) -> Result<Status, StatusCode> {
        self.renames += 1;
        if self.config.rename_failures.contains(&self.renames)
            || (!posix && self.config.reject_existing && std::fs::symlink_metadata(&new).is_ok())
        {
            return Err(StatusCode::Failure);
        }
        std::fs::rename(old, new).map_err(io_status)?;
        Ok(ok(id))
    }
}
impl russh_sftp::server::Handler for FsServer {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn init(&mut self, _: u32, _: HashMap<String, String>) -> Result<Version, StatusCode> {
        let mut version = Version::new();
        if self.config.advertise_posix {
            version
                .extensions
                .insert("posix-rename@openssh.com".into(), "1".into());
        }
        Ok(version)
    }
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        if self.config.occupy_stage_on_open
            && (filename.contains(".meterm.edit.tmp") || filename.contains(".meterm.copy-"))
        {
            std::fs::write(&filename, b"occupied staging").map_err(io_status)?;
        }
        let options: std::fs::OpenOptions = flags.into();
        let file = options.open(filename).map_err(io_status)?;
        let handle = uuid::Uuid::new_v4().to_string();
        self.handles.insert(handle.clone(), file);
        Ok(Handle { id, handle })
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, StatusCode> {
        self.handles.remove(&handle).ok_or(StatusCode::Failure)?;
        Ok(ok(id))
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, StatusCode> {
        let file = self.handles.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(io_status)?;
        let mut data = vec![0; len as usize];
        let n = file.read(&mut data).map_err(io_status)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        data.truncate(n);
        Ok(Data { id, data })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, StatusCode> {
        self.writes += 1;
        if self
            .config
            .fail_write_after
            .is_some_and(|limit| self.writes > limit)
        {
            return Err(StatusCode::Failure);
        }
        let file = self.handles.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(io_status)?;
        file.write_all(&data).map_err(io_status)?;
        Ok(ok(id))
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        let mut attrs = FileAttributes::from(&std::fs::metadata(path).map_err(io_status)?);
        if let Some((uid, gid)) = self.config.reported_uid_gid {
            attrs.uid = Some(uid);
            attrs.gid = Some(gid);
        }
        Ok(Attrs { id, attrs })
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        let mut attrs = FileAttributes::from(&std::fs::symlink_metadata(path).map_err(io_status)?);
        if let Some((uid, gid)) = self.config.reported_uid_gid {
            attrs.uid = Some(uid);
            attrs.gid = Some(gid);
        }
        Ok(Attrs { id, attrs })
    }
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        if self.config.reject_ownership_changes && (attrs.uid.is_some() || attrs.gid.is_some()) {
            return Err(StatusCode::PermissionDenied);
        }
        #[cfg(unix)]
        if let Some(mode) = attrs.permissions {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
                .map_err(io_status)?;
        }
        #[cfg(not(unix))]
        let _ = (path, attrs);
        Ok(ok(id))
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        let path = std::fs::canonicalize(path)
            .map_err(io_status)?
            .to_string_lossy()
            .into_owned();
        Ok(Name {
            id,
            files: vec![File::dummy(path)],
        })
    }
    async fn readlink(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        let target = std::fs::read_link(path)
            .map_err(io_status)?
            .to_string_lossy()
            .into_owned();
        Ok(Name {
            id,
            files: vec![File::dummy(target)],
        })
    }
    async fn remove(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        std::fs::remove_file(path).map_err(io_status)?;
        Ok(ok(id))
    }
    async fn rename(&mut self, id: u32, old: String, new: String) -> Result<Status, StatusCode> {
        self.rename_file(id, old, new, false)
    }
    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, StatusCode> {
        if request != "posix-rename@openssh.com" || !self.config.advertise_posix {
            return Err(StatusCode::OpUnsupported);
        }
        let mut bytes = data.as_slice();
        fn string(bytes: &mut &[u8]) -> Result<String, StatusCode> {
            if bytes.len() < 4 {
                return Err(StatusCode::BadMessage);
            }
            let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
            *bytes = &bytes[4..];
            if bytes.len() < len {
                return Err(StatusCode::BadMessage);
            }
            let value =
                String::from_utf8(bytes[..len].to_vec()).map_err(|_| StatusCode::BadMessage)?;
            *bytes = &bytes[len..];
            Ok(value)
        }
        let old = string(&mut bytes)?;
        let new = string(&mut bytes)?;
        self.rename_file(id, old, new, true).map(Packet::Status)
    }
}
pub async fn sftp_pair(config: SftpTestConfig) -> Arc<SftpSession> {
    let (client, server) = tokio::io::duplex(1024 * 1024);
    russh_sftp::server::run(
        server,
        FsServer {
            config,
            handles: HashMap::new(),
            renames: 0,
            writes: 0,
        },
    )
    .await;
    Arc::new(SftpSession::new_opts(client, Some(5)).await.unwrap())
}
fn request(operation: &str, source: &Path, destination: &Path) -> Vec<u8> {
    serde_json::to_vec(
        &serde_json::json!({ "operation": operation, "path": source, "new_path": destination }),
    )
    .unwrap()
}
fn success(response: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(&response[1..]).unwrap()["success"] == true
}

#[test]
fn local_copy_rejects_same_file_and_preserves_source() {
    let dir = TestDir::new();
    let source = dir.path.join("original.txt");
    std::fs::write(&source, b"original content").unwrap();
    for destination in [source.clone(), dir.path.join("./original.txt")] {
        let response = super::handle_file_operation(&request("copy", &source, &destination));
        assert!(!success(&response), "copy to self must be rejected");
        assert_eq!(std::fs::read(&source).unwrap(), b"original content");
    }
}
#[cfg(unix)]
#[test]
fn local_copy_rejects_symlink_and_hardlink_aliases() {
    let dir = TestDir::new();
    let source = dir.path.join("source");
    std::fs::write(&source, b"keep source").unwrap();
    let link = dir.path.join("symlink");
    std::os::unix::fs::symlink(&source, &link).unwrap();
    let hard = dir.path.join("hardlink");
    std::fs::hard_link(&source, &hard).unwrap();
    for destination in [link, hard] {
        assert!(!success(&super::handle_file_operation(&request(
            "copy",
            &source,
            &destination
        ))));
        assert_eq!(std::fs::read(&source).unwrap(), b"keep source");
    }
}
#[test]
fn local_copy_distinct_file_still_overwrites_destination() {
    let dir = TestDir::new();
    let source = dir.path.join("source");
    let target = dir.path.join("target");
    std::fs::write(&source, b"complete source").unwrap();
    std::fs::write(&target, b"old").unwrap();
    assert!(success(&super::handle_file_operation(&request(
        "copy", &source, &target
    ))));
    assert_eq!(std::fs::read(target).unwrap(), b"complete source");
}
#[tokio::test]
async fn sftp_copy_rejects_same_and_normalized_paths() {
    let dir = TestDir::new();
    let source = dir.path.join("source");
    std::fs::write(&source, b"keep source").unwrap();
    let sftp = sftp_pair(Default::default()).await;
    for destination in [source.clone(), dir.path.join("./source")] {
        assert!(!success(
            &super::handle_sftp_file_operation(&request("copy", &source, &destination), &sftp)
                .await
        ));
        assert_eq!(std::fs::read(&source).unwrap(), b"keep source");
    }
}
#[cfg(unix)]
#[tokio::test]
async fn sftp_copy_preserves_source_through_symlink_and_hardlink_aliases() {
    let dir = TestDir::new();
    let source = dir.path.join("source");
    std::fs::write(&source, b"keep source").unwrap();
    let link = dir.path.join("symlink");
    std::os::unix::fs::symlink(&source, &link).unwrap();
    let hard = dir.path.join("hardlink");
    std::fs::hard_link(&source, &hard).unwrap();
    let sftp = sftp_pair(Default::default()).await;
    assert!(!success(
        &super::handle_sftp_file_operation(&request("copy", &source, &link), &sftp).await
    ));
    assert_eq!(std::fs::read(&source).unwrap(), b"keep source");
    // SFTP has no inode identity. An undetected hardlink must still be copied safely.
    assert!(success(
        &super::handle_sftp_file_operation(&request("copy", &source, &hard), &sftp).await
    ));
    assert_eq!(std::fs::read(&source).unwrap(), b"keep source");
    assert_eq!(std::fs::read(&hard).unwrap(), b"keep source");
}
#[tokio::test]
async fn sftp_copy_distinct_file_still_overwrites_destination() {
    let dir = TestDir::new();
    let source = dir.path.join("source");
    let target = dir.path.join("target");
    std::fs::write(&source, b"complete source").unwrap();
    std::fs::write(&target, b"old").unwrap();
    let sftp = sftp_pair(SftpTestConfig {
        reject_existing: true,
        ..Default::default()
    })
    .await;
    assert!(success(
        &super::handle_sftp_file_operation(&request("copy", &source, &target), &sftp).await
    ));
    assert_eq!(std::fs::read(&source).unwrap(), b"complete source");
    assert_eq!(std::fs::read(&target).unwrap(), b"complete source");
    assert_eq!(
        std::fs::read_dir(&dir.path).unwrap().count(),
        2,
        "temporary files must be cleaned"
    );
}
#[tokio::test]
async fn sftp_touch_rejects_existing_without_truncation_and_creates_new() {
    let dir = TestDir::new();
    let existing = dir.path.join("existing");
    let new = dir.path.join("new");
    std::fs::write(&existing, b"original content").unwrap();
    let sftp = sftp_pair(Default::default()).await;
    assert!(!success(
        &super::handle_sftp_file_operation(&request("touch", &existing, &existing), &sftp).await
    ));
    assert_eq!(std::fs::read(&existing).unwrap(), b"original content");
    assert!(success(
        &super::handle_sftp_file_operation(&request("touch", &new, &new), &sftp).await
    ));
    assert_eq!(std::fs::read(&new).unwrap(), b"");
}

#[tokio::test]
async fn sftp_copy_write_failure_preserves_existing_destination() {
    let dir = TestDir::new();
    let source = dir.path.join("source");
    let target = dir.path.join("target");
    std::fs::write(&source, b"complete source").unwrap();
    std::fs::write(&target, b"original destination").unwrap();
    let sftp = sftp_pair(SftpTestConfig {
        fail_write_after: Some(0),
        ..Default::default()
    })
    .await;
    assert!(!success(
        &super::handle_sftp_file_operation(&request("copy", &source, &target), &sftp).await
    ));
    assert_eq!(std::fs::read(&source).unwrap(), b"complete source");
    assert_eq!(std::fs::read(&target).unwrap(), b"original destination");
    assert_eq!(std::fs::read_dir(&dir.path).unwrap().count(), 2);
}

#[tokio::test]
async fn sftp_copy_commit_failure_rolls_back_existing_destination() {
    let dir = TestDir::new();
    let source = dir.path.join("source");
    let target = dir.path.join("target");
    std::fs::write(&source, b"complete source").unwrap();
    std::fs::write(&target, b"original destination").unwrap();
    let sftp = sftp_pair(SftpTestConfig {
        rename_failures: vec![1, 3],
        ..Default::default()
    })
    .await;
    assert!(!success(
        &super::handle_sftp_file_operation(&request("copy", &source, &target), &sftp).await
    ));
    assert_eq!(std::fs::read(&source).unwrap(), b"complete source");
    assert_eq!(std::fs::read(&target).unwrap(), b"original destination");
    assert_eq!(std::fs::read_dir(&dir.path).unwrap().count(), 2);
}

#[tokio::test]
async fn sftp_copy_exclusive_staging_preserves_colliding_file() {
    let dir = TestDir::new();
    let source = dir.path.join("source");
    let target = dir.path.join("target");
    std::fs::write(&source, b"complete source").unwrap();
    std::fs::write(&target, b"original destination").unwrap();
    let sftp = sftp_pair(SftpTestConfig {
        occupy_stage_on_open: true,
        ..Default::default()
    })
    .await;
    assert!(!success(
        &super::handle_sftp_file_operation(&request("copy", &source, &target), &sftp).await
    ));
    assert_eq!(std::fs::read(&target).unwrap(), b"original destination");
    let staged = std::fs::read_dir(&dir.path)
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains(".meterm.copy-")
        })
        .unwrap();
    assert_eq!(std::fs::read(staged.path()).unwrap(), b"occupied staging");
}

#[tokio::test]
async fn sftp_copy_long_basename_uses_short_sibling_staging_and_backup() {
    let dir = TestDir::new();
    let source = dir.path.join("source");
    let destination = dir.path.join("x".repeat(220));
    std::fs::write(&source, b"complete source").unwrap();
    std::fs::write(&destination, b"old destination").unwrap();
    let sftp = sftp_pair(SftpTestConfig {
        reject_existing: true,
        ..Default::default()
    })
    .await;
    assert!(success(
        &super::handle_sftp_file_operation(&request("copy", &source, &destination), &sftp).await
    ));
    assert_eq!(std::fs::read(&source).unwrap(), b"complete source");
    assert_eq!(std::fs::read(&destination).unwrap(), b"complete source");
    assert_eq!(std::fs::read_dir(&dir.path).unwrap().count(), 2);
}
