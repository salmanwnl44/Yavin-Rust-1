//! EXT-31: extension webviews -- tokens, paths, the policy, the page, files, ownership.

use super::*;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const OTHER: &str = "fedcba9876543210fedcba9876543210";

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("yavin-webview-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// An extension copy with a media folder, a script, and a secret beside the copy.
fn copy(name: &str) -> PathBuf {
    let dir = temp(name);
    let copy = dir.join("copy");
    std::fs::create_dir_all(copy.join("extension/media")).unwrap();
    std::fs::write(copy.join("extension/media/app.js"), "console.log(1)").unwrap();
    std::fs::write(copy.join("extension/media/logo.svg"), "<svg/>").unwrap();
    std::fs::write(copy.join("extension/package.json"), "{}").unwrap();
    std::fs::write(dir.join("secret.txt"), "outside the copy").unwrap();
    copy
}

fn request(path: &str) -> Request<Vec<u8>> {
    Request::builder()
        .uri(format!("{ORIGIN}{path}"))
        .body(Vec::new())
        .unwrap()
}

fn body(response: &Response<Vec<u8>>) -> String {
    String::from_utf8_lossy(response.body()).into_owned()
}

#[test]
fn tokens_and_relative_paths_are_strict() {
    assert!(token_ok(TOKEN));
    for bad in [
        "",
        "0123",
        &TOKEN.to_uppercase(),
        &format!("{TOKEN}0"),
        "0123456789abcdef0123456789abcdeg",
        "../3456789abcdef0123456789abcdef",
    ] {
        assert!(!token_ok(bad), "{bad}");
    }
    for ok in ["", "extension", "extension/media", "a.b/c-d_e"] {
        assert!(relative_ok(ok), "{ok}");
    }
    for bad in [
        "/extension",
        "extension/../..",
        "..",
        "a//b",
        "./a",
        "C:/Windows",
        "c:a",
        "a\\b",
        "a/\u{0}b",
        &"x".repeat(401),
    ] {
        assert!(!relative_ok(bad), "{bad}");
    }
}

#[test]
fn the_policy_allows_nothing_from_the_network_and_scripts_only_when_enabled() {
    let on = csp(true);
    for part in [
        "default-src 'none'",
        &format!("script-src {ORIGIN} 'unsafe-inline'"),
        "connect-src 'none'",
        "frame-src 'none'",
        "worker-src 'none'",
        "object-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        &format!("img-src {ORIGIN} data: blob:"),
    ] {
        assert!(on.contains(part), "{part}: {on}");
    }
    // No source wider than the webview origin: no scheme-wide or wildcard source anywhere.
    for source in on.split([' ', ';']).filter(|s| !s.is_empty()) {
        assert!(
            !matches!(source, "*" | "http:" | "https:" | "ws:" | "wss:") && !source.contains("*"),
            "{source}: {on}"
        );
    }
    assert!(!on.contains("unsafe-eval"));
    assert!(csp(false).contains("script-src 'none'"));
}

#[test]
fn the_bootstrap_comes_first_before_the_extensions_own_policy() {
    let html = r#"<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-abc'"><title>t</title></head><body><header>h</header></body></html>"#;
    let out = with_bootstrap(html, None, true);
    let script = out.find("<script>").unwrap();
    assert!(script > out.find("<head>").unwrap(), "inside <head>");
    assert!(
        script < out.find("<meta http-equiv").unwrap(),
        "before the extension's own policy, which applies only after it"
    );
    assert!(out.contains("acquireVsCodeApi"));
    assert!(out.ends_with("</body></html>"), "the rest unchanged");
    // `<header>` is not `<head>`; without a head, after `<html>`; without either, after the doctype.
    let no_head = with_bootstrap(
        "<!doctype html><html><body><header>x</header></body></html>",
        None,
        true,
    );
    assert!(no_head.find("<script>").unwrap() < no_head.find("<body>").unwrap());
    assert!(no_head.starts_with("<!doctype html><html><script>"));
    let bare = with_bootstrap("<!DOCTYPE html><p>hi</p>", None, true);
    assert!(bare.starts_with("<!DOCTYPE html><script>"), "{bare}");
    let fragment = with_bootstrap("<p>hi</p>", None, true);
    assert!(fragment.starts_with("<script>"));
    // Scripts off: the HTML as given, no bootstrap.
    assert_eq!(with_bootstrap(html, None, false), html);
}

#[test]
fn saved_state_cannot_close_the_bootstrap_script() {
    let state = r#"{"note":"</script><script>alert(1)</script>"}"#;
    let out = with_bootstrap("<html><head></head></html>", Some(state), true);
    assert_eq!(
        out.matches("</script>").count(),
        1,
        "only the bootstrap's own end"
    );
    assert!(out.contains(r#"\u003c/script>\u003cscript>alert(1)\u003c/script>"#));
    assert!(with_bootstrap("<html><head></head></html>", None, true).contains("let state = null;"));
}

#[test]
fn a_panel_is_bound_once_to_its_window_and_extension_and_bounded() {
    let webviews = Webviews::default();
    let c = copy("bind");
    let open = |window: &str, token: &str, html: String, state: Option<String>| {
        webviews.open(
            window,
            token,
            "acme.web",
            c.clone(),
            html,
            state,
            true,
            vec![],
        )
    };
    open("main", TOKEN, "<p>1</p>".into(), None).unwrap();
    let error = open("main", TOKEN, "<p>2</p>".into(), None).unwrap_err();
    assert!(error.contains("already in use"), "{error}");
    let error = open("other", TOKEN, "<p>2</p>".into(), None).unwrap_err();
    assert!(
        error.contains("already in use"),
        "another window cannot take it either"
    );
    assert!(open("main", "nope", String::new(), None)
        .unwrap_err()
        .contains("32 hexadecimal"));
    assert!(open("main", OTHER, "x".repeat(MAX_HTML + 1), None)
        .unwrap_err()
        .starts_with("TooLarge"));
    assert!(open(
        "main",
        OTHER,
        String::new(),
        Some("x".repeat(MAX_STATE + 1))
    )
    .unwrap_err()
    .starts_with("TooLarge"));
    assert!(open("main", OTHER, String::new(), Some("not json".into()))
        .unwrap_err()
        .contains("JSON"));
    let error = webviews
        .open(
            "main",
            OTHER,
            "acme.web",
            c.clone(),
            String::new(),
            None,
            true,
            vec!["../x".into()],
        )
        .unwrap_err();
    assert!(error.contains("resource roots"), "{error}");
    // Only its own window updates or closes it.
    assert!(webviews
        .update("other", TOKEN, Some("<p>x</p>".into()), None, None, None)
        .unwrap_err()
        .starts_with("UnknownWebview"));
    webviews.close("other", TOKEN);
    assert!(
        body(&webviews.respond("main", &request(&format!("/{TOKEN}/index.html"))))
            .contains("<p>1</p>")
    );
    webviews
        .update(
            "main",
            TOKEN,
            Some("<p>new</p>".into()),
            Some(Some(r#"{"n":1}"#.into())),
            None,
            None,
        )
        .unwrap();
    let page = body(&webviews.respond("main", &request(&format!("/{TOKEN}/index.html"))));
    assert!(page.contains("<p>new</p>") && page.contains(r#"let state = {"n":1};"#));
    // Scripts turned off later: no bootstrap, a policy with no scripts; roots narrowed later too.
    webviews
        .update(
            "main",
            TOKEN,
            None,
            None,
            Some(false),
            Some(vec!["extension/media".into()]),
        )
        .unwrap();
    let off = webviews.respond("main", &request(&format!("/{TOKEN}/index.html")));
    assert!(!body(&off).contains("acquireVsCodeApi"));
    assert!(off.headers()["Content-Security-Policy"]
        .to_str()
        .unwrap()
        .contains("script-src 'none'"));
    assert_eq!(
        webviews
            .respond(
                "main",
                &request(&format!("/{TOKEN}/res/extension/package.json"))
            )
            .status(),
        StatusCode::FORBIDDEN
    );
    assert!(webviews
        .update("main", TOKEN, None, None, None, Some(vec!["../out".into()]))
        .unwrap_err()
        .contains("resource roots"));
    assert!(page.contains("<p>new</p>") && page.contains(r#"let state = {"n":1};"#));
    webviews.close("main", TOKEN);
    assert_eq!(
        webviews
            .respond("main", &request(&format!("/{TOKEN}/index.html")))
            .status(),
        StatusCode::NOT_FOUND
    );
    // At most MAX_PANELS in a window; another window has its own count.
    for i in 0..MAX_PANELS {
        open("main", &format!("{i:032x}"), String::new(), None).unwrap();
    }
    let error = open("main", OTHER, String::new(), None).unwrap_err();
    assert!(error.starts_with("TooMany"), "{error}");
    open("second", OTHER, String::new(), None).unwrap();
    // An extension's panels go with it; a window's with it.
    webviews.close_all("main", Some("someone.else"));
    assert_eq!(webviews.count("main"), MAX_PANELS);
    webviews.close_all("main", Some("acme.web"));
    assert_eq!(webviews.count("main"), 0);
    webviews.window_closed("second");
    assert_eq!(webviews.count("second"), 0);
}

#[test]
fn a_page_is_served_only_to_its_window_with_its_policy() {
    let webviews = Webviews::default();
    let c = copy("serve");
    webviews
        .open(
            "main",
            TOKEN,
            "acme.web",
            c,
            "<html><head></head><body>hi</body></html>".into(),
            None,
            true,
            vec![],
        )
        .unwrap();
    let page = webviews.respond("main", &request(&format!("/{TOKEN}/index.html")));
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(page.headers()["Content-Security-Policy"], csp(true));
    assert_eq!(page.headers()["X-Content-Type-Options"], "nosniff");
    assert_eq!(page.headers()["Cache-Control"], "no-store");
    assert!(body(&page).contains("acquireVsCodeApi"));
    for (window, path) in [
        ("other", format!("/{TOKEN}/index.html")),
        ("main", format!("/{OTHER}/index.html")),
        ("main", "/not-a-token/index.html".to_string()),
        ("main", format!("/{TOKEN}/other.html")),
        ("main", format!("/{TOKEN}/")),
    ] {
        assert_eq!(
            webviews.respond(window, &request(&path)).status(),
            StatusCode::NOT_FOUND,
            "{window} {path}"
        );
    }
}

#[test]
fn files_come_only_from_inside_the_copy_and_its_roots() {
    let webviews = Webviews::default();
    let c = copy("files");
    webviews
        .open(
            "main",
            TOKEN,
            "acme.web",
            c.clone(),
            String::new(),
            None,
            true,
            vec!["extension/media".into()],
        )
        .unwrap();
    let get = |path: &str| webviews.respond("main", &request(&format!("/{TOKEN}/res/{path}")));
    let script = get("extension/media/app.js");
    assert_eq!(script.status(), StatusCode::OK);
    assert_eq!(
        script.headers()["Content-Type"],
        "text/javascript; charset=utf-8"
    );
    assert_eq!(body(&script), "console.log(1)");
    assert_eq!(
        get("extension/media/logo.svg").headers()["Content-Type"],
        "image/svg+xml"
    );
    assert_eq!(
        get("extension/media/log%6F.svg").status(),
        StatusCode::OK,
        "percent-encoded"
    );
    for (path, status) in [
        ("extension/package.json", StatusCode::FORBIDDEN),
        ("extension/media/../package.json", StatusCode::FORBIDDEN),
        ("extension/media/%2E%2E/package.json", StatusCode::FORBIDDEN),
        (
            "extension/media/..%2F..%2F..%2Fsecret.txt",
            StatusCode::FORBIDDEN,
        ),
        ("../secret.txt", StatusCode::FORBIDDEN),
        ("C:/Windows/win.ini", StatusCode::FORBIDDEN),
        ("extension/media\\app.js", StatusCode::FORBIDDEN),
        ("extension/media/missing.js", StatusCode::NOT_FOUND),
        ("extension/media", StatusCode::NOT_FOUND),
        ("extension/media/%zz", StatusCode::BAD_REQUEST),
    ] {
        assert_eq!(get(path).status(), status, "{path}");
    }
    // With no roots declared, the whole copy -- and still nothing outside it.
    let all = Webviews::default();
    all.open(
        "main",
        OTHER,
        "acme.web",
        c.clone(),
        String::new(),
        None,
        true,
        vec![],
    )
    .unwrap();
    let get = |path: &str| all.respond("main", &request(&format!("/{OTHER}/res/{path}")));
    assert_eq!(get("extension/package.json").status(), StatusCode::OK);
    assert_eq!(get("../secret.txt").status(), StatusCode::FORBIDDEN);
    // Larger than a webview's file may be: refused.
    std::fs::write(
        c.join("extension/big.bin"),
        vec![0u8; MAX_RESOURCE as usize + 1],
    )
    .unwrap();
    assert_eq!(
        get("extension/big.bin").status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[cfg(windows)]
#[test]
fn a_link_inside_the_copy_that_leads_out_of_it_is_not_followed() {
    let c = copy("link");
    let outside = c.parent().unwrap().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("x.txt"), "outside").unwrap();
    // A junction needs no privilege; if it cannot be made, there is nothing to check.
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(c.join("extension").join("out"))
        .arg(&outside)
        .output()
        .is_ok_and(|o| o.status.success());
    if !made {
        return;
    }
    let result = read_resource(&c, &[], "extension/out/x.txt");
    assert_eq!(result.err(), Some(StatusCode::FORBIDDEN));
}

#[test]
fn a_frame_may_navigate_only_to_a_live_panels_page() {
    let webviews = Webviews::default();
    webviews
        .open(
            "main",
            TOKEN,
            "acme.web",
            copy("nav"),
            String::new(),
            None,
            true,
            vec![],
        )
        .unwrap();
    for ok in [
        format!("{ORIGIN}/{TOKEN}/index.html"),
        format!("{ORIGIN}/{TOKEN}/index.html?x=1"),
        format!("{ORIGIN}/{TOKEN}/index.html#top"),
        "about:blank".into(),
        "about:srcdoc".into(),
    ] {
        assert!(webviews.navigation_allowed(&ok), "{ok}");
    }
    for bad in [
        "https://example.com/".to_string(),
        "http://tauri.localhost/".into(),
        "http://ipc.localhost/plugin".into(),
        "file:///C:/Windows/win.ini".into(),
        "javascript:alert(1)".into(),
        "data:text/html,<p>x</p>".into(),
        format!("{ORIGIN}/{OTHER}/index.html"),
        format!("{ORIGIN}/{TOKEN}/res/extension/media/app.js"),
        format!("{ORIGIN}.evil.com/{TOKEN}/index.html"),
        format!("{ORIGIN}/{TOKEN}"),
    ] {
        assert!(!webviews.navigation_allowed(&bad), "{bad}");
    }
    webviews.close("main", TOKEN);
    assert!(!webviews.navigation_allowed(&format!("{ORIGIN}/{TOKEN}/index.html")));
}

#[test]
fn files_are_served_with_their_types() {
    for (path, kind) in [
        ("a.js", "text/javascript; charset=utf-8"),
        ("a.CSS", "text/css; charset=utf-8"),
        ("a.svg", "image/svg+xml"),
        ("a.woff2", "font/woff2"),
        ("a.exe", "application/octet-stream"),
        ("noext", "application/octet-stream"),
    ] {
        assert_eq!(content_type(path), kind, "{path}");
    }
}

#[test]
fn only_a_get_for_the_webview_origin_is_answered() {
    let webviews = Webviews::default();
    webviews
        .open(
            "main",
            TOKEN,
            "acme.web",
            copy("origin"),
            "<p>x</p>".into(),
            None,
            true,
            vec![],
        )
        .unwrap();
    let ask = |method: &str, uri: String| {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .body(Vec::new())
            .unwrap();
        webviews.respond("main", &request).status()
    };
    assert_eq!(
        ask("GET", format!("{ORIGIN}/{TOKEN}/index.html")),
        StatusCode::OK
    );
    for (method, uri) in [
        ("POST", format!("{ORIGIN}/{TOKEN}/index.html")),
        (
            "GET",
            format!("http://yavin-webview.invalid/{TOKEN}/index.html"),
        ),
        (
            "GET",
            format!("https://yavin-webview.invalid.evil.com/{TOKEN}/index.html"),
        ),
        ("GET", format!("https://other.invalid/{TOKEN}/index.html")),
    ] {
        assert_eq!(
            ask(method, uri.clone()),
            StatusCode::NOT_FOUND,
            "{method} {uri}"
        );
    }
}
