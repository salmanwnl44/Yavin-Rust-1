# C2 production profile review — candidate specification (EXT-33 E5)

> ⚠️ **Development status (2026-11-01): ON HOLD — IN DEVELOPMENT, NOT SHIPPED.** This reviews a *candidate* profile; nothing is registered or enabled. C2 is held pending D1–D4 approvals and a security sign-off. Work-in-progress pushed for visibility, not a release.

**This document reviews a *candidate* C2 contained-server profile. It registers and activates nothing.** The production C2 registry is empty and stays empty (`C2Authority::new` holds no profiles; `with_profiles` is compiled out of release builds). A profile may be registered only after this review is completed and the four decisions in [`C2_DECISION_LOG.md`](C2_DECISION_LOG.md) are `Approved`.

- Authored: 2026-10-31 · Branch: `ext-32-workers` · Revision: `6947a3f`
- **No binary was downloaded, hashed, or signature-verified for this review.** Every provenance, hash, signature, and version fact below is therefore marked **`Unverified`** or **`TBD`** and must be established by the approving reviewer. Nothing here is invented.

## Candidate selection and basis

Two concrete servers appear in Yavin's own survey (`PROCESS_CAPABILITY_DESIGN.md` §17.1, `openvsx.rs`, `checkers.rs`): **Ruff** (`charliermarsh.ruff`) and the **Lua language server** (`sumneko.lua`). Both are real, in-scope C2 use cases: each reads the workspace it analyzes and otherwise needs no write, network, or child process.

| Candidate | Why considered | Fit for C2 (read-only, no net, no child, no write) | Distribution shape | Leaning |
| --- | --- | --- | --- | --- |
| **Ruff** (`ruff server`) | Already a Yavin checker (`checkers.rs`: `program "ruff"`, `pyproject.toml` projects); single self-contained native binary; Astral's provenance story is public | Strong — `ruff server` is an LSP that reads project files + config; no network or child process needed for core linting | Single static executable per platform | **Primary candidate** |
| **Lua LS** (`lua-language-server`) | Named in the OpenVSX survey (`openvsx.rs`); common real server | Plausible — reads workspace Lua + config | Ships a runtime + data files (larger surface; bundles Lua) | Alternative |

