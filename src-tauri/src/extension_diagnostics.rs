//! Extension diagnostics (EXT-14): what happened to an extension -- an install refused, a
//! signature that did not verify, a permission denied, a dependency missing, a sandbox that
//! could not be set up, a host that crashed or ran out of time -- as typed records the user can
//! read, act on, copy and clear.
//!
//! - **One catalog** (`classify`): every native error code Yavin produces maps to a category,
//!   a severity, whether it is a *security refusal* (Yavin said no, on purpose) or a *failure*
//!   (something broke), a user-safe summary and, where there is one, what to do next. The code
//!   is stable; the window does not classify anything.
//! - **Redacted before kept** (`redact`): detail text loses absolute paths (to `<path>`), anything
//!   that looks like a credential (`token=`, `Bearer …`, long hex or base64 runs, to
//!   `<redacted>`), environment assignments, control characters, and is cut to
//!   `MAX_DETAIL`. Secret values never reach a record in the first place: the native layer never
//!   passes them to one (EXT-13).
//! - **Bounded.** In memory: the latest `MAX_RECORDS`; a record repeated within `REPEAT_WINDOW`
//!   (same code, extension, window) is counted, not added. On disk: `diagnostics.jsonl` in the
//!   extensions folder, rotated to `diagnostics.1.jsonl` past `MAX_FILE` -- at most two files;
//!   older records are gone. Writing is best effort: a full disk or a locked file drops the
//!   write, never an enforcement decision or a cleanup.
//! - **Whose.** A record of a host session carries its window (EXT-11); a window sees its own
//!   records and the application's (installs, recovery, profiles), never another window's.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The most records kept in memory.
pub const MAX_RECORDS: usize = 500;
/// The longest detail text kept.
pub const MAX_DETAIL: usize = 500;
/// The largest diagnostics file before it is rotated.
pub const MAX_FILE: u64 = 256 * 1024;
/// A record repeated within this is counted on the earlier one.
pub const REPEAT_WINDOW: Duration = Duration::from_secs(10);
const FILE: &str = "diagnostics.jsonl";
const ROTATED: &str = "diagnostics.1.jsonl";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Install,
    Trust,
    Permission,
    Dependency,
    Api,
    Sandbox,
    Timeout,
    Crash,
    Resource,
    Storage,
    Profile,
    Recovery,
    Host,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

/// What a code means, said once.
#[derive(Clone, Debug, PartialEq)]
pub struct Meaning {
    pub category: Category,
    pub severity: Severity,
    /// Yavin refused on purpose (a check held) -- not something broken.
    pub refusal: bool,
    pub summary: &'static str,
    pub remedy: Option<&'static str>,
}

