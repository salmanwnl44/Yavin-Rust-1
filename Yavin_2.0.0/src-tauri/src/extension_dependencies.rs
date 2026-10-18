//! Extension dependencies and API compatibility (EXT-12): what a manifest may declare, which
//! extension API this Yavin provides, and a deterministic resolver -- native, so what the window
//! believes about versions, dependencies or compatibility never decides anything.
//!
//! **Declarations** (`declared`), strictly validated -- anything malformed is refused, never
//! read as "anything goes":
//!
//! - `manifestVersion`: 1 (or absent: 1).
//! - `engines.yavin`: the extension API range it supports. Required for an extension with code
//!   (`main`); a declarative one (themes, snippets) runs nothing and may omit it.
//! - `extensionDependencies`: `["publisher.name", ...]` -- required, any version (the
//!   IDE-07 form, kept).
//! - `dependencies`: `{"publisher.name": "<range>" | {"version": "<range>", "optional": true}}`.
//! - `incompatibilities`: `{"publisher.name": "<range>"}` -- it cannot run beside those versions.
//!
//! Ids are canonical (`ide_workspace::extension_id`); an extension cannot name itself; an id is
//! named once across all three; at most `MAX_DEPENDENCIES`.
//!
//! **Ranges** are the `semver` crate's (`VersionReq`): comparators `=`, `>`, `>=`, `<`, `<=`,
//! `~`, `^`, wildcards (`1.*`, `*`), several separated by commas. One rule is Yavin's: a bare
//! version (`1.2.3`) means exactly that version, as manifest authors (and npm) mean it -- not the
//! crate's caret. npm's `||` and space-separated comparators are refused, not reinterpreted.
//! A pre-release matches only a comparator naming that same major.minor.patch with a
//! pre-release (semver's rule).
//!
//! **The resolver** (`resolve`) takes the extension to install and candidate metadata -- never
//! the network -- and returns a complete plan or the reason there is none.

use ide_workspace::extension_id::canonical_id;
use semver::{Version, VersionReq};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// The extension API this Yavin provides (`EXTENSION_API` in `manifest.ts` is the same).
pub const EXTENSION_API: &str = "2.0.0";
/// The manifest format this Yavin reads.
pub const MANIFEST_VERSION: u64 = 1;
/// The most dependencies and incompatibilities one manifest may name, together.
pub const MAX_DEPENDENCIES: usize = 64;
/// The most candidate versions the resolver tries before it gives up (`TooComplex`).
pub const MAX_STEPS: usize = 100_000;

pub fn api() -> Version {
    Version::parse(EXTENSION_API).expect("EXTENSION_API is a version")
}

/// A version range as written, and what it means.
#[derive(Clone, Debug, PartialEq)]
pub struct Range {
    pub text: String,
    req: VersionReq,
}

impl Range {
    pub fn any() -> Range {
        Range {
            text: "*".into(),
            req: VersionReq::STAR,
        }
    }

    pub fn exactly(version: &Version) -> Range {
        Range::parse(&version.to_string()).expect("a version is a range")
    }

    pub fn parse(text: &str) -> Result<Range, String> {
        let bad = |why: &str| format!("\"{text}\" is not a version range: {why}");
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed.len() > 100 {
            return Err(bad("empty or too long"));
        }
        // On what was written: a trailing newline is not trimmed into validity.
        if text.chars().any(char::is_control) || trimmed.contains("||") {
            return Err(bad("`||` and control characters are not part of a range"));
        }
        let mut comparators = Vec::new();
        for part in trimmed.split(',') {
            let part = part.trim();
            if part.is_empty() {
                return Err(bad("an empty comparator"));
            }
            // npm's "1.0.0 2.0.0": not this syntax -- refused, not read as something else.
            let operand = part.trim_start_matches(['=', '<', '>', '^', '~']).trim();
            if operand.contains(char::is_whitespace) {
                return Err(bad("separate comparators with commas"));
            }
            // A bare version is that version exactly -- so it must be a whole one: "1.2" would be
            // the crate's caret, which is not what a bare version means here.
            let bare = !part.starts_with(['=', '<', '>', '^', '~']);
            if bare && !part.contains('*') && Version::parse(part).is_err() {
                return Err(bad(
                    "a version without an operator must be complete (x.y.z)",
                ));
            }
            comparators.push(if bare && Version::parse(part).is_ok() {
                format!("={part}")
            } else {
                part.to_string()
            });
        }
        let req = VersionReq::parse(&comparators.join(", ")).map_err(|e| bad(&e.to_string()))?;
        Ok(Range {
            text: trimmed.to_string(),
            req,
        })
    }

