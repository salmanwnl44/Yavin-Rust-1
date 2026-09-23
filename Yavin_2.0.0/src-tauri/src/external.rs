//! Handing a URL to the OS's default browser.
//!
//! Started life inside `git.rs` for the commit view's "Open on GitHub" link. The terminal
//! needs the same thing for links it detects in shell output, and two copies of a security
//! check is one copy too many -- so it lives here, with one command both callers use.

use std::process::Command;

/// Whether a URL may be handed to the OS launcher.
///
/// The URLs reaching this are not typed by the user: one comes from `git remote get-url`,
/// i.e. from repository content, and the other from whatever a program printed into the
/// terminal. So "it starts with https://" is not on its own enough. The launchers below are
/// not shells, but `explorer.exe` in particular does not follow the usual argument quoting
/// and has historically split its argument on commas -- which would let one crafted URL open
/// a *second* target such as a UNC path (`\\host\share\x.exe`, an NTLM leak or a program
/// launch). Whitespace, quotes, backslashes and commas have no business in a web URL, so all
/// of them are refused rather than escaped.
pub fn is_openable_web_url(url: &str) -> bool {
    const MAX_URL: usize = 2048;
    // `https` anywhere, and `http` only to the loopback address. A local dev server is
    // almost never served over TLS, and the Ports view exists to open exactly those -- but
    // plain http to an arbitrary host is the case worth refusing, so the exception is
    // confined to the one host that cannot be somebody else's machine.
    let rest = match url.strip_prefix("https://") {
        Some(rest) => rest,
        None => match url.strip_prefix("http://") {
            Some(rest) if is_loopback(rest) => rest,
            _ => return false,
        },
    };
    if url.len() > MAX_URL || rest.is_empty() {
        return false;
    }
    if url
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '\\' | ',' | '"' | '\'' | '|'))
    {
        return false;
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or("");
    !host.is_empty() && !host.starts_with('-')
}

/// Whether the authority names this machine's loopback interface, and nothing else. Compared
/// against the whole host so `localhost.evil.test` is not mistaken for `localhost`.
fn is_loopback(rest: &str) -> bool {
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host
        .strip_prefix('[')
        .map_or(host, |bracketed| bracketed.split(']').next().unwrap_or(""));
    let host = if host.starts_with("::") {
        host
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

pub fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // `explorer` treats an http(s) argument as "open this URL in the default browser" --
        // the same mechanism `reveal_in_os_explorer` already relies on for opening a path.
        Command::new("explorer")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    if !is_openable_web_url(&url) {
        return Err("Only a plain https:// URL may be opened".into());
    }
    tauri::async_runtime::spawn_blocking(move || open_in_browser(&url))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_plain_https_url_can_be_handed_to_the_os_browser_launcher() {
        for good in [
            "https://github.com/owner/repo/commit/abc123",
            "https://git.example.com:8443/o/r/commit/abc",
            "https://host.test/path?query=1#frag",
            "https://localhost:5173/",
        ] {
            assert!(is_openable_web_url(good), "should be openable: {good}");
        }
        // Plain http is allowed to the loopback address only, so the Ports view can open a
        // local dev server -- which is essentially never served over TLS.
        for good in [
            "http://localhost:5173/",
            "http://127.0.0.1:8080",
            "http://[::1]:3000/path",
        ] {
            assert!(is_openable_web_url(good), "loopback http: {good}");
        }
        for bad in [
            "",
            "http://github.com/x",
            // Not loopback, however much the name looks like it.
            "http://localhost.evil.test/x",
            "http://127.0.0.1.evil.test/x",
            "http://evil.test/?x=localhost",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://",
            // explorer.exe has historically split on commas, which would open a second,
            // attacker-chosen target -- here a UNC path (NTLM leak / program launch).
            "https://ok.test/x,\\\\10.0.0.1\\share\\evil.exe",
            "https://ok.test/x\\..\\..\\evil",
            "https://ok.test/a b",
            "https://ok.test/x\nhttps://evil.test",
            "https://ok.test/\"quoted\"",
            "https://-badhost/x",
        ] {
            assert!(!is_openable_web_url(bad), "should be refused: {bad}");
        }
        // Length is bounded so a pathological URL cannot be handed to the launcher.
        assert!(!is_openable_web_url(&format!(
            "https://ok.test/{}",
            "a".repeat(4096)
        )));
    }
}
