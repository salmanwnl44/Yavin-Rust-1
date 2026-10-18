//! EXT-03: Open VSX requests and packages against a local fake Open VSX server -- no network.

use super::*;
use crate::extension_package::tests::{package, temp};
use crate::extension_service::{ExtensionService, Inventory, INVENTORY};
use crate::extensions::MANIFEST_FILE;
use crate::marketplace::tests::{serve, sha};
use crate::marketplace::{redirect, stage, PackageSource};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[test]
fn queries_and_segments_are_encoded_under_any_base() {
    assert_eq!(encode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
    let official = registry("https://open-vsx.org/").unwrap();
    assert_eq!(
        api_url(
            &official,
            &["-".into(), "search".into()],
            &[
                ("query", "c# & f#".into()),
                ("offset", "40".into()),
                ("size", "20".into())
            ]
        ),
        "https://open-vsx.org/api/-/search?query=c%23%20%26%20f%23&offset=40&size=20"
    );
    // A private mirror under a path: the API is under it.
    let mirror = registry("https://mirror.example.com/openvsx/").unwrap();
    assert_eq!(
        api_url(
            &mirror,
            &["PKief".into(), "material-icon-theme".into()],
            &[]
        ),
        "https://mirror.example.com/openvsx/api/PKief/material-icon-theme"
    );
    // A segment that would mean something else is refused, not encoded into it (EXT-08).
    for bad in [
        "", ".", "..", "a\nb", "a/b", "../x", "a\\b", "a%2Fb", "a%252Fb", "%2e%2e", "a?x=1", "a#f",
        "a b", " a", "\u{0}",
    ] {
        assert!(segment("namespace", bad).is_err(), "{bad:?}");
    }
    // Reserved characters and Unicode that are valid in a segment are kept, encoded.
    for good in ["PKief", "vscode-yaml", "1.15.0", "C++", "a@b", "名前"] {
        assert_eq!(segment("name", good).unwrap(), good);
    }
    assert_eq!(
        api_url(&mirror, &["名前".into(), "C++".into()], &[]),
        "https://mirror.example.com/openvsx/api/%E5%90%8D%E5%89%8D/C++"
    );
    assert!(registry("http://open-vsx.org/")
        .unwrap_err()
        .starts_with("InsecureTransport"));
}

#[test]
fn only_open_vsx_itself_may_redirect_to_its_file_host() {
    let official = registry("https://open-vsx.org/").unwrap();
    let cdn = "https://openvsx.eclipsecontent.org/redhat/vscode-yaml/1.0.0/x.vsix";
    assert_eq!(redirect(&official, "u", cdn).unwrap(), cdn);
    assert!(redirect(&official, "u", "https://evil.example.net/x.vsix").is_err());
    assert!(redirect(&official, "u", "http://openvsx.eclipsecontent.org/x.vsix").is_err());
    assert_eq!(url_on(&official, cdn).unwrap(), cdn);
    let mirror = registry("https://mirror.example.com/openvsx/").unwrap();
    assert!(
        redirect(&mirror, "u", cdn).is_err(),
        "a mirror's files stay on the mirror"
    );
    assert!(url_on(&mirror, cdn).is_err());
    assert!(url_on(&mirror, "https://mirror.example.com/elsewhere/x.vsix").is_err());
    assert!(url_on(
        &mirror,
        "https://mirror.example.com/openvsx/api/a/b/1/file/x.vsix"
    )
    .is_ok());
    assert!(url_on(&mirror, "https://mirror.example.com/openvsx/api/a?b=1").is_err());
}

/// A fake Open VSX server: answers by request target, and records every request.
fn fake(
    respond: impl Fn(&str, &str) -> (u16, Vec<(&'static str, String)>, Vec<u8>) + Send + Sync + 'static,
) -> (String, Arc<Mutex<Vec<String>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let base = Arc::new(Mutex::new(String::new()));
    let own = base.clone();
    let url = serve(move |target| {
        log.lock().unwrap().push(target.to_string());
        respond(&own.lock().unwrap(), target)
    });
    *base.lock().unwrap() = url.clone();
    (url, seen)
}

fn json_answer(value: Value) -> (u16, Vec<(&'static str, String)>, Vec<u8>) {
    (
        200,
        vec![("Content-Type", "application/json".into())],
        value.to_string().into_bytes(),
    )
}

#[test]
fn search_pages_versions_and_failures_follow_the_api_contract() {
    let (base, seen) = fake(|_, target| match target {
        t if t.starts_with("/registry/api/-/search?query=yaml%20lint&offset=20&size=20") => {
            json_answer(json!({"offset": 20, "totalSize": 41, "extensions": []}))
        }
        "/registry/api/acme/busy" => (429, vec![("Retry-After", "30".into())], b"{}".to_vec()),
        "/registry/api/acme/down" => (503, vec![], b"down".to_vec()),
        "/registry/api/acme/huge" => {
            json_answer(json!({"x": "y".repeat((MAX_JSON + 10) as usize)}))
        }
        "/registry/api/acme/html" => (
            200,
            vec![("Content-Type", "text/html".into())],
            b"<html>".to_vec(),
        ),
        "/registry/api/acme/hello/versions?offset=0&size=100" => {
            json_answer(json!({"offset": 0, "totalSize": 1, "versions": {"1.0.0": "x"}}))
        }
        _ => (404, vec![], br#"{"error":"Extension not found"}"#.to_vec()),
    });
    let r = registry(&base).unwrap();
    let search = |query: &str, offset, size| {
        answer(
            &r,
            Request::Search {
                query: query.into(),
                category: None,
                offset,
                size,
            },
        )
    };
    let page = search("yaml lint", 20, 20).unwrap();
    assert!(page.contains("\"totalSize\":41"), "{page}");
    // Out-of-range pages are refused before any request.
    let before = seen.lock().unwrap().len();
    assert!(search("x", 0, 0).unwrap_err().starts_with("InvalidRequest"));
    assert!(search("x", 0, MAX_PAGE + 1)
        .unwrap_err()
        .starts_with("InvalidRequest"));
    assert!(search("x", MAX_OFFSET + 1, 10)
        .unwrap_err()
        .starts_with("InvalidRequest"));
    assert_eq!(seen.lock().unwrap().len(), before);
    let ext = |name: &str| {
        answer(
            &r,
            Request::Extension {
                namespace: "acme".into(),
                name: name.into(),
                version: None,
            },
        )
    };
    let limited = ext("busy").unwrap_err();
    assert!(
        limited.starts_with("RateLimited") && limited.contains("30 s"),
        "{limited}"
    );
    assert!(ext("down")
        .unwrap_err()
        .starts_with("MarketplaceUnavailable"));
    assert!(ext("nobody").unwrap_err().starts_with("NotFound"));
    assert!(ext("huge").unwrap_err().starts_with("TooLarge"));
    assert!(ext("html").unwrap_err().starts_with("UnexpectedContent"));
    let versions = answer(
        &r,
        Request::Versions {
            namespace: "acme".into(),
            name: "hello".into(),
            offset: 0,
            size: 100,
        },
    )
    .unwrap();
    assert!(versions.contains("1.0.0"));
}

#[test]
fn a_registry_that_does_not_answer_times_out() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let held: Vec<_> = listener.incoming().take(2).collect();
        std::thread::sleep(Duration::from_secs(10));
        drop(held);
    });
    let mut r = registry(&format!("http://127.0.0.1:{port}/")).unwrap();
    r.timeout = Duration::from_millis(500);
    let started = std::time::Instant::now();
    let error = answer(
        &r,
        Request::Extension {
            namespace: "a".into(),
            name: "b".into(),
            version: None,
        },
    )
    .unwrap_err();
    assert!(error.starts_with("MarketplaceUnavailable"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// What one fake registry publishes for `acme.hello`: per version, its metadata and package.
struct Published {
    package: Vec<u8>,
    metadata_id: (&'static str, &'static str),
    checksum: Option<String>,
    download_url: Option<String>,
}

/// A VS Code package of `publisher.name` at `version` with a colour theme -- and code that
/// would leave a mark if anything ran it while installing.
fn theme_vsix(dir: &Path, name: &str, version: &str) -> Vec<u8> {
    let manifest = format!(
        r#"{{"publisher":"Acme","name":"{name}","version":"{version}","engines":{{"vscode":"^1.80.0"}},"main":"./out/extension.js","contributes":{{"themes":[{{"label":"Acme Dark","uiTheme":"vs-dark","path":"./theme.json"}}]}}}}"#
    );
    let at = dir.join(format!("p-{name}-{version}"));
    fs::create_dir_all(&at).unwrap();
    let code = b"require('fs').writeFileSync('ran.txt', 'ran'); module.exports = {};";
    fs::read(package(
        &at,
        &[
            ("extension.vsixmanifest", b"<PackageManifest/>"),
            ("extension/package.json", manifest.as_bytes()),
            (
                "extension/theme.json",
                br##"{"colors":{"editor.background":"#101010"}}"##,
            ),
            ("extension/out/extension.js", code),
        ],
    ))
    .unwrap()
}

fn yavin_package(dir: &Path, version: &str) -> Vec<u8> {
    theme_vsix(dir, "hello", version)
}

fn vscode_package(dir: &Path) -> Vec<u8> {
    let at = dir.join("vsix");
    fs::create_dir_all(&at).unwrap();
    fs::read(package(
        &at,
        &[
            ("[Content_Types].xml", b"<Types/>"),
            ("extension.vsixmanifest", b"<PackageManifest/>"),
            ("extension/package.json", br#"{"publisher":"acme","name":"hello","version":"3.0.0","engines":{"vscode":"^1.90.0"}}"#),
            ("extension/out/extension.js", b"module.exports = {};"),
        ],
    ))
    .unwrap()
}

fn registry_of(published: Arc<Mutex<BTreeMap<String, Published>>>) -> String {
    fake(move |base, target| {
        // Open VSX looks extensions up case-insensitively (verified on open-vsx.org).
        let target = target.to_ascii_lowercase();
        let all = published.lock().unwrap();
        for (version, one) in all.iter() {
            let prefix = format!("/registry/api/acme/hello/{version}");
            if target == prefix {
                let file = |name: &str| format!("{base}api/acme/hello/{version}/file/{name}");
                return json_answer(json!({
                    "namespace": one.metadata_id.0,
                    "name": one.metadata_id.1,
                    "version": version,
                    "engines": {"yavin": "^2.0.0"},
                    "files": {
                        "download": one.download_url.clone().unwrap_or_else(|| file("acme.hello.vsix")),
                        "sha256": file("acme.hello.sha256"),
                    },
                }));
            }
            if target == format!("{prefix}/file/acme.hello.sha256") {
                let checksum = one.checksum.clone().unwrap_or_else(|| sha(&one.package));
                return (200, vec![("Content-Type", "text/plain;charset=UTF-8".into())], checksum.into_bytes());
            }
            if target == format!("{prefix}/file/acme.hello.vsix") {
                return (200, vec![("Content-Type", "application/octet-stream".into())], one.package.clone());
            }
        }
        (404, vec![], b"{}".to_vec())
    })
    .0
}

use std::collections::BTreeMap;

fn inventory(root: &Path) -> Inventory {
    serde_json::from_str(&fs::read_to_string(root.join(INVENTORY)).unwrap()).unwrap()
}

#[test]
fn an_open_vsx_version_is_installed_through_the_inventory_with_its_origin() {
    let dir = temp("openvsx-install");
    let published = Arc::new(Mutex::new(BTreeMap::new()));
    for version in ["1.0.0", "2.0.0"] {
        published.lock().unwrap().insert(
            version.to_string(),
            Published {
                package: yavin_package(&dir, version),
                metadata_id: ("Acme", "Hello"),
                checksum: None,
                download_url: None,
            },
        );
    }
    let base = registry_of(published.clone());
    let root = dir.join("extensions");
    let service = ExtensionService::new(root.clone(), Vec::new());
    *service.abandoned_after.lock().unwrap() = Some(Duration::ZERO);
    let source = || PackageSource::OpenVsx {
        registry_url: base.clone(),
        namespace: "Acme".into(),
        name: "Hello".into(),
    };
    let install = |version: &str| {
        let staged = stage(&service, source(), "acme.hello", version)?;
        service.commit(&staged.token, "acme.hello")?;
        Ok::<_, String>(staged.token)
    };
    let op = install("1.0.0").unwrap();
    service.finish(&op, "acme.hello", true).unwrap();
    let record = inventory(&root).extensions["acme.hello"].clone();
    assert_eq!(record.active.source, format!("openvsx {base}"));
    assert_eq!(record.active.version, "1.0.0");
    assert!(record.active.sha256.is_some());
    // Installing ran nothing of it.
    assert!(!root.join("ran.txt").exists() && !dir.join("ran.txt").exists());
    // An update whose registration fails rolls back to 1.0.0.
    let op = install("2.0.0").unwrap();
    service.finish(&op, "acme.hello", false).unwrap();
    assert_eq!(inventory(&root).extensions["acme.hello"], record);

    let refused = |change: &dyn Fn(&mut Published), why: &str| {
        let mut all = published.lock().unwrap();
        let mut one = Published {
            package: yavin_package(&dir, "3.0.0"),
            metadata_id: ("acme", "hello"),
            checksum: None,
            download_url: None,
        };
        change(&mut one);
        all.insert("3.0.0".into(), one);
        drop(all);
        let error = stage(&service, source(), "acme.hello", "3.0.0").unwrap_err();
        assert!(error.starts_with(why), "{why}: {error}");
        assert_eq!(
            inventory(&root).extensions["acme.hello"],
            record,
            "{why}: nothing changed"
        );
    };
    refused(
        &|one| one.metadata_id = ("acme", "other"),
        "ManifestMismatch",
    );
    refused(
        &|one| one.checksum = Some("0".repeat(64)),
        "IntegrityFailed",
    );
    refused(
        &|one| one.checksum = Some("not a checksum".into()),
        "IntegrityFailed",
    );
    refused(
        &|one| one.package = vscode_package(&dir),
        "UnsupportedPackage",
    );
    refused(
        &|one| one.download_url = Some("https://evil.example.net/acme.hello.vsix".into()),
        "OutsideRegistry",
    );
    // A package claiming another identity inside is refused too (the native manifest check).
    refused(
        &|one| {
            let at = dir.join("other");
            fs::create_dir_all(&at).unwrap();
            one.package = theme_vsix(&at, "other", "3.0.0");
        },
        "ManifestMismatch",
    );
    // A Yavin package served as an Open VSX one is refused: Open VSX serves VS Code packages.
    refused(
        &|one| {
            let at = dir.join("yavin");
            fs::create_dir_all(&at).unwrap();
            one.package = fs::read(package(
                &at,
                &[(
                    MANIFEST_FILE,
                    br#"{"publisher":"acme","name":"hello","version":"3.0.0"}"#,
                )],
            ))
            .unwrap();
        },
        "InvalidPackage",
    );
    assert!(inventory(&root).operations.is_empty());
    let _ = fs::remove_dir_all(&dir);
}

/// Browsing and installing never run extension code: none of this code can.
#[test]
fn nothing_here_can_run_extension_code() {
    for source in [
        include_str!("openvsx.rs"),
        include_str!("marketplace.rs"),
        include_str!("extension_service.rs"),
        include_str!("extension_package.rs"),
    ] {
        let code = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in [
            "rquickjs",
            "Command::new",
            "ServerProcess",
            "ExtHostSessions",
        ] {
            assert!(!code.contains(forbidden), "{forbidden}");
        }
    }
}

/// The real open-vsx.org (run on purpose: `cargo test -p yavin-ide --lib live_ -- --ignored`):
/// a search, a record, and a checksum fetched through its CDN redirect.
#[test]
#[ignore = "uses the network"]
fn live_open_vsx_search_record_and_checksum() {
    let r = registry("https://open-vsx.org/").unwrap();
    let page: Value = serde_json::from_str(
        &answer(
            &r,
            Request::Search {
                query: "yaml".into(),
                category: None,
                offset: 0,
                size: 2,
            },
        )
        .unwrap(),
    )
    .unwrap();
    assert!(page["totalSize"].as_u64().unwrap() > 0);
    let first = &page["extensions"][0];
    let (namespace, name, version) = (
        first["namespace"].as_str().unwrap(),
        first["name"].as_str().unwrap(),
        first["version"].as_str().unwrap(),
    );
    let meta = version_metadata(&r, namespace, name, version).unwrap();
    let checksum = get_text(&r, &file_url(&meta, "sha256", &r).unwrap(), "checksum", 256).unwrap();
    assert_eq!(checksum.trim().len(), 64, "{checksum}");
}

/// EXT-06: the approved CDN is one whole origin, for open-vsx.org alone; a mirror's base and
/// the URLs its answers name cannot climb out of it.
#[test]
fn only_the_approved_cdn_origin_and_the_mirrors_own_paths_are_accepted() {
    let official = registry("https://open-vsx.org/").unwrap();
    for refused in [
        "https://openvsx.eclipsecontent.org:8443/a/b/1/x.vsix",
        "http://openvsx.eclipsecontent.org/a/b/1/x.vsix",
        "https://evil.openvsx.eclipsecontent.org/a/b/1/x.vsix",
        "https://openvsx.eclipsecontent.org.evil.net/a/b/1/x.vsix",
    ] {
        assert!(redirect(&official, "u", refused).is_err(), "{refused}");
        assert!(url_on(&official, refused).is_err(), "{refused}");
    }
    // open-vsx.org on another port is not open-vsx.org: no CDN for it.
    let other_port = registry("https://open-vsx.org:8443/").unwrap();
    assert!(other_port.file_origins.is_empty());
    let mirror = registry("https://mirror.example.com/openvsx/").unwrap();
    for escape in [
        "https://mirror.example.com/openvsx/../admin/x.vsix",
        "https://mirror.example.com/openvsx/%2e%2e/admin/x.vsix",
        "https://mirror.example.com/openvsx/..%2fadmin/x.vsix",
        "https://mirror.example.com/openvsx//x.vsix",
        "https://mirror.example.com/openvsxx/x.vsix",
    ] {
        assert!(url_on(&mirror, escape).is_err(), "{escape}");
    }
    for bad in [
        "https://mirror.example.com/openvsx/../",
        "https://mirror.example.com/open%2fvsx/",
        "https://mirror.example.com/openvsx/?x=1",
    ] {
        assert!(registry(bad).is_err(), "{bad}");
    }
    // Query values are encoded, so none can add a parameter; segments that would add a path
    // or a query are refused before a URL is built (EXT-08).
    let url = api_url(
        &mirror,
        &["a".into(), "n".into()],
        &[("query", "a&size=1000#x".into())],
    );
    assert_eq!(
        url,
        "https://mirror.example.com/openvsx/api/a/n?query=a%26size%3D1000%23x"
    );
    assert!(segment("name", "a/../b").is_err() && segment("name", "n?x=1#f").is_err());
}
