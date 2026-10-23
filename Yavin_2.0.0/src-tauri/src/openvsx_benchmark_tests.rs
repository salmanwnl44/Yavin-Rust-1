//! The Open VSX compatibility benchmark's native half (EXT-25): every extension of
//! `benchmark/openvsx/catalogue.json` through Yavin's own install path -- the version's record,
//! the download under the marketplace policy, its SHA-256 and its signature under the pinned key
//! (`download`), the package's validation and unpacking (`extension_package::unpack`), and the
//! VS Code adapter (`vsix::adapt`) -- short of committing it to an inventory. Nothing of any
//! extension runs here.
//!
//! Ignored (it downloads real packages): `YAVIN_BENCH_CATALOGUE=<catalogue.json>
//! YAVIN_BENCH_OUT=<an empty scratch folder> cargo test open_vsx_benchmark -- --ignored`.
//! It writes `<out>/native.json` and keeps each package's unpacked files under `<out>/<id>/`
//! for the static analysis (`scripts/openvsx-benchmark.mjs`).

use super::{download, registry};
use crate::extension_package::{unpack, Format, LIMITS};
use ide_workspace::extension_id::canonical_id;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

#[test]
#[ignore = "downloads real packages from open-vsx.org"]
fn open_vsx_benchmark() {
    let catalogue = PathBuf::from(std::env::var("YAVIN_BENCH_CATALOGUE").expect("catalogue"));
    let out = PathBuf::from(std::env::var("YAVIN_BENCH_OUT").expect("output folder"));
    fs::create_dir_all(&out).unwrap();
    let catalogue: Value = serde_json::from_str(&fs::read_to_string(catalogue).unwrap()).unwrap();
    let registry = registry("https://open-vsx.org/").unwrap();
    let mut results = Vec::new();
    for entry in catalogue["extensions"].as_array().unwrap() {
        let (namespace, name, version) = (
            entry["namespace"].as_str().unwrap(),
            entry["name"].as_str().unwrap(),
            entry["version"].as_str().unwrap(),
        );
        let id = canonical_id(&format!("{namespace}.{name}")).unwrap();
        let folder = out.join(&id);
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        let archive = folder.join("package.vsix");
        let started = Instant::now();
        let mut result =
            json!({"id": id, "namespace": namespace, "name": name, "version": version});
        match download(&registry, namespace, name, &id, version, &archive) {
            Err(error) => result["download"] = json!({"ok": false, "error": error}),
            Ok((sha256, size, signature, platform)) => {
                result["download"] = json!({
                    "ok": true, "sha256": sha256, "size": size,
                    "signature": signature.status, "keyId": signature.key_id,
                    // EXT-30: the variant chosen for this platform (null: universal).
                    "platform": platform,
                });
                let files = folder.join("files");
                match unpack(&archive, &files, &LIMITS) {
                    Err(error) => result["unpack"] = json!({"ok": false, "error": error}),
                    Ok(unpacked) => {
                        result["unpack"] = json!({
                            "ok": true, "files": unpacked.files, "bytes": unpacked.bytes,
                            "platform": unpacked.platform,
                            "format": if unpacked.format == Format::Vsix { "vsix" } else { "yavin" },
                        });
                        result["adapt"] = match crate::vsix::adapt(
                            &files,
                            &unpacked.manifest,
                            &id,
                            version,
                        ) {
                            Ok(text) => {
                                json!({"ok": true, "manifest": serde_json::from_str::<Value>(&text).unwrap()})
                            }
                            Err(error) => json!({"ok": false, "error": error}),
                        };
                    }
                }
            }
        }
        result["installMs"] = json!(started.elapsed().as_millis() as u64);
        // Kept for the activation stage (`extension_host_real_tests::open_vsx_benchmark_activation`).
        if result["adapt"]["ok"] != json!(true) {
            let _ = fs::remove_file(&archive);
        }
        eprintln!("{id} {version}: {}", summary(&result));
        results.push(result);
    }
    fs::write(
        out.join("native.json"),
        serde_json::to_string_pretty(
            &json!({"registry": "https://open-vsx.org/", "results": results}),
        )
        .unwrap(),
    )
    .unwrap();
}

fn summary(result: &Value) -> String {
    for stage in ["download", "unpack", "adapt"] {
        if result[stage]["ok"] == json!(false) {
            return format!(
                "{stage} failed: {}",
                result[stage]["error"].as_str().unwrap_or("")
            );
        }
    }
    "installed".into()
}