/// The catalog: every native code Yavin's extension system produces, what it is and what to
/// do. An unknown code is a failure of the host category, said as such.
pub fn classify(code: &str) -> Meaning {
    use Category::*;
    use Severity::*;
    let m = |category, severity, refusal, summary, remedy| Meaning {
        category,
        severity,
        refusal,
        summary,
        remedy,
    };
    match code {
        // Installation (EXT-02, EXT-03, EXT-06).
        "IntegrityFailed" => m(Install, Error, true, "The package did not match its published checksum.", Some("Try again later; if it persists, the registry may be serving a damaged or changed package.")),
        "UnsafePackage" | "TooLarge" => m(Install, Error, true, "The package contains unsafe files or is too large.", Some("Do not install it. Report it to its publisher.")),
        "InvalidPackage" | "MalformedPackage" | "InvalidManifest" | "ManifestMismatch" => m(Install, Error, true, "The package is not a valid extension, or not the one it claims to be.", Some("Install a version the publisher has fixed.")),
        "UnsupportedPackage" => m(Install, Warning, true, "The package is a VS Code extension with nothing Yavin can install.", None),
        "InstallFailed" | "RollbackFailed" | "PackageMissing" => m(Install, Error, false, "Installing or updating did not complete.", Some("Try again. The previously installed version was kept.")),
        "InstallRolledBack" => m(Install, Warning, false, "An update did not complete; the previous version was restored.", Some("Try the update again, or keep the version you have.")),
        "MarketplaceUnavailable" | "UnexpectedContent" | "UnexpectedRedirect" | "OutsideRegistry" | "InsecureTransport" | "RateLimited" => m(Install, Warning, false, "The marketplace could not be reached safely.", Some("Check the connection and the marketplace address in Settings, then try again.")),
        // Package trust (EXT-09).
        "SignatureMissing" | "SignatureInvalid" | "SignatureMalformed" | "UntrustedKey" | "KeyRevoked" | "KeyExpired" => m(Trust, Error, true, "The package's signature did not verify under a key Yavin trusts, so it was not installed.", Some("Do not install it from this source. A newer Yavin may trust a newer registry key.")),
        "VerificationUnavailable" => m(Trust, Warning, true, "The package's signature could not be checked, so it was not installed.", Some("Try again later.")),
        // Permissions and ownership (EXT-07, EXT-11).
        "PermissionDenied" => m(Permission, Warning, true, "The extension asked for something it is not allowed.", Some("Allow it on the extension's page if you trust it.")),
        "NotOwned" | "UnknownMethod" | "InvalidRequest" | "NotOwner" | "StaleGeneration" => m(Permission, Warning, true, "The extension sent a request that is not its to make.", Some("If this repeats, disable the extension and report it to its publisher.")),
        "TrustRequired" => m(Permission, Info, true, "Extensions' code does not run in an untrusted folder.", Some("Trust the folder (File › Manage Workspace Trust) if you trust its contents.")),
        "ExtensionDisabled" => m(Permission, Info, true, "The extension is disabled.", Some("Enable it from the Extensions view.")),
        "ExtensionChanged" => m(Permission, Info, true, "The running code is no longer the installed copy.", Some("Reload extensions.")),
        // Dependencies and the API (EXT-12).
        "DependencyMissing" | "DependencyConflict" | "DependencyUnavailable" | "DependencyNotLoaded" | "DependencyCycle" | "TooComplex" => m(Dependency, Error, true, "The extension's dependencies are missing, disabled, incompatible or circular.", Some("Install or enable what it needs, in a compatible version.")),
        "WouldBreakDependents" => m(Dependency, Warning, true, "The update would break an installed extension that needs this one; nothing was changed.", Some("Update or disable the dependent extension first.")),
        "IncompatibleApi" => m(Api, Error, true, "The extension needs another version of Yavin's extension API.", Some("Install a version made for this Yavin, or update Yavin.")),
        // The sandbox and resources (EXT-10).
        "SandboxUnavailable" => m(Sandbox, Error, true, "Extension code runs only in Yavin's sandbox, which could not be set up.", Some("Reinstall Yavin. Extensions' themes and snippets still work.")),
        "HostCrashedRepeatedly" => m(Crash, Error, false, "The extension host kept ending unexpectedly; it is held off for a while.", Some("Disable the extension that crashes, then restart the extension host.")),
        "HostCrashed" => m(Crash, Error, false, "The extension host ended unexpectedly.", Some("If it repeats, disable the extension that was running.")),
        "HostWatchdog" => m(Timeout, Error, false, "An extension ran past its time limit and could not be interrupted; its host was ended.", Some("Disable the extension that was running.")),
        "Timeout" | "ActivationTimeout" => m(Timeout, Warning, false, "An extension did not answer in time.", Some("If it repeats, disable it.")),
        "TooManyRequests" | "MessageBudget" | "MessageTooLarge" => m(Resource, Warning, true, "An extension sent more than Yavin accepts; the excess was refused.", Some("If it repeats, disable it.")),
        "HostFailed" | "HostUnavailable" => m(Host, Error, false, "The extension host could not be started.", Some("Reinstall Yavin.")),
        // Profiles, settings and secrets (EXT-13).
        "SecretStorageUnavailable" => m(Storage, Error, false, "The system's credential store is not available, so no secret was read or kept.", None),
        "SecretCorrupted" => m(Storage, Warning, false, "A stored secret could not be read.", Some("The extension can store it again.")),
        "SecretOwnerChanged" => m(Storage, Warning, true, "A secret was kept by another copy of this extension (installed from elsewhere), so this one cannot read it.", Some("The extension can store a new one.")),
        "SecretInvalid" | "SecretTooLarge" | "NoWorkspace" => m(Storage, Warning, true, "An extension's secret request was not valid.", None),
        "ProfileNotFound" | "ProfileActive" | "ProfileDependency" => m(Profile, Warning, true, "The extension profile change could not be made as asked.", None),
        // Recovery (EXT-02).
        "InventoryRecovered" => m(Recovery, Warning, false, "Yavin repaired its record of installed extensions.", Some("Check that your extensions are as expected; repaired ones may be disabled until you enable them.")),
        "SafeMode" => m(Host, Info, true, "Safe mode: no extension code runs.", Some("Turn safe mode off from the Extensions view.")),
        _ => m(Host, Error, false, "Something went wrong in the extension system.", None),
    }
}

