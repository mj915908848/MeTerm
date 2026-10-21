use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::settings_secrets::{
    canonical_service_base, confidential_service_base, provider_secret, require_ai_settings_window,
    searxng_password,
};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_MODEL_BYTES: usize = 512;
const MAX_SEARCH_QUERY_BYTES: usize = 8 * 1024;
const MAX_STREAM_ID_BYTES: usize = 128;
const STREAM_CONNECT_TIMEOUT_SECS: u64 = 30;
// Silence allowed between stream chunks. A long answer may take far longer
// than this overall; only a stalled connection should time out.
const STREAM_IDLE_TIMEOUT_SECS: u64 = 180;

/// Cancellation tokens of in-flight streams, keyed by the WebView's stream id.
/// A cancel that lands before the stream registers leaves a cancelled token
/// behind, which the stream then picks up and stops on immediately.
static STREAM_CANCELS: LazyLock<Mutex<HashMap<String, CancellationToken>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn stream_token(stream_id: &str) -> CancellationToken {
    let mut map = STREAM_CANCELS.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(stream_id.to_string()).or_default().clone()
}

fn release_stream_token(stream_id: &str) {
    let mut map = STREAM_CANCELS.lock().unwrap_or_else(|e| e.into_inner());
    map.remove(stream_id);
}

fn validate_stream_id(stream_id: &str) -> Result<(), String> {
    if stream_id.is_empty()
        || stream_id.len() > MAX_STREAM_ID_BYTES
        || !stream_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid AI stream id".to_string());
    }
    Ok(())
}

/// Decodes a byte stream as UTF-8 without splitting characters that straddle
/// chunk boundaries. Invalid bytes become U+FFFD, as with `from_utf8_lossy`.
#[derive(Default)]
struct Utf8ChunkDecoder {
    pending: Vec<u8>,
}

impl Utf8ChunkDecoder {
    fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    return out;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    out.push_str(
                        std::str::from_utf8(&self.pending[..valid]).expect("validated prefix"),
                    );
                    match err.error_len() {
                        // Incomplete trailing sequence: wait for the next chunk.
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            self.pending.drain(..valid + bad);
                        }
                    }
                }
            }
        }
    }

    fn finish(&mut self) -> String {
        let rest = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        rest
    }
}

/// Transport errors keep a recognisable kind (timeout / connection) so the
/// WebView can tell a network blip, which it retries, from a provider error.
/// The URL and reqwest's source chain are left out of the message.
fn transport_error(err: &reqwest::Error, while_streaming: bool) -> String {
    let stage = if while_streaming {
        "AI provider stream"
    } else {
        "AI provider request"
    };
    if err.is_timeout() {
        format!("{stage} timed out")
    } else if err.is_connect() {
        format!("{stage} failed: connection error")
    } else {
        format!("{stage} failed: connection closed")
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderRequest {
    provider_id: String,
    provider_type: String,
    base_url: String,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearxngSearchRequest {
    base_url: String,
    username: String,
    query: String,
    #[serde(default = "default_page")]
    page: u16,
    #[serde(default)]
    language: Option<String>,
}

fn default_page() -> u16 {
    1
}

#[derive(Serialize)]
pub struct FetchResponse {
    ok: bool,
    status: u16,
    body: String,
}

fn stream_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(STREAM_CONNECT_TIMEOUT_SECS))
        .read_timeout(std::time::Duration::from_secs(STREAM_IDLE_TIMEOUT_SECS))
        // Never forward a broker-injected credential through an HTTP redirect.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "failed to initialize HTTP client".to_string())
}

fn client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        // Never forward a broker-injected credential through an HTTP redirect.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "failed to initialize HTTP client".to_string())
}

fn append_path(base: &str, suffix: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base).map_err(|_| "invalid service URL".to_string())?;
    let path = url.path().trim_end_matches('/');
    url.set_path(&format!("{path}{suffix}"));
    Ok(url)
}

fn openai_url(base: &str, endpoint: &str) -> Result<reqwest::Url, String> {
    let base_path = reqwest::Url::parse(base)
        .map_err(|_| "invalid service URL".to_string())?
        .path()
        .trim_end_matches('/')
        .to_string();
    let has_version = base_path.rsplit('/').next().is_some_and(|part| {
        part.strip_prefix('v')
            .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
    });
    append_path(
        base,
        &format!("{}{endpoint}", if has_version { "" } else { "/v1" }),
    )
}

fn validated_binding(request: &AiProviderRequest) -> Result<(String, Option<String>), String> {
    let base = canonical_service_base(&request.base_url)?;
    let secret = provider_secret(&request.provider_id, &request.provider_type, &base)?;
    if matches!(request.provider_type.as_str(), "anthropic" | "gemini") && secret.is_none() {
        return Err("AI provider credential is not configured".to_string());
    }
    Ok((base, secret))
}

