# C2 (EXT-33 E5) decision log

> ⚠️ **Development status (2026-11-01): ON HOLD — IN DEVELOPMENT, NOT SHIPPED.** C2 is held for now, disabled in every build (empty registry, unknown profiles fail closed), pending D1–D4 approvals and a security sign-off. Work-in-progress pushed for visibility, not a release.

**Status: all four decisions OPEN. Production C2 is disabled and must stay disabled until each is `Approved` by its named decision-maker.** This log records recommendations and evidence so a reviewer can approve or reject a concrete design; it does **not** itself approve anything. Nothing here is an engineering go-ahead, a legal opinion, or an authorization to register a C2 profile.

- Authored: 2026-10-31 · Branch: `ext-32-workers` · Revision at authoring: `6947a3f`
- Companion documents: [`PROCESS_CAPABILITY_DESIGN.md`](PROCESS_CAPABILITY_DESIGN.md) §15 (Q5, Q11), §24.1–§24.8 (what is built); [`C2_PRODUCTION_PROFILE_REVIEW.md`](C2_PRODUCTION_PROFILE_REVIEW.md); [`C2_RELEASE_READINESS.md`](C2_RELEASE_READINESS.md).
- Conventions: decision-maker **roles** are named; **owners and target dates are `TBD`** because no owner has been assigned in-repo and this process cannot assign one. No owner, date, approval, or legal advice below is invented.

> **Architect baseline (2026-10-31).** The senior architect has **adopted D1–D4 as the engineering baseline** — the implementation is built to these choices and will not be redesigned without a concrete defect. This is an *engineering* decision about how the system is built; it is **not** the release-gate approval. The release-gate `Status` column below (who must sign off before production C2 is enabled) is unchanged and still **OPEN** for every decision. In particular, D1 (persistent ACL change on user files) and D3 (consent/legal) require human sign-off that an architect cannot give.

## Summary

| ID | Decision | Role to decide | Owner / target | Recommendation | Status |
| --- | --- | --- | --- | --- | --- |
| D1 | Accept a recursive, read-only ACL grant on the user's workspace folder | Security decision-maker (+ product owner for the user-files policy) | TBD / TBD | Accept Option A (scoped, read-only, reparse/hard-link-refusing, journaled) with the stated conditions | **Pending review** |
| D2 | ACL grant/removal latency budget and timeout behavior | Engineering lead (+ product for UX threshold) | TBD / TBD | Async-always; server never starts before `Granted`; progress past ~1 s; large trees cancellable. No flat wall-clock SLA | **Proposed** |
| D3 | C2 consent / security-privacy disclosure wording | Privacy/legal reviewer **and** security reviewer (jointly) | TBD / TBD | Adopt the drafted wording as a **draft**; do not ship without privacy/legal + security sign-off | **Proposed (draft; needs legal/privacy + security review)** |
| D4 | C2 AppContainer SID granularity and lifecycle (Q11) | Security decision-maker | TBD / TBD | Per (extension copy + class + workspace) derived SID — the implemented design | **Proposed** |

---

## D1 — Recursive workspace ACL access and inheritance

**Exact question (Q5).** Will Yavin accept adding a read-only ACL entry for a per-extension/class AppContainer SID to the user's **workspace folder and its entire subtree**, as a persistent change to the ACLs of the user's own files, so that a contained C2 server (e.g. a language server) can read the project it operates on? Alternatives: a broker-mediated file API (requires adapting every server), or copying the workspace (impractical by size/staleness).

**Decision-maker role.** Security decision-maker, with product-owner concurrence because the change touches the user's own files' security descriptors.

**Owner / target date.** TBD / TBD.

**Recommended option.** **Option A — a scoped read-only grant**, exactly as implemented and proven live (`workspace_acl::safe_grant`), with these properties, all required:

