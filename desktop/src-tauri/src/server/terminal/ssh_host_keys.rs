//! MeTerm's host-key replacements, isolated from OpenSSH's trust store.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use crate::server::private_file::atomic_write_private;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[cfg(any(windows, target_os = "macos"))]
pub(super) fn path(host: &str, port: u16) -> Result<PathBuf, String> {
    let directory = dirs::data_local_dir()
        .ok_or_else(|| "MeTerm SSH host key storage is unavailable".to_string())?
        .join("com.meterm.app")
        .join("ssh-host-keys");
    Ok(endpoint_path(&directory, host, port))
}

fn endpoint_path(directory: &Path, host: &str, port: u16) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(port.to_be_bytes());
    hasher.update(host.to_ascii_lowercase());
    directory.join(format!("{:x}", hasher.finalize()))
}

/// None leaves verification to the usual OpenSSH trust flow.
pub(super) fn verify(
    saved: Option<&str>,
    confirmed: Option<&str>,
    observed: &str,
    replacing: bool,
) -> Option<bool> {
    if replacing {
        return Some(confirmed == Some(observed));
    }
    saved.map(|saved| saved == observed && confirmed.is_none_or(|confirmed| confirmed == observed))
}

pub(super) fn read(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(fingerprint) => Ok(Some(fingerprint)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read MeTerm SSH host key: {error}")),
    }
}

pub(super) fn replace(
    path: &Path,
    previous: Option<&str>,
    fingerprint: &str,
) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "MeTerm SSH host key storage is unavailable".to_string())?;
    let current = read(path)?;
    if current.as_deref() == Some(fingerprint) {
        return Ok(());
    }
    if current.as_deref() != previous {
        return Err(
            "MeTerm SSH host key changed during confirmation. Reconnect to verify it again.".into(),
        );
    }
    atomic_write_private(path, fingerprint.as_bytes())
        .map_err(|error| format!("Could not save MeTerm SSH host key: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_requires_an_exact_confirmation_and_supersedes_the_old_key() {
        assert_eq!(verify(None, None, "old", false), None);
        assert_eq!(verify(Some("old"), None, "new", false), Some(false));
        assert_eq!(verify(Some("old"), None, "new", true), Some(false));
        assert_eq!(verify(Some("old"), Some("new"), "other", true), Some(false));
        assert_eq!(verify(Some("old"), Some("new"), "new", true), Some(true));
        assert_eq!(verify(Some("new"), None, "new", false), Some(true));
        assert_eq!(verify(Some("new"), Some("old"), "old", false), Some(false));
    }

    #[test]
    fn replacement_is_persistent_and_scoped_to_the_host_and_port() {
        let directory =
            std::env::temp_dir().join(format!("meterm-ssh-host-keys-{}", uuid::Uuid::new_v4()));
        let path = endpoint_path(&directory, "example.com", 12288);
        assert_eq!(path, endpoint_path(&directory, "EXAMPLE.com", 12288));
        let other_port = endpoint_path(&directory, "example.com", 22);
        let other_host = endpoint_path(&directory, "different.example.com", 12288);
        assert_eq!(read(&path).unwrap(), None);

        replace(&path, None, "first").unwrap();
        replace(&path, Some("first"), "second").unwrap();
        replace(&path, Some("first"), "second").unwrap();
        assert!(replace(&path, Some("first"), "stale").is_err());
        assert_eq!(read(&path).unwrap().as_deref(), Some("second"));
        assert_eq!(read(&other_port).unwrap(), None);
        assert_eq!(read(&other_host).unwrap(), None);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