/// One thing that happened.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// Seconds since the Unix epoch.
    pub at: u64,
    pub code: String,
    pub category: Category,
    pub severity: Severity,
    pub refusal: bool,
    pub extension: Option<String>,
    pub version: Option<String>,
    /// The window (its native label) a host session belonged to; none: the application's.
    pub window: Option<String>,
    pub session: Option<u32>,
    /// install, update, load, activation, request, host, recovery, profile, secret.
    pub phase: String,
    pub summary: String,
    pub remedy: Option<String>,
    /// Redacted.
    pub detail: Option<String>,
    /// Ties records of one install, session or recovery together (not an authorization).
    pub correlation: Option<String>,
    /// Times it happened within `REPEAT_WINDOW` of the first.
    pub count: u32,
    /// `native`, or `window` for what the window reported (classified natively all the same).
    pub source: String,
}

/// A record about to be made: what is known where it happened.
#[derive(Default, Clone, Debug)]
pub struct Event {
    pub code: String,
    pub extension: Option<String>,
    pub version: Option<String>,
    pub window: Option<String>,
    pub session: Option<u32>,
    pub phase: &'static str,
    pub detail: Option<String>,
    pub correlation: Option<String>,
}

impl Event {
    pub fn new(code: &str, phase: &'static str) -> Event {
        Event {
            code: code.to_string(),
            phase,
            ..Event::default()
        }
    }
    pub fn extension(mut self, id: impl Into<String>) -> Event {
        self.extension = Some(id.into());
        self
    }
    pub fn version(mut self, version: impl Into<String>) -> Event {
        self.version = Some(version.into());
        self
    }
    pub fn window(mut self, window: impl Into<String>, session: u32) -> Event {
        self.window = Some(window.into());
        self.session = Some(session);
        self
    }
    pub fn detail(mut self, detail: impl Into<String>) -> Event {
        self.detail = Some(detail.into());
        self
    }
    pub fn correlation(mut self, correlation: impl Into<String>) -> Event {
        self.correlation = Some(correlation.into());
        self
    }
}

/// The code of a `Code: message` error, if it has one.
pub fn code_of(error: &str) -> &str {
    match error.split_once(':') {
        Some((code, _)) if !code.is_empty() && code.bytes().all(|b| b.is_ascii_alphanumeric()) => {
            code
        }
        _ => "Unknown",
    }
}