1. **Subtree boundary.** One canonical workspace root per grant. Ambiguous multi-root / nested-repository scope is **out of scope** and refused until separately decided.
2. **Inherited permissions.** A single Access-Allowed ACE for the derived container SID granting `FILE_GENERIC_READ` only — no write, append, delete, execute, `WRITE_DAC`, or `WRITE_OWNER` — with `CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE` so existing and newly created descendants inherit read. Write/network/child-process denial remains the sandbox's job (unchanged).
3. **Newly created descendants.** Inherit the read-only ACE by normal Windows inheritance; they are readable, never writable by the container.
4. **Reparse points.** The tree is scanned and the **whole grant is refused** if any symlink/junction/`..`/ADS/device/8.3 path reaches outside the canonical root (`workspace_acl::outward_reparse`). Independently, Windows evaluates reads against the *target* object's DACL, so an outward junction is **denied at read time even if planted after the scan** — proven by `reads_cannot_escape_the_root_through_a_junction` (see D1 evidence).
5. **Hard links — addressed separately (do not assume reparse refusal covers them).** A hard link inside the root to a file **outside** it is a second name for the *same* object, and the inherited ACE can land on that shared object during propagation. These trees are **refused at grant** (`sandbox::external_hard_link_name` via link-count + `FindFirstFileNameW`; `workspace_acl::external_hard_link`); hard links created *after* the grant are denied by the OS because the object was never ACE'd. Hard links are same-volume only, so name enumeration is complete, not best-effort. See [`C2_RELEASE_READINESS.md`](C2_RELEASE_READINESS.md) §A for the live evidence.
6. **Cleanup.** Every add/remove is journaled before the ACL is touched; `revoke` verifies zero residual container-SID ACEs before clearing; `reconcile` at startup re-removes the ACE of every journaled grant and verifies zero residue (including on a protected/non-inheriting child DACL); a corrupt journal fails closed.

**Alternatives considered and why not.** Option B (broker-mediated FS API) cannot run the concrete servers (ruff, Lua LS) unmodified and is **rejected for C2**. Workspace copying is impractical (size, staleness).

**Security and operational consequences.**
- *Benefit:* real third-party servers can read the workspace while the OS provably denies write/network/child-process from inside the no-capability AppContainer.
- *Cost/residual:* a read ACE for the container SID persists on the user's files for the grant's lifetime; cleanup must be complete on revoke / disable / uninstall / workspace switch / shutdown / crash. The **same-user residual** (§4.2 of the design) stands: other code running as the same user could already read these files; the grant does not lower that bar, but it does add a container principal that can read until revoked.
- *Hard dependency:* a tree carrying a pre-existing broad write ACE (`ALL APPLICATION PACKAGES` / `ALL RESTRICTED APPLICATION PACKAGES` with write/modify) would let the sandbox write; `safe_grant` **refuses** such trees (`container_writable`), so this must remain a refusal, not a warning.

**Evidence.** `PROCESS_CAPABILITY_DESIGN.md` §24.2–§24.4; live tests `a_read_only_grant_allows_reads_and_denies_every_write`, `a_pre_existing_broad_write_ace_defeats_read_only`, `revocation_removes_the_grant_and_preserves_other_aces`, `reads_cannot_escape_the_root_through_a_junction`, `hard_links_present_at_grant_expose_the_object_but_later_ones_do_not`, reconcile/crash-recovery tests in `crates/ide-workspace/tests/workspace_acl.rs`; mutations `EXT-33 ACL-01..09`.

**Status: Pending review.** Actual decision / rationale / decision-maker / date: _not yet made._

---

## D2 — ACL grant latency budget and timeout behavior

**Exact question.** What measurable latency budget applies to applying and removing the recursive ACE, what exactly does it measure, and how do timeout, cancellation, rollback, and extension-blocking behave? A timeout must never result in an unauthorized launch.

**Decision-maker role.** Engineering lead, with product-owner input on the user-visible progress/cancel threshold.

**Owner / target date.** TBD / TBD.

