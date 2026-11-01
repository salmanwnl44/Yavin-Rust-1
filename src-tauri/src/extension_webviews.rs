//! Extension webviews (EXT-31): the HTML an extension shows in a panel, served natively from its
//! own origin to an isolated frame in the window -- never rendered as Yavin's markup, never given
//! Yavin's services.
//!
//! **Why native.** On Windows, WebView2 adds the application's initialization scripts -- Tauri's
//! IPC bridge and its invoke key among them -- to every frame, whatever Tauri asks (wry's
//! documentation of `for_main_frame_only`; measured in the packaged application: the frame has
//! `__TAURI_INTERNALS__` and `chrome.webview`). A webview's frame therefore holds that script. It
//! must not be able to use it, so every channel is closed, each by more than one thing:
//!
//! - **An origin Tauri does not know.** Webview content is `https://yavin-webview.invalid/`,
//!   served by this module's own WebView2 interception (`attach`) -- not a Tauri custom protocol,
//!   which Tauri counts as a *local* origin, allowed every application command. To Tauri this
//!   origin is remote: its IPC refuses application commands from it (no capability grants a
//!   remote origin anything). `.invalid` never resolves: if the interception were missing,
//!   nothing would load.
//! - **Tauri's channels.** Its IPC over its own protocol (`http://ipc.localhost`) is blocked by
//!   the page's policy (`connect-src 'none'`), and refused anyway: a sandboxed frame's `Origin`
//!   is `null`. Its fallback, `chrome.webview.postMessage`, is delivered by WebView2 to the
//!   frame's own event, which nothing handles, not to Tauri's (measured: a frame's
//!   `extensions_webview_close` for its own page never ran).
//! - **The frame.** It is `<iframe sandbox="allow-scripts">`
//!   (`components/extensions/ExtensionWebview.tsx`): an opaque origin, no storage, no popups, no
//!   top navigation, no forms.
//! - **Policy.** Every page is served with a Content Security Policy header (`csp`): nothing
//!   from the network (`connect-src 'none'`: no fetch, XMLHttpRequest, WebSocket or beacon, so
//!   not Tauri's IPC either), scripts, styles, images, fonts and media only from the webview
//!   origin (and `data:`/`blob:` for images, fonts and media), no frames, objects, forms or
//!   `<base>`. An extension's own CSP can only narrow it.
//! - **Navigation.** A frame may navigate only to a live webview's own page: every other frame
//!   navigation in the window is cancelled (`FrameNavigationStarting`, `attach`), and the window's
//!   own policy allows frames only from the webview origin (`frame-src`), so a webview cannot
//!   become a remote page. Yavin has no other frames (its Markdown views forbid them).
//! - **Ownership.** A panel's token (32 random hex digits, made by the extension's layer from the
//!   OS's random source) is bound here, once, to the window and the extension that registered it.
//!   Its page and files are served only to that window, and its files come only from that
//!   extension's verified copy (`ExtensionService::host_copy`), inside the resource roots it
//!   declared -- never the workspace, never anything outside the copy.
//!
//! What runs in the frame besides the extension's HTML is `webview_bootstrap.js`:
//! `acquireVsCodeApi()` (postMessage, getState, setState) speaking to the window by
//! `postMessage`, and links that do not navigate. The window relays messages, bounded, to the
//! extension that owns the panel (`services/extensions/webviews.ts`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{Request, Response, StatusCode};

/// The webview origin, as the window's frames and the extension's layer name it. Served by
/// `attach` -- never a Tauri custom protocol (see the module's documentation).
pub const ORIGIN: &str = "https://yavin-webview.invalid";

/// Bounds: what one window may hold, and how large each part may be.
pub const MAX_PANELS: usize = 32;
pub const MAX_HTML: usize = 4 * 1024 * 1024;
pub const MAX_STATE: usize = 256 * 1024;
pub const MAX_ROOTS: usize = 16;
/// The largest file served to a webview (an image, a script bundle, a font).
pub const MAX_RESOURCE: u64 = 16 * 1024 * 1024;

