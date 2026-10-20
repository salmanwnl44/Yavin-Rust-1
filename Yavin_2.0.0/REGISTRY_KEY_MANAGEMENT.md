# Yavin registry signing — key management and operations (EXT-24)

**Status: a procedure, not yet an arrangement.** Nothing in this document has been exercised with the production key. Each step says what evidence closes it. Until the custody items are closed, the production key is **not** in secure custody and the release recommendation stays NO-GO (see `EXTENSION_RELEASE_AUDIT.md`).

## What the key does, and what it does not

The registry signing key signs `registry/index.json` (Ed25519, domain `Yavin.RegistryIndex.v1\0`, exact bytes; EXT-20). Yavin trusts it only through the anchors compiled into each release (`src-tauri/src/registry_anchors.json`). Whoever holds it can make Yavin accept **any index** — any list of packages and checksums — served at the pinned registry address (`https://raw.githubusercontent.com/salmanwnl44/Yavin-Rust-1/main/Yavin_2.0.0/registry/`). It does not authenticate publishers, and it cannot make Yavin install a package that is not served there.

## Current state (verified 2026-10-20, without reading the key)

| Item            | Finding                                                                                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key id          | `yavin-registry-2026-10-19`, Ed25519, pinned `active`, `notAfter` 2028-10-19                                                                                                                                                                                                        |
| Storage         | One file, `%USERPROFILE%\.yavin-registry\signing-key.pem`, on one developer machine; ACL: that user only; **unencrypted** (PKCS#8 header `BEGIN PRIVATE KEY`)                                                                                                                       |
| Backup          | **None found** (no other copy by name in the user profile; none confirmed by an operator)                                                                                                                                                                                           |
| CI access       | None. `.github/workflows/registry-sign.yml` is prepared but inactive: its environment and secret do not exist                                                                                                                                                                       |
| Exposure checks | No private key in any tracked or untracked repository file, in history (all refs), in workflows or CI artifacts (none are uploaded), or in this audit's logs. Limits: the developer machine itself, its backups and other copies outside the repository cannot be checked from here |
| Test keys       | Separate: generated per test run (tests clean them up), pinned only by `test-registry` builds through `YAVIN_TEST_REGISTRY_KEY`; never the production id's key in a shipped build                                                                                                   |

## Required custody arrangement (operator)

Recommended, in order of preference — choose one and record the choice here:

1. **Hardware-backed key** (a hardware security key or HSM that signs Ed25519 without exporting the key), used by named release operators.
2. **GitHub environment secret** `YAVIN_REGISTRY_SIGNING_KEY` in an environment `registry-signing` with **required reviewers** (at least one operator other than the requester) and a **deployment-branch rule** limited to `main`; used only by `registry-sign.yml` (manual runs; never pull requests). The key then leaves the developer machine.
3. Not acceptable alone: an environment variable or a plaintext file on a workstation (the current state).

Whichever is chosen:

- **Backup:** an encrypted offline copy (passphrase-protected PKCS#8, `ENCRYPTED PRIVATE KEY`) in two separate places (for example a password manager vault and an encrypted drive in a safe), the passphrase held apart from the copies. _Evidence to close:_ an operator records where, when, by whom, and performs the recovery check below.
- **Recovery check, without exposing the key:** decrypt the backup on an offline machine, sign a test message, and verify it against the pinned public key (`node scripts/verify-registry.mjs --files <dir>` on a renewal made from the backup). Record the date. Never paste the key anywhere.
- **Access:** named operators only; access logged (GitHub environment history, or a written log for a hardware key). Remove the workstation copy once a custody option is in place and the backup is verified.

## Routine renewal (before every expiry)

The index is valid for 365 days (`VALID_DAYS` in `scripts/build-registry.mjs`); CI's daily `registry` job and `build-registry.mjs --check` fail **90 days** before expiry (`YAVIN_REGISTRY_WARN_DAYS`). Current index: sequence 1, expires **2027-10-19** — renew by **2027-07-21**.

1. On `main`, with no other registry change pending: run `registry-sign.yml` (reason: "renewal") — or, with a local custodied key, `node scripts/build-registry.mjs --renew`. It takes the next sequence (never reuses one), new dates, signs the exact bytes, and verifies the signature under the pinned key before writing.
2. Verify the candidate offline: `node scripts/verify-registry.mjs --files Yavin_2.0.0/registry`.
3. Review the diff: only `sequence`, `issuedAt`, `expiresAt` and the signature change.
4. Commit and push to `main`; then verify the **deployed** files: `node scripts/verify-registry.mjs` (fails unless the deployed bytes are the repository's and verify).
5. In the next Yavin release, raise `minSequence` in `registry_anchors.json` to the new sequence (the freshness floor).

_Not yet exercised._

## Changing the registry's content

`node scripts/build-registry.mjs` (with the key) gives a changed catalog the next sequence; then steps 2–5 above. A published package version is immutable (the script refuses to change one).

## Rollback and recovery of a bad index

**A sequence never goes down.** Every Yavin that accepted sequence _N_ refuses anything below it (and every release refuses anything below its pinned floor). To undo a bad index: restore the previous content in the repository (`registry/catalog.json`, packages) and sign it **again with a higher sequence** (`--renew`), then publish and verify as above. A malformed or wrongly signed index is refused by every Yavin; until a good one is published, installs and updates from the registry are refused and installed extensions keep working.

## Rotation (planned)

1. Generate a new key under custody (hardware, or offline then into the secret store); record its public key and provenance.
2. Release Yavin with **both** keys pinned (`active`), the new one with its `notAfter`.
3. After that release is the minimum in use, sign the index with the new key (`KEY_ID` in `build-registry.mjs`).
4. In a later release, mark the old key `revoked` (or remove it); destroy its copies and record it.

Yavins without the new key refuse the new index (`UntrustedKey`: "update Yavin") — expected; keep step 3 behind adoption of step 2.

## Compromise (incident response)

1. Stop signing with the key; revoke it in the anchors (`status: "revoked"`) and pin a new key, in an **emergency Yavin release**; raise `minSequence` above every sequence the attacker may have signed.
2. Sign the current content with the new key at a higher sequence; publish; verify.
3. Until users update, an attacker able to serve content at the pinned address can make older Yavins accept indexes of their choosing (still only packages served there, still checked by SHA-256 and the EXT-19 trust records once installed). Announce the update.
4. Rotate any related credentials (repository push access, CI) — publishing requires write access to the repository.

## Loss (no backup)

No new index can be signed. The current index stays valid until it expires (2027-10-19); after that no extension with code installs or updates from the registry until a Yavin release pins a new key. Recovery is rotation without the old key (steps 1–2 of rotation, then sign with the new key) — users must update Yavin first. This is why the backup is required.

## Retirement

Mark the key `revoked` in a release, then destroy every copy (including backups) and record the date and who did it.
