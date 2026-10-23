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
    // Said in full if it fails (it has failed under load, with no message to tell why).
    let huge = ext("huge").unwrap_err();
    assert!(huge.starts_with("TooLarge"), "{huge}");
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
    /// Its signature (EXT-09).
    signature: Sig,
}

/// How a version is signed (EXT-09), with the fixed test keys.
#[derive(Clone)]
enum Sig {
    /// By the key pinned as `test-key` (`SEED_A`), over the package served.
    Valid,
    /// No signature listed.
    Absent,
    /// A valid signature, one bit changed.
    Tampered,
    /// By another key (`SEED_B`), under the pinned key's id.
    OtherKey,
    /// Valid, but the metadata names another key id.
    KeyId(&'static str),
    /// These bytes as the `.sigzip`.
    Bytes(Vec<u8>),
    /// Listed, but not served.
    Unserved,
    /// The key named on another server.
    KeyElsewhere,
}

/// The trust store tests use: `test-key` (`SEED_A`) pinned for the fake registry at `base`.
fn pinned(base: &str) -> Result<crate::package_trust::TrustStore, String> {
    let origin = base
        .trim_end_matches('/')
        .trim_end_matches("/registry")
        .to_string();
    trust::store_of(vec![trust::anchor(&origin, "test-key", trust::SEED_A)])
}

use crate::package_trust::tests as trust;

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
                let key = match &one.signature {
                    Sig::KeyId(id) => format!("{base}api/-/public-key/{id}"),
                    Sig::KeyElsewhere => {
                        "https://keys.example.net/api/-/public-key/test-key".into()
                    }
                    _ => format!("{base}api/-/public-key/test-key"),
                };
                let mut files = json!({
                    "download": one.download_url.clone().unwrap_or_else(|| file("acme.hello.vsix")),
                    "sha256": file("acme.hello.sha256"),
                    "publicKey": key,
                });
                if !matches!(one.signature, Sig::Absent) {
                    files["signature"] = json!(file("acme.hello.sigzip"));
                }
                return json_answer(json!({
                    "namespace": one.metadata_id.0,
                    "name": one.metadata_id.1,
                    "version": version,
                    "engines": {"yavin": "^2.0.0"},
                    "files": files,
                }));
            }
            if target == format!("{prefix}/file/acme.hello.sigzip") {
                let sigzip = match &one.signature {
                    Sig::Unserved => return (404, vec![], vec![]),
                    Sig::OtherKey => trust::signed(trust::SEED_B, &one.package),
                    Sig::Tampered => {
                        use ed25519_dalek::Signer;
                        let mut bytes = trust::signing(trust::SEED_A).sign(&one.package).to_bytes();
                        bytes[0] ^= 1;
                        trust::sigzip_with(&bytes)
                    }
                    Sig::Bytes(bytes) => bytes.clone(),
                    _ => trust::signed(trust::SEED_A, &one.package),
                };
                return (
                    200,
                    vec![("Content-Type", "application/octet-stream".into())],
                    sigzip,
                );
            }
            if target == format!("{prefix}/file/acme.hello.sha256") {
                let checksum = one.checksum.clone().unwrap_or_else(|| sha(&one.package));
                return (
                    200,
                    vec![("Content-Type", "text/plain;charset=UTF-8".into())],
                    checksum.into_bytes(),
                );
            }
            if target == format!("{prefix}/file/acme.hello.vsix") {
                return (
                    200,
                    vec![("Content-Type", "application/octet-stream".into())],
                    one.package.clone(),
                );
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
                signature: Sig::Valid,
            },
        );
    }
    let base = registry_of(published.clone());
    let store = pinned(&base);
    crate::package_trust::with_store(store, || installs_and_refuses(&dir, &base, published));
}

