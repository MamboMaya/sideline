//! `classify_local`/`classifier_health`: the local-provider half of the
//! classifier feature (see src/lib/classify.ts for the claude-provider half
//! and the tag-decision logic — this module only speaks HTTP). Every call
//! is restricted to loopback hosts by `validate_url` (notes never leave the
//! machine): the frontend already validates a URL before it's saved to
//! `.sideline.json`, but that's a UI courtesy, not a security boundary — the
//! real one is here, since these two commands are what actually make the
//! network request.
//!
//! reqwest's `json` Cargo feature isn't enabled (see Cargo.toml), so request/
//! response bodies are built/parsed by hand with `serde_json` instead of the
//! `.json()` convenience methods, to avoid adding a dependency for this.

use std::time::Duration;

use reqwest::Url;

/// Parses `url` and rejects anything that isn't a plain http/https request
/// to a loopback host (127.0.0.1, localhost, or the IPv6 loopback `::1`,
/// with or without the `[...]` brackets the URL syntax wraps IPv6 hosts in).
/// This is the one thing standing between the classifier feature and a note
/// body leaving the machine, so it's deliberately strict: anything it can't
/// positively confirm is loopback is rejected, not just anything obviously
/// remote.
fn validate_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|e| format!("invalid classifier URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("classifier URL must be http or https, got {other}")),
    }
    let host = parsed
        .host_str()
        .ok_or("classifier URL has no host")?
        .trim_start_matches('[')
        .trim_end_matches(']');
    if host == "127.0.0.1" || host == "localhost" || host == "::1" {
        Ok(parsed)
    } else {
        Err(format!(
            "classifier URL must point at 127.0.0.1, localhost, or ::1 (got {host})"
        ))
    }
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())
}

/// Posts `payload` as JSON to `<url>/decide` and returns the parsed JSON
/// response — see docs/backend.md for the exact request/response shape this
/// is expected to speak. `url` is the base classifier URL from
/// `.sideline.json`'s `classifier.url` (e.g. `http://127.0.0.1:4410`), not
/// the full `/decide` path.
#[tauri::command]
pub(crate) async fn classify_local(
    url: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = validate_url(&url)?;
        let decide = base
            .join("/decide")
            .map_err(|e| format!("invalid classifier URL: {e}"))?;
        let body = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        let resp = client()?
            .post(decide)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .map_err(|e| format!("classifier unreachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("classifier returned HTTP {}", resp.status()));
        }
        let text = resp.text().map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| format!("bad classifier response: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Settings pane's "Test" button: a bare `GET <url>/healthz`, success iff the
/// response status is 2xx. Same loopback-only validation as classify_local.
#[tauri::command]
pub(crate) async fn classifier_health(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = validate_url(&url)?;
        let healthz = base
            .join("/healthz")
            .map_err(|e| format!("invalid classifier URL: {e}"))?;
        let resp = client()?
            .get(healthz)
            .send()
            .map_err(|e| format!("classifier unreachable: {e}"))?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(format!("classifier returned HTTP {}", resp.status()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::validate_url;

    #[test]
    fn accepts_127_0_0_1() {
        assert!(validate_url("http://127.0.0.1:4410").is_ok());
    }

    #[test]
    fn accepts_localhost() {
        assert!(validate_url("http://localhost:4410").is_ok());
    }

    #[test]
    fn accepts_https() {
        assert!(validate_url("https://127.0.0.1:4410").is_ok());
    }

    #[test]
    fn accepts_ipv6_loopback() {
        assert!(validate_url("http://[::1]:4410").is_ok());
    }

    #[test]
    fn rejects_non_loopback_host() {
        assert!(validate_url("http://example.com:4410").is_err());
        assert!(validate_url("http://192.168.1.5:4410").is_err());
    }

    #[test]
    fn rejects_non_http_scheme() {
        assert!(validate_url("ftp://127.0.0.1:4410").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn rejects_malformed_url() {
        assert!(validate_url("not a url").is_err());
        assert!(validate_url("").is_err());
    }
}