const BOOTSTRAP: &str = include_str!("webview_bootstrap.js");

/// One panel's page, as its window registered it.
#[derive(Debug, Clone)]
struct Panel {
    window: String,
    extension: String,
    html: String,
    state: Option<String>,
    scripts: bool,
    /// Folders inside the copy its files may come from (`/`-separated, relative; `""`: all).
    roots: Vec<String>,
    copy: PathBuf,
}

#[derive(Default)]
pub struct Webviews {
    panels: Mutex<HashMap<String, Panel>>,
    /// Webviews whose frames are guarded and served (`attach`), by label.
    guarded: Mutex<std::collections::HashSet<String>>,
}

/// A panel's token: exactly 32 lowercase hex digits.
pub fn token_ok(token: &str) -> bool {
    token.len() == 32
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A resource root or path inside the copy: `/`-separated components, none empty, `.`, `..`,
/// with a drive, a colon, a backslash or a control character. `""` is the copy itself.
pub fn relative_ok(path: &str) -> bool {
    if path.is_empty() {
        return true;
    }
    path.len() <= 400
        && !path.starts_with('/')
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.contains(':')
                && !part.contains('\\')
                && !part.chars().any(char::is_control)
        })
}

impl Webviews {
    /// Binds `token` to `window` and `extension`, whose verified copy is `copy`. Refused: a
    /// malformed token, one already bound (by anyone), too many panels in the window, or a
    /// malformed or oversized part.
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &self,
        window: &str,
        token: &str,
        extension: &str,
        copy: PathBuf,
        html: String,
        state: Option<String>,
        scripts: bool,
        roots: Vec<String>,
    ) -> Result<(), String> {
        if !token_ok(token) {
            return Err("InvalidRequest: a webview's token is 32 hexadecimal digits.".into());
        }
        check_parts(Some(&html), state.as_deref())?;
        if roots.len() > MAX_ROOTS || !roots.iter().all(|r| relative_ok(r)) {
            return Err(format!(
                "InvalidRequest: at most {MAX_ROOTS} resource roots, each a folder inside the extension."
            ));
        }
        let mut panels = self.panels.lock().map_err(|_| "WebviewFailed: poisoned")?;
        if panels.contains_key(token) {
            return Err("InvalidRequest: that webview token is already in use.".into());
        }
        if panels.values().filter(|p| p.window == window).count() >= MAX_PANELS {
            return Err(format!(
                "TooMany: at most {MAX_PANELS} webviews in a window."
            ));
        }
        panels.insert(
            token.to_string(),
            Panel {
                window: window.to_string(),
                extension: extension.to_string(),
                html,
                state,
                scripts,
                roots,
                copy,
            },
        );
        Ok(())
    }

    /// Changes a panel's page, saved state, scripts or resource roots -- only from its own window.
    pub fn update(
        &self,
        window: &str,
        token: &str,
        html: Option<String>,
        state: Option<Option<String>>,
        scripts: Option<bool>,
        roots: Option<Vec<String>>,
    ) -> Result<(), String> {
        check_parts(html.as_ref(), state.as_ref().and_then(|s| s.as_deref()))?;
        if roots
            .as_ref()
            .is_some_and(|r| r.len() > MAX_ROOTS || !r.iter().all(|x| relative_ok(x)))
        {
            return Err(format!(
                "InvalidRequest: at most {MAX_ROOTS} resource roots, each a folder inside the extension."
            ));
        }
        let mut panels = self.panels.lock().map_err(|_| "WebviewFailed: poisoned")?;
        let panel = panels
            .get_mut(token)
            .filter(|p| p.window == window)
            .ok_or("UnknownWebview: no such webview in this window.")?;
        if let Some(html) = html {
            panel.html = html;
        }
        if let Some(state) = state {
            panel.state = state;
        }
        if let Some(scripts) = scripts {
            panel.scripts = scripts;
        }
        if let Some(roots) = roots {
            panel.roots = roots;
        }
        Ok(())
    }

    /// Forgets a panel -- only from its own window. Forgetting one already gone is not an error.
    pub fn close(&self, window: &str, token: &str) {
        if let Ok(mut panels) = self.panels.lock() {
            if panels.get(token).is_some_and(|p| p.window == window) {
                panels.remove(token);
            }
        }
    }

    /// Forgets every panel of `window` (its page loaded again, or it closed), or of one extension
    /// in it.
    pub fn close_all(&self, window: &str, extension: Option<&str>) {
        if let Ok(mut panels) = self.panels.lock() {
            panels.retain(|_, p| p.window != window || extension.is_some_and(|e| e != p.extension));
        }
    }

    /// Whether `uri` is a page of a live panel: the only frame navigation allowed in a window.
    pub fn navigation_allowed(&self, uri: &str) -> bool {
        if uri == "about:blank" || uri == "about:srcdoc" {
            return true;
        }
        let Some(rest) = uri.strip_prefix(ORIGIN).and_then(|r| r.strip_prefix('/')) else {
            return false;
        };
        let token = rest.split(['/', '?', '#']).next().unwrap_or("");
        let page = &rest[token.len()..];
        token_ok(token)
            && (page == "/index.html"
                || page.starts_with("/index.html?")
                || page.starts_with("/index.html#"))
            && self
                .panels
                .lock()
                .map(|p| p.contains_key(token))
                .unwrap_or(false)
    }

    /// Whether `window` still needs its frame guard (true once per webview, until it closes).
    pub fn needs_guard(&self, window: &str) -> bool {
        self.guarded
            .lock()
            .map(|mut g| g.insert(window.to_string()))
            .unwrap_or(false)
    }

    /// A window closed: its panels and its guard go.
    pub fn window_closed(&self, window: &str) {
        self.close_all(window, None);
        if let Ok(mut g) = self.guarded.lock() {
            g.remove(window);
        }
    }

    #[cfg(test)]
    pub fn count(&self, window: &str) -> usize {
        self.panels
            .lock()
            .map(|p| p.values().filter(|x| x.window == window).count())
            .unwrap_or(0)
    }

    /// Answers a request for the webview origin from the webview labelled `window`.
    pub fn respond(&self, window: &str, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        if request.uri().scheme_str() != Some("https")
            || request.uri().host() != Some("yavin-webview.invalid")
            || request.method() != tauri::http::Method::GET
        {
            return plain(StatusCode::NOT_FOUND, "not found");
        }
        let path = request.uri().path().to_string();
        let mut parts = path.trim_start_matches('/').splitn(2, '/');
        let token = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        let panel = match self.panels.lock() {
            Ok(panels) if token_ok(token) => panels.get(token).cloned(),
            _ => None,
        };
        // Another window's panel is no panel here.
        let Some(panel) = panel.filter(|p| p.window == window) else {
            return plain(StatusCode::NOT_FOUND, "no such webview");
        };
        if rest == "index.html" {
            return page(&panel, token);
        }
        if let Some(file) = rest.strip_prefix("res/") {
            return resource(&panel, file);
        }
        plain(StatusCode::NOT_FOUND, "not found")
    }
}

