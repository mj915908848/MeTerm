//! Fixed event broker for the connection launcher. The launcher has no generic
//! event-emission capability; each action has a fixed name and payload shape.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ConnectionAction {
    Open {
        preferred_owner: String,
        connection_type: ConnectionType,
        key: String,
    },
    New {
        preferred_owner: String,
        kind: NewKind,
    },
    Mutated,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionType {
    Ssh,
    Remote,
    Jumpserver,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NewKind {
    Local,
    Ssh,
    Remote,
    Jumpserver,
    Phone,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRequest<'a> {
    #[serde(rename = "type")]
    connection_type: &'a ConnectionType,
    key: &'a str,
    target_window_label: &'a str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NewRequest<'a> {
    kind: &'a NewKind,
    target_window_label: &'a str,
}

fn is_app_window(label: &str) -> bool {
    label == "main"
        || label.strip_prefix("window-").is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix.len() <= 64
                && suffix
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

fn live_owner(app: &AppHandle, preferred_owner: &str) -> Option<String> {
    if is_app_window(preferred_owner) && app.get_webview_window(preferred_owner).is_some() {
        return Some(preferred_owner.to_owned());
    }
    if app.get_webview_window("main").is_some() {
        return Some("main".to_owned());
    }
    let mut remaining: Vec<_> = app
        .webview_windows()
        .into_keys()
        .filter(|label| is_app_window(label))
        .collect();
    remaining.sort();
    remaining.into_iter().next()
}

#[tauri::command]
pub fn connections_dispatch(
    caller: WebviewWindow,
    app: AppHandle,
    request: ConnectionAction,
) -> Result<Option<String>, String> {
    if caller.label() != "connections" {
        return Err("connection dispatcher is launcher-only".into());
    }
    match request {
        ConnectionAction::Open {
            preferred_owner,
            connection_type,
            key,
        } => {
            if key.is_empty() || key.len() > 4096 {
                return Err("invalid connection key".into());
            }
            let target = live_owner(&app, &preferred_owner).ok_or("no app window is available")?;
            app.emit_to(
                &target,
                "connections-open-request",
                OpenRequest {
                    connection_type: &connection_type,
                    key: &key,
                    target_window_label: &target,
                },
            )
            .map_err(|e| e.to_string())?;
            Ok(Some(target))
        }
        ConnectionAction::New {
            preferred_owner,
            kind,
        } => {
            let target = live_owner(&app, &preferred_owner).ok_or("no app window is available")?;
            app.emit_to(
                &target,
                "connections-new-request",
                NewRequest {
                    kind: &kind,
                    target_window_label: &target,
                },
            )
            .map_err(|e| e.to_string())?;
            Ok(Some(target))
        }
        ConnectionAction::Mutated => {
            app.emit("connections-mutated", ())
                .map_err(|e| e.to_string())?;
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_app_window, ConnectionAction, ConnectionType, OpenRequest};

    #[test]
    fn only_app_windows_can_receive_connection_requests() {
        assert!(is_app_window("main"));
        assert!(is_app_window("window-42"));
        for label in [
            "connections",
            "settings",
            "window-",
            "window-../main",
            "main-other",
        ] {
            assert!(!is_app_window(label));
        }
    }

    #[test]
    fn broker_request_and_event_have_only_expected_fields() {
        let request: ConnectionAction = serde_json::from_value(serde_json::json!({
            "action": "open", "preferredOwner": "window-42", "connectionType": "ssh", "key": "ssh:a"
        }))
        .unwrap();
        assert!(
            matches!(request, ConnectionAction::Open { preferred_owner, key, .. }
            if preferred_owner == "window-42" && key == "ssh:a")
        );
        let payload = serde_json::to_value(OpenRequest {
            connection_type: &ConnectionType::Ssh,
            key: "ssh:a",
            target_window_label: "window-42",
        })
        .unwrap();
        assert_eq!(
            payload,
            serde_json::json!({
                "type": "ssh", "key": "ssh:a", "targetWindowLabel": "window-42"
            })
        );
        assert!(
            serde_json::from_value::<ConnectionAction>(serde_json::json!({
                "action": "emit", "event": "menu-request-quit", "payload": {}
            }))
            .is_err()
        );
    }
}
