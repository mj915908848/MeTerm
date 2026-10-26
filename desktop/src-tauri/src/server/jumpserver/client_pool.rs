//! Principal-partitioned JumpServer HTTP client cache.
//!
//! JumpServer clients contain session cookies, bearer tokens, CSRF state, and
//! cached credentials. A normalized base URL alone is therefore not a safe
//! cache key: every owner-token generation gets an independent client.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use crate::server::auth::AuthPrincipal;

use super::{normalize_base_url, JumpServerClient};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ClientPoolKey {
    base_url: String,
    /// Owner-token generation that authenticated the request.
    generation: uuid::Uuid,
}

fn pool_key(base_url: &str, principal: &AuthPrincipal) -> Result<ClientPoolKey, String> {
    Ok(ClientPoolKey {
        base_url: normalize_base_url(base_url)?,
        generation: principal.generation(),
    })
}

static CLIENT_POOL: LazyLock<
    Mutex<HashMap<ClientPoolKey, Arc<tokio::sync::Mutex<JumpServerClient>>>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Clear all cached clients (called when proxy mode changes).
pub fn clear_client_pool() {
    CLIENT_POOL.lock().unwrap().clear();
}

/// Remove the current principal's cached login for one JumpServer origin.
pub(super) fn reset_client(base_url: &str, principal: &AuthPrincipal) -> Result<(), String> {
    let key = pool_key(base_url, principal)?;
    CLIENT_POOL.lock().unwrap().remove(&key);
    Ok(())
}

/// Get or create a cached client for exactly one authenticated generation.
pub(super) fn get_or_create_client(
    base_url: &str,
    principal: &AuthPrincipal,
) -> Result<Arc<tokio::sync::Mutex<JumpServerClient>>, String> {
    let key = pool_key(base_url, principal)?;
    let mut pool = CLIENT_POOL.lock().unwrap();
    if let Some(client) = pool.get(&key) {
        return Ok(client.clone());
    }
    let client = Arc::new(tokio::sync::Mutex::new(JumpServerClient::new(
        &key.base_url,
    )?));
    pool.insert(key, client.clone());
    Ok(client)
}

pub(crate) fn remove_owner_generation(generation: uuid::Uuid) {
    CLIENT_POOL
        .lock()
        .unwrap()
        .retain(|key, _| key.generation != generation);
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn owner(generation: uuid::Uuid) -> AuthPrincipal {
        AuthPrincipal::Owner { generation }
    }

    #[test]
    fn cache_reuse_requires_exact_generation() {
        let _test = TEST_LOCK.lock().unwrap();
        clear_client_pool();
        let generation = uuid::Uuid::new_v4();
        let first = get_or_create_client("https://jump.example.com/", &owner(generation)).unwrap();
        let same = get_or_create_client("https://jump.example.com", &owner(generation)).unwrap();
        let next_generation =
            get_or_create_client("https://jump.example.com", &owner(uuid::Uuid::new_v4())).unwrap();

        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &next_generation));
        clear_client_pool();
    }

    #[test]
    fn retired_generation_cleanup_keeps_current_generation() {
        let _test = TEST_LOCK.lock().unwrap();
        clear_client_pool();
        let old = uuid::Uuid::new_v4();
        let current = uuid::Uuid::new_v4();
        let old_owner = get_or_create_client("https://jump.example.com", &owner(old)).unwrap();
        let current_owner =
            get_or_create_client("https://jump.example.com", &owner(current)).unwrap();

        remove_owner_generation(old);

        let recreated_owner =
            get_or_create_client("https://jump.example.com", &owner(old)).unwrap();
        let current_owner_again =
            get_or_create_client("https://jump.example.com", &owner(current)).unwrap();
        assert!(!Arc::ptr_eq(&old_owner, &recreated_owner));
        assert!(Arc::ptr_eq(&current_owner, &current_owner_again));
        clear_client_pool();
    }

    #[test]
    fn fresh_auth_reset_is_scoped_to_one_origin() {
        let _test = TEST_LOCK.lock().unwrap();
        clear_client_pool();
        let principal = owner(uuid::Uuid::new_v4());
        let first = get_or_create_client("https://jump.example.com", &principal).unwrap();
        let other = get_or_create_client("https://other.example.com", &principal).unwrap();

        reset_client("https://jump.example.com", &principal).unwrap();

        let recreated = get_or_create_client("https://jump.example.com", &principal).unwrap();
        let other_again = get_or_create_client("https://other.example.com", &principal).unwrap();
        assert!(!Arc::ptr_eq(&first, &recreated));
        assert!(Arc::ptr_eq(&other, &other_again));
        clear_client_pool();
    }
}