/// `text` made safe to keep and show: no absolute paths, nothing that looks like a credential
/// or an environment assignment, no control characters, at most `MAX_DETAIL` characters.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len().min(MAX_DETAIL + 16));
    for word in text.split_inclusive(|c: char| c.is_whitespace()) {
        let (core, space) = match word.char_indices().last() {
            Some((at, c)) if c.is_whitespace() => (&word[..at], &word[at..]),
            _ => (word, ""),
        };
        out.push_str(&redact_word(core));
        out.push_str(if space.is_empty() { "" } else { " " });
    }
    // A credential after "Bearer" or "Basic" is the next word, whatever it looks like.
    let mut words: Vec<String> = out.split(' ').map(str::to_string).collect();
    for n in 1..words.len() {
        let before = words[n - 1].to_ascii_lowercase();
        if (before == "bearer" || before == "basic") && !words[n].is_empty() {
            words[n] = "<redacted>".into();
        }
    }
    let joined: String = words
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    if joined.chars().count() > MAX_DETAIL {
        let cut: String = joined.chars().take(MAX_DETAIL).collect();
        format!("{cut}…")
    } else {
        joined
    }
}

fn redact_word(word: &str) -> String {
    // Keep surrounding punctuation (quotes, brackets, a trailing period or colon).
    let trim: &[char] = &[
        '"', '\'', '(', ')', '[', ']', '{', '}', ',', ';', '.', ':', '`',
    ];
    let start = word.len() - word.trim_start_matches(trim).len();
    let end = word.trim_end_matches(trim).len().max(start);
    let (lead, core, tail) = (&word[..start], &word[start..end], &word[end..]);
    let lower = core.to_ascii_lowercase();
    let secret_key = |key: &str| {
        [
            "token",
            "secret",
            "password",
            "passwd",
            "pwd",
            "apikey",
            "api_key",
            "api-key",
            "key",
            "auth",
            "authorization",
            "credential",
            "session",
            "cookie",
        ]
        .iter()
        .any(|k| key == *k || key.ends_with(&format!("_{k}")) || key.ends_with(&format!("-{k}")))
    };
    // A path first: `C:\…` is not a `key:value`.
    let replaced = if is_path(core) {
        "<path>".to_string()
    } else if lower.starts_with("http://") || lower.starts_with("https://") {
        // A URL keeps its origin, never its path or query (a token may be in either).
        let rest = &core[core.find("://").map(|i| i + 3).unwrap_or(0)..];
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        let host = host.rsplit('@').next().unwrap_or(host);
        format!(
            "{}{host}/…",
            &core[..core.find("://").map(|i| i + 3).unwrap_or(0)]
        )
    } else if let Some((key, value)) = core
        .split_once(['=', ':'])
        .filter(|(k, v)| !k.is_empty() && !v.is_empty() && !k.contains('/') && !k.contains('\\'))
    {
        if secret_key(&key.to_ascii_lowercase())
            || key
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                && key.len() > 1
        {
            // A credential, or an environment assignment (FOO_BAR=...): the name only.
            format!("{key}=<redacted>")
        } else if is_path(value) {
            format!("{key}=<path>")
        } else {
            core.to_string()
        }
    } else if is_path(core) {
        "<path>".to_string()
    } else if looks_secret(core) {
        "<redacted>".to_string()
    } else {
        core.to_string()
    };
    format!("{lead}{replaced}{tail}")
}

/// An absolute path: `C:\…`, `C:/…`, `\\server\…`, `/home/…`, `/Users/…`, `~/…`, `file:///…`.
fn is_path(text: &str) -> bool {
    let b = text.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || text.starts_with("\\\\")
        || text.starts_with("file:")
        || text.starts_with("~/")
        || (text.starts_with('/') && text.len() > 1 && text[1..].contains('/'))
}

