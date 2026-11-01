# Yavin IDE 2.1.0 — first build

**Released:** 2026-10-19. **Platform:** Windows x64 (MSI). The first published build of Yavin; there is no earlier release to upgrade from.

## What it includes

The editor, terminal, Git and Local History, and the extension system (EXT-01 … EXT-22): Yavin's signed extension registry and Open VSX, packages verified before install, per-extension permissions enforced natively, extension code in a sandboxed host (an AppContainer with job limits), profiles and settings, diagnostics, and safe upgrade and recovery of installed extensions. The final audit is in [EXTENSION_RELEASE_AUDIT.md](EXTENSION_RELEASE_AUDIT.md).

## Known limitations — accepted for this release

The EXT-23 audit recommended **NO-GO** until the items below are resolved. The release owner accepted them for this first build; they remain open.

- **Registry signing key custody.** The key that signs Yavin's extension registry is kept as an unencrypted file on one machine, with no backup or rehearsed rotation. Until it is moved into secure custody and backed up, losing it would stop new registry indexes until a Yavin release with a new key, and its compromise would let whoever holds it publish registry indexes.
- **Registry index renewal.** The signed index expires on **2027-10-19** and nothing yet renews it automatically. A renewal must be published before then, or extensions with code can no longer be installed or updated from Yavin's registry.
- **CI.** The continuous-integration run of the release commit's predecessor failed in the UI test step; the cause is not yet identified. All suites pass locally (see the audit for exact results).
- **First-install replay.** A brand-new installation accepts any validly signed, unexpired registry index, including an older one. Only one index has been published so far, so there is nothing older to replay yet.
- **Executable extensions run only on Windows.** Elsewhere, themes and snippets apply, but no extension code runs.
- **Publisher identity is not verified.** A registry signature proves which registry published a package, not who wrote it.
- **Same-user malware** is outside the threat model: a program running as you can change Yavin's files and records.

## Upgrading and downgrading

Each later release will carry a higher version. The installer refuses to install an older Yavin over a newer one. Do not install builds of Yavin made from source before this release: they allow downgrades and can damage a newer extension inventory. Never install a test build (made with the `test-registry` feature): it shares this installer's upgrade identity and accepts a registry key from its environment.

## Checksum

`Yavin IDE_2.1.0_x64_en-US.msi` — SHA-256 `AA71EAA74E530539008B7097AFF107290580DFD5F9EDFCCF2BD3CDE7A2857235`. The installer is not code-signed, so Windows SmartScreen may warn on first run.