    pub fn matches(&self, version: &Version) -> bool {
        self.req.matches(version)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Requirement {
    pub id: String,
    pub range: Range,
    pub optional: bool,
}

/// What a manifest declares about the API and other extensions.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Declared {
    /// `engines.yavin`, if stated.
    pub api: Option<Range>,
    /// By id.
    pub requires: Vec<Requirement>,
    /// By id.
    pub incompatible: Vec<(String, Range)>,
    /// It has code (`main`).
    pub code: bool,
}

impl Declared {
    pub fn required(&self) -> impl Iterator<Item = &Requirement> {
        self.requires.iter().filter(|r| !r.optional)
    }
    pub fn optional(&self) -> impl Iterator<Item = &Requirement> {
        self.requires.iter().filter(|r| r.optional)
    }
}

/// An extension id a manifest names: canonical, and not its own.
fn other_id(raw: &str, own: &str, field: &str) -> Result<String, String> {
    if canonical_id(raw).as_deref() != Some(raw) {
        return Err(format!(
            "{field}: \"{raw}\" is not an extension id (publisher.name, lower case)"
        ));
    }
    if raw == own {
        return Err(format!("{field}: an extension cannot name itself"));
    }
    Ok(raw.to_string())
}

/// The declarations of the manifest of `id`, validated.
pub fn declared(manifest: &Value, id: &str) -> Result<Declared, String> {
    match manifest.get("manifestVersion") {
        None => {}
        Some(v) if v.as_u64() == Some(MANIFEST_VERSION) => {}
        Some(v) => {
            return Err(format!(
                "manifestVersion {v} is not one this Yavin reads (it reads {MANIFEST_VERSION})"
            ))
        }
    }
    let code = manifest.get("main").is_some_and(|main| !main.is_null());
    let api = match manifest.get("engines") {
        None | Some(Value::Null) => None,
        Some(Value::Object(engines)) => match engines.get("yavin") {
            None => None,
            Some(Value::String(range)) => {
                Some(Range::parse(range).map_err(|e| format!("engines.yavin: {e}"))?)
            }
            Some(_) => return Err("engines.yavin must be a version range".into()),
        },
        Some(_) => return Err("engines must be an object".into()),
    };
    if code && api.is_none() {
        return Err(
            "an extension with code must state the extension API it supports (engines.yavin)"
                .into(),
        );
    }
    let mut named = BTreeSet::new();
    let mut requires = Vec::new();
    let mut name = |id: String, field: &str| -> Result<String, String> {
        if !named.insert(id.clone()) {
            return Err(format!("{field}: {id} is named more than once"));
        }
        Ok(id)
    };
    match manifest.get("extensionDependencies") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            for one in list {
                let raw = one
                    .as_str()
                    .ok_or("extensionDependencies: each must be an extension id")?;
                let id = name(
                    other_id(raw, id, "extensionDependencies")?,
                    "extensionDependencies",
                )?;
                requires.push(Requirement {
                    id,
                    range: Range::any(),
                    optional: false,
                });
            }
        }
        Some(_) => return Err("extensionDependencies must be a list of extension ids".into()),
    }
    match manifest.get("dependencies") {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            for (raw, spec) in map {
                let field = format!("dependencies.{raw}");
                let dependency = name(other_id(raw, id, &field)?, &field)?;
                let (range, optional) = match spec {
                    Value::String(range) => (range.as_str(), false),
                    Value::Object(spec) => {
                        if spec.keys().any(|k| k != "version" && k != "optional") {
                            return Err(format!(
                                "{field}: only \"version\" and \"optional\" are read"
                            ));
                        }
                        let range = spec
                            .get("version")
                            .and_then(Value::as_str)
                            .ok_or(format!("{field}.version must be a version range"))?;
                        let optional = match spec.get("optional") {
                            None => false,
                            Some(Value::Bool(b)) => *b,
                            Some(_) => {
                                return Err(format!("{field}.optional must be true or false"))
                            }
                        };
                        (range, optional)
                    }
                    _ => {
                        return Err(format!(
                            "{field} must be a version range or {{\"version\", \"optional\"}}"
                        ))
                    }
                };
                requires.push(Requirement {
                    id: dependency,
                    range: Range::parse(range).map_err(|e| format!("{field}: {e}"))?,
                    optional,
                });
            }
        }
        Some(_) => return Err("dependencies must be an object of extension ids".into()),
    }
    let mut incompatible = Vec::new();
    match manifest.get("incompatibilities") {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            for (raw, spec) in map {
                let field = format!("incompatibilities.{raw}");
                let other = other_id(raw, id, &field)?;
                if named.contains(&other) {
                    return Err(format!(
                        "{field}: {other} is both a dependency and incompatible"
                    ));
                }
                let range = spec
                    .as_str()
                    .ok_or(format!("{field} must be a version range"))?;
                incompatible.push((
                    other,
                    Range::parse(range).map_err(|e| format!("{field}: {e}"))?,
                ));
            }
        }
        Some(_) => return Err("incompatibilities must be an object of extension ids".into()),
    }
    if requires.len() + incompatible.len() > MAX_DEPENDENCIES {
        return Err(format!(
            "it names more than {MAX_DEPENDENCIES} other extensions"
        ));
    }
    requires.sort_by(|a, b| a.id.cmp(&b.id));
    incompatible.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(Declared {
        api,
        requires,
        incompatible,
        code,
    })
}