fn installs_and_refuses(
    dir: &Path,
    base: &str,
    published: Arc<Mutex<BTreeMap<String, Published>>>,
) {
    let dir = dir.to_path_buf();
    let base = base.to_string();
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
    // Its signature, found valid under the pinned key, kept with the copy -- bound to its bytes.
    let signature = record.active.signature.clone().expect("a signature record");
    assert_eq!(
        signature.status,
        crate::package_trust::SignatureStatus::RegistrySigned
    );
    assert_eq!(signature.key_id.as_deref(), Some("test-key"));
    assert_eq!(Some(&signature.sha256), record.active.sha256.as_ref());
    assert_eq!(signature.namespace, "acme");
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
            signature: Sig::Valid,
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
    // EXT-09: what the signature is decides, before anything is replaced.
    refused(&|one| one.signature = Sig::Absent, "SignatureMissing");
    refused(&|one| one.signature = Sig::Tampered, "SignatureInvalid");
    refused(&|one| one.signature = Sig::OtherKey, "SignatureInvalid");
    refused(
        &|one| one.signature = Sig::KeyId("rotated-key"),
        "UntrustedKey",
    );
    refused(
        &|one| one.signature = Sig::Bytes(b"not a zip".to_vec()),
        "SignatureMalformed",
    );
    refused(
        &|one| one.signature = Sig::Unserved,
        "VerificationUnavailable",
    );
    refused(
        &|one| one.signature = Sig::KeyElsewhere,
        "SignatureMalformed",
    );
    // A genuine signature by the pinned key -- over other bytes (the package before a change
    // the registry's checksum was updated to cover).
    refused(
        &|one| {
            let before = [one.package.as_slice(), b"\0"].concat();
            one.signature = Sig::Bytes(trust::signed(trust::SEED_A, &before));
        },
        "SignatureInvalid",
    );
    assert!(inventory(&root).operations.is_empty());
    // EXT-14: each refusal is a trust diagnostic of the application's -- refused, with what to
    // do, its detail redacted (no path of this machine).
    let seen = service.diagnostics().visible("main", Some("acme.hello"));
    for code in [
        "SignatureMissing",
        "SignatureInvalid",
        "UntrustedKey",
        "SignatureMalformed",
        "VerificationUnavailable",
        "IntegrityFailed",
        "ManifestMismatch",
    ] {
        let found = seen
            .iter()
            .find(|d| d.code == code)
            .unwrap_or_else(|| panic!("{code}: {seen:?}"));
        assert!(found.refusal, "{code}");
        assert!(found.window.is_none(), "an install is the application's");
        assert!(found.remedy.is_some() || code == "UnsupportedPackage");
    }
    assert!(seen.iter().all(|d| !d
        .detail
        .as_deref()
        .unwrap_or("")
        .contains(&dir.display().to_string())));
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
    let meta = version_metadata(&r, namespace, name, None, version).unwrap();
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

/// The trust store decides, and only it: under a store that pins nothing for this registry, a
/// revoked key, or no readable store at all, the same validly signed package is refused -- and
/// what the window sends cannot say otherwise (a `verified` claim in the request is not read).
#[test]
fn only_the_pinned_store_can_make_a_package_trusted() {
    let dir = temp("openvsx-trust");
    let published = Arc::new(Mutex::new(BTreeMap::new()));
    published.lock().unwrap().insert(
        "1.0.0".to_string(),
        Published {
            package: yavin_package(&dir, "1.0.0"),
            metadata_id: ("acme", "hello"),
            checksum: None,
            download_url: None,
            signature: Sig::Valid,
        },
    );
    let base = registry_of(published);
    let root = dir.join("extensions");
    let service = ExtensionService::new(root.clone(), Vec::new());
    // The request as the window sends it, with claims of its own -- which are not read.
    let source = || -> PackageSource {
        serde_json::from_value(json!({
            "kind": "openVsx", "registryUrl": base, "namespace": "acme", "name": "hello",
            "verified": true, "signature": {"status": "registrySigned"}, "trusted": true,
        }))
        .unwrap()
    };
    let attempt = |store| {
        crate::package_trust::with_store(store, || stage(&service, source(), "acme.hello", "1.0.0"))
    };
    let mut revoked = trust::anchor(
        base.trim_end_matches('/').trim_end_matches("/registry"),
        "test-key",
        trust::SEED_A,
    );
    revoked["status"] = json!("revoked");
    for (store, why) in [
        (trust::store_of(vec![]), "UntrustedKey"),
        (
            trust::store_of(vec![trust::anchor(
                "https://open-vsx.org",
                "test-key",
                trust::SEED_A,
            )]),
            "UntrustedKey",
        ),
        (trust::store_of(vec![revoked]), "KeyRevoked"),
        (Err("unreadable".to_string()), "VerificationUnavailable"),
    ] {
        let error = attempt(store).err().unwrap();
        assert!(error.starts_with(why), "{why}: {error}");
        assert!(!root.join(INVENTORY).exists() || inventory(&root).extensions.is_empty());
    }
    // Pinned: installed.
    let staged = attempt(pinned(&base)).unwrap();
    service.commit(&staged.token, "acme.hello").unwrap();
    let _ = fs::remove_dir_all(&dir);
}

// --- EXT-15: the bytes a trust decision covers --------------------------------------------------

/// The bytes the signature is checked over are the bytes whose checksum was verified: read once,
/// their SHA-256 compared -- a package file that changed in between is refused.
#[test]
fn the_bytes_checked_are_the_bytes_hashed() {
    let dir = temp("openvsx-same-bytes");
    std::fs::create_dir_all(&dir).unwrap();
    let archive = dir.join("package.vsix");
    std::fs::write(&archive, b"PK the package as downloaded").unwrap();
    let sha = crate::extension_package::sha256_file(&archive).unwrap();
    assert_eq!(
        verified_bytes(&archive, &sha).unwrap(),
        b"PK the package as downloaded"
    );
    std::fs::write(&archive, b"PK something else, written in between").unwrap();
    let refused = verified_bytes(&archive, &sha).unwrap_err();
    assert!(refused.starts_with("IntegrityFailed"), "{refused}");
    let _ = std::fs::remove_dir_all(dir);
}

/// A signed, installed copy whose files change afterwards is no longer the package that was
/// verified: it is not used (no previous version: reported broken), not listed as signed, and
/// its code does not load -- until its files are as installed again.
#[test]
fn an_installed_copy_whose_files_change_is_not_listed_signed_or_used() {
    let dir = temp("openvsx-files-changed");
    let published = Arc::new(Mutex::new(BTreeMap::new()));
    published.lock().unwrap().insert(
        "1.0.0".to_string(),
        Published {
            package: yavin_package(&dir, "1.0.0"),
            metadata_id: ("acme", "hello"),
            checksum: None,
            download_url: None,
            signature: Sig::Valid,
        },
    );
    let base = registry_of(published);
    let root = dir.join("extensions");
    let service = ExtensionService::new(root.clone(), Vec::new());
    crate::package_trust::with_store(pinned(&base), || {
        let source = PackageSource::OpenVsx {
            registry_url: base.clone(),
            namespace: "acme".into(),
            name: "hello".into(),
        };
        let staged = stage(&service, source, "acme.hello", "1.0.0").unwrap();
        service.commit(&staged.token, "acme.hello").unwrap();
        service.finish(&staged.token, "acme.hello", true).unwrap();
    });
    let entry = |service: &ExtensionService| {
        service
            .list(None)
            .unwrap()
            .extensions
            .into_iter()
            .find(|e| e.id.as_deref() == Some("acme.hello"))
            .unwrap()
    };
    let signed = entry(&service);
    assert_eq!(
        signed.signature.as_ref().unwrap().status,
        crate::package_trust::SignatureStatus::RegistrySigned
    );
    let record = inventory(&root).extensions["acme.hello"].clone();
    assert!(
        record.active.files_sha256.is_some(),
        "the files are bound at install"
    );
    // One file of the installed copy changes.
    let folder = root.join(record.active.folder.replace('/', "\\"));
    let theme = folder.join("extension").join("theme.json");
    let original = std::fs::read(&theme).unwrap();
    std::fs::write(
        &theme,
        b"{\"colors\": {\"editor.background\": \"#ff0000\"}}",
    )
    .unwrap();
    let changed = entry(&service);
    assert!(changed.signature.is_none(), "not listed as signed");
    assert!(
        changed
            .error
            .as_deref()
            .unwrap_or("")
            .contains("files changed"),
        "{:?}",
        changed.error
    );
    // A file added is a change too.
    std::fs::write(&theme, &original).unwrap();
    assert!(
        entry(&service).signature.is_some(),
        "as installed again: signed again"
    );
    std::fs::write(folder.join("extra.js"), b"module.exports = {};").unwrap();
    assert!(entry(&service).signature.is_none());
    std::fs::remove_file(folder.join("extra.js")).unwrap();
    assert!(entry(&service).signature.is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

// --- EXT-30: a version built per platform ------------------------------------------------------

use crate::extension_package::tests::{elsewhere, vsixmanifest};
use crate::extension_package::HOST_PLATFORM;

#[test]
fn the_variant_chosen_is_this_platforms_then_universal_else_refused() {
    let label = "acme.hello 1.0.0";
    let meta = |answered: Value, downloads: Value| {
        let mut m = json!({"namespace": "acme", "name": "hello", "version": "1.0.0"});
        if !answered.is_null() {
            m["targetPlatform"] = answered;
        }
        if !downloads.is_null() {
            m["downloads"] = downloads;
        }
        m
    };
    let downloads = |platforms: &[&str]| {
        Value::Object(
            platforms
                .iter()
                .map(|p| (p.to_string(), json!(format!("https://x/{p}.vsix"))))
                .collect(),
        )
    };
    let other = elsewhere();
    let host = HOST_PLATFORM;
    // Open VSX answered with this platform's, or with the universal package: that one.
    assert_eq!(
        choose_variant(&meta(json!(host), downloads(&[host, other])), host, label),
        Ok(None)
    );
    assert_eq!(
        choose_variant(
            &meta(json!("universal"), downloads(&["universal"])),
            host,
            label
        ),
        Ok(None)
    );
    // No platforms at all (an older registry): universal.
    assert_eq!(
        choose_variant(&meta(Value::Null, Value::Null), host, label),
        Ok(None)
    );
    // Answered with another platform's (as open-vsx.org did for sumneko.lua): this one's fetched.
    assert_eq!(
        choose_variant(
            &meta(json!(other), downloads(&[other, host, "linux-x64"])),
            host,
            label
        ),
        Ok(Some(host))
    );
    // This platform's preferred over the universal package when both are published.
    assert_eq!(
        choose_variant(
            &meta(json!("universal"), downloads(&["universal", host])),
            host,
            label
        ),
        Ok(Some(host))
    );
    // Another platform's answered, a universal one published: that.
    assert_eq!(
        choose_variant(
            &meta(json!(other), downloads(&[other, "universal"])),
            host,
            label
        ),
        Ok(Some("universal"))
    );
    // Published only for others (or for VS Code in a browser): refused, naming them.
    for only in [vec![other], vec!["web"], vec![other, "linux-arm64"]] {
        let error =
            choose_variant(&meta(json!(only[0]), downloads(&only)), host, label).unwrap_err();
        assert!(error.starts_with("UnsupportedPlatform"), "{error}");
        for p in &only {
            assert!(error.contains(p), "{error}");
        }
        assert!(error.contains(host), "{error}");
    }
    // Malformed metadata: refused, never guessed.
    for (bad, why) in [
        (meta(json!("win32-x65"), Value::Null), "not a platform"),
        (meta(json!(7), Value::Null), "not text"),
        (meta(json!(other), json!(["win32-x64"])), "not a map"),
        (meta(json!(other), json!("win32-x64")), "not a map"),
    ] {
        let error = choose_variant(&bad, host, label).unwrap_err();
        assert!(
            error.starts_with("UnexpectedContent") && error.contains(why),
            "{error}"
        );
    }
    // A platform Yavin does not know, or one whose download is not a URL, is not offered.
    let error = choose_variant(
        &meta(
            json!(other),
            json!({"riscv-64": "https://x/r.vsix", host: 7}),
        ),
        host,
        label,
    )
    .unwrap_err();
    assert!(error.starts_with("UnsupportedPlatform"), "{error}");
}

/// A VS Code package of `acme.hello` 1.0.0 built for `platform` (`None`: every one).
fn platform_vsix(dir: &Path, platform: Option<&str>) -> Vec<u8> {
    let at = dir.join(format!("p-{}", platform.unwrap_or("universal")));
    fs::create_dir_all(&at).unwrap();
    let manifest = r#"{"publisher":"Acme","name":"hello","version":"1.0.0","engines":{"vscode":"^1.80.0"},"contributes":{"themes":[{"label":"Acme Dark","uiTheme":"vs-dark","path":"./theme.json"}]}}"#;
    fs::read(package(
        &at,
        &[
            ("extension.vsixmanifest", vsixmanifest(platform).as_bytes()),
            ("extension/package.json", manifest.as_bytes()),
            (
                "extension/theme.json",
                br##"{"colors":{"editor.background":"#101010"}}"##,
            ),
        ],
    ))
    .unwrap()
}

/// A fake Open VSX that answers `/api/acme/hello/1.0.0` with `answered`'s metadata, and each
/// platform's own at `/api/acme/hello/<platform>/1.0.0`; `packages` are what each serves (and
/// what its metadata claims, by `claims`).
fn platform_registry(
    answered: &'static str,
    packages: Vec<(&'static str, &'static str, Vec<u8>)>,
) -> (String, Arc<Mutex<Vec<String>>>) {
    fake(move |base, target| {
        let downloads: serde_json::Map<String, Value> = packages
            .iter()
            .map(|(p, _, _)| {
                (
                    p.to_string(),
                    json!(format!("{base}api/acme/hello/{p}/1.0.0/file/hello.vsix")),
                )
            })
            .collect();
        let meta_of = |p: &str, claims: &str| {
            let file = |name: &str| format!("{base}api/acme/hello/{p}/1.0.0/file/{name}");
            json_answer(json!({
                "namespace": "acme", "name": "hello", "version": "1.0.0",
                "targetPlatform": claims,
                "downloads": downloads,
                "files": {
                    "download": file("hello.vsix"),
                    "sha256": file("hello.sha256"),
                    "signature": file("hello.sigzip"),
                    "publicKey": format!("{base}api/-/public-key/test-key"),
                },
            }))
        };
        if target == "/registry/api/acme/hello/1.0.0" {
            let (p, claims, _) = packages.iter().find(|(p, _, _)| *p == answered).unwrap();
            return meta_of(p, claims);
        }
        for (p, claims, bytes) in &packages {
            let prefix = format!("/registry/api/acme/hello/{p}/1.0.0");
            if target == prefix {
                return meta_of(p, claims);
            }
            if target == format!("{prefix}/file/hello.vsix") {
                return (
                    200,
                    vec![("Content-Type", "application/octet-stream".into())],
                    bytes.clone(),
                );
            }
            if target == format!("{prefix}/file/hello.sha256") {
                return (
                    200,
                    vec![("Content-Type", "text/plain".into())],
                    sha(bytes).into_bytes(),
                );
            }
            if target == format!("{prefix}/file/hello.sigzip") {
                return (
                    200,
                    vec![("Content-Type", "application/octet-stream".into())],
                    trust::signed(trust::SEED_A, bytes),
                );
            }
        }
        (404, vec![], b"{}".to_vec())
    })
}

#[test]
fn a_package_built_per_platform_is_installed_as_this_platforms_signed_and_checked() {
    let dir = temp("openvsx-platform");
    let other = elsewhere();
    let host = HOST_PLATFORM;
    let try_install = |name: &str,
                       answered: &'static str,
                       packages: Vec<(&'static str, &'static str, Vec<u8>)>| {
        let (base, seen) = platform_registry(answered, packages);
        let root = dir.join(name);
        let service = ExtensionService::new(root.clone(), Vec::new());
        let source = PackageSource::OpenVsx {
            registry_url: base.clone(),
            namespace: "acme".into(),
            name: "hello".into(),
        };
        let result = crate::package_trust::with_store(pinned(&base), || {
            let staged = stage(&service, source, "acme.hello", "1.0.0")?;
            service.commit(&staged.token, "acme.hello")?;
            service.finish(&staged.token, "acme.hello", true)?;
            Ok::<_, String>(())
        });
        let installed =
            root.join(INVENTORY).exists() && inventory(&root).extensions.contains_key("acme.hello");
        let requests = seen.lock().unwrap().clone();
        (result, installed, requests, root)
    };

    // Open VSX answers with another platform's: this platform's is fetched, verified, installed.
    let (result, installed, seen, root) = try_install(
        "chosen",
        other,
        vec![
            (other, other, platform_vsix(&dir, Some(other))),
            (host, host, platform_vsix(&dir, Some(host))),
        ],
    );
    result.unwrap();
    assert!(installed);
    let record = inventory(&root).extensions["acme.hello"].clone();
    let signature = record.active.signature.clone().expect("signed");
    assert_eq!(
        signature.status,
        crate::package_trust::SignatureStatus::RegistrySigned
    );
    assert_eq!(Some(&signature.sha256), record.active.sha256.as_ref());
    assert_eq!(
        record.active.sha256.as_deref(),
        Some(sha(&platform_vsix(&dir, Some(host))).as_str()),
        "the installed bytes are this platform's package"
    );
    assert!(seen
        .iter()
        .any(|t| t == &format!("/registry/api/acme/hello/{host}/1.0.0/file/hello.vsix")));
    assert!(
        !seen
            .iter()
            .any(|t| t.contains(&format!("/{other}/1.0.0/file/"))),
        "{seen:?}"
    );

    // Published only for another platform: refused before any package is fetched.
    let (result, installed, seen, _) = try_install(
        "none",
        other,
        vec![(other, other, platform_vsix(&dir, Some(other)))],
    );
    let error = result.unwrap_err();
    assert!(
        error.starts_with("UnsupportedPlatform") && error.contains(other),
        "{error}"
    );
    assert!(!installed);
    assert!(!seen.iter().any(|t| t.contains("/file/")), "{seen:?}");

    // The platform's metadata describes another platform: refused at once, from the metadata --
    // no package is fetched on its word.
    let (result, installed, seen, _) = try_install(
        "lying-metadata",
        other,
        vec![
            (other, other, platform_vsix(&dir, Some(other))),
            (host, other, platform_vsix(&dir, Some(host))),
        ],
    );
    let error = result.unwrap_err();
    assert!(
        error.starts_with("ManifestMismatch")
            && error.contains(&format!("asked for acme.hello 1.0.0's {host} package")),
        "{error}"
    );
    assert!(!installed);
    assert!(!seen.iter().any(|t| t.contains("/file/")), "{seen:?}");

    // The package chosen as this platform's says it is another's: refused by its own manifest
    // (signed and checksummed as served -- integrity does not make it the right package).
    let (result, installed, _, _) = try_install(
        "lying-package",
        other,
        vec![
            (other, other, platform_vsix(&dir, Some(other))),
            (host, host, platform_vsix(&dir, Some(other))),
        ],
    );
    let error = result.unwrap_err();
    assert!(error.starts_with("UnsupportedPlatform"), "{error}");
    assert!(!installed);

    // Chosen as universal, built for this platform: the package and its metadata disagree.
    let (result, installed, _, _) = try_install(
        "universal-mismatch",
        "universal",
        vec![("universal", "universal", platform_vsix(&dir, Some(host)))],
    );
    let error = result.unwrap_err();
    assert!(error.starts_with("ManifestMismatch"), "{error}");
    assert!(!installed);

    // A universal package: installed as before.
    let (result, installed, _, _) = try_install(
        "universal",
        "universal",
        vec![("universal", "universal", platform_vsix(&dir, None))],
    );
    result.unwrap();
    assert!(installed);
    let _ = fs::remove_dir_all(&dir);
}