fn check_parts(html: Option<&String>, state: Option<&str>) -> Result<(), String> {
    if html.is_some_and(|h| h.len() > MAX_HTML) {
        return Err(format!(
            "TooLarge: a webview's HTML is at most {} MiB.",
            MAX_HTML / 1024 / 1024
        ));
    }
    if let Some(state) = state {
        if state.len() > MAX_STATE {
            return Err(format!(
                "TooLarge: a webview's state is at most {} KiB.",
                MAX_STATE / 1024
            ));
        }
        if serde_json::from_str::<serde_json::Value>(state).is_err() {
            return Err("InvalidRequest: a webview's state is JSON.".into());
        }
    }
    Ok(())
}

/// The policy every webview page is served with. Scripts only when the panel enables them; the
/// extension's own policy (a `<meta>` in its HTML) can only narrow this one.
pub fn csp(scripts: bool) -> String {
    let script = if scripts {
        format!("script-src {ORIGIN} 'unsafe-inline'")
    } else {
        "script-src 'none'".into()
    };
    format!(
        "default-src 'none'; {script}; style-src {ORIGIN} 'unsafe-inline'; img-src {ORIGIN} data: blob:; \
         font-src {ORIGIN} data:; media-src {ORIGIN} data: blob:; connect-src 'none'; frame-src 'none'; \
         child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
    )
}