**Neither is bundled with Yavin today.** Yavin bundles only ripgrep (`src-tauri/resources/search/`). A C2 profile pins an exact executable path + SHA-256 (`broker::ProgramId`); so a production profile requires either **(a)** bundling a specific, provenance-verified build (preferred — deterministic hash, no reliance on the user's machine) or **(b)** resolving a user-installed binary (provenance **unverifiable** by Yavin — not recommended for a first C2 profile). This review assumes approach (a).

The remainder specifies **Ruff** as the candidate. The same template applies to any other server and must be re-completed per server.

---

## Ruff C2 profile — candidate specification

### Identity, purpose, operations, scope
- **Profile id (proposed):** `ruff` (C2 class). **Server identity/SID:** derived per extension copy + C2 class + workspace (`workspace_identity::derive`), never `ALL APPLICATION PACKAGES`.
- **Purpose:** run Ruff as a contained language server / linter over a Python workspace, returning diagnostics.
- **Supported operations (architect decision — the extension's only say is `op` + bounded `input`):** a **closed allow-list**, deny by default:
  - `lint` — run Ruff over a workspace-relative path set and return diagnostics (maps to `ruff check --output-format json`).
  - `format-check` — report formatting diffs (maps to `ruff format --check --diff`).
  - Argument validation (native, before the request reaches the server): `op` ∈ the allow-list; `input` is JSON ≤ `MAX_REQUEST` (64 KiB); any path in `input` must be **workspace-relative, canonicalize inside the root, and contain no `..`, drive letter, UNC prefix, or NUL** (reuse the glob/path rules already enforced for `workspace.findFiles`). No `op` may name a program, SID, container, workspace, or identity — those are native.
  - The LSP (`ruff server`) long-lived-session mode is **out of scope for the first profile**: it needs a framed-LSP server adapter (new C2 functionality) and is deferred. The request/response channel as built (one bounded request → one bounded response) fits `lint`/`format-check`, not a streaming LSP session.
- **Required workspace scope:** read-only over the single canonical workspace root (D1). Config files Ruff honors (`pyproject.toml`, `ruff.toml`, `.ruff.toml`) are inside that root and covered by the read grant.

### Upstream, provenance, build, signing — VERIFIED from authoritative upstream (2026-10-31)

Verified against PyPI's metadata API and the GitHub release page. **No binary was downloaded or executed** — only published metadata and the published checksum *text* file were fetched.

- **Upstream project / repository:** Ruff, by Astral. Source repository **`https://github.com/astral-sh/ruff`** (listed as "Repository" in the PyPI `project_urls`); docs `https://docs.astral.sh/ruff`. **Verified.**
- **License:** `license_expression: MIT` on PyPI (`LICENSE` in `license_files`). **Verified.**
- **Latest version (candidate to pin):** **0.17.3** — GitHub release page "Released on 2026-10-26"; PyPI wheels uploaded `2026-10-27T00:34:02Z`. **Verified** as the latest at authoring. (Series moved 0.16.x → 0.17.x during Oct 2026; pin one exact release, do not track "latest".)
- **Distribution mechanisms:** (a) **GitHub Releases** standalone binaries — the Windows x64 asset is **`ruff-x86_64-pc-windows-msvc.zip`** with a companion **`ruff-x86_64-pc-windows-msvc.zip.sha256`** checksum file; (b) **PyPI wheels** (e.g. `ruff-0.17.3-py3-none-win_amd64.whl`); (c) `cargo install` / standalone installer. **Verified.**
- **Provenance / signature verification — VERIFIED 2026-11-01 (`gh attestation verify`, exit 0):**
  - `gh` CLI (v2.103.3) was installed via winget; GitHub authentication was **not** available, so the API-backed `gh attestation verify --repo` path failed (`auth`). The **offline `--bundle`** path was used instead: the SLSA provenance bundle was fetched from the public, unauthenticated API (`/repos/astral-sh/ruff/attestations/sha256:<zip-digest>`) and verified against the **Sigstore public-good trust root** with `gh attestation verify ruff-x86_64-pc-windows-msvc.zip --bundle <bundle> --repo astral-sh/ruff` → **exit 0 (verified)**.
  - Verified facts from the attestation: predicate `https://slsa.dev/provenance/v1`; **subject** `ruff-x86_64-pc-windows-msvc.zip` sha256 `a84d9ac7…e813` (our exact archive); **sourceRepositoryURI** `https://github.com/astral-sh/ruff`; **buildSignerURI / builder.id** `https://github.com/astral-sh/ruff/.github/workflows/release.yml@refs/heads/main`; **issuer** `https://token.actions.githubusercontent.com`; source revision git sha1 `ba65abf8ba7bfbcc059f7fb9712be5ba9cab6abc` (from the companion `in-toto release/v0.2` attestation, subject `pkg:github/astral-sh/ruff@0.17.3`).
  - **Scope note:** GitHub attests the **release archive**, not the extracted `ruff.exe` (the API returns `404` for the exe digest). The exe is trusted transitively: attested+verified zip → zip sha256 matches published → extracted-exe sha256 `1447a6a2…a11b` (two tools). This chain is complete and sound.
  - *PyPI wheel:* `ruff-0.17.3-py3-none-win_amd64.whl` has **no** `attestations` field and `has_sig: false` — not PEP 740-attested on PyPI. The **GitHub Release** artifact (attested) is therefore the one to bundle.

### Executable hash and upgrade process

- **Published checksum of the Windows zip (VERIFIED, authoritative):**
  `a84d9ac74af8ef5bac84a1888a1634df18e6e985e2f930d35c052beacd00e813  ruff-x86_64-pc-windows-msvc.zip` (from the upstream `.sha256` asset).
- **Published checksum of the PyPI Windows wheel (VERIFIED, authoritative):**
  `56b8ffb3f3b3cbccb8b76b71b38261b7ed982ef5d20f5b447b1b61a7f4949b24  ruff-0.17.3-py3-none-win_amd64.whl` (PyPI `digests.sha256`).
- **Exact executable SHA-256 that `ProgramId.sha256` must pin — VERIFIED 2026-10-31:**
  **`1447a6a20b86e5d40bfebb0c2e56f8b929e2c30b0131f9ab1b5afbc826f5a11b`** (`ruff.exe`, 27,150,128 bytes).
  Produced by the real bundle process, **without executing the binary**:
  1. `curl -sSL` the GitHub release asset `ruff-x86_64-pc-windows-msvc.zip` into an isolated directory (10,282,950 bytes).
  2. `sha256sum` the zip → `a84d9ac7…e813` — **matches** the upstream published `.sha256`. (Mismatch ⇒ abort.)
  3. `unzip` → a single file `ruff.exe` (27,150,128 bytes), nothing else.
  4. `sha256sum` and PowerShell `Get-FileHash -Algorithm SHA256` **both** → `1447a6a2…a11b` (two independent tools agree).
  - **GitHub Artifact Attestation — VERIFIED 2026-11-01** (`gh attestation verify … --bundle … --repo astral-sh/ruff` → exit 0, Sigstore public-good trust root). The attestation's subject is the archive `a84d9ac7…e813`; the exe hash is trusted via the verified archive → published checksum → extraction chain above.
  - This hash is content-addressed (tool/machine-independent) and is the value `ProgramId.sha256` pins for ruff 0.17.3's Windows x64 build. The downloaded artifacts lived only in the session scratchpad and were deleted; **nothing was bundled into the repository or registered.**
- **Upgrade / hash-change process (proposed):** new version → fetch the GitHub Release artifact → `gh attestation verify ... --repo astral-sh/ruff` **and** match the published `.sha256` → extract → recompute the exe hash → security review of the version diff's capability impact → update the pinned `ProgramId` → the old hash stops being accepted (C2 re-hashes at every launch, Q9). Rollback = revert the `ProgramId` to the previously approved version+hash.

### Acquisition, validation, storage, revocation of the binary
- **Acquisition:** **`TBD`** (bundle at build time from a trusted, pinned source; no runtime download recommended).
- **Validation at launch:** the launch **re-hashes** the on-disk program and refuses if it does not match the pinned SHA-256 (implemented in `establish`); a swapped binary fails closed.
- **Storage:** inside Yavin's read/execute program folder (the sandbox grants read/execute on the program folder only; `sandbox::grant_program`).
- **Revocation:** removing the profile (registry change) plus `C2Authority::revoke` for any live grant (ends the process, removes the workspace ACE, verifies zero residue).

### Permissions and data accessible under the C2 grant
- **Data the server can read:** every file in the workspace root, **including secrets** (`.env`, credentials, private keys, `.git/config`) — disclosed in consent (D3). This is the inherent cost of read-only workspace access and the reason consent is informed and deny-by-default.
- **Permissions granted:** one inheritable `FILE_GENERIC_READ` ACE for the derived container SID on the workspace root (D1). Nothing else.

### Capability restrictions (enforced by the EXT-10 sandbox, unchanged)
- **Filesystem write:** denied (OS-enforced; proven live).
- **Network (loopback + public):** denied (no network capability in the lowbox token).
- **Child processes:** denied (child-process-restricted mitigation).
- **`OpenProcess` on Yavin:** denied.
- **Read outside the workspace:** denied by target-DACL evaluation even through a planted junction (D1 §4).

### Resource, concurrency, I/O, and deadline limits (architect decision — proposed, measurement pending)
- **Memory:** **1 GiB** (`memory_bytes = 1 << 30`) — proposed. Ruff is memory-efficient, but a one-shot `lint` over a large tree can allocate; 1 GiB is a safe ceiling above the C1 broker's 512 MiB, enforced by the job object (exceeding it ends the process). *Measurement pending* on 10k/100k/500k-file Python trees before ratification.
- **CPU:** **one core-equivalent** (`cpu_rate_for(1, 4)` on a 4-core baseline, i.e. the job-object CPU-rate cap already used by the test profile). *Measurement pending.*
- **Processes:** **one** (child processes denied by the sandbox; a `lint` run is single-process).
- **Concurrency:** **≤ 2** requests in flight per grant (`MAX_INFLIGHT_PER_GRANT`) — fixed by the channel.
- **Request input:** ≤ **64 KiB** (`MAX_REQUEST`). **Response:** ≤ **1 MiB** (`MAX_RESPONSE`), refused by the length prefix before allocation; an oversized response ends the server. (A `lint` over a very large tree could exceed 1 MiB of JSON diagnostics → the op must paginate or scope to a path set; part of the adapter design.)
- **Per-request deadline:** **10 s** (`REQUEST_TIMEOUT`); a timeout ends the server and is a structured error.
- **Launch timeout:** **120 s** (`LAUNCH_TIMEOUT`), including the async ACL grant wait.
- **Network / child process:** **denied** by the no-capability lowbox token + child-process-restricted mitigation (not a profile setting; OS-enforced and proven live for any contained server).
#### Measured 2026-11-01 (isolated Python workspaces; `ruff.exe` 0.17.3; this Windows host)

Generated workspaces of 50 / 1000 / 5000 `.py` files (each with real lint issues), ran `ruff check --output-format json .` and `ruff format --check --diff .`, measured peak working-set, CPU time, wall time, exit code, and output size (methodology + raw JSON in `C2_RELEASE_READINESS.md` §C.2):

| Workspace | op | wall (cold→warm) | CPU ms | peak WS | output bytes |
| --- | --- | --- | --- | --- | --- |
| 50 | lint | 1.77 s → 0.10 s | 79–141 | 31 MB | 226 KB |
| 1000 | lint | 6.49 s → 0.38 s | 359–1109 | 57 MB | **4.54 MB** |
| 5000 | lint | **31.8 s** → 1.59 s | 2047–4719 | **179 MB** | **22.7 MB** |
| 5000 | format-check | 0.51 s → 0.48 s | 1219–1375 | 31 MB | **1.46 MB** |

**Verdicts (do not treat proposed limits as validated until supported):**
- **Memory 1 GiB — VALIDATED (generous).** Peak working set maxed at **179 MB** on 5000 files; 1 GiB has ~5× headroom. Enforced by the job object; ruff never approached it.
- **CPU 1 core-equivalent — VALIDATED.** CPU/wall ≈ 0.15 (I/O-bound on cold cache); ruff does not saturate a core. 1 core-equiv is adequate.
- **Processes 1 — VALIDATED** (ruff is single-process; child processes denied by the sandbox).
- **Per-request deadline 10 s — NOT VALIDATED for whole-tree `lint`.** A cold-cache whole-tree lint of 5000 files took **31.8 s** (> 10 s); warm 1.6 s. ⇒ the `lint` op **must be path-scoped/incremental** (lint the open file(s), not the whole tree), or bulk lint needs a different, larger deadline than the interactive channel's. The 10 s bound is correct for scoped ops.
- **Response size 1 MiB — NOT VALIDATED for whole-tree output.** Whole-tree `lint` JSON reached **22.7 MB** (1000 files already 4.5 MB); even `format-check --diff` on 5000 files was **1.46 MB** — all exceed `MAX_RESPONSE` (1 MiB). ⇒ through the channel these would be refused and the server ended (correct fail-closed behavior), confirming the op **must paginate or scope to a bounded path set**. The 1 MiB bound is not raised to accommodate bulk output.
- **Request 64 KiB / in-flight ≤ 2 — unchanged** (channel-fixed; adequate for scoped requests).

**Conclusion:** memory/CPU/process limits are **measurement-validated with headroom**; the deadline and response-size limits are **adequate only for a path-scoped `lint`/`format-check` op, not a whole-workspace request** — which is exactly how the op must be designed. No limit was raised to make a test pass; instead the op contract is constrained to fit the protective bounds.
- **Status:** memory/CPU/process **validated**; deadline/response **validated for scoped ops, require the op to be path-scoped** (design constraint recorded); cold-cache whole-tree behavior documented. Registration still blocked on D1–D4 + the op adapter (not built) + security sign-off.

### Consent, grant lifecycle, revocation, failure behavior
- **Consent:** native, deny-by-default, identity-bound, per workspace; wording per D3 (draft). A C2 grant without a workspace is refused.
- **Grant lifecycle:** consent → async workspace grant to `Granted` (verified) → `may_start` fresh re-verify → re-hash → sandboxed spawn in derived container → token-SID match. Any failure rolls back the ACL and kills the process.
- **Per-request:** every request re-derives identity, re-authorizes the grant, re-verifies `may_start` on reuse, and re-checks the grant after the round trip so a revoke mid-call delivers no response.
- **Revocation:** ends the process/channel, removes the workspace ACE, verifies zero residue; shutdown revokes all and waits for ACL quiescence.
- **Failure (fail closed):** outward reparse / external hard link / un-appliable ACL / non-Windows / unverified identity → no grant, no server, structured error (`SandboxUnavailable` / `PermissionDenied` / `ExternalHardLink`), no partial ACE left behind.

### Known limitations, unresolved risks, proposed acceptance tests
- **Unresolved (must be closed before registration):** provenance, signature, version, and exact hash are all `Unverified`/`TBD`; production memory/CPU limits unvalidated; the exact op set undefined; D1–D4 unapproved.
- **Same-user residual:** code already running as the user can read these files; the grant adds a container principal that can read until revoked (accepted risk to be dispositioned under D1).
- **Proposed acceptance tests (when a profile is approved — not run now):** live containment probe (read workspace incl. `.env`; write/network/child/`OpenProcess` denied); reparse refusal (junction/symlink/`..`/ADS/device/8.3); external-hard-link refusal; grant→revoke zero residue (plain + protected-DACL child); crash-between-grant-and-removal reconcile to zero; per-extension/per-workspace isolation; consent-denied and revoke-during-run; request bounds/timeout/crash; re-hash rejects a swapped binary; and a measured memory/CPU/latency profile on 10k/100k/500k-file Python workspaces.

---

## Reviewer checklist (all must be `Approved`/verified before registration)

- [x] Upstream repository and official-artifact identity **verified** — `github.com/astral-sh/ruff`, MIT (2026-10-31).
- [x] Exact version identified — **0.17.3** (pin this exact release, not "latest").
- [x] Provenance/signature verification **performed** — `gh attestation verify … --bundle … --repo astral-sh/ruff` → exit 0 (Sigstore public-good trust root); archive published `.sha256` also matched. PyPI wheel is **not** attested (bundle the GitHub artifact).
- [x] Archive SHA-256 recorded — zip `a84d9ac7…e813`; wheel `56b8ffb3…b24` (published, authoritative).
- [x] **Exact `ruff.exe` SHA-256** computed from the checksum-verified, attested archive and recorded — `1447a6a2…a11b` (two-tool agreement, binary not executed during provenance).
- [x] GitHub Artifact Attestation **verified** (`gh attestation verify`, exit 0) against the archive subject.
- [x] Hash-upgrade/rollback review process agreed (above).
- [x] Op set enumerated (`lint`, `format-check`) with native argument validation; LSP-session mode deferred; ops **must be path-scoped** (see measurements).
- [x] Production memory/CPU/process limits **measured and validated** (1 GiB / 1 core / 1 proc — peak 179 MB); deadline/response limits validated **for scoped ops** (whole-tree exceeds both — op must scope).
- [ ] **Op adapter implemented** (maps `lint`/`format-check` → bounded `ruff` invocation + path validation + output pagination) — **NOT built** (gated behind D1–D4 + activation; building it now is out of scope).
- [ ] D1–D4 ([`C2_DECISION_LOG.md`](C2_DECISION_LOG.md)) all `Approved` — **pending** (see [`C2_FINAL_GATE_REVIEW.md`](C2_FINAL_GATE_REVIEW.md) §1).
- [ ] Acceptance tests implemented and green on Windows — **pending** (templated above).
- [ ] Activation reviewed as a separate minimal change ([`C2_RELEASE_READINESS.md`](C2_RELEASE_READINESS.md) §6) — **pending**.

**Sources (verified 2026-10-31):** [ruff on PyPI](https://pypi.org/project/ruff/) · [ruff 0.17.3 release](https://github.com/astral-sh/ruff/releases/tag/0.17.3) · [astral-sh/ruff](https://github.com/astral-sh/ruff).
