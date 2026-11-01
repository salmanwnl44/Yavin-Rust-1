# C2 (EXT-33 E5) — final gate review

> ⚠️ **Development status (2026-11-01): ON HOLD — IN DEVELOPMENT, NOT SHIPPED.** The C2 contained-server extension capability is being held for now: it is disabled in every build, the production profile registry is empty, and unknown profiles fail closed. It stays held pending the human approvals (D1–D4) and a security sign-off. This is work-in-progress pushed for visibility, not a release; do not enable it.

**Gate status: BLOCKED. Production C2 registry is EMPTY and stays empty.** This review closes the governance and evidence gaps that can be closed by inspection, research, and safe verification, and states exactly which human approvals remain. It activates nothing, registers no profile, changes no ACL/enforcement, and does not begin E6.

- Authored: 2026-10-31 · Branch: `ext-32-workers` · Revision at authoring: `6947a3f`
- Toolchain: rustc 1.99.1 (58cf8f9c3 2026-10-13), cargo 1.99.1, node v24.20.0 · Platform: Windows 11 (26300)
- Companions (full detail): [`C2_DECISION_LOG.md`](C2_DECISION_LOG.md), [`C2_PRODUCTION_PROFILE_REVIEW.md`](C2_PRODUCTION_PROFILE_REVIEW.md), [`C2_RELEASE_READINESS.md`](C2_RELEASE_READINESS.md), [`PROCESS_CAPABILITY_DESIGN.md`](PROCESS_CAPABILITY_DESIGN.md) §24.

---

## 1. D1–D4 decision briefs and approval status

All four remain **unapproved**. No owner or deadline has been assigned in-repo; this process cannot assign one, so each is `TBD`. No approval below is invented.

### D1 — Recursive workspace ACL scope and inheritance
- **Exact decision required:** accept (or reject) that Yavin may add one inheritable **read-only** ACE for a per-extension/class AppContainer SID to the user's **workspace root and its whole subtree**, as a persistent change to the user's files' ACLs, so a contained server can read the project.
- **Recommended option:** **Accept Option A** — scoped single canonical root; `FILE_GENERIC_READ` only (`CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE`); refuse the whole tree on any outward reparse point or external hard link; refuse any tree the container could already write; journal-before-mutation with startup `reconcile` to zero residue.
- **Alternatives & trade-offs:** *Option B (broker-mediated FS API)* — cannot run ruff/Lua LS unmodified → **rejected for C2**. *Workspace copy* — impractical (size/staleness) → rejected. *Do nothing* — C2 cannot exist on Windows.
- **Existing technical evidence:** live tests (read allowed / write-network-child denied; broad-write-ACE tree refused; outward junction read-denied and refused; external hard link refused; revoke/reconcile zero residue; protected-DACL child clean) — `workspace_acl` suite **22 passed / 0 failed** (re-run 2026-10-31); mutations `ACL-01..09` **9/9 caught**.
- **Security & operational consequences:** enables real servers with OS-enforced write/network/child denial; cost is a read ACE persisting on the user's files until revoked, plus the generic same-user residual (§4.2) that other same-user code can already read those files.
- **Specific approval question:** *"Do you accept a persistent, scoped, read-only container-SID ACE on the user's workspace subtree, with grant-time refusal of outward-reparse / external-hard-link / already-writable trees and journaled zero-residue cleanup, as the C2 workspace-read mechanism?"*
- **Required approving role:** Security decision-maker (with product-owner concurrence for the user-files policy). **Owner/deadline:** TBD / TBD. **Status: Pending review.**

### D2 — ACL latency budget and timeout behavior
- **Exact decision required:** ratify a latency **policy** (not a flat SLA) and the timeout/cancellation behavior.
- **Recommended option:** **async-always**; the server never starts before the grant is `Granted` (verified by `may_start`); visible progress once an op exceeds ~1 s; large trees cancellable (best-effort post-apply, then rolled back); **a timeout never launches**.
- **Alternatives & trade-offs:** a *flat wall-clock SLA* is infeasible — propagation is O(tree) and 500k ≈ 26 s (measured); enforcing one would either fail large workspaces or invite an unsafe "launch anyway" path.
- **Existing technical evidence (measured, warm):** 1k ≈ 0.04 s; 10k ≈ 0.35 s (fresh 2026-10-31: grant 349 ms / revoke 306 ms); 100k ≈ 2.6–11.5 s; **500k grant ≈ 25.8 s / revoke ≈ 27.4 s (actual)**. **Cold-cache not measured** — cannot be forced in this environment without an admin standby-list flush or reboot (documented limitation). Stale-op safety and cancellation proven (`a_newer_revoke_prevents_a_stale_grant_from_reapplying`, `cancelling_a_grant_leaves_no_applied_permission`; mutations `ACL-07/08/09`).
- **Security & operational consequences:** safety is independent of tree size (verified-before-start); cost is a possibly long, cancellable wait on very large trees.
- **Specific approval question:** *"Do you ratify the async-always, verified-before-start, cancellable policy (no flat time SLA), and accept that cold-cache tiers remain unmeasured until a suitable environment is available?"*
- **Required approving role:** Engineering lead (product input on the progress/cancel UX threshold). **Owner/deadline:** TBD / TBD. **Status: Proposed (measured; cold-cache tier outstanding).**

