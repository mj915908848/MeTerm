use super::*;

#[test]
fn ssh_transport_errors_are_reduced_to_stable_public_codes() {
    let cases = [
        (
            "SSH authentication timed out after 20s",
            StatusCode::GATEWAY_TIMEOUT,
            "ssh_connect_timeout",
        ),
        (
            "read private key /Users/alice/.ssh/id_ed25519: permission denied",
            StatusCode::UNPROCESSABLE_ENTITY,
            "credential_unavailable",
        ),
        (
            "invalid key: encrypted material could not be decoded",
            StatusCode::UNPROCESSABLE_ENTITY,
            "credential_unavailable",
        ),
        (
            "password auth: server rejected credentials",
            StatusCode::BAD_GATEWAY,
            "ssh_auth_failed",
        ),
        (
            "SOCKS5 proxy proxy.internal:1080: connection refused",
            StatusCode::BAD_GATEWAY,
            "ssh_connect_failed",
        ),
    ];

    for (raw, expected_status, expected_code) in cases {
        let (status, code) = classify_ssh_connect_error(raw);
        assert_eq!(status, expected_status);
        assert_eq!(code, expected_code);
        let response = serde_json::json!({ "error": code }).to_string();
        assert!(!response.contains("/Users/alice/.ssh"));
        assert!(!response.contains("proxy.internal"));
        assert!(!response.contains("encrypted material"));
    }
}

#[test]
fn host_key_challenge_uses_an_explicit_field_allow_list() {
    let raw = serde_json::json!({
        "error": "host_key_unknown",
        "hostname": "db.example:22",
        "fingerprint": "SHA256:abc",
        "key_type": "ssh-ed25519",
        "message": "must not be forwarded",
        "private_key_path": "/Users/alice/.ssh/id_ed25519",
        "proxy": "proxy.internal:1080",
    })
    .to_string();

    let challenge = sanitized_host_key_challenge(&raw).expect("valid host-key challenge");
    assert_eq!(challenge["error"], "host_key_unknown");
    assert_eq!(challenge["hostname"], "db.example:22");
    assert_eq!(challenge["fingerprint"], "SHA256:abc");
    assert_eq!(challenge["key_type"], "ssh-ed25519");
    let response = challenge.to_string();
    assert!(!response.contains("private_key_path"));
    assert!(!response.contains("/Users/alice/.ssh"));
    assert!(!response.contains("proxy.internal"));
    assert!(!response.contains("must not be forwarded"));

    assert!(sanitized_host_key_challenge(
        r#"{"error":"host_key_unknown","fingerprint":"SHA256:abc"}"#
    )
    .is_none());
    assert!(sanitized_host_key_challenge(
        r#"{"error":"unrelated","hostname":"h","fingerprint":"f","key_type":"k"}"#
    )
    .is_none());
}

#[tokio::test]
async fn failed_ssh_connect_never_registers_a_discoverable_session() {
    let state = Arc::new(super::super::create_dummy_state());
    let before = state.session_manager.list().len();
    let config = super::super::terminal::ssh::SshConfig {
        host: "127.0.0.1".into(),
        port: 0,
        username: "nobody".into(),
        auth_method: super::super::terminal::ssh::SshAuthMethod::Password,
        password: "not-a-real-password".into(),
        private_key: String::new(),
        passphrase: String::new(),
        trusted_fingerprint: String::new(),
        disable_hook: true,
        multiplex_sftp: false,
        proxy_type: String::new(),
        proxy_host: String::new(),
        proxy_port: 0,
        proxy_username: String::new(),
        proxy_password: String::new(),
    };

    let (status, _) = connect_and_start_ssh_session(state.clone(), config).await;

    assert_ne!(status, StatusCode::CREATED);
    assert_eq!(state.session_manager.list().len(), before);
}