/// Whether `declared`'s API range admits this Yavin's (the native policy: `engines.yavin` must
/// be satisfied by `EXTENSION_API`; a package's own version proves nothing).
pub fn check_api(declared: &Declared) -> Result<(), String> {
    match &declared.api {
        Some(range) if !range.matches(&api()) => Err(format!(
            "it needs extension API {}; this Yavin provides {EXTENSION_API}",
            range.text
        )),
        _ => Ok(()),
    }
}

// --- The resolver --------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Installed {
        enabled: bool,
    },
    /// Not installed: it would be.
    Available,
}

/// One version of one extension the resolver may choose.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub id: String,
    pub version: Version,
    pub source: Source,
    pub declared: Declared,
    /// Why it may not be used at all, from whoever knows (its signature is not trusted, it is
    /// for another platform, ...).
    pub unusable: Option<String>,
}

/// A complete plan: what runs, what would be installed (dependencies first), and what is not
/// used and why (optional dependencies).
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub selected: Vec<(String, Version)>,
    pub install: Vec<(String, Version)>,
    pub notes: Vec<String>,
}

#[derive(Debug, PartialEq)]
pub struct Conflict {
    pub code: &'static str,
    pub message: String,
}

impl Conflict {
    fn new(code: &'static str, message: String) -> Conflict {
        Conflict { code, message }
    }
    /// `Code: message`, as the window maps errors.
    pub fn text(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

struct Search<'a> {
    root: &'a str,
    /// Per id, the candidates in the order they are tried.
    options: BTreeMap<&'a str, Vec<&'a Candidate>>,
    steps: usize,
}

/// Why `candidate` cannot be used, whatever asks for it.
fn unusable(candidate: &Candidate) -> Option<String> {
    if let Some(why) = &candidate.unusable {
        return Some(why.clone());
    }
    if let Err(why) = check_api(&candidate.declared) {
        return Some(why);
    }
    if candidate.source == (Source::Installed { enabled: false }) {
        return Some("it is installed but disabled".into());
    }
    None
}

/// What among `selected` cannot run beside `candidate` (either side's `incompatibilities`).
fn clash(selected: &BTreeMap<&str, &Candidate>, candidate: &Candidate) -> Option<String> {
    for other in selected.values() {
        for (id, range) in &other.declared.incompatible {
            if *id == candidate.id && range.matches(&candidate.version) {
                return Some(format!(
                    "{} {} cannot run beside {} {}",
                    other.id, other.version, candidate.id, range.text
                ));
            }
        }
        for (id, range) in &candidate.declared.incompatible {
            if *id == other.id && range.matches(&other.version) {
                return Some(format!(
                    "it cannot run beside {} {} ({})",
                    other.id, other.version, range.text
                ));
            }
        }
    }
    None
}

type Pending<'a> = Vec<(&'a str, &'a Range, String)>;

impl<'a> Search<'a> {
    fn solve(
        &mut self,
        selected: BTreeMap<&'a str, &'a Candidate>,
        pending: Pending<'a>,
    ) -> Result<BTreeMap<&'a str, &'a Candidate>, Conflict> {
        let Some(((id, range, by), rest)) =
            pending.split_first().map(|(f, r)| (f.clone(), r.to_vec()))
        else {
            return Ok(selected);
        };
        if let Some(chosen) = selected.get(id) {
            return if range.matches(&chosen.version) {
                self.solve(selected, rest)
            } else {
                Err(Conflict::new(
                    "DependencyConflict",
                    format!(
                        "{by} needs {id} {}, but {id} {} is needed by another",
                        range.text, chosen.version
                    ),
                ))
            };
        }
        let options = self.options.get(id).cloned().unwrap_or_default();
        if options.is_empty() {
            return Err(Conflict::new(
                "DependencyMissing",
                format!("{by} needs {id} {}, which is not installed", range.text),
            ));
        }
        let mut reasons = Vec::new();
        let mut deeper: Option<Conflict> = None;
        for candidate in options {
            self.steps += 1;
            if self.steps > MAX_STEPS {
                return Err(Conflict::new(
                    "TooComplex",
                    format!(
                        "resolving {} tried more than {MAX_STEPS} versions",
                        self.root
                    ),
                ));
            }
            let named = format!("{} {}", candidate.id, candidate.version);
            if !range.matches(&candidate.version) {
                reasons.push(format!("{named} is not {}", range.text));
                continue;
            }
            if let Some(why) = unusable(candidate) {
                reasons.push(format!("{named}: {why}"));
                continue;
            }
            if let Some(why) = clash(&selected, candidate) {
                reasons.push(format!("{named}: {why}"));
                continue;
            }
            let mut next = selected.clone();
            next.insert(candidate.id.as_str(), candidate);
            let mut queue = rest.clone();
            for need in candidate.declared.required() {
                queue.push((need.id.as_str(), &need.range, named.clone()));
            }
            match self.solve(next, queue) {
                Ok(found) => return Ok(found),
                Err(conflict) if conflict.code == "TooComplex" => return Err(conflict),
                Err(conflict) => {
                    deeper.get_or_insert(conflict);
                }
            }
        }
        Err(deeper.unwrap_or_else(|| {
            Conflict::new(
                "DependencyConflict",
                format!("{by} needs {id} {}: {}", range.text, reasons.join("; ")),
            )
        }))
    }
}

/// A cycle among `edges` (id → ids), as a path, the first one in id order.
fn cycle(edges: &BTreeMap<&str, Vec<&str>>) -> Option<Vec<String>> {
    fn visit<'a>(
        at: &'a str,
        edges: &BTreeMap<&'a str, Vec<&'a str>>,
        path: &mut Vec<&'a str>,
        done: &mut BTreeSet<&'a str>,
    ) -> Option<Vec<String>> {
        if let Some(start) = path.iter().position(|p| *p == at) {
            let mut found: Vec<String> = path[start..].iter().map(|s| s.to_string()).collect();
            found.push(at.to_string());
            return Some(found);
        }
        if done.contains(at) {
            return None;
        }
        path.push(at);
        for next in edges.get(at).into_iter().flatten() {
            if let Some(found) = visit(next, edges, path, done) {
                return Some(found);
            }
        }
        path.pop();
        done.insert(at);
        None
    }
    let mut done = BTreeSet::new();
    for start in edges.keys() {
        if let Some(found) = visit(start, edges, &mut Vec::new(), &mut done) {
            return Some(found);
        }
    }
    None
}

