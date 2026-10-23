//! EXT-12: declarations, ranges, the API policy and the resolver -- all from fixed metadata, no
//! network, the same result every run.

use super::*;
use serde_json::json;

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

fn r(text: &str) -> Range {
    Range::parse(text).unwrap()
}

/// A candidate with these `dependencies` (`{id: range | {version, optional}}`) and more.
fn cand(id: &str, version: &str, source: Source, manifest: Value) -> Candidate {
    let mut m = json!({"engines": {"yavin": "^2.0.0"}, "main": "extension.js"});
    for (key, value) in manifest.as_object().unwrap() {
        m[key] = value.clone();
    }
    Candidate {
        id: id.into(),
        version: v(version),
        source,
        declared: declared(&m, id).unwrap(),
        unusable: None,
    }
}

const ON: Source = Source::Installed { enabled: true };
const OFF: Source = Source::Installed { enabled: false };
const NEW: Source = Source::Available;

fn plan(root: &str, range: &str, candidates: &[Candidate]) -> Result<Plan, Conflict> {
    resolve(root, &r(range), candidates)
}

fn picked(plan: &Plan) -> Vec<String> {
    plan.selected
        .iter()
        .map(|(id, v)| format!("{id}@{v}"))
        .collect()
}

// --- Ranges ----------------------------------------------------------------------------------

#[test]
fn ranges_exact_caret_tilde_comparators_and_boundaries() {
    // A bare version is that version exactly -- not the semver crate's caret.
    assert!(r("1.2.3").matches(&v("1.2.3")));
    assert!(!r("1.2.3").matches(&v("1.2.4")));
    assert!(r("=1.2.3").matches(&v("1.2.3")));
    assert!(r("^1.2.3").matches(&v("1.9.0")) && !r("^1.2.3").matches(&v("2.0.0")));
    assert!(!r("^1.2.3").matches(&v("1.2.2")));
    assert!(r("^0.2.3").matches(&v("0.2.9")) && !r("^0.2.3").matches(&v("0.3.0")));
    assert!(r("~1.2.3").matches(&v("1.2.9")) && !r("~1.2.3").matches(&v("1.3.0")));
    assert!(r(">=1.0.0, <2.0.0").matches(&v("1.999.0")));
    assert!(
        !r(">=1.0.0, <2.0.0").matches(&v("2.0.0")),
        "the upper bound is exclusive"
    );
    assert!(
        r(">=1.0.0, <2.0.0").matches(&v("1.0.0")),
        "the lower bound is inclusive"
    );
    assert!(r("1.*").matches(&v("1.7.3")) && !r("1.*").matches(&v("2.0.0")));
    assert!(r("*").matches(&v("9.9.9")));
}

#[test]
fn prereleases_match_only_when_named() {
    assert!(
        !r("^2.0.0").matches(&v("2.1.0-beta.1")),
        "a range does not admit pre-releases of other versions"
    );
    assert!(r(">=2.1.0-beta.1").matches(&v("2.1.0-beta.2")));
    assert!(!r(">=2.1.0-beta.1").matches(&v("2.2.0-beta.1")));
    assert!(r(">=2.1.0-beta.1").matches(&v("2.1.0")));
    assert!(r("2.1.0-rc.1").matches(&v("2.1.0-rc.1")));
    // Pre-release identifiers order as semver says: numerically, and before the release.
    assert!(v("1.0.0-beta.9") < v("1.0.0-beta.10"));
    assert!(v("1.0.0-rc.1") < v("1.0.0"));
}

#[test]
fn malformed_ranges_are_refused_never_read_as_anything() {
    for bad in [
        "",
        " ",
        "latest",
        "^",
        ">=",
        "1.2",
        "x.y.z",
        ">=1.0.0 <2.0.0",
        "1.0.0 || 2.0.0",
        "^1.0.0,",
        ",^1.0.0",
        "1.0.0\n",
        &"1".repeat(101),
        "=>1.0.0",
        "^v1.0.0",
    ] {
        assert!(Range::parse(bad).is_err(), "{bad:?} was accepted");
    }
}

// --- Declarations ----------------------------------------------------------------------------

fn decl(manifest: Value) -> Result<Declared, String> {
    declared(&manifest, "acme.app")
}