/// A long run that looks like a key, a token or a hash: 24+ characters of hex, or of base64 /
/// URL-safe base64 with both letters and digits.
fn looks_secret(text: &str) -> bool {
    if text.len() < 24 {
        return false;
    }
    let hex = text.bytes().all(|b| b.is_ascii_hexdigit());
    let base64 = text
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_'))
        && text.bytes().any(|b| b.is_ascii_digit())
        && text.bytes().any(|b| b.is_ascii_alphabetic());
    hex || base64
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The diagnostics of one Yavin: the latest records, and the file they are kept in.
pub struct Diagnostics {
    folder: Option<PathBuf>,
    records: Mutex<VecDeque<Diagnostic>>,
    loaded: std::sync::atomic::AtomicBool,
}

impl Default for Diagnostics {
    fn default() -> Self {
        Diagnostics::in_folder(None)
    }
}

impl Diagnostics {
    /// Kept in `folder` (none: in memory only).
    pub fn in_folder(folder: Option<PathBuf>) -> Diagnostics {
        Diagnostics {
            folder,
            records: Mutex::new(VecDeque::new()),
            loaded: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn held(&self) -> std::sync::MutexGuard<'_, VecDeque<Diagnostic>> {
        let mut records = self.records.lock().unwrap_or_else(|p| p.into_inner());
        if !self.loaded.swap(true, std::sync::atomic::Ordering::SeqCst) {
            if let Some(folder) = &self.folder {
                for file in [ROTATED, FILE] {
                    let text = std::fs::read_to_string(folder.join(file)).unwrap_or_default();
                    for line in text.lines() {
                        if let Ok(record) = serde_json::from_str::<Diagnostic>(line) {
                            records.push_back(record);
                        }
                    }
                }
                while records.len() > MAX_RECORDS {
                    records.pop_front();
                }
            }
        }
        records
    }

    /// Records `event` (classified, redacted, deduplicated); returns the record.
    pub fn record(&self, event: Event) -> Diagnostic {
        self.record_from(event, "native")
    }

    /// What the window reported (an activation that timed out, say): classified here, from a
    /// short list of codes the window can observe, redacted, and marked as the window's.
    pub fn record_from_window(&self, window: &str, event: Event) -> Result<Diagnostic, String> {
        const WINDOW_CODES: [&str; 5] = [
            "ActivationTimeout",
            "Timeout",
            "HostCrashed",
            "ActivationFailed",
            "CommandFailed",
        ];
        if !WINDOW_CODES.contains(&event.code.as_str()) {
            return Err(format!(
                "InvalidRequest: \"{}\" is not a code the window reports.",
                event.code
            ));
        }
        if event
            .extension
            .as_deref()
            .is_some_and(|id| ide_workspace::extension_id::canonical_id(id).as_deref() != Some(id))
        {
            return Err("InvalidRequest: not an extension id.".into());
        }
        let mut event = event;
        event.window = Some(window.to_string());
        event.session = None;
        Ok(self.record_from(event, "window"))
    }

    fn record_from(&self, event: Event, source: &str) -> Diagnostic {
        let meaning = classify(&event.code);
        let at = now();
        let record = Diagnostic {
            at,
            // A code is a word: anything else (a message passed by mistake) is not kept as one.
            code: if (1..=60).contains(&event.code.len())
                && event.code.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                event.code.clone()
            } else {
                "Unknown".into()
            },
            category: meaning.category,
            severity: meaning.severity,
            refusal: meaning.refusal,
            extension: event.extension,
            version: event.version.map(|v| v.chars().take(64).collect()),
            window: event.window,
            session: event.session,
            phase: event.phase.to_string(),
            summary: meaning.summary.to_string(),
            remedy: meaning.remedy.map(str::to_string),
            detail: event.detail.map(|d| redact(&d)).filter(|d| !d.is_empty()),
            // Made natively (an operation id, a session number), never from user data: kept to
            // its safe characters, not redacted (an id is not a credential).
            correlation: event.correlation.map(|c| {
                c.chars()
                    .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                    .take(80)
                    .collect()
            }),
            count: 1,
            source: source.to_string(),
        };
        let mut records = self.held();
        // Repeated: counted on the earlier record, not added (a flood stays one line).
        if let Some(earlier) = records.iter_mut().rev().find(|r| {
            r.code == record.code
                && r.extension == record.extension
                && r.window == record.window
                && r.session == record.session
                && at.saturating_sub(r.at) <= REPEAT_WINDOW.as_secs()
        }) {
            earlier.count = earlier.count.saturating_add(1);
            return earlier.clone();
        }
        records.push_back(record.clone());
        while records.len() > MAX_RECORDS {
            records.pop_front();
        }
        drop(records);
        self.persist(&record);
        record
    }

    /// Appends `record` to the file, rotating it first if it is full. Best effort: a failure
    /// is dropped -- diagnostics never stop anything else.
    fn persist(&self, record: &Diagnostic) {
        let Some(folder) = &self.folder else { return };
        let _ = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(folder)?;
            let file = folder.join(FILE);
            if std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0) >= MAX_FILE {
                let _ = std::fs::remove_file(folder.join(ROTATED));
                std::fs::rename(&file, folder.join(ROTATED))?;
            }
            let mut line = serde_json::to_string(record).map_err(std::io::Error::other)?;
            line.push('\n');
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file)?
                .write_all(line.as_bytes())
        })();
    }

    /// The records `window` may see -- its own and the application's -- newest first; for
    /// one extension if `extension`.
    pub fn visible(&self, window: &str, extension: Option<&str>) -> Vec<Diagnostic> {
        self.held()
            .iter()
            .rev()
            .filter(|r| r.window.as_deref().is_none_or(|w| w == window))
            .filter(|r| extension.is_none_or(|id| r.extension.as_deref() == Some(id)))
            .cloned()
            .collect()
    }

    /// Clears what `window` may see (for one extension if `extension`), in memory and on
    /// disk; other windows' records stay. How many.
    pub fn clear(&self, window: &str, extension: Option<&str>) -> usize {
        let mut records = self.held();
        let before = records.len();
        records.retain(|r| {
            let visible = r.window.as_deref().is_none_or(|w| w == window)
                && extension.is_none_or(|id| r.extension.as_deref() == Some(id));
            !visible
        });
        let cleared = before - records.len();
        let kept: Vec<Diagnostic> = records.iter().cloned().collect();
        drop(records);
        if let Some(folder) = &self.folder {
            let _ = std::fs::remove_file(folder.join(ROTATED));
            let text: String = kept
                .iter()
                .filter_map(|r| serde_json::to_string(r).ok())
                .map(|line| line + "\n")
                .collect();
            let _ = std::fs::write(folder.join(FILE), text);
        }
        cleared
    }

    /// A plain-text report of what `window` may see, for the user to copy: every field is
    /// already redacted; nothing else is added.
    #[cfg(test)]
    pub fn report(&self, window: &str, extension: Option<&str>, version: &str) -> String {
        render_report(&self.visible(window, extension), version)
    }
}

