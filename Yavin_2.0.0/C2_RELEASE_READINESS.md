# C2 (EXT-33 E5) release readiness — evidence and gate

> ⚠️ **Development status (2026-11-01): ON HOLD — IN DEVELOPMENT, NOT SHIPPED.** C2 is held for now, disabled in every build (empty registry, unknown profiles fail closed), pending D1–D4 approvals and a security sign-off. Work-in-progress pushed for visibility, not a release.

**Verdict: the release gate is BLOCKED. Production C2 is disabled and must remain so.** This document gathers the hard-link, cleanup/revocation, and release-acceptance evidence, states the release gate with explicit pass/fail conditions, and defines the activation + rollback procedure. It changes no ACL, registers no profile, and makes no production code change (the only source added is a release-configuration *test*, §5.1).

- Authored: 2026-10-31 · Branch: `ext-32-workers` · Revision: `6947a3f`
- Toolchain: rustc 1.99.1 (58cf8f9c3 2026-10-13), cargo 1.99.1, node v24.20.0 · Platform: Windows 11 (26300)
- Companions: [`C2_DECISION_LOG.md`](C2_DECISION_LOG.md), [`C2_PRODUCTION_PROFILE_REVIEW.md`](C2_PRODUCTION_PROFILE_REVIEW.md), [`PROCESS_CAPABILITY_DESIGN.md`](PROCESS_CAPABILITY_DESIGN.md) §24.
- All tests use disposable temp trees and a dedicated test container. **No real workspace ACL was modified.** The `c2`/`c2_capability` suites require the `c2-test-profiles` feature (off in production); `workspace_acl` and the release-config assertion run in the production feature set.

---

## A. Hard-link risk

**Threat model.** A C2 grant adds an inheritable read ACE to the workspace tree. Two ways a read could escape the intended tree:
1. **Reparse points** (junction/symlink/`..`/ADS/device/8.3) under the root pointing outside it.
2. **Hard links** under the root naming a file that also lives outside it (a second directory entry for the *same* object).

The junction/reparse checks (`outward_reparse`) do **not** by themselves resolve hard links: a hard link is not a reparse point, so refusing outward junctions says nothing about a hard-linked object. Hard links are treated as a **separate** control.