#[test]
fn required_optional_and_incompatible_declarations() {
    let d = decl(json!({
        "engines": {"yavin": "^2.0.0"},
        "main": "x.js",
        "extensionDependencies": ["acme.base"],
        "dependencies": {"acme.util": "^1.2.0", "acme.extra": {"version": ">=0.3.0", "optional": true}},
        "incompatibilities": {"acme.old": "<2.0.0"},
    }))
    .unwrap();
    let names: Vec<_> = d
        .requires
        .iter()
        .map(|r| (r.id.as_str(), r.range.text.as_str(), r.optional))
        .collect();
    assert_eq!(
        names,
        [
            ("acme.base", "*", false),
            ("acme.extra", ">=0.3.0", true),
            ("acme.util", "^1.2.0", false)
        ]
    );
    assert_eq!(d.required().count(), 2);
    assert_eq!(d.optional().count(), 1);
    assert_eq!(d.incompatible[0].0, "acme.old");
    assert!(d.code);
}

#[test]
fn malformed_duplicate_and_self_declarations_are_refused() {
    let base = json!({"engines": {"yavin": "^2.0.0"}, "main": "x.js"});
    let with = |key: &str, value: Value| {
        let mut m = base.clone();
        m[key] = value;
        decl(m)
    };
    for (key, value) in [
        ("extensionDependencies", json!(["acme.base", "acme.base"])),
        ("extensionDependencies", json!(["acme.app"])),
        ("extensionDependencies", json!(["Acme.Base"])),
        ("extensionDependencies", json!(["not an id"])),
        ("extensionDependencies", json!("acme.base")),
        ("extensionDependencies", json!([7])),
        ("dependencies", json!({"acme.app": "^1.0.0"})),
        ("dependencies", json!({"acme.base": "latest"})),
        (
            "dependencies",
            json!({"acme.base": {"version": "^1.0.0", "optional": "yes"}}),
        ),
        (
            "dependencies",
            json!({"acme.base": {"version": "^1.0.0", "when": "always"}}),
        ),
        ("dependencies", json!({"acme.base": {"optional": true}})),
        ("dependencies", json!({"acme.base": 1})),
        ("dependencies", json!(["acme.base"])),
        ("incompatibilities", json!({"acme.old": 2})),
        ("incompatibilities", json!({"acme.app": "*"})),
        ("incompatibilities", json!(["acme.old"])),
        ("manifestVersion", json!(2)),
        ("manifestVersion", json!("1")),
        ("engines", json!({"yavin": 2})),
        ("engines", json!({"yavin": "two"})),
        ("engines", json!("^2.0.0")),
    ] {
        assert!(
            with(key, value.clone()).is_err(),
            "{key}: {value} was accepted"
        );
    }
    // The same id twice across the forms, and both required and incompatible.
    let mut twice = base.clone();
    twice["extensionDependencies"] = json!(["acme.base"]);
    twice["dependencies"] = json!({"acme.base": "^1.0.0"});
    assert!(decl(twice).unwrap_err().contains("more than once"));
    let mut both = base.clone();
    both["dependencies"] = json!({"acme.base": "^1.0.0"});
    both["incompatibilities"] = json!({"acme.base": "<1.0.0"});
    assert!(decl(both).unwrap_err().contains("both"));
    // Too many.
    let mut many = base.clone();
    let list: Vec<String> = (0..=MAX_DEPENDENCIES)
        .map(|n| format!("acme.dep{n}"))
        .collect();
    many["extensionDependencies"] = json!(list);
    assert!(decl(many).is_err());
}

// --- The API policy --------------------------------------------------------------------------