fn add_provider_auth(
    mut builder: reqwest::RequestBuilder,
    provider_type: &str,
    secret: Option<&str>,
) -> reqwest::RequestBuilder {
    match (provider_type, secret) {
        ("openai", Some(secret)) => builder = builder.bearer_auth(secret),
        ("anthropic", Some(secret)) => {
            builder = builder
                .header("x-api-key", secret)
                .header("anthropic-version", "2023-06-01");
        }
        ("gemini", Some(secret)) => builder = builder.header("x-goog-api-key", secret),
        _ => {}
    }
    builder
}

async fn bounded_text(mut response: reqwest::Response) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("HTTP response is too large".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "failed to read HTTP response".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("HTTP response is too large".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "HTTP response is not valid UTF-8".to_string())
}

fn model_url(request: &AiProviderRequest, base: &str) -> Result<reqwest::Url, String> {
    match request.provider_type.as_str() {
        "openai" => openai_url(base, "/models"),
        "anthropic" => append_path(base, "/v1/models"),
        "gemini" => append_path(base, "/v1beta/models"),
        _ => Err("invalid AI provider type".to_string()),
    }
}

fn stream_url(request: &AiProviderRequest, base: &str) -> Result<reqwest::Url, String> {
    match request.provider_type.as_str() {
        "openai" => openai_url(base, "/chat/completions"),
        "anthropic" => append_path(base, "/v1/messages"),
        "gemini" => {
            let model = request
                .model
                .as_deref()
                .ok_or_else(|| "Gemini model is required".to_string())?;
            if model.is_empty()
                || model.len() > MAX_MODEL_BYTES
                || model.chars().any(char::is_control)
                || model == "."
                || model == ".."
            {
                return Err("invalid Gemini model".to_string());
            }
            let mut url = append_path(base, "/v1beta/models")?;
            url.path_segments_mut()
                .map_err(|_| "invalid Gemini service URL".to_string())?
                .push(model)
                .push(":streamGenerateContent");
            // url::Url encodes ':' at the start of a segment. Gemini expects
            // the action suffix on the model segment, so restore only that
            // fixed delimiter after the model itself has been escaped.
            let path = url
                .path()
                .replace("/%3AstreamGenerateContent", ":streamGenerateContent");
            url.set_path(&path);
            url.query_pairs_mut().append_pair("alt", "sse");
            Ok(url)
        }
        _ => Err("invalid AI provider type".to_string()),
    }
}

/// Fixed-operation model-list broker. The WebView supplies provider metadata,
/// never an Authorization header or saved secret.
#[tauri::command]
pub async fn fetch_ai_models(
    window: tauri::WebviewWindow,
    request: AiProviderRequest,
) -> Result<FetchResponse, String> {
    require_ai_settings_window(&window)?;
    let (base, secret) = validated_binding(&request)?;
    let url = model_url(&request, &base)?;
    let builder = add_provider_auth(
        client(15)?.get(url),
        &request.provider_type,
        secret.as_deref(),
    );
    let response = builder
        .send()
        .await
        .map_err(|_| "AI provider request failed".to_string())?;
    let status = response.status().as_u16();
    let body = bounded_text(response).await?;
    Ok(FetchResponse {
        ok: (200..300).contains(&status),
        status,
        body,
    })
}

/// Fixed-operation SearXNG broker. Query parameters are encoded natively and
/// Basic authentication is assembled only after authority validation.
#[tauri::command]
pub async fn fetch_searxng_search(
    window: tauri::WebviewWindow,
    request: SearxngSearchRequest,
) -> Result<FetchResponse, String> {
    require_ai_settings_window(&window)?;
    if request.query.is_empty() || request.query.len() > MAX_SEARCH_QUERY_BYTES {
        return Err("invalid SearXNG query".to_string());
    }
    if request.page == 0 || request.page > 1_000 {
        return Err("invalid SearXNG page".to_string());
    }
    if request
        .language
        .as_deref()
        .is_some_and(|value| value.len() > 32 || value.chars().any(char::is_control))
    {
        return Err("invalid SearXNG language".to_string());
    }
    let base = confidential_service_base(&request.base_url)?;
    let password = searxng_password(&base, &request.username)?;
    let mut url = append_path(&base, "/search")?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("q", &request.query);
        pairs.append_pair("format", "json");
        pairs.append_pair("pageno", &request.page.to_string());
        if let Some(language) = request
            .language
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            pairs.append_pair("language", language);
        }
    }
    let mut builder = client(15)?.get(url);
    if let Some(password) = password {
        if request.username.is_empty() {
            return Err("SearXNG username is required for saved authentication".to_string());
        }
        builder = builder.basic_auth(&request.username, Some(password));
    }
    let response = builder
        .send()
        .await
        .map_err(|_| "SearXNG request failed".to_string())?;
    let status = response.status().as_u16();
    let body = bounded_text(response).await?;
    Ok(FetchResponse {
        ok: (200..300).contains(&status),
        status,
        body,
    })
}