### D3 — Consent wording and privacy/legal review
- **Exact decision required:** approve the native C2 consent/disclosure wording.
- **Recommended option:** adopt the drafted dialog (names the extension + workspace; states the server can read every file **including `.env`, credentials, private keys, `.git/config`**; states it cannot write/network/spawn; states scope = this workspace, duration = until revoked, and the revocation path; **never says "safe"**; deny-by-default). Full text in `C2_DECISION_LOG.md` D3.
- **Alternatives & trade-offs:** vaguer wording risks uninformed consent; naming secrets concretely is the recommended bar. Wording is subject to legal/privacy phrasing constraints this process cannot anticipate.
- **Existing technical evidence:** the implemented C2 consent body already names the extension + workspace + those secret classes and never claims safety (`grants.rs` `Scope::C2`; tests `the_c2_consent_names_the_workspace...`, `a_c2_grant_requires_a_workspace`; mutation `C2T-03` catches a skipped consent gate).
- **Security & operational consequences:** informed, revocable, per-workspace consent; the wording must match the enforced containment exactly (security review) and satisfy disclosure norms (privacy/legal).
- **Specific approval question:** *"Does privacy/legal approve this disclosure wording for shipping, and does security confirm it accurately describes the enforced containment?"*
- **Required approving role:** Privacy/legal reviewer **and** security reviewer, jointly. **This review provides NO legal conclusion.** **Owner/deadline:** TBD / TBD. **Status: Proposed draft (needs legal/privacy + security sign-off).**

### D4 — SID granularity and lifecycle (Q11)
- **Exact decision required:** confirm the AppContainer identity granularity.
- **Recommended option:** **per (extension copy + class + workspace)** deterministic derived SID (implemented) — never `ALL APPLICATION PACKAGES`.
- **Alternatives & trade-offs:** per-user / per-session give no per-extension isolation → rejected; per-process adds churn without benefit over per-copy+class+workspace. Coarser (per-extension across classes) would let a C2 SID be reused by another class → not recommended.
- **Existing technical evidence:** token SID == derived SID == ACL-granted SID proven live; isolation proven (`a_grant_to_one_container_is_not_shared_with_another`, `concurrent_grants_on_two_workspaces_are_isolated`); deterministic re-derivation + `reconcile` for stale identities; mutation `C2-11` (identity substitution) caught.
- **Security & operational consequences:** bounded profiles/grants, tenant isolation, tractable cleanup/reconcile; an extension update changes `copy_id` → new SID (old grant revocable/reconcilable).
- **Specific approval question:** *"Do you confirm per-(extension copy + class + workspace) SID granularity as the C2 identity model?"*
- **Required approving role:** Security decision-maker. **Owner/deadline:** TBD / TBD. **Status: Proposed.**

---

## 2. Ruff provenance verification results

Verified from authoritative upstream (PyPI metadata API + GitHub release + published `.sha256`), with the archive's **GitHub Artifact Attestation cryptographically verified** 2026-11-01 (`gh attestation verify`, exit 0). The Windows archive was downloaded to an isolated scratchpad directory, its checksum matched the published value and the verified attestation subject, and the extracted `ruff.exe` was hashed with two independent tools. The binary was **not executed during provenance verification**; it **was** executed later, on isolated throwaway workspaces only, to measure resource limits (§3). **Nothing was bundled into the repository or registered.** Full detail (exact commands) in `C2_PRODUCTION_PROFILE_REVIEW.md` and `C2_RELEASE_READINESS.md` §C.