#[test]
fn the_api_is_this_yavins_and_a_code_extension_must_say_which_it_supports() {
    let api_of = |engines: Value, main: bool| {
        let mut m = json!({"engines": engines});
        if main {
            m["main"] = json!("x.js");
        }
        decl(m).and_then(|d| check_api(&d))
    };
    assert!(api_of(json!({"yavin": "^2.0.0"}), true).is_ok());
    assert!(api_of(json!({"yavin": ">=2.0.0, <3.0.0"}), true).is_ok());
    // An exact version is that version only: 2.0.0 is not this API (2.1.0).
    assert!(api_of(json!({"yavin": "2.0.0"}), true).is_err());
    // EXT-25: the API is 2.1.0 (additive): 2.0 ranges and 2.1 ones fit.
    assert!(api_of(json!({"yavin": "^2.1.0"}), true).is_ok());
    assert!(api_of(json!({"yavin": "2.1.0"}), true).is_ok());
    // A future API, an older major, a pre-release of a later one: refused.
    for refused in [
        "^3.0.0",
        "^1.0.0",
        "2.0.1",
        "^2.2.0",
        ">=2.2.0-beta.1, <3.0.0",
    ] {
        let error = api_of(json!({"yavin": refused}), true).unwrap_err();
        assert!(
            error.contains(&format!("this Yavin provides {EXTENSION_API}")),
            "{refused}: {error}"
        );
    }
    // Code with no API stated: refused, not taken as "any".
    assert!(decl(json!({"main": "x.js"}))
        .unwrap_err()
        .contains("engines.yavin"));
    assert!(decl(json!({"main": "x.js", "engines": {}})).is_err());
    // Declarative: may omit it.
    assert!(decl(json!({})).and_then(|d| check_api(&d)).is_ok());
    assert_eq!(api(), v(EXTENSION_API));
}

#[test]
fn the_renderer_states_the_same_api_version() {
    let manifest = include_str!("../../src/services/extensions/manifest.ts");
    assert!(manifest.contains(&format!(
        "export const EXTENSION_API = \"{EXTENSION_API}\";"
    )));
}

// --- The resolver ----------------------------------------------------------------------------

#[test]
fn required_dependencies_resolve_against_installed_copies() {
    let candidates = [
        cand(
            "acme.app",
            "1.0.0",
            NEW,
            json!({"dependencies": {"acme.base": "^1.2.0"}}),
        ),
        cand("acme.base", "1.4.0", ON, json!({})),
    ];
    let plan = plan("acme.app", "1.0.0", &candidates).unwrap();
    assert_eq!(picked(&plan), ["acme.app@1.0.0", "acme.base@1.4.0"]);
    assert_eq!(plan.install, [("acme.app".to_string(), v("1.0.0"))]);
}

#[test]
fn missing_required_and_unavailable_optional_dependencies() {
    let missing = plan(
        "acme.app",
        "1.0.0",
        &[cand(
            "acme.app",
            "1.0.0",
            NEW,
            json!({"dependencies": {"acme.base": "^1.0.0"}}),
        )],
    )
    .unwrap_err();
    assert_eq!(missing.code, "DependencyMissing");
    assert!(
        missing.message.contains("acme.base ^1.0.0"),
        "{}",
        missing.message
    );
    // Optional and absent: it still resolves, and says so.
    let fine = plan(
        "acme.app",
        "1.0.0",
        &[cand(
            "acme.app",
            "1.0.0",
            NEW,
            json!({"dependencies": {"acme.extra": {"version": "^1.0.0", "optional": true}}}),
        )],
    )
    .unwrap();
    assert_eq!(picked(&fine), ["acme.app@1.0.0"]);
    assert!(fine.notes[0].contains("not installed"), "{:?}", fine.notes);
    // Optional, installed in a version outside its range: not used, not an error.
    let other = plan(
        "acme.app",
        "1.0.0",
        &[
            cand(
                "acme.app",
                "1.0.0",
                NEW,
                json!({"dependencies": {"acme.extra": {"version": "^2.0.0", "optional": true}}}),
            ),
            cand("acme.extra", "1.0.0", ON, json!({})),
        ],
    )
    .unwrap();
    assert!(other.notes[0].contains("is not used"), "{:?}", other.notes);
}

#[test]
fn a_dependency_is_never_replaced_downgraded_or_enabled_to_satisfy_another() {
    // Installed 1.0.0; 2.0.0 is available: the installed copy is what there is.
    let candidates = [
        cand(
            "acme.app",
            "1.0.0",
            NEW,
            json!({"dependencies": {"acme.base": "^2.0.0"}}),
        ),
        cand("acme.base", "1.0.0", ON, json!({})),
        cand("acme.base", "2.0.0", NEW, json!({})),
    ];
    let conflict = plan("acme.app", "1.0.0", &candidates).unwrap_err();
    assert_eq!(conflict.code, "DependencyConflict");
    assert!(
        conflict.message.contains("acme.base 1.0.0 is not ^2.0.0"),
        "{}",
        conflict.message
    );
    // A disabled dependency is not enabled for it.
    let disabled = plan(
        "acme.app",
        "1.0.0",
        &[
            cand(
                "acme.app",
                "1.0.0",
                NEW,
                json!({"extensionDependencies": ["acme.base"]}),
            ),
            cand("acme.base", "1.0.0", OFF, json!({})),
        ],
    )
    .unwrap_err();
    assert!(
        disabled.message.contains("disabled"),
        "{}",
        disabled.message
    );
}