/// Fixed-operation AI streaming broker. Only the provider's chat/generation
/// endpoint can receive the authority-bound credential.
#[tauri::command]
pub async fn fetch_ai_stream(
    window: tauri::WebviewWindow,
    request: AiProviderRequest,
    body: String,
    stream_id: String,
    on_event: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    require_ai_settings_window(&window)?;
    validate_stream_id(&stream_id)?;
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err("AI request body is too large".to_string());
    }
    let (base, secret) = validated_binding(&request)?;
    confidential_service_base(&base)?;
    let url = stream_url(&request, &base)?;
    let builder = add_provider_auth(
        stream_client()?
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body),
        &request.provider_type,
        secret.as_deref(),
    );

    let cancel = stream_token(&stream_id);
    // Dropping the in-flight request when the user stops closes the provider
    // connection, so generation (and billing) stops with it.
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("AbortError".to_string()),
        result = relay_stream(builder, &on_event) => result,
    };
    release_stream_token(&stream_id);
    result
}

async fn relay_stream(
    builder: reqwest::RequestBuilder,
    on_event: &tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let mut response = builder
        .send()
        .await
        .map_err(|e| transport_error(&e, false))?;
    let status = response.status().as_u16();

    if !(200..300).contains(&status) {
        let body = bounded_text(response).await.unwrap_or_default();
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("HTTP {status}: {snippet}"));
    }

    let mut decoder = Utf8ChunkDecoder::default();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| transport_error(&e, true))?
    {
        let text = decoder.push(&chunk);
        if !text.is_empty() && on_event.send(text).is_err() {
            return Ok(());
        }
    }
    let rest = decoder.finish();
    if !rest.is_empty() {
        let _ = on_event.send(rest);
    }
    Ok(())
}

/// Stops an in-flight `fetch_ai_stream` and drops its provider request.
#[tauri::command]
pub fn cancel_ai_stream(window: tauri::WebviewWindow, stream_id: String) -> Result<(), String> {
    require_ai_settings_window(&window)?;
    validate_stream_id(&stream_id)?;
    stream_token(&stream_id).cancel();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(provider_type: &str, base_url: &str) -> AiProviderRequest {
        AiProviderRequest {
            provider_id: "test".to_string(),
            provider_type: provider_type.to_string(),
            base_url: base_url.to_string(),
            model: Some("gemini/test model".to_string()),
        }
    }

    #[test]
    fn utf8_decoder_keeps_characters_split_across_chunks() {
        let text = "data: 你好，世界 🎉\n";
        let bytes = text.as_bytes();
        for split in 0..=bytes.len() {
            let mut decoder = Utf8ChunkDecoder::default();
            let mut out = decoder.push(&bytes[..split]);
            out.push_str(&decoder.push(&bytes[split..]));
            out.push_str(&decoder.finish());
            assert_eq!(out, text, "split at {split}");
        }
        let mut decoder = Utf8ChunkDecoder::default();
        let out: String = bytes.iter().map(|b| decoder.push(&[*b])).collect();
        assert_eq!(out + &decoder.finish(), text);
    }

    #[test]
    fn utf8_decoder_replaces_invalid_bytes_and_flushes_a_truncated_tail() {
        let mut decoder = Utf8ChunkDecoder::default();
        assert_eq!(decoder.push(b"a\xffb"), "a\u{FFFD}b");
        assert_eq!(decoder.push("中".as_bytes().get(..2).unwrap()), "");
        assert_eq!(decoder.finish(), "\u{FFFD}");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn stream_ids_are_bounded_tokens() {
        assert!(validate_stream_id("3f2b-41aa_9").is_ok());
        assert!(validate_stream_id("").is_err());
        assert!(validate_stream_id("a/b").is_err());
        assert!(validate_stream_id(&"a".repeat(MAX_STREAM_ID_BYTES + 1)).is_err());
    }

    #[test]
    fn a_cancel_before_the_stream_registers_still_stops_it() {
        let id = "cancel-before-register";
        stream_token(id).cancel();
        assert!(stream_token(id).is_cancelled());
        release_stream_token(id);
        assert!(!stream_token(id).is_cancelled());
        release_stream_token(id);
    }

    #[test]
    fn provider_urls_are_fixed_operations() {
        assert_eq!(
            model_url(
                &request("openai", "https://example.com/openai"),
                "https://example.com/openai"
            )
            .unwrap()
            .as_str(),
            "https://example.com/openai/v1/models"
        );
        assert_eq!(
            stream_url(
                &request("anthropic", "https://example.com"),
                "https://example.com"
            )
            .unwrap()
            .as_str(),
            "https://example.com/v1/messages"
        );
    }

    #[test]
    fn openai_existing_version_is_not_duplicated() {
        assert_eq!(
            openai_url("https://example.com/api/v4", "/models")
                .unwrap()
                .as_str(),
            "https://example.com/api/v4/models"
        );
    }
}