| Fact | Value | Status |
| --- | --- | --- |
| Source repository | `https://github.com/astral-sh/ruff` (PyPI `project_urls` "Repository") | **Verified** |
| License | `MIT` (`license_expression`, PyPI) | **Verified** |
| Candidate version | **0.17.3** (GitHub "Released on 2026-10-26"; PyPI wheels `2026-10-27T00:34:02Z`) | **Verified latest at authoring** |
| Windows release asset | `ruff-x86_64-pc-windows-msvc.zip` (+ `.sha256` checksum file) | **Verified** |
| Zip published SHA-256 | `a84d9ac74af8ef5bac84a1888a1634df18e6e985e2f930d35c052beacd00e813` | **Verified (published)** |
| GitHub Artifact Attestation | `gh attestation verify … --bundle … --repo astral-sh/ruff` → **exit 0** | **VERIFIED 2026-11-01** (Sigstore public-good trust root; offline bundle, no GitHub auth) |
| Attestation subject / builder | subject `…windows-msvc.zip = a84d9ac7…e813`; builder `…/release.yml@refs/heads/main`; issuer `token.actions.githubusercontent.com`; src rev `ba65abf…` | **Verified** |
| PyPI wheel | `ruff-0.17.3-py3-none-win_amd64.whl`, sha256 `56b8ffb3f3b3cbccb8b76b71b38261b7ed982ef5d20f5b447b1b61a7f4949b24` | **Verified (published)** |
| PyPI wheel PEP 740 attestation | none (`has_sig: false`, no `attestations`) | **Verified absent** → bundle the attested GitHub artifact |
| **Exact `ruff.exe` hash to pin in `ProgramId`** | **`1447a6a20b86e5d40bfebb0c2e56f8b929e2c30b0131f9ab1b5afbc826f5a11b`** (27,150,128 bytes) | **VERIFIED** — from the attested, checksum-matched archive; hashed with two tools |
| Ruff op set + argument validation | `lint`, `format-check` (allow-list), path-scoped | **Defined (architect); adapter NOT built** |
| Production memory/CPU/process limits | 1 GiB / 1 core-equiv / 1 proc | **MEASURED & validated** (peak 179 MB; see §3) |
| Deadline 10 s / response 1 MiB | — | **Validated for path-scoped ops only** — whole-tree lint exceeds both (§3) |

**Update/rollback policy (proposed):** new version → verify the GitHub artifact's attestation **and** published `.sha256` → extract → recompute exe hash → security-review the version diff → update the pinned `ProgramId`; rollback reverts `ProgramId` to the prior approved version+hash (C2 re-hashes every launch, Q9, so the old binary stops being accepted).

**LuaLS** remains the documented alternative (ships a runtime + data files → larger surface; its provenance was not verified this increment).

---

## 3. Outstanding latency and packaged-build evidence

| Item | Status | Detail |
| --- | --- | --- |
| Release-profile crate build (production features, no `c2-test-profiles`) | **DONE 2026-10-31** | `cargo build --release --locked -p yavin-ide` → exit 0 in **1m18s**; `yavin-ide.exe` **22,750,208 bytes**, built `2026-10-30T21:59:09Z`. Proves the shipped crate builds in the release profile with the test feature off. |
| Full packaged `tauri build` bundle (installer/MSI/NSIS) | **NOT run** | Requires the frontend build (`npm run build`) + bundler/signing toolchain; not exercised here. The crate-level release build above is the feasible subset. **Not claimed as a packaged acceptance.** |
| Warm ACL latency (fresh) | **DONE 2026-10-31** | 1k grant 39.5 ms / revoke 33.6 ms; 10k grant 349 ms / revoke 306 ms. Consistent with prior runs. |
| Cold-cache ACL latency | **NOT measured (infeasible here)** | Forcing a cold file-system cache needs an admin standby-list flush (e.g. RAMMap/EmptyStandbyList) or reboot; not available in this environment. Cold runs would only be *slower*, and the async-always/verified-before-start policy (D2) is independent of the absolute figure. |
| **Ruff archive attestation** | **DONE 2026-11-01** | `gh` v2.103.3 installed via winget; offline `gh attestation verify … --bundle … --repo astral-sh/ruff` → **exit 0** against the Sigstore public-good trust root (no GitHub auth needed). |
| **Ruff resource measurement** | **DONE 2026-11-01** | Isolated 50/1000/5000-file Python trees; peak WS **179 MB** (vs 1 GiB), CPU/wall ≈ 0.15. Deadline 10 s & response 1 MiB **exceeded by whole-tree lint** (31.8 s / 22.7 MB) → op must be path-scoped. Detail + raw data in `C2_RELEASE_READINESS.md` §C.2. |
| Gate security checks | **DONE** | Release-config assertion `tests/c2_production.rs` 3/3; `workspace_acl` 22/0/2; `c2` **20/0/2** (incl. new shutdown + no-swap tests); `c2_capability`+`extension_permissions` 12/0; mutations `C2` 15/15, `ACL` 9/9, `E4` 3/3. |
| Packaged foreground-focus test | **NOT run, NOT claimed** | Out of scope for this environment. |