#[test]
fn untrusted_or_api_incompatible_candidates_are_rejected_with_their_reason() {
    let mut untrusted = cand("acme.base", "1.1.0", NEW, json!({}));
    untrusted.unusable = Some("its signature is not verified".into());
    let candidates = [
        cand(
            "acme.app",
            "1.0.0",
            NEW,
            json!({"dependencies": {"acme.base": "^1.0.0"}}),
        ),
        untrusted,
        cand(
            "acme.base",
            "1.0.0",
            NEW,
            json!({"engines": {"yavin": "^3.0.0"}}),
        ),
    ];
    let conflict = plan("acme.app", "1.0.0", &candidates).unwrap_err();
    assert!(
        conflict
            .message
            .contains("acme.base 1.1.0: its signature is not verified"),
        "{}",
        conflict.message
    );
    assert!(
        conflict
            .message
            .contains("acme.base 1.0.0: it needs extension API ^3.0.0"),
        "{}",
        conflict.message
    );
    // The root itself with a future API.
    let future = plan(
        "acme.app",
        "1.0.0",
        &[cand(
            "acme.app",
            "1.0.0",
            NEW,
            json!({"engines": {"yavin": "^3.0.0"}}),
        )],
    )
    .unwrap_err();
    assert!(future.message.contains("extension API ^3.0.0"));
}

#[test]
fn available_dependencies_are_chosen_newest_first_and_backtrack() {
    // base 2.0.0 needs util ^2 (none); base 1.5.0 works with util 1.0.0.
    let candidates = [
        cand(
            "acme.app",
            "1.0.0",
            NEW,
            json!({"dependencies": {"acme.base": ">=1.0.0"}}),
        ),
        cand(
            "acme.base",
            "2.0.0",
            NEW,
            json!({"dependencies": {"acme.util": "^2.0.0"}}),
        ),
        cand(
            "acme.base",
            "1.5.0",
            NEW,
            json!({"dependencies": {"acme.util": "^1.0.0"}}),
        ),
        cand("acme.base", "1.0.0", NEW, json!({})),
        cand("acme.util", "1.0.0", NEW, json!({})),
    ];
    let first = plan("acme.app", "1.0.0", &candidates).unwrap();
    assert_eq!(
        picked(&first),
        ["acme.app@1.0.0", "acme.base@1.5.0", "acme.util@1.0.0"]
    );
    // Dependencies before what needs them.
    let order: Vec<_> = first.install.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(order, ["acme.util", "acme.base", "acme.app"]);
    // The same, whatever order the candidates come in, every run.
    let mut shuffled = candidates.to_vec();
    shuffled.reverse();
    for _ in 0..20 {
        assert_eq!(plan("acme.app", "1.0.0", &shuffled).unwrap(), first);
        shuffled.rotate_left(1);
    }
}

#[test]
fn direct_and_indirect_cycles_are_refused() {
    let direct = plan(
        "acme.a",
        "1.0.0",
        &[
            cand(
                "acme.a",
                "1.0.0",
                NEW,
                json!({"extensionDependencies": ["acme.b"]}),
            ),
            cand(
                "acme.b",
                "1.0.0",
                ON,
                json!({"extensionDependencies": ["acme.a"]}),
            ),
        ],
    )
    .unwrap_err();
    assert_eq!(direct.code, "DependencyCycle");
    assert!(
        direct.message.contains("acme.a → acme.b → acme.a"),
        "{}",
        direct.message
    );
    let indirect = plan(
        "acme.a",
        "1.0.0",
        &[
            cand(
                "acme.a",
                "1.0.0",
                NEW,
                json!({"extensionDependencies": ["acme.b"]}),
            ),
            cand(
                "acme.b",
                "1.0.0",
                ON,
                json!({"extensionDependencies": ["acme.c"]}),
            ),
            cand(
                "acme.c",
                "1.0.0",
                ON,
                json!({"extensionDependencies": ["acme.a"]}),
            ),
        ],
    )
    .unwrap_err();
    assert_eq!(indirect.code, "DependencyCycle");
    // An optional edge that would close a cycle is not used (and said so); not an error.
    let optional = plan(
        "acme.a",
        "1.0.0",
        &[
            cand(
                "acme.a",
                "1.0.0",
                NEW,
                json!({"extensionDependencies": ["acme.b"]}),
            ),
            cand(
                "acme.b",
                "1.0.0",
                ON,
                json!({"dependencies": {"acme.a": {"version": "*", "optional": true}}}),
            ),
        ],
    )
    .unwrap();
    assert!(
        optional.notes.iter().any(|n| n.contains("cycle")),
        "{:?}",
        optional.notes
    );
}