/// The plan for running `root` at a version in `range`, from `candidates` alone.
///
/// Selection is deterministic: for an id that is installed, only its installed copy is a
/// candidate (a dependency is never replaced, updated, downgraded or enabled to satisfy
/// another); for one that is not, its available versions newest first -- and for `root` its
/// available versions only (it is what is being installed). Requirements are taken in order --
/// the root's, then each chosen version's, by id -- and the first version that fits all of them
/// is kept, trying the next when a deeper requirement fails. Then: no cycle among required
/// dependencies; no installed extension broken by a version this plan would put in place.
pub fn resolve(root: &str, range: &Range, candidates: &[Candidate]) -> Result<Plan, Conflict> {
    let mut by_id: BTreeMap<&str, Vec<&Candidate>> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for candidate in candidates {
        if seen.insert((
            candidate.id.as_str(),
            candidate.version.clone(),
            candidate.source.clone() != Source::Available,
        )) {
            by_id
                .entry(candidate.id.as_str())
                .or_default()
                .push(candidate);
        }
    }
    let mut options: BTreeMap<&str, Vec<&Candidate>> = BTreeMap::new();
    for (id, list) in &by_id {
        let installed: Vec<&Candidate> = list
            .iter()
            .copied()
            .filter(|c| c.source != Source::Available)
            .collect();
        let mut chosen: Vec<&Candidate> = if *id == root {
            list.iter()
                .copied()
                .filter(|c| c.source == Source::Available)
                .collect()
        } else if !installed.is_empty() {
            installed
        } else {
            list.clone()
        };
        chosen.sort_by(|a, b| b.version.cmp(&a.version));
        chosen.dedup_by(|a, b| a.version == b.version);
        options.insert(id, chosen);
    }
    let mut search = Search {
        root,
        options,
        steps: 0,
    };
    let selected = search.solve(
        BTreeMap::new(),
        vec![(root, range, "the install".to_string())],
    )?;

    // Required edges, and the optional ones that are installed and fit.
    let mut notes = Vec::new();
    let mut edges: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for chosen in selected.values() {
        let entry = edges.entry(chosen.id.as_str()).or_default();
        for need in chosen.declared.required() {
            entry.push(need.id.as_str());
        }
    }
    if let Some(path) = cycle(&edges) {
        return Err(Conflict::new(
            "DependencyCycle",
            format!("its dependencies form a cycle: {}", path.join(" → ")),
        ));
    }
    for chosen in selected.values() {
        for want in chosen.declared.optional() {
            let fits = selected.get(want.id.as_str()).copied().or_else(|| {
                by_id
                    .get(want.id.as_str())
                    .and_then(|list| list.iter().copied().find(|c| c.source != Source::Available))
            });
            match fits {
                Some(found) if want.range.matches(&found.version) && unusable(found).is_none() => {
                    let mut with = edges.clone();
                    with.entry(chosen.id.as_str())
                        .or_default()
                        .push(want.id.as_str());
                    if cycle(&with).is_some() {
                        notes.push(format!(
                            "{} can use {}, but not first: it would form a cycle",
                            chosen.id, want.id
                        ));
                    } else {
                        edges = with;
                    }
                }
                Some(found) => notes.push(format!(
                    "{} can use {} {}; {} {} is not used",
                    chosen.id, want.id, want.range.text, found.id, found.version
                )),
                None => notes.push(format!(
                    "{} can use {} {}, which is not installed",
                    chosen.id, want.id, want.range.text
                )),
            }
        }
    }

    // What this plan puts in place must not break an installed extension.
    let changed: BTreeMap<&str, &Candidate> = selected
        .iter()
        .filter(|(_, c)| c.source == Source::Available)
        .map(|(id, c)| (*id, *c))
        .collect();
    for installed in candidates.iter().filter(|c| {
        c.source == (Source::Installed { enabled: true }) && !changed.contains_key(c.id.as_str())
    }) {
        for need in installed.declared.required() {
            if let Some(new) = changed.get(need.id.as_str()) {
                if !need.range.matches(&new.version) {
                    return Err(Conflict::new(
                        "WouldBreakDependents",
                        format!(
                            "{} {} would break {} {}, which needs {} {}",
                            new.id,
                            new.version,
                            installed.id,
                            installed.version,
                            need.id,
                            need.range.text
                        ),
                    ));
                }
            }
        }
        for new in changed.values() {
            let mut beside = BTreeMap::new();
            beside.insert(installed.id.as_str(), installed);
            if let Some(why) = clash(&beside, new) {
                return Err(Conflict::new(
                    "DependencyConflict",
                    format!("{} {}: {why}", new.id, new.version),
                ));
            }
        }
    }

    // Installed dependencies first, then what needs them; ties by id.
    let mut install = Vec::new();
    let mut placed = BTreeSet::new();
    while placed.len() < changed.len() {
        let next = changed.keys().copied().find(|id| {
            !placed.contains(id)
                && edges
                    .get(id)
                    .into_iter()
                    .flatten()
                    .all(|d| placed.contains(d) || !changed.contains_key(d))
        });
        let Some(id) = next else { break };
        placed.insert(id);
        install.push((id.to_string(), changed[id].version.clone()));
    }
    Ok(Plan {
        selected: selected
            .iter()
            .map(|(id, c)| (id.to_string(), c.version.clone()))
            .collect(),
        install,
        notes,
    })
}

#[cfg(test)]
#[path = "extension_dependencies_tests.rs"]
mod tests;