/// The panel's HTML with the bootstrap first: before any of the extension's own `<meta>`
/// policies (a policy in a `<meta>` applies only to what follows it), after the doctype.
pub fn with_bootstrap(html: &str, state: Option<&str>, scripts: bool) -> String {
    if !scripts {
        return html.to_string();
    }
    // The state as a JSON string literal inside the script: `</script>` cannot close it early.
    let state = state.unwrap_or("null").replace('<', "\\u003c");
    let script = format!(
        "<script>{}</script>",
        BOOTSTRAP.replace("__YAVIN_WEBVIEW_STATE__", &state)
    );
    let lower = html.to_ascii_lowercase();
    let after = |tag: &str| -> Option<usize> {
        let start = lower.find(tag)?;
        let close = lower[start..].find('>')?;
        Some(start + close + 1)
    };
    // `<head` but not `<header`.
    let head = lower
        .match_indices("<head")
        .find(|(at, _)| {
            lower[at + 5..]
                .chars()
                .next()
                .is_some_and(|c| c == '>' || c.is_whitespace())
        })
        .and_then(|(at, _)| lower[at..].find('>').map(|close| at + close + 1));
    let at = head
        .or_else(|| after("<html"))
        .or_else(|| after("<!doctype"))
        .unwrap_or(0);
    format!("{}{}{}", &html[..at], script, &html[at..])
}

fn page(panel: &Panel, _token: &str) -> Response<Vec<u8>> {
    let body = with_bootstrap(&panel.html, panel.state.as_deref(), panel.scripts);
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", csp(panel.scripts))
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(body.into_bytes())
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "webview"))
}

/// A file of the panel's extension: inside one of its roots, inside its verified copy, a plain
/// file (no link), at most `MAX_RESOURCE`.
fn resource(panel: &Panel, path: &str) -> Response<Vec<u8>> {
    match read_resource(&panel.copy, &panel.roots, path) {
        Ok((bytes, kind)) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", kind)
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .body(bytes)
            .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "webview")),
        Err(status) => plain(status, "not found"),
    }
}