---

## 4. Security risks and unresolved questions

1. **Persistent ACL change to user files (D1)** — scoped read-only, refusal-guarded, journaled; residual is the generic same-user read. Needs explicit acceptance.
2. **Secrets exposure to a consented server** — inherent to read-only workspace access; mitigated by informed, revocable, deny-by-default consent (D3, needs legal/privacy).
3. **Profile provenance** — Ruff upstream/version/distribution, the archive **attestation (`gh attestation verify`, exit 0)**, the pinned `ruff.exe` hash (`1447a6a2…a11b`), and resource limits are all **verified/measured**. **Outstanding:** the Ruff **op adapter is not implemented** (the `lint`/`format-check` allow-list + path validation + output pagination is design-only; whole-tree output/time exceed the channel's 1 MiB/10 s bounds, so the op must be path-scoped), and a human **security sign-off**.
4. **Cold-cache latency unmeasured** — environment limitation; does not affect safety.
5. **Multi-root / nested-repository scope** — undecided; currently refused.
6. **Full packaged bundle unverified** — only the crate-level release build was run.

---

## 5. Exact release-gate status

| # | Condition | State |
| --- | --- | --- |
| G1 | D1–D4 recorded **with actual approvals** | ❌ all unapproved (Proposed/Pending review) |
| G2 | Production candidate profile passes provenance + security review | ⚠️ provenance **verified** (incl. **attestation `gh attestation verify` exit 0**, pinned exe hash, **measured** limits); **outstanding:** the Ruff **op adapter** (not built — design-only) and a human **security sign-off** |
| G3 | Hard-link risk mitigated or dispositioned | ⚠️ mitigated by refusal (code + tests); formal disposition pending D1 |
| G4 | Cleanup/revocation guarantees evidenced | ✅ automated evidence complete/green; gated with D1 (app-`shutdown` lacks a standalone unit test) |
| G5 | Release acceptance evidence complete and reviewed | ⚠️ security checks + crate release build done; **full packaged bundle + cold-cache outstanding**; awaiting review |
| G6 | Production registry empty until a separate activation decision | ✅ empty (proven) — must stay empty |

**Gate result: BLOCKED** (G1 and G2 fail; G5 partial).

---

## 6. Actions requiring human approval

| Action | Who | What they approve |
| --- | --- | --- |
| D1 | Security decision-maker (+ product) | The persistent scoped read-only workspace ACL mechanism |
| D2 | Engineering lead (+ product) | The async-always latency policy; acceptance that cold-cache tiers are deferred |
| D3 | Privacy/legal **and** security (jointly) | The consent/disclosure wording (legal conclusion is theirs, not this review's) |
| D4 | Security decision-maker | Per-(copy+class+workspace) SID granularity |
| Profile | Security reviewer | Sign-off on the pinned Ruff 0.17.3 exe hash (`1447a6a2…a11b`, verified + attested), the measured limits, and the path-scoped op contract — and acceptance that the op adapter is a separate reviewed build |
| Activation | Release owner | The separate minimal activation change (registers the one approved profile) |

No owners or deadlines are assigned; all are `TBD`. This review cannot and does not approve any of the above.

---

## 7. Recommended next step

The profile's **mechanical** G2 work is now done: attestation verified (`gh attestation verify` exit 0), exe hash pinned, limits measured. The remaining G2 items are a **human security sign-off** and the **Ruff op adapter** (design-only; a separate reviewed build, correctly gated behind the decisions). So convene the **security decision-maker** to rule on **D1** and **D4** (architecture gates; evidence complete), route **D3** to privacy/legal + security with the drafted wording, and have **D2** ratified by the engineering lead (cold-cache deferral noted). Once D1–D4 are approved, the path-scoped op adapter is built and reviewed, then a separate minimal activation change registers the one approved profile.

Until then: **production C2 stays disabled, the registry stays empty, unknown profiles fail closed, and E6 is not begun.** E5 is not complete.
