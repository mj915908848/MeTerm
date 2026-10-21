//! Code-signature check for the isolated, non-distributable MeTerm Dev bundle.
//!
//! Compiled only into the macOS development build. The development credential
//! recovery path calls it before touching the production Keychain namespace.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Command;

// The expected identity is the developer's own Apple Development certificate,
// so neither the certificate CN (which embeds a personal Apple ID) nor the team
// it belongs to belongs in the (published) source tree. Both are injected at
// build time instead: `make desktop-dev` / `make desktop-build-dev` derive them
// from the local keychain, and a build without them fails closed here rather
// than weakening the signer check.
//
// Compiled only with `debug_assertions` + `development-mobile-control` on macOS,
// so distributable builds are unaffected.
const DEVELOPMENT_SIGNER_CN: Option<&str> = option_env!("METERM_DEV_SIGNER_CN");
const DEVELOPMENT_TEAM_ID: Option<&str> = option_env!("METERM_DEV_TEAM_ID");

fn development_signer_cn() -> Result<&'static str, String> {
    DEVELOPMENT_SIGNER_CN
        .map(str::trim)
        .filter(|cn| cn.starts_with("Apple Development:"))
        .ok_or_else(|| {
            "development signer identity was not embedded at build time; build through \
             `make desktop-dev` / `make desktop-build-dev`, or export METERM_DEV_SIGNER_CN \
             with the full Apple Development certificate CN before building"
                .to_string()
        })
}

fn development_team_id() -> Result<&'static str, String> {
    DEVELOPMENT_TEAM_ID
        .map(str::trim)
        .filter(|team| {
            team.len() == 10
                && team
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        })
        .ok_or_else(|| {
            "development team identifier was not embedded at build time; build through \
             `make desktop-dev` / `make desktop-build-dev`, or export METERM_DEV_TEAM_ID \
             with the Apple Development certificate team ID before building"
                .to_string()
        })
}

pub(crate) fn validate_development_app_identity() -> Result<(), String> {
    let signer_cn = development_signer_cn()?;
    let team_id = development_team_id()?;
    let executable = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|_| "cannot resolve the current development app executable".to_string())?;
    let app = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .filter(|path| path.file_name() == Some(OsStr::new("MeTerm Dev.app")))
        .ok_or_else(|| "provisioning must run from the signed MeTerm Dev.app bundle".to_string())?;
    let expected_executable = app.join("Contents").join("MacOS").join("meterm");
    if std::fs::canonicalize(&expected_executable).ok().as_ref() != Some(&executable) {
        return Err("unexpected MeTerm Dev executable path".to_string());
    }

    let verification = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(format!(
            "-R=identifier \"com.meterm.dev\" and anchor apple generic and certificate leaf[subject.OU] = \"{team_id}\" and certificate leaf[subject.CN] = \"{signer_cn}\""
        ))
        .arg(app)
        .output()
        .map_err(|_| "failed to invoke native code-signature verification".to_string())?;
    if !verification.status.success() {
        return Err("MeTerm Dev bundle signature verification failed".to_string());
    }
    let details = Command::new("/usr/bin/codesign")
        .args(["-d", "--verbose=4"])
        .arg(&executable)
        .output()
        .map_err(|_| "failed to inspect the development code signature".to_string())?;
    if !details.status.success() {
        return Err("MeTerm Dev executable is not signed".to_string());
    }
    let signature_text = String::from_utf8_lossy(&details.stderr);
    if !signature_text
        .lines()
        .any(|line| line == "Identifier=com.meterm.dev")
        || !signature_text
            .lines()
            .any(|line| line.strip_prefix("Authority=") == Some(signer_cn))
        || !signature_text
            .lines()
            .any(|line| line.strip_prefix("TeamIdentifier=") == Some(team_id))
    {
        return Err("unexpected MeTerm Dev signing identity".to_string());
    }

    let identifier = Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(app.join("Contents").join("Info.plist"))
        .output()
        .map_err(|_| "failed to inspect the development bundle identifier".to_string())?;
    if !identifier.status.success()
        || String::from_utf8_lossy(&identifier.stdout).trim() != "com.meterm.dev"
    {
        return Err("unexpected MeTerm Dev bundle identifier".to_string());
    }
    Ok(())
}
