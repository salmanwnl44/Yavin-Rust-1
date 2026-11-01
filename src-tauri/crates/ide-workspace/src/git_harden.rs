//! EXT-33 E0.1/E0.3 (F-G1, V1, V2): the Git settings that stop a repository's own
//! configuration from making Git run a program while Yavin merely reads the repository.
//!
//! This lives in `ide-workspace` so it has one definition shared by both callers: the
//! user-facing Git (`git.rs` in the `yavin-ide` crate, for untrusted workspaces) and Yavin's
//! own background bookkeeping (`operations::git_dirty`, which checks whether paths match the
//! index). If the two ever drift, "Yavin's own bookkeeping is hardened" stops being true; one
//! source keeps it true.
//!
//! Two parts:
//! - [`HARDENING`], a fixed list of `-c` settings, applied to every hardened command. `-c`
//!   beats the repository's own `.git/config`, and an empty value clears the key.
//! - [`driver_overrides_from`], the per-name overrides emptying each filter and diff driver the
//!   configuration defines (a driver is chosen by name from `.gitattributes`, so no fixed list
//!   can name them in advance).

/// The fixed `-c` settings prepended to every hardened Git command. Each neutralises a
/// configuration key a repository can set to make Git run a program during ordinary,
/// read-looking operations, or clears a path a downloaded folder could otherwise point at.
pub const HARDENING: &[&str] = &[
    "-c",
    "core.fsmonitor=",
    "-c",
    "core.hooksPath=",
    "-c",
    "core.pager=cat",
    "-c",
    "core.editor=true",
    "-c",
    "core.sshCommand=",
    "-c",
    "core.askpass=",
    "-c",
    "core.alternateRefsCommand=",
    "-c",
    "diff.external=",
    "-c",
    "log.showSignature=false",
    "-c",
    "gpg.program=",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "uploadpack.packObjectsHook=",
    "-c",
    "safe.bareRepository=explicit",
    // EXT-33 E0.3 (V1): a submodule or an embedded repository carries its own configuration,
    // which the per-name driver overrides (computed from the outer repository) cannot see.
    // `git status` and `git diff` otherwise recurse into it and run its filters and diff
    // drivers. Ignoring submodule state for every hardened command stops that for both layouts
    // on every status and diff path at once, so no call site can forget it. An untrusted view
    // then does not report a submodule's own dirtiness; that is the safe trade (its filters
    // are emptied too). A trusted repository is never hardened, so its submodules are unchanged.
    "-c",
    "diff.ignoreSubmodules=all",
    // EXT-33 E0.3 (review note): the non-OpenPGP signature programs, which `gpg.program=`
    // does not cover. Yavin never asks Git for signature status (%G?, %(signature)), so these
    // run only for a compromised window (outside the EXT-07 model); emptied as defence in depth.
    "-c",
    "gpg.ssh.program=",
    "-c",
    "gpg.x509.program=",
];

/// The regex for `git config --get-regexp` that lists every filter and diff driver key.
pub const DRIVER_REGEXP: &str = r"^(filter|diff)\.";

/// The `-c key=value` overrides that empty every filter and diff driver named in `listed`, the
/// NUL-separated output of `git config -z --name-only --get-regexp` with [`DRIVER_REGEXP`]
/// (run under [`HARDENING`], so listing the names runs none of the drivers).
///
/// `Err` if a driver's name cannot be spelled as a `-c` key -- one holding `=` -- so the
/// operation is refused rather than leaving that driver live.
pub fn driver_overrides_from(listed: &str) -> Result<Vec<String>, String> {
    let mut overrides = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for name in listed.split('\0').filter(|n| !n.is_empty()) {
        let (section, keys): (&str, &[&str]) = if name.starts_with("filter.") {
            (
                "filter",
                &["clean=", "smudge=", "process=", "required=false"],
            )
        } else if name.starts_with("diff.") {
            ("diff", &["textconv=", "command="])
        } else {
            continue;
        };
        // `<section>.<driver>.<key>`; two-part keys (`diff.renames`) name no driver.
        let Some((driver, _key)) = name[section.len() + 1..].rsplit_once('.') else {
            continue;
        };
        if driver.contains('=') {
            return Err(format!("This repository's configuration names a Git driver Yavin cannot safely disable ({section}.{driver}), so Yavin does not run Git on it."));
        }
        if seen.insert((section, driver.to_string())) {
            for key in keys {
                overrides.push("-c".to_string());
                overrides.push(format!("{section}.{driver}.{key}"));
            }
        }
    }
    Ok(overrides)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fixed_set_is_c_key_pairs_and_names_each_program_key() {
        assert_eq!(HARDENING.len() % 2, 0, "pairs of -c and key=value");
        let keys: Vec<&str> = HARDENING.iter().skip(1).step_by(2).copied().collect();
        assert!(HARDENING.iter().step_by(2).all(|c| *c == "-c"));
        for key in [
            "core.fsmonitor=",
            "core.hooksPath=",
            "core.sshCommand=",
            "diff.external=",
            "gpg.program=",
            "gpg.ssh.program=",
            "gpg.x509.program=",
            "credential.helper=",
            "diff.ignoreSubmodules=all",
        ] {
            assert!(keys.contains(&key), "{key} in {keys:?}");
        }
    }

    #[test]
    fn every_named_driver_is_emptied_by_its_exact_name() {
        let listed =
            "filter.Mixed.Case.clean\0filter.lfs.smudge\0diff.pic.textconv\0diff.renames\0";
        let overrides = driver_overrides_from(listed).unwrap();
        let pairs: Vec<&str> = overrides
            .iter()
            .skip(1)
            .step_by(2)
            .map(String::as_str)
            .collect();
        assert!(overrides.iter().step_by(2).all(|c| c == "-c"));
        for expected in [
            "filter.Mixed.Case.clean=",
            "filter.Mixed.Case.smudge=",
            "filter.Mixed.Case.process=",
            "filter.Mixed.Case.required=false",
            "filter.lfs.clean=",
            "filter.lfs.process=",
            "diff.pic.textconv=",
            "diff.pic.command=",
        ] {
            assert!(pairs.contains(&expected), "{expected} in {pairs:?}");
        }
        // Two-part keys name no driver.
        assert!(
            !pairs.iter().any(|p| p.starts_with("diff.renames")),
            "{pairs:?}"
        );
    }

    #[test]
    fn a_driver_name_the_c_syntax_cannot_spell_is_refused() {
        let refused = driver_overrides_from("filter.a=b.clean\0").unwrap_err();
        assert!(refused.contains("cannot safely disable"), "{refused}");
    }
}
