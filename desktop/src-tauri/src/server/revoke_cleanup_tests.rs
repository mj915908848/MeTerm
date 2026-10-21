use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue};

use super::auth::AuthPrincipal;
use super::create_dummy_state;

fn device_generation(state: &super::ServerState, token: &str) -> uuid::Uuid {
    let mut request = Request::new(Body::empty());
    request.headers_mut().insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    match state.authenticator.authenticate_request(&request).unwrap() {
        AuthPrincipal::Device { generation, .. } => generation,
        AuthPrincipal::Owner { .. } => panic!("device token authenticated as owner"),
    }
}

#[tokio::test]
async fn delayed_single_revoke_cleanup_spares_same_device_new_generation() {
    let state = create_dummy_state();
    let old_token = state
        .authenticator
        .issue_device_token("device-a", "Old Phone")
        .unwrap();
    let old_generation = device_generation(&state, &old_token);

    let retired = state
        .authenticator
        .revoke_device("device-a")
        .unwrap()
        .unwrap();
    assert_eq!(retired.generation, old_generation);

    let new_token = state
        .authenticator
        .issue_device_token("device-a", "New Phone")
        .unwrap();
    let new_generation = device_generation(&state, &new_token);
    assert_ne!(new_generation, retired.generation);

    let cleanup = state.disconnect_device_generation(&retired.device_id, retired.generation);
    assert_eq!(cleanup.disconnected, 0);
    assert!(state
        .authenticator
        .is_device_generation_current("device-a", new_generation));
}

#[tokio::test]
async fn delayed_revoke_all_cleanup_spares_repaired_generation_only() {
    let state = create_dummy_state();
    for device_id in ["device-a", "device-b"] {
        state
            .authenticator
            .issue_device_token(device_id, "Old Phone")
            .unwrap();
    }

    let outcome = state.revoke_all_for_local_owner("N".repeat(32)).unwrap();
    assert!(outcome.devices_revoked);
    assert_eq!(outcome.retired_devices.len(), 2);

    let new_token = state
        .authenticator
        .issue_device_token("device-a", "New Phone")
        .unwrap();
    let new_generation = device_generation(&state, &new_token);

    let cleanup = state.disconnect_device_generations(&outcome.retired_devices);
    assert_eq!(cleanup.disconnected, 0);
    assert!(state
        .authenticator
        .is_device_generation_current("device-a", new_generation));
}