**Recommended policy (measured, not yet ratified — do not treat the numbers below as an approved SLA).**
- **What is measured:** wall-clock of `begin_grant`→`Granted` (apply + verify) and `begin_revoke`→removed (remove + zero-residue verify), on the machine/tree stated with each figure. Recursive ACE propagation is **O(tree size)**.
- **Measured (warm cache, developer machine; load varies run to run):** 1k ≈ 30–40 ms; 10k ≈ 0.26–0.60 s; 100k ≈ 2.6–11.5 s; **500k grant ≈ 25.8 s / revoke ≈ 27.4 s (actual, not extrapolated)**. Fresh run 2026-10-31: 1k grant 39.5 ms / revoke 33.6 ms; 10k grant 349 ms / revoke 306 ms (`YAVIN_ACL_FILES` + `measure_acl_latency`). (Earlier figures from §24.2/§24.4/§24.5.)
- **Cold-cache: NOT measured — infeasible in this environment.** Forcing a cold file-system cache needs an admin standby-list flush (RAMMap/EmptyStandbyList) or a reboot, unavailable here. Cold runs would only be slower; the async-always/verified-before-start policy is independent of the absolute figure. A ratified budget must state whether cold-cache tiers are required (and then be measured on a suitable machine).
- **Policy:** **async-always** (never block the UI thread); the contained server **does not start until the grant reaches `Granted` after verification** (`may_start`); a visible progress/"working" indication once an operation exceeds ~1 s; large trees cancellable. Because `SetNamedSecurityInfoW` is a single uninterruptible call with no sub-operation callback, "progress" is a state transition, not a percentage, and **cancellation is best-effort after the call begins** (a grant that applies after cancel is rolled back / revoked — proven by `cancelling_a_grant_leaves_no_applied_permission`).
- **Timeout → no launch, fail closed.** If a grant does not reach `Granted`, `may_start` refuses and no server starts. A stale grant can never re-apply behind a newer revoke (monotonic `OP_SEQ`; `a_newer_revoke_prevents_a_stale_grant_from_reapplying`, mutation `ACL-08`). The extension's request remains blocked/refused; it never receives a handle.

**Consequences.** A flat wall-clock SLA is **infeasible** for very large trees (500k ≈ 26 s); forcing one would either fail huge workspaces or invite an unsafe "launch anyway" path. The async-always + verified-before-start policy keeps safety independent of tree size at the cost of a possibly long, cancellable wait on very large workspaces.

**Evidence.** §24.2, §24.4, §24.5; `WorkspaceGrantManager` lifecycle; tests named above; mutations `ACL-07` (no-grant bypass), `ACL-08` (stale reapply), `ACL-09` (non-`Granted` accepted).

**Status: Proposed (measured, budget not ratified).** Actual decision: _not yet made._ A ratified budget must state the target machine class, workspace-size tiers, and whether cold-cache tiers are required before approval.

---

## D3 — User consent and security/privacy disclosure wording

**Exact question.** What exact disclosure does the C2 consent dialog present, describing the data a contained server can read (including `.env`, credentials, private keys, `.git/config`), the grant's scope, duration, revocation behavior, and residual risk — and it must never claim the server is "safe"?

**Decision-maker role.** Privacy/legal reviewer **and** security reviewer, jointly. This log cannot and does not grant legal approval.

**Owner / target date.** TBD / TBD.

**Draft wording (for review — not approved).** The dialog is native (the renderer cannot answer it), identity-bound, and separate from Workspace Trust and ordinary extension permissions. Proposed text:

> **Allow “{extension name}” to run a background server that can read this workspace?**
>
> “{extension name}” ({extension id}, version {version}) wants to start a sandboxed helper that will **read every file in `{workspace path}`**, including any secrets kept there — for example `.env` files, API keys and credentials, private keys, and `.git/config`.
>
> The helper runs isolated: it **cannot modify your files, use the network, or start other programs**. It can only **read** this folder.
>
> Allowing this **does not mean the server is safe.** It means you accept that this extension's server may read the contents of this workspace until you revoke access.
>
> This permission applies to **this workspace only**, persists until you revoke it (Extensions → this extension → Revoke server access), and is removed automatically when you disable or uninstall the extension or switch workspaces.
>
> [ Allow for this workspace ]  [ Don't allow ]  (default: Don't allow)