/// `records` as the report the user copies (each field already redacted).
pub fn render_report(records: &[Diagnostic], version: &str) -> String {
    let mut out = format!(
        "Yavin extension diagnostics\nYavin {version} · {} · {} record(s)\n",
        std::env::consts::OS,
        records.len()
    );
    for r in records {
        out.push_str(&format!(
            "\n[{}] {} {} ({}{}){}\n  {}\n",
            r.at,
            r.code,
            r.extension.as_deref().unwrap_or("-"),
            if r.refusal { "refused" } else { "failed" },
            if r.count > 1 {
                format!(", {}×", r.count)
            } else {
                String::new()
            },
            r.correlation
                .as_ref()
                .map(|c| format!(" #{c}"))
                .unwrap_or_default(),
            r.summary
        ));
        if let Some(remedy) = &r.remedy {
            out.push_str(&format!("  Next: {remedy}\n"));
        }
        if let Some(detail) = &r.detail {
            out.push_str(&format!("  Detail: {detail}\n"));
        }
    }
    out
}

/// Where a Yavin keeps its diagnostics: beside its extensions.
pub fn folder_of(extensions_root: &Path) -> PathBuf {
    extensions_root.join(".diagnostics")
}

#[cfg(test)]
#[path = "extension_diagnostics_tests.rs"]
mod tests;