#[test]
fn conflicting_constraints_and_incompatibilities() {
    // Two dependents want different majors of one dependency.
    let conflict = plan(
        "acme.app",
        "1.0.0",
        &[
            cand(
                "acme.app",
                "1.0.0",
                NEW,
                json!({"dependencies": {"acme.left": "*", "acme.right": "*"}}),
            ),
            cand(
                "acme.left",
                "1.0.0",
                NEW,
                json!({"dependencies": {"acme.base": "^1.0.0"}}),
            ),
            cand(
                "acme.right",
                "1.0.0",
                NEW,
                json!({"dependencies": {"acme.base": "^2.0.0"}}),
            ),
            cand("acme.base", "1.0.0", NEW, json!({})),
            cand("acme.base", "2.0.0", NEW, json!({})),
        ],
    )
    .unwrap_err();
    assert_eq!(conflict.code, "DependencyConflict");
    assert!(
        conflict.message.contains("acme.base"),
        "{}",
        conflict.message
    );
    // The root declares itself incompatible with a version its own dependency brings in.
    let clash = plan(
        "acme.app",
        "1.0.0",
        &[
            cand("acme.app", "1.0.0", NEW, json!({"dependencies": {"acme.util": "*"}, "incompatibilities": {"acme.base": "<2.0.0"}})),
            cand("acme.util", "1.0.0", ON, json!({"dependencies": {"acme.base": "*"}})),
            cand("acme.base", "1.0.0", ON, json!({})),
        ],
    )
    .unwrap_err();
    assert!(
        clash.message.contains("cannot run beside"),
        "{}",
        clash.message
    );
    // An installed extension declares itself incompatible with what is being installed.
    let other = plan(
        "acme.new",
        "1.0.0",
        &[
            cand("acme.new", "1.0.0", NEW, json!({})),
            cand(
                "acme.old",
                "1.0.0",
                ON,
                json!({"incompatibilities": {"acme.new": "*"}}),
            ),
        ],
    )
    .unwrap_err();
    assert_eq!(other.code, "DependencyConflict");
}

#[test]
fn an_update_that_would_break_an_installed_dependent_is_refused() {
    // acme.base 1.0.0 is installed, acme.app needs ^1; updating base to 2.0.0 would break it.
    let candidates = [
        cand("acme.base", "2.0.0", NEW, json!({})),
        cand(
            "acme.app",
            "1.0.0",
            ON,
            json!({"dependencies": {"acme.base": "^1.0.0"}}),
        ),
    ];
    let broken = plan("acme.base", "2.0.0", &candidates).unwrap_err();
    assert_eq!(broken.code, "WouldBreakDependents");
    assert!(
        broken
            .message
            .contains("acme.base 2.0.0 would break acme.app 1.0.0, which needs acme.base ^1.0.0"),
        "{}",
        broken.message
    );
    // A compatible update is fine; a disabled dependent does not hold it back.
    assert!(plan(
        "acme.base",
        "1.1.0",
        &[
            cand("acme.base", "1.1.0", NEW, json!({})),
            candidates[1].clone()
        ]
    )
    .is_ok());
    let mut off = candidates[1].clone();
    off.source = OFF;
    assert!(plan("acme.base", "2.0.0", &[candidates[0].clone(), off]).is_ok());
    // An optional dependent does not hold it back either.
    let optional = cand(
        "acme.app",
        "1.0.0",
        ON,
        json!({"dependencies": {"acme.base": {"version": "^1.0.0", "optional": true}}}),
    );
    assert!(plan("acme.base", "2.0.0", &[candidates[0].clone(), optional]).is_ok());
}

// --- Adversarial and generated graphs --------------------------------------------------------