/// Percent-decodes a URL path (a webview's `asWebviewUri` encodes each segment).
fn decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn read_resource(
    copy: &Path,
    roots: &[String],
    path: &str,
) -> Result<(Vec<u8>, &'static str), StatusCode> {
    let path = decode(path).ok_or(StatusCode::BAD_REQUEST)?;
    if !relative_ok(&path) || path.is_empty() {
        return Err(StatusCode::FORBIDDEN);
    }
    let inside_root = roots.is_empty()
        || roots
            .iter()
            .any(|root| root.is_empty() || path == *root || path.starts_with(&format!("{root}/")));
    if !inside_root {
        return Err(StatusCode::FORBIDDEN);
    }
    let base = copy.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
    let file = path
        .split('/')
        .fold(copy.to_path_buf(), |p, part| p.join(part));
    let meta = std::fs::symlink_metadata(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    if !meta.file_type().is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    if meta.len() > MAX_RESOURCE {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let real = file.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
    if !real.starts_with(&base) {
        return Err(StatusCode::FORBIDDEN);
    }
    let bytes = std::fs::read(&real).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((bytes, content_type(&path)))
}

/// A served file's type, by its extension; anything else is bytes (and `nosniff` keeps it so).
pub fn content_type(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    let extension = lower.rsplit('.').next().unwrap_or("");
    match extension {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn plain(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "no-store")
        .body(text.as_bytes().to_vec())
        .expect("a plain response")
}

/// Serves the webview origin to `webview` and guards its frames (Windows, WebView2): every
/// request for `ORIGIN` is answered by `Webviews::respond` for this webview's label, and every
/// frame navigation that is not to a live panel's page is cancelled. Installed once per webview.
#[cfg(windows)]
pub fn attach(webview: &tauri::Webview, app: tauri::AppHandle) {
    use std::fmt::Write as _;
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
    };
    use webview2_com::{
        take_pwstr, NavigationStartingEventHandler, WebResourceRequestedEventHandler,
    };
    use windows::core::{Interface, HSTRING, PWSTR};
    use windows::Win32::UI::Shell::SHCreateMemStream;
    let label = webview.label().to_string();
    let _ = webview.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let env = platform.environment();
        // Frames may navigate only to a live panel's page.
        let guard_app = app.clone();
        let guard = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            if !guard_app.state::<Webviews>().navigation_allowed(&uri) {
                args.SetCancel(true)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_FrameNavigationStarting(&guard, &mut token);
        // The webview origin, for frames too (the newer filter covers every request source).
        let filter = HSTRING::from(format!("{ORIGIN}/*"));
        let added = match core.cast::<ICoreWebView2_22>() {
            Ok(core22) => core22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                &filter,
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            ),
            Err(_) => {
                core.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
            }
        };
        if added.is_err() {
            return;
        }
        let serve = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let request = args.Request()?;
            let mut uri = PWSTR::null();
            request.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            if !uri.starts_with(&format!("{ORIGIN}/")) {
                return Ok(());
            }
            let mut method = PWSTR::null();
            request.Method(&mut method)?;
            let method = take_pwstr(method);
            let answer = match Request::builder()
                .method(method.as_str())
                .uri(uri.as_str())
                .body(Vec::new())
            {
                Ok(request) => app.state::<Webviews>().respond(&label, &request),
                Err(_) => plain(StatusCode::BAD_REQUEST, "bad request"),
            };
            let mut headers = String::new();
            for (name, value) in answer.headers() {
                if let Ok(value) = value.to_str() {
                    let _ = writeln!(headers, "{name}: {value}");
                }
            }
            let status = answer.status();
            let stream = if answer.body().is_empty() {
                None
            } else {
                SHCreateMemStream(Some(answer.body()))
            };
            let response = env.CreateWebResourceResponse(
                stream.as_ref(),
                status.as_u16() as i32,
                &HSTRING::from(status.canonical_reason().unwrap_or("OK")),
                &HSTRING::from(headers),
            )?;
            args.SetResponse(&response)?;
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_WebResourceRequested(&serve, &mut token);
    });
}

#[cfg(not(windows))]
pub fn attach(_webview: &tauri::Webview, _app: tauri::AppHandle) {}

// --- Commands (the window's) ----------------------------------------------------------------------

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn extensions_webview_open(
    webview: tauri::Webview,
    service: tauri::State<'_, crate::extension_service::ExtensionService>,
    webviews: tauri::State<'_, Webviews>,
    token: String,
    extension_id: String,
    html: String,
    state: Option<String>,
    scripts: bool,
    roots: Vec<String>,
) -> Result<String, String> {
    // Only an extension whose code runs -- its verified copy -- shows a webview, and its files
    // come only from that copy.
    let copy = service.host_copy(&extension_id)?;
    webviews.open(
        webview.label(),
        &token,
        &copy.id,
        PathBuf::from(copy.folder),
        html,
        state,
        scripts,
        roots,
    )?;
    Ok(format!("{ORIGIN}/{token}/index.html"))
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn extensions_webview_update(
    webview: tauri::Webview,
    webviews: tauri::State<'_, Webviews>,
    token: String,
    html: Option<String>,
    state: Option<String>,
    set_state: Option<bool>,
    scripts: Option<bool>,
    roots: Option<Vec<String>>,
) -> Result<(), String> {
    let state = set_state.unwrap_or(false).then_some(state);
    webviews.update(webview.label(), &token, html, state, scripts, roots)
}

#[tauri::command(async)]
pub fn extensions_webview_close(
    webview: tauri::Webview,
    webviews: tauri::State<'_, Webviews>,
    token: String,
) {
    webviews.close(webview.label(), &token);
}

#[cfg(test)]
#[path = "extension_webviews_tests.rs"]
mod tests;
