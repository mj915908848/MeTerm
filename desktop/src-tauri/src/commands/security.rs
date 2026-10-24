// ─── Native-only cleanup for insecure legacy Keychain ACLs ───

// 只有 macOS 和测试用到 / used on macOS and in tests only
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const RELEASE_INSECURE_LEGACY_KEYCHAIN_SERVICES: &[&str] = &[
    "com.meterm.dev.ssh",
    "com.meterm.app.jumpserver",
    "com.meterm.dev.jumpserver",
    "com.meterm.app.remote",
    "com.meterm.dev.remote",
    "com.meterm.app.settings",
    "com.meterm.dev.settings",
];

// Debug builds never perform service-wide Keychain deletion. Even a
// `com.meterm.dev.*` service can contain entries created under an older signing
// requirement, and SecItemDelete then returns errSecInvalidOwnerEdit. Legacy
// cleanup remains a strict release migration; development uses fresh,
// channel-specific vault services instead.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const DEBUG_INSECURE_LEGACY_KEYCHAIN_SERVICES: &[&str] = &[];

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn insecure_legacy_keychain_services_for_build(debug_build: bool) -> &'static [&'static str] {
    if debug_build {
        DEBUG_INSECURE_LEGACY_KEYCHAIN_SERVICES
    } else {
        RELEASE_INSECURE_LEGACY_KEYCHAIN_SERVICES
    }
}

/// Fixed-service helper reserved for an explicit, owner-confirmed maintenance
/// flow. Normal server startup must never call it. This is not a Tauri command,
/// takes no caller-supplied service name, and excludes current authority-bound
/// services.
#[allow(dead_code)]
pub(crate) fn scrub_insecure_legacy_keychain_services_for_maintenance() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        for service in insecure_legacy_keychain_services_for_build(cfg!(debug_assertions)) {
            macos_service_scrub::scrub(service)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos_service_scrub {
    use std::ffi::c_void;
    use std::ptr;

    type CfIndex = isize;
    type CfStringEncoding = u32;
    type CfStringRef = *const c_void;
    type CfMutableDictionaryRef = *const c_void;
    type OsStatus = i32;

    const UTF8: CfStringEncoding = 0x0800_0100;
    const ERR_SEC_SUCCESS: OsStatus = 0;
    const ERR_SEC_ITEM_NOT_FOUND: OsStatus = -25300;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFStringCreateWithBytes(
            alloc: *const c_void,
            bytes: *const u8,
            length: CfIndex,
            encoding: CfStringEncoding,
            external: u8,
        ) -> CfStringRef;
        fn CFDictionaryCreateMutable(
            alloc: *const c_void,
            capacity: CfIndex,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CfMutableDictionaryRef;
        fn CFDictionarySetValue(
            dictionary: CfMutableDictionaryRef,
            key: *const c_void,
            value: *const c_void,
        );
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        static kSecClass: CfStringRef;
        static kSecClassGenericPassword: CfStringRef;
        static kSecAttrService: CfStringRef;
        fn SecItemDelete(query: *const c_void) -> OsStatus;
    }

    pub(super) fn scrub(service: &str) -> Result<(), String> {
        unsafe {
            let service_ref = CFStringCreateWithBytes(
                ptr::null(),
                service.as_ptr(),
                service.len() as CfIndex,
                UTF8,
                0,
            );
            if service_ref.is_null() {
                return Err("failed to create legacy Keychain query".to_string());
            }
            let query = CFDictionaryCreateMutable(
                ptr::null(),
                0,
                ptr::addr_of!(kCFTypeDictionaryKeyCallBacks),
                ptr::addr_of!(kCFTypeDictionaryValueCallBacks),
            );
            if query.is_null() {
                CFRelease(service_ref);
                return Err("failed to create legacy Keychain query".to_string());
            }
            CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
            CFDictionarySetValue(query, kSecAttrService, service_ref);
            let status = SecItemDelete(query);
            CFRelease(query);
            CFRelease(service_ref);
            match status {
                ERR_SEC_SUCCESS | ERR_SEC_ITEM_NOT_FOUND => Ok(()),
                other => Err(format!("legacy Keychain maintenance scrub failed: {other}")),
            }
        }
    }
}

// ─── Proxy settings ───

#[tauri::command]
pub fn set_proxy_mode(window: tauri::WebviewWindow, mode: String) -> Result<(), String> {
    require_security_window(&window)?;
    let bypass = mode != "system";
    let old_bypass =
        crate::server::jumpserver::BYPASS_PROXY.swap(bypass, std::sync::atomic::Ordering::Relaxed);
    // 仅在代理模式真正改变时才清空 client pool，避免重复调用时丢失认证状态
    if old_bypass != bypass {
        crate::server::jumpserver::clear_client_pool();
        eprintln!(
            "[settings] proxy mode changed: {} (bypass={})",
            mode, bypass
        );
    } else {
        eprintln!(
            "[settings] proxy mode: {} (bypass={}, unchanged)",
            mode, bypass
        );
    }
    Ok(())
}

fn require_security_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label();
    if label == "main" || label == "settings" || label.starts_with("window-") {
        Ok(())
    } else {
        Err("security operation is unavailable to this window".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maintenance_scrub_excludes_current_and_per_connection_migration_services() {
        for service in [
            "com.meterm.app.ssh",
            "com.meterm.app.ssh.v2",
            "com.meterm.app.ssh.v3",
            "com.meterm.app.jumpserver.v3",
            "com.meterm.app.remote.v2",
            "com.meterm.app.settings.v2",
            "com.meterm.app.settings.v3",
        ] {
            assert!(!RELEASE_INSECURE_LEGACY_KEYCHAIN_SERVICES.contains(&service));
        }
    }

    #[test]
    fn debug_startup_skips_legacy_keychain_mutation() {
        let services = insecure_legacy_keychain_services_for_build(true);
        assert_eq!(services, DEBUG_INSECURE_LEGACY_KEYCHAIN_SERVICES);
        assert!(services.is_empty());
    }

    #[test]
    fn release_maintenance_scrub_retains_the_complete_security_baseline() {
        assert_eq!(
            insecure_legacy_keychain_services_for_build(false),
            RELEASE_INSECURE_LEGACY_KEYCHAIN_SERVICES
        );
    }
}