**Established facts (live, this Windows).**
- *Reparse — reads cannot escape.* Windows evaluates a read against the **target** object's DACL; the container holds an ACE only on the workspace tree, never on an outside target, and granting the inheritable ACE does not propagate it through a junction to the target. An outward junction — present at grant or planted afterward by concurrent same-user code — is **denied at read** (`reads_cannot_escape_the_root_through_a_junction`, both cases). The grant-time scan (`outward_reparse`) is kept as defense in depth and to avoid granting onto unexpected objects.
- *Hard link present at grant — exposes the shared object, so the tree is REFUSED.* A hard link under the root to an outside file has the inherited read ACE propagated onto the shared object, so the sandbox could read it. Such trees are **refused at grant** (`sandbox::external_hard_link_name` via `GetFileInformationByHandle` link count + `FindFirstFileNameW`; `workspace_acl::external_hard_link` → `GrantError::ExternalHardLink`). Hard links are **same-volume only**, so `FindFirstFileNameW` enumerates *every* name of the object — enumeration is complete, not best-effort.
- *Hard link created after grant — denied by the OS.* The outside object was never in the tree, so it carries no container ACE; a later hard link to it is denied (same mechanism as post-grant junction substitution). The narrow race of planting a hard link *during* the grant scan lands in the same post-grant-denied bucket (the object is not re-ACL'd after the single propagation).

**Conclusion.** Hard-link exposure is eliminated by grant-time refusal **plus** the OS's own denial of post-grant links — it is **not** an open residual. The residual that **remains for human disposition (D1)** is the generic same-user one (§4.2): code already running as the user can read these files regardless of the grant.

**Targeted live evidence (this run).**

Run: `cargo test -p ide-workspace --test workspace_acl -- --test-threads=1` → **22 passed, 0 failed, 2 ignored** (probes). The hard-link/reparse checks:

| Check | Test | Result |
| --- | --- | --- |
| Outward junction cannot be read through (at grant and planted after) | `reads_cannot_escape_the_root_through_a_junction` | **PASS** |
| Hard link at grant exposes → refused; later link denied by OS | `hard_links_present_at_grant_expose_the_object_but_later_ones_do_not` | **PASS** |
| Outward junction detected and refused at grant | `an_outward_junction_is_detectable`, `safe_grant_refuses_an_outward_junction` | **PASS** |
| External hard link refused at grant | `safe_grant_refuses_an_external_hard_link` | **PASS** |

**Mitigation / gate.** The refusal-based mitigation is implemented and tested; no change needed. Production approval remains blocked on D1 (accepting the ACL change at all) — not on hard links, which are dispositioned by refusal.

---

## B. Cleanup and revocation

Evidence is drawn from `crates/ide-workspace/tests/workspace_acl.rs` (ACL lifecycle, production feature set) and `crates/ide-workspace/tests/c2.rs` (channel/launch revocation, `c2-test-profiles`). No ACL implementation was changed for this report.

Runs: `workspace_acl` (production feature set, 22 passed / 0 failed / 2 ignored) and `c2` (`c2-test-profiles`, 20 passed / 0 failed / 2 ignored, incl. the shutdown and no-swap tests).

| Scenario | Mechanism | Test | Result |
| --- | --- | --- | --- |
| Normal revocation leaves zero residue | `revoke` verifies zero container ACEs before clearing; unrelated ACEs preserved | `revocation_removes_the_grant_and_preserves_other_aces` | **PASS** |
| Process termination on revoke + ACL clean + blocks relaunch | `C2Authority::revoke` kills the process, removes the ACE, verifies zero residue | `revocation_stops_the_server_cleans_the_acl_and_blocks_relaunch`, `revocation_ends_the_channel_and_refuses_further_requests` | **PASS** |
| Cancellation rolls back | `cancel` rolls back whether it beats or loses the worker race | `cancelling_a_grant_leaves_no_applied_permission` | **PASS** |
| Timeout / failed grant → no launch | `may_start` refuses unless `Granted`; a failed grant never readies | `may_start_refuses_a_failed_grant`, `the_manager_reports_failure_and_never_readies_a_refused_tree` | **PASS** |
| Interrupted ACL op / stale op | monotonic `OP_SEQ`; stale grant undoes itself behind a newer revoke | `a_newer_revoke_prevents_a_stale_grant_from_reapplying` | **PASS** |
| Startup recovery (crash before removal) | journal-before-mutation; `reconcile` re-removes and verifies zero residue | `startup_reconciliation_removes_a_grant_a_crash_left_behind` | **PASS** |
| Corrupt journal | fails closed | `a_corrupt_journal_fails_closed` | **PASS** |
| Concurrent grant/revoke race | one ACL lock serializes all DACL mutation | `concurrent_grants_on_two_workspaces_are_isolated`, `the_manager_grants_and_revokes_asynchronously` | **PASS** |
| Shutdown revokes all + quiesces | `shutdown` revokes every live & channel server, removes each ACE, waits for workers to quiesce | `shutdown_revokes_every_live_server_and_quiesces` (two servers/two workspaces; both ended, both ACEs → 0, `quiescent()` true) — **added 2026-10-31** | **PASS** |
| Zero-residue on protected-DACL child | revoke/reconcile clean a non-inheriting child | `a_protected_dacl_child_leaves_no_residue` | **PASS** |

**Finding.** No defect. All automated cleanup/revocation scenarios pass on this Windows host. The previously-noted coverage gap — no standalone test for the authority-level `shutdown` — is now **closed** by `shutdown_revokes_every_live_server_and_quiesces` (c2 suite 20/0/2). The app wires `C2Authority::shutdown` into the run-loop exit in `lib.rs`; that one-line wiring remains exercised only through the authority test, which is the meaningful unit.

---

## C. Ruff production-profile verification (G2 evidence, 2026-11-01)

Candidate: **Ruff 0.17.3, Windows x64**. Full profile spec in [`C2_PRODUCTION_PROFILE_REVIEW.md`](C2_PRODUCTION_PROFILE_REVIEW.md). Nothing was registered; the downloaded artifacts lived only in the session scratchpad and were deleted.

### C.1 Attestation verification — VERIFIED (exit 0)

`gh` (v2.103.3) was installed via `winget`. GitHub auth was unavailable, so the offline bundle path was used (no secret required):

```
# archive re-download + checksum (matches upstream-published .sha256)
sha256sum ruff-x86_64-pc-windows-msvc.zip
  a84d9ac74af8ef5bac84a1888a1634df18e6e985e2f930d35c052beacd00e813   [MATCH]
# fetch SLSA provenance bundle from the public, unauthenticated API
curl .../repos/astral-sh/ruff/attestations/sha256:a84d9ac7...e813   -> att.json (2 attestations)
# verify the SLSA provenance bundle against the Sigstore public-good trust root
gh attestation verify ruff-x86_64-pc-windows-msvc.zip --bundle bundle.json --repo astral-sh/ruff
  exit 0   [VERIFIED]
```

Verified attestation facts: predicate `https://slsa.dev/provenance/v1`; **subject** `ruff-x86_64-pc-windows-msvc.zip = a84d9ac7…e813`; **sourceRepositoryURI** `https://github.com/astral-sh/ruff`; **builder.id** `…/.github/workflows/release.yml@refs/heads/main`; **issuer** `https://token.actions.githubusercontent.com`; **source rev** `ba65abf8ba7bfbcc059f7fb9712be5ba9cab6abc`. GitHub attests the **archive** (exe digest returns 404); the extracted `ruff.exe` (`1447a6a2…a11b`, 27,150,128 B) is trusted transitively via verified-archive → checksum → extraction.

### C.2 Resource-limit measurement — methodology + raw results

Methodology: generated isolated workspaces of 50 / 1000 / 5000 `.py` files (each with real lint issues), ran `ruff check --output-format json .` and `ruff format --check --diff .` cold then warm, measuring peak working set (polled `PeakWorkingSet64`, monotonic), `TotalProcessorTime`, wall time, exit code, and output size (`measure.ps1`). Isolated trees only; **no real workspace touched**; ruff run on the host (not the sandbox) to measure intrinsic appetite.

| Workspace | op | exit | wall cold | wall warm | CPU ms | peak WS | out bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | lint | 1 | 1766 ms | 104 ms | 79–141 | 30.5 MB | 226,507 |
| 50 | format-check | — | 101 ms | 80 ms | 62 | 12–17 MB | 14,005 |
| 1000 | lint | 1 | 6486 ms | 383 ms | 359–1109 | 57 MB | 4,540,467 |
| 1000 | format-check | — | 176 ms | 162 ms | 219–266 | 21 MB | 285,465 |
| 5000 | lint | 1 | 31,784 ms | 1592 ms | 2047–4719 | 179 MB | 22,714,472 |
| 5000 | format-check | — | 510 ms | 475 ms | 1219–1375 | 28–31 MB | 1,455,467 |

(exit 1 for lint = ruff found issues, as expected; raw JSON archived at the session scratchpad `ruff-verify/measurements.json`.)

**Proposed vs validated:**

| Limit | Proposed | Measured | Verdict |
| --- | --- | --- | --- |
| Memory | 1 GiB | peak 179 MB | **Validated** (≈5× headroom) |
| CPU | 1 core-equiv | CPU/wall ≈ 0.15 | **Validated** (I/O-bound, no core saturation) |
| Processes | 1 | 1 | **Validated** |
| In-flight | 2 | — | Channel-fixed |
| Request | 64 KiB | — | Channel-fixed (scoped requests fit) |
| Response | 1 MiB | whole-tree lint 4.5–22.7 MB; fmt 1.46 MB | **NOT validated for whole-tree** → op must paginate/scope |
| Deadline | 10 s | whole-tree cold lint 31.8 s; warm 1.6 s | **NOT validated for whole-tree** → op must be path-scoped |

**Finding (no limit raised to pass):** memory/CPU/process limits hold with headroom; the deadline and response bounds are adequate only for a **path-scoped** `lint`/`format-check`, not a whole-workspace request. A whole-tree request would (correctly) be refused by the channel's `MAX_RESPONSE`/timeout and the server ended — fail-closed. The op contract is therefore constrained to bounded path sets; the bounds are not loosened.

### C.3 Security review (implementation inspection)

| Property | Where enforced | Status |
| --- | --- | --- |
| Native executable path (request cannot name a program) | `establish` uses `profile.program`; request carries only `op`/`input` | **Enforced** (mutations C2S-01, C2-11) |
| No-swap: on-disk bytes must match pinned hash | `establish` step 7 → `ExecutableChanged`/`ExecutableNotFound` | **Enforced + now tested** (`a_program_whose_bytes_do_not_match_the_pinned_hash_is_refused`) |
| Workspace-scoped, read-only ACL | D1 mechanism; `may_start` fresh re-verify | **Enforced** (§A/§B, ACL mutations) |
| Request/response bounds | `MAX_REQUEST`/`MAX_RESPONSE` before alloc | **Enforced + tested** (oversized req/resp) |
| Timeout + process end | `REQUEST_TIMEOUT`, kill on timeout | **Enforced + tested** (slow-request test) |
| Concurrency cap | `MAX_INFLIGHT_PER_GRANT` → `TooBusy` (c2.rs:480) | **Enforced**; covered by construction + serialization tests (no standalone multi-thread stress test — a controlled-blocking harness would be needed; deferred to avoid a flaky test) |
| Consent required, deny-by-default, never implies trust | `request_consent` + C2 consent body | **Enforced** (C2-10, C2T-03) |
| No bypass of `C2Authority`; not an ordinary extension API | `process.callServer` → capability + authority; opaque `op`/`input` | **Enforced** (C2S-03) |
| **Closed op allow-list + argument validation for Ruff** | — | **NOT implemented** — the channel passes `op`/`input` opaquely; the `lint`/`format-check` allow-list + path validation is a **spec** (profile review), not code. Building the adapter is new functionality, gated behind D1–D4 + activation. |

**Gap (honest):** the Ruff-specific op allow-list, argument/path validation, and output pagination do **not** exist as code — they are specified only. They cannot be implemented now without building the server adapter (new functionality, out of scope and gated). The generic channel's identity/consent/bounds/timeout/isolation guarantees are real and tested; the Ruff op contract is design-only.

### C.4 Test-scenario mapping (Phase E)

| # | Scenario | Coverage |
| --- | --- | --- |
| 1 | Valid lint | **Not testable yet** — no op adapter/registered profile (design-only) |
| 2 | Valid format-check | **Not testable yet** — same |
| 3 | Invalid/tampered executable | **Tested** — `a_program_whose_bytes_do_not_match_the_pinned_hash_is_refused` (`ExecutableChanged`), added 2026-11-01 |
| 4 | Invalid arguments | Generic: `InvalidRequest` for empty/overlong `op`; Ruff arg-validation is design-only |
| 5 | Unsupported operation | **Tested** (generic) — `an_unknown_op_is_a_structured_error` |
| 6 | Oversized request | **Tested** — `an_oversized_request_is_refused` |
| 7 | Oversized response | **Tested** — `an_oversized_response_is_refused` (confirmed relevant by C.2: whole-tree output >1 MiB) |
| 8 | Timeout enforcement | **Tested** — `a_slow_request_times_out_and_ends_the_server` |
| 9 | Resource exhaustion | Job-object memory/CPU caps (E3 model, reused); C.2 shows ruff stays far under |
| 10 | Concurrent request enforcement | Enforced (`MAX_INFLIGHT`→`TooBusy`); serialization tested; no standalone stress test (see C.3) |
| 11 | Process termination | **Tested** — revocation + shutdown tests |
| 12 | Workspace isolation | **Tested** — `a_different_copy_or_workspace_is_refused`, per-workspace ACL isolation |
| 13 | Shutdown cleanup | **Tested** — `shutdown_revokes_every_live_server_and_quiesces` |

---

## 5. Release acceptance run (against the production/release configuration)

Build/test commands run from `src-tauri/` with `TMP=TEMP=D:/salman/tmp` (linker requirement). The mutation runner retries a Smart App Control `os error 4551` up to 3× and marks a still-blocked case `BROKEN` (proves nothing), never disabling the control.

### 5.1 Test-only profiles are unavailable in the release configuration (deterministic)

A *passing test-only build is not accepted as evidence.* Two deterministic facts establish exclusion in the **production** feature set:

1. **Compile-time:** `C2Authority::with_profiles` — the only constructor that can register a profile — is `#[cfg(feature = "c2-test-profiles")]`. Neither `src-tauri/Cargo.toml` nor `crates/ide-workspace/Cargo.toml` puts `c2-test-profiles` in any `default` set (there is no `default` key), so a normal/release build does not compile that constructor. There is no code path to register a profile.
2. **Runtime assertion in the release config:** `crates/ide-workspace/tests/c2_production.rs` is **not** gated by the feature, so it runs in the production feature set and asserts the registry is empty and both launch and request fail closed.

```
$ cargo test --locked -p ide-workspace --test c2_production      # no --features
running 3 tests
test the_release_configuration_registers_no_c2_profiles ... ok
test a_request_in_the_release_configuration_fails_closed ... ok
test a_launch_in_the_release_configuration_fails_closed ... ok
test result: ok. 3 passed; 0 failed; 0 ignored
```
→ In the shipped configuration, `C2Authority::new(...).profiles()` is empty and a launch/request naming any profile (`ruff`, `lua-language-server`, `test-server`) returns `UnknownProfile`. **Directly proven.**

### 5.2 The shipped crate compiles in the release configuration

```
$ cargo check --locked -p yavin-ide        # default features, no c2-test-profiles
Finished `dev` profile ... in 32.34s    (exit 0)

$ cargo build --release --locked -p yavin-ide   # release profile, no c2-test-profiles (2026-10-31)
Finished `release` profile [optimized] target(s) in 1m 18s   (exit 0)
# -> target/release/yavin-ide.exe, 22,750,208 bytes, built 2026-10-30T21:59:09Z
```
→ The production crate builds with the test feature **off**, in both the dev and the **release** profile. **Directly proven.** (The full packaged `tauri build` bundle — frontend + installer/signing — was not run; see §5.7.)

### 5.3 C2 requests without an approved profile fail closed

Covered by 5.1 (`UnknownProfile` on both the launch and request paths in the release config) and by `production_registers_no_profiles_and_launches_nothing` (feature build). **Directly proven.**

### 5.4 Test-only profiles cannot be reached through production config or extension input

- No `default` feature pulls in `c2-test-profiles` (5.1).
- C2 is **not** an extension-callable launch/consent API: `process.callServer` reaches the authority but the authority registers no profile, so it answers `UnknownProfile`; consent is a native dialog the renderer cannot trigger (§24.7/§24.8). An extension controls only `op`/`input` — never the profile registry, identity, workspace, SID, path, or approval.
- Regression: `only_call_server_is_an_extension_c2_method_and_it_needs_process` (the only extension-reachable C2 method is `process.callServer`, and it requires the `process` capability). **Directly proven** (see 5.6 run).

### 5.5 Revocation and ACL cleanup guarantees remain covered

See §B — all scenarios **PASS** (`workspace_acl` 22/0/2, `c2` 20/0/2).

### 5.6 E1–E4 not regressed; mutation detectors still fire

Mutation families relevant to the gate (the runner removes each protection and requires its named test to fail):

| Family | What it guards | Count | Result |
| --- | --- | --- | --- |
| `EXT-33 C2` (incl. C2-10..15, C2T-01..05, C2S-01/03/04/05/06) | consent, identity, verified-grant, ACL cleanup on revoke, test-profile-in-production, HostCopy identity, native-workspace, revoke-ownership, caller-identity, C2-through-ordinary-API, request/response bounds, revocation | 15 | **15/15 caught** |
| `EXT-33 ACL` | read-only mask, SID-scoped ownership, broad-ACE refusal, reparse refusal, journaling, external-hard-link refusal, no-grant/stale/non-Granted `may_start` bypass | 9 | **9/9 caught** |
| `EXT-33 E4` | C1 filter capability gate + identity + concurrency (regression) | 3 | **3/3 caught** (after re-anchoring E4-03, see note) |

> **Mutation-target drift found and fixed.** The first `EXT-33 E4` run reported `E4-03` (`process.runFilter` runs without the process capability) as **DRIFTED**: its one-line anchor `need(PROCESS)` now matched **twice** in `extension_permissions.rs`, because the E5 work added a second `need(PROCESS)` for `process.callServer`. A drifted mutation proves nothing, so the regression guard was effectively lost. Fix: re-anchored `E4-03` to the runFilter-unique `!slots_ok` branch (mirroring how `C2S-03` anchors the callServer-unique `!op_ok` branch). Re-run: **3/3 caught**. No protection logic changed — only the mutation's target text. This is the one finding of this increment; it is resolved.

Live suites:

| Suite | Command | Result |
| --- | --- | --- |
| ACL lifecycle (production feature set) | `cargo test -p ide-workspace --test workspace_acl -- --test-threads=1` | **22 passed, 0 failed, 2 ignored** |
| C2 launch/channel/isolation/revocation/shutdown | `cargo test -p ide-workspace --features c2-test-profiles --test c2 -- --test-threads=1` | **20 passed, 0 failed, 2 ignored** (2026-11-01, incl. shutdown + no-swap tests) |
| C2 capability commands + permissions regression | `cargo test -p yavin-ide --features c2-test-profiles --lib -- c2_capability extension_permissions` | **12 passed, 0 failed** |

No `os error 4551` (Smart App Control) was hit in these runs. The mutation runner retried none; all builds compiled and the named tests ran.

### 5.7 Not run this increment (explicitly outstanding)

- **Release-profile crate build — DONE 2026-10-31** (§5.2): `cargo build --release -p yavin-ide` exit 0, 1m18s, `yavin-ide.exe` 22,750,208 bytes.
- **Full packaged `tauri build` bundle (installer/MSI/NSIS, signing) and the foreground-focus test — NOT run, NOT claimed.** They need the frontend build + bundler/signing toolchain not exercised here. The crate-level release build is the feasible subset.
- **Cold-cache ACL latency tiers — NOT measured (infeasible here).** Forcing a cold file-system cache requires an admin standby-list flush (RAMMap/EmptyStandbyList) or a reboot, unavailable in this environment. Fresh **warm** figures were taken 2026-10-31 (1k: grant 39.5 ms / revoke 33.6 ms; 10k: grant 349 ms / revoke 306 ms); cold runs would only be slower and do not change the async-always policy (D2).
- **Full 203-mutation sweep** — only the gate-relevant families (C2/ACL/E4) were run; the remaining families are unchanged this increment.

---

## 6. Release gate and rollback

### 6.1 Gate — production C2 stays disabled until ALL pass

| # | Condition | State |
| --- | --- | --- |
| G1 | D1–D4 recorded **with actual approvals** by their named roles | ❌ all `Proposed`/`Pending review` |
| G2 | A production candidate profile passes provenance + security review (hash, signature, version verified) | ⚠️ Ruff provenance, archive **attestation (`gh attestation verify`, exit 0)**, pinned exe hash, and resource limits all **verified/measured** (§C); **outstanding:** the Ruff op adapter (not built — spec only), and a human security sign-off |
| G3 | Hard-link risk mitigated or dispositioned by the security decision-maker | ⚠️ mitigated by refusal (code); formal disposition pending D1 |
| G4 | Cleanup/revocation guarantees have sufficient evidence | ⚠️ automated evidence complete and green (§B; 42 live tests incl. shutdown + no-swap, 9/9 ACL mutations); still gated with D1 |
| G5 | Release acceptance evidence complete and reviewed | ⚠️ §5 complete and green (release-config assertion, release-config compile, 27 gate mutations, 52 live tests) **except** the packaged `tauri build`/focus test (§5.7); awaiting review |
| G6 | Production registry empty until a separate activation decision is approved | ✅ empty (5.1) — must stay empty until G1–G5 pass |

**Gate result: BLOCKED (G1 and G2 fail).**

### 6.2 Activation — a separate, minimal, reviewable change (do NOT apply now)

Activation is intentionally not part of this increment. When G1–G5 pass, activation is a small reviewed diff:
1. Add the feature/registration that constructs `C2Authority` **with the one approved profile** (the reviewed `ProgramId` path + verified SHA-256), behind an explicit production enablement — not the test feature.
2. Bundle the provenance-verified binary and wire its path.
3. No change to the sandbox, ACL, consent, or authority logic (all already enforced).
The diff must be reviewed on its own, with the profile review and decision log attached.

### 6.3 Rollback / deactivation

1. **Revoke active grants:** call `C2Authority::revoke` for every live grant (ends the process, removes the workspace ACE, verifies zero residue) — or trigger app `shutdown`, which revokes all and waits for ACL quiescence.
2. **Remove the profile:** revert the activation diff so `C2Authority::new` again registers no profile; rebuild. Every subsequent call answers `UnknownProfile`.
3. **Verify deactivation:** the release-config assertions (§5.1) pass (empty registry; launch/request → `UnknownProfile`); `cargo check -p yavin-ide` (no feature) builds.
4. **Verify no residual ACLs:** run `reconcile` at startup (removes and verifies zero container-SID ACEs for any journaled grant); independently confirm with `sandbox::container_aces(root, container) == 0` on any workspace that had a grant. Any non-zero count is a rollback failure and must be re-reconciled.
5. **Confirm journals drained:** `c2-grants.json` holds no active C2 grant; the ACL journal records no un-reconciled intent.

---

## 7. Unresolved blockers (summary)

1. **D1–D4 unapproved** (human decisions) — the primary blocker. No owner/date assigned.
2. **Profile not registrable yet** — Ruff provenance, archive attestation (`gh attestation verify` exit 0), pinned exe hash (`1447a6a2…a11b`), and resource limits are **verified/measured** (§C). Remaining: the **Ruff op adapter is not implemented** (the `lint`/`format-check` allow-list + path validation + output pagination is design-only; building it is gated behind D1–D4 + activation), and a human **security sign-off**.
3. **Full packaged `tauri build` bundle + foreground-focus test not run** — the release-profile crate build **was** run (exit 0); the installer/signing bundle and focus test remain outstanding.
4. **Cold-cache latency tiers unmeasured** — infeasible in this environment (admin standby-list flush/reboot needed); warm figures refreshed 2026-10-31 (D2).
5. **Multi-root / nested-repository workspace scope** undecided (D1 refuses it for now).

**Findings this increment.**
- **Resolved:** mutation `EXT-33 E4-03` had drifted (its anchor matched twice after E5 added `process.callServer`), silently losing the "`runFilter` without the process capability" regression guard. Re-anchored and re-verified (3/3 caught). No protection logic changed. *Follow-up for maintainers:* single-line `need(PROCESS)` anchors are fragile when a capability is reused by a new method; prefer branch-unique anchors (as `C2S-03`/`E4-03` now do).
- **Resolved this increment:** the authority-level `C2Authority::shutdown` now has a direct test (`shutdown_revokes_every_live_server_and_quiesces`) covering two servers/workspaces; the earlier coverage note is closed.

**No enforcement defect was found.** The implemented controls (containment, reparse/hard-link refusal, journaled zero-residue cleanup, per-request re-authorization, production exclusion) hold under their tests and mutations. The gap to release is governance (D1–D4) and a reviewed profile, not missing enforcement. **E5 is not complete; E1–E4 untouched; E6 not begun.**