/// A small deterministic generator (xorshift): the same graphs every run.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// `count` extensions with `versions` each, each version depending on a few later ones.
fn generated(seed: u64, count: usize, versions: usize) -> Vec<Candidate> {
    let mut rng = Rng(seed);
    let mut all = Vec::new();
    for e in 0..count {
        for n in 0..versions {
            let mut deps = serde_json::Map::new();
            for _ in 0..rng.below(4) {
                let to = e + 1 + rng.below(5) as usize;
                if to < count {
                    let range = match rng.below(3) {
                        0 => "*".to_string(),
                        1 => format!("^{}.0.0", 1 + rng.below(versions as u64)),
                        _ => format!(">={}.0.0", 1 + rng.below(versions as u64)),
                    };
                    deps.insert(format!("acme.e{to}"), json!(range));
                }
            }
            all.push(cand(
                &format!("acme.e{e}"),
                &format!("{}.0.0", n + 1),
                NEW,
                json!({"dependencies": deps}),
            ));
        }
    }
    all
}

#[test]
fn generated_graphs_resolve_the_same_way_every_time_and_plans_hold() {
    for seed in 1..=40u64 {
        let candidates = generated(seed * 7919, 30, 4);
        let first = plan("acme.e0", "*", &candidates);
        let mut reversed = candidates.clone();
        reversed.reverse();
        assert_eq!(plan("acme.e0", "*", &reversed), first, "seed {seed}");
        let Ok(found) = first else { continue };
        // Whatever it chose satisfies every requirement of everything it chose.
        let chosen: BTreeMap<&str, &Version> = found
            .selected
            .iter()
            .map(|(id, v)| (id.as_str(), v))
            .collect();
        for (id, version) in &found.selected {
            let candidate = candidates
                .iter()
                .find(|c| c.id == *id && c.version == *version)
                .unwrap();
            for need in candidate.declared.required() {
                assert!(
                    need.range.matches(chosen[need.id.as_str()]),
                    "seed {seed}: {id} {version} needs {} {}",
                    need.id,
                    need.range.text
                );
            }
        }
        // And installs dependencies before what needs them.
        let at: BTreeMap<&str, usize> = found
            .install
            .iter()
            .enumerate()
            .map(|(n, (id, _))| (id.as_str(), n))
            .collect();
        for (id, version) in &found.install {
            let candidate = candidates
                .iter()
                .find(|c| c.id == *id && c.version == *version)
                .unwrap();
            for need in candidate.declared.required() {
                assert!(
                    at[need.id.as_str()] < at[id.as_str()],
                    "seed {seed}: {} before {id}",
                    need.id
                );
            }
        }
    }
}

#[test]
fn a_pathological_graph_is_cut_off_not_left_running() {
    // Every level offers many versions; the last level satisfies none: an exponential search
    // without a budget.
    let levels = 12;
    let mut candidates = Vec::new();
    for level in 0..levels {
        for n in 1..=8 {
            let deps = if level + 1 < levels {
                json!({"dependencies": {format!("acme.l{}", level + 1): "*"}})
            } else {
                json!({"dependencies": {"acme.never": "^1.0.0"}})
            };
            candidates.push(cand(
                &format!("acme.l{level}"),
                &format!("{n}.0.0"),
                NEW,
                deps,
            ));
        }
    }
    candidates.push(cand("acme.never", "2.0.0", NEW, json!({})));
    let started = std::time::Instant::now();
    let conflict = plan("acme.l0", "*", &candidates).unwrap_err();
    assert!(
        matches!(conflict.code, "TooComplex" | "DependencyConflict"),
        "{conflict:?}"
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_wide_graph_of_many_extensions_resolves_quickly() {
    let mut candidates = vec![cand(
        "acme.root",
        "1.0.0",
        NEW,
        json!({"dependencies": (0..60).map(|n| (format!("acme.w{n}"), json!("^1.0.0"))).collect::<serde_json::Map<_, _>>()}),
    )];
    for n in 0..60 {
        for version in ["1.0.0", "1.1.0", "2.0.0"] {
            candidates.push(cand(&format!("acme.w{n}"), version, NEW, json!({})));
        }
    }
    let started = std::time::Instant::now();
    let found = plan("acme.root", "1.0.0", &candidates).unwrap();
    assert_eq!(found.selected.len(), 61);
    assert!(found
        .selected
        .iter()
        .filter(|(id, _)| id != "acme.root")
        .all(|(_, v)| *v == Version::parse("1.1.0").unwrap()));
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
}