**Consequences.** The wording must name secrets concretely (so consent is informed), must not imply safety/trust/verification (§8.6), and must state scope (this workspace), duration (until revoked), and revocation path. It is deny-by-default. Legal/privacy review is required before any shipping copy; security review must confirm the described containment matches the enforced containment.

**Evidence.** Implemented C2 consent body (`grants.rs`, `Scope::C2`) already names the extension + workspace + `.env`/credentials/private keys/`.git/config` and never claims safety; tests `the_c2_consent_names_the_workspace...`, `a_c2_grant_requires_a_workspace`. The wording above aligns the dialog copy with that body for reviewers to ratify.

**Status: Proposed (draft; requires privacy/legal and security sign-off).** Actual decision: _not yet made._

---

## D4 — C2 AppContainer SID granularity and lifecycle (Q11)

**Exact question.** At what granularity is the contained server's AppContainer identity (SID) created: per-user, per-session, per-extension, or per-extension+class+workspace — and how do isolation, grant reuse, concurrent sessions, revocation, ACL cleanup, and stale-identity recovery behave?

**Decision-maker role.** Security decision-maker.

**Owner / target date.** TBD / TBD.

**Comparison against the current implementation.**

| Granularity | Isolation | Grant reuse | Concurrency | Revocation / cleanup | Stale identity | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Per-user | None between extensions | Maximal | — | One revoke affects all | — | **Rejected** — no isolation |
| Per-session | None between extensions in a session | High | New SID per session | Session end cleans | Low reuse | **Rejected** — no per-extension isolation |
| **Per extension+class+workspace (implemented)** | One extension/class/workspace cannot read another's tree | Bounded, deterministic | Two workspaces grant concurrently and stay isolated | ACE removed for exactly that SID; others preserved; zero-residue verified | Deterministic re-derivation; `reconcile` cleans orphans | **Recommended** |
| Per-process | Strongest | None (new SID each launch) | High churn | More ACE adds/removes | Hard to reconcile | Not needed; churn without benefit over per-ext+class+workspace |

**Current design (implemented, test-only).** `workspace_identity::derive(copy_id, class, workspace_root)` yields a deterministic AppContainer name `Yavin.<class>.v1.<32 hex>` = length-prefixed, domain-separated SHA-256 over `(version, class, copy, canonical-root)`. The launch verifies the **token SID == derived SID == the SID the ACL granted** (one identity across token, derivation, and ACL). An extension update changes `copy_id` and therefore the SID; the format is versioned (bumping `IDENTITY_VERSION` re-derives all).

**Consequences.** Per-extension+class+workspace keeps profiles and ACL grants bounded, isolates tenants, and makes cleanup/reconcile tractable (each grant keyed by `(root, container)`). The residual choice for the decision-maker is only whether class granularity should ever be coarser (per-extension across classes) — **not recommended**, as it would let a C2 grant's SID be reused by another class.

**Evidence.** §24.6 (identity + SID agreement, mutation `C2-11`); §24.2/§24.5 isolation tests (`a_grant_to_one_container_is_not_shared_with_another`); `reconcile` recovery tests.

**Status: Proposed.** Actual decision: _not yet made._

---

## What this log does not do

- It does not register, activate, or hash-pin any C2 profile (see [`C2_PRODUCTION_PROFILE_REVIEW.md`](C2_PRODUCTION_PROFILE_REVIEW.md)).
- It does not approve any decision on behalf of security, legal/privacy, engineering, or product.
- It does not assert owners or dates that have not been assigned.
- Until D1–D4 are `Approved` with real sign-offs, the production C2 registry stays empty and E5 remains incomplete.
