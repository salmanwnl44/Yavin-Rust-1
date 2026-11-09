# Yavin — Non-AI Engineering Progress

Continuous engineering log for Yavin's desktop IDE quality (AI/LLM functionality explicitly out of scope). Each entry records a concrete, verified change. Completed entries are not rewritten.

- Branch: `main` · started: 2026-11-05
- Rules in force: no commits/push; no `git add .`/reset/clean/stash/restore; protected search license files untouched; C2 registry stays empty; no test-only profiles in production; E6 not begun; no AI features.

---

## WS18 — LSP Rename & Workspace-Wide Symbol Refactoring — ✅ GAP-ASSESSED + FILLED

**Finding (Phase 0/3): the rename and WorkspaceEdit pipelines are mature and already apply cross-file renames through the Document Model; two genuine safety gaps remain — no client-side validation of the new name, and no workspace-scope containment on a server's returned edit.** Tracing the lifecycle confirmed the rest exists and is correct, so nothing was rebuilt. **Rename already works end to end:** capability negotiation (`renameProvider` / `prepareProvider`, and client-side `rename.prepareSupport`); `resolveRenameLocation` uses `textDocument/prepareRename` when supported, handles all three response shapes (`Range`, `{ range, placeholder }`, `{ defaultBehavior }`), and **falls back to the word at the cursor** when prepare is unsupported or declines; `provideRenameEdits` issues `textDocument/rename` through the shared `ask`/manager path (server routing, **stale-result rejection**, cancellation) and hands the result to **Yavin's WorkspaceEdit engine — never Monaco** — so edits land through `DocumentService`. **F2 and the editor context-menu "Rename Symbol"** are Monaco's built-in rename action, present because a `RenameProvider` is registered; no command needed adding. **The WorkspaceEdit engine (`workspaceEdit.ts`) was already comprehensive:** every target resolved before anything changes; **versioned `documentChanges` version-checked** (stale → whole edit refused); **overlapping edits refused**; read-only / proposed / dirty-delete refused; **open dirty documents edited in place via `DocumentService`** (unsaved, undoable) and **closed files opened through the same guarded Module-03 ops** the Explorer uses; create/rename/delete routed to host file operations in order; URIs compared by `ResourceId` (multi-root safe); **honest non-transactionality** — a file op failing after text edits stops and reports what was done (no risky rollback). All of this is covered by existing `workspaceEdit.test.ts` (4 cases) and the F2 cross-file + read-only Playwright tests.

**Gap 1 — the new name was sent unvalidated (Phase 4).** `provideRenameEdits` passed `newName` straight to the server, so an empty, whitespace-only or multi-line name produced a doomed request. **Fix (`rename.ts`, pure + unit-tested):** `isValidRenameName` rejects a non-string, blank, or line-spanning name; the provider refuses such a rename **before any request is issued** and reports why, leaving the document untouched. Deliberately **no language-specific identifier rules** — the language server remains the authority on what is a legal identifier (a single-line non-blank name like `数値` or `a b` is passed through for the server to judge), per the spec's "Yavin validates basic request safety."

**Gap 2 — a server's edit could touch resources outside its workspace (Phases 5 & 7).** The engine applied whatever URIs a server returned, with no scope check — a buggy or hostile server could rewrite, create, rename or delete files anywhere on disk via a rename or a server-initiated `workspace/applyEdit`. **Fix:** `applyWorkspaceEdit` takes an optional `within` (the owning server's workspace folders); when given, **every file an edit touches must be inside one of them**, else the **whole edit is refused, changing nothing** (`untitled:` URIs can't reach disk and are unconstrained; Yavin's own edits, with no `within`, are unrestricted). The manager now exposes each server's root folder (`context().roots`, and passes `[server.folder.uri]` on server-initiated `applyEdit`), and the Monaco rename path forwards it. This enforces **multi-root isolation / no disk escape** at the one place edits are applied, honestly bounded by the architecture (each server is rooted at one folder; the guard is "within that folder").

**Tests and results — real vs. fake:**

- **`node --test` `rename.test.ts` → 1 passed (new):** `isValidRenameName` accepts a plausible/odd-but-single-line identifier and rejects empty, blank, tab-only, multi-line (`\n`/`\r`), `undefined` and numeric names.
- **`node --test` `workspaceEdit.test.ts` → 5 passed** (was 4), adding **WS18 scope containment**: an edit touching a file outside the given `within` folder is **refused whole** (not even the in-scope file changes, nothing written), while the same edit without the out-of-scope change applies normally under that scope.
- **Playwright `lsp.spec.ts` → 27 passed** (was 26), adding a **WS18 integration test over the real client → manager → rename provider → WorkspaceEdit engine → DocumentService path**: with the server answering rename with an edit to `file:///outside/secret.ts` (new `escapingRename` knob), the rename is **refused** ("outside the workspace"), the open document is byte-for-byte unchanged, and the out-of-workspace file was never created. The existing **F2 cross-file rename** and **read-only-file rename refused** tests still pass (regression).
- **Broad LSP unit suite (`src/services/lsp/*.test.ts`) → 59 passed, 0 failed; `documents.test.ts` + `editorModelBridge.test.ts` → 72 passed.** `tsc --noEmit` exit 0; `prettier` clean. **No Rust changed** (no Rust format/clippy/test run needed).

**Rename preview / safe-review behavior (Phase 6):** reused the existing safe-review model rather than building a custom diff system (per the spec's "reuse / avoid a large custom diff system"): a multi-file rename lands as **unsaved, undoable edits** across the affected documents — each shown with the "Unsaved changes" indicator and in the editor's diff gutter, **nothing written to disk until the user saves**, and the whole rename reversible with a single undo. **Cancellation leaves documents and disk unchanged** (Esc in the rename box issues no request; the engine's all-or-nothing check means a refused edit changes nothing). A dedicated pre-apply multi-file **preview/confirm panel is deferred** (below).

**WorkspaceEdit safety guarantees (Phase 7) — what is and isn't guaranteed:** text-edit range validation, overlapping-edit refusal, versioned-document checks, read-only/dirty/proposed refusal, `ResourceId` URI comparison, and now **workspace-scope containment** all hold as **preflight checks before any change**. **Atomicity is _not_ claimed for multi-resource file operations:** text edits are staged and applied together, but create/rename/delete go to the filesystem one by one, and a failure part-way **stops and reports what was done** — it does **not** roll back (a rollback that re-wrote files could clobber concurrent user changes; the spec forbids risky rollback). This limitation is stated plainly, not papered over.

**Performance / reliability (Phase 10):** no new request scheduling or caching; rename stays request-driven and asynchronous; `prepareRename` is issued once by Monaco's widget (no redundant calls added); the containment check is a single O(operations) pass with no document copies; cancellation and stale-version rejection are inherited from the unchanged `ask`/manager path.

**Real vs. fake verification:** verified against the **fake LSP server** over the real client, manager, Monaco rename provider, WorkspaceEdit engine and DocumentService (the spec's prescribed harness), with a deterministic `escapingRename` knob for the containment path. **No bundled real language server, so no real-server claim** — the rename follows LSP 3.17 and reuses the same request/stale/cancel machinery as the already-tested providers.

**Deferred / not done (with reasons):** (1) **A dedicated pre-apply multi-file rename preview/confirm panel** — the existing unsaved-edit + single-undo + diff-gutter model already lets the user review and revert a rename with nothing written to disk, and the spec explicitly cautions against a large custom diff system; a VS-Code-style refactor-preview tree is a UI feature, not a correctness gap. (2) **Per-sibling-folder isolation finer than "within the owning server's folder"** — the architecture roots each server at one folder (and informs it of siblings), so "within that folder" is the faithful, honestly-bounded scope; a cross-folder rename would come from a different server instance. (3) **Transactional multi-file create/rename/delete** — deliberately not implemented (see above); safe partial-failure reporting is used instead.

**Files changed:** `src/services/lsp/rename.ts` (new — `isValidRenameName`), `src/services/lsp/rename.test.ts` (new — 1 test), `src/services/lsp/workspaceEdit.ts` (+optional `within` scope containment), `src/services/lsp/workspaceEdit.test.ts` (+1 containment test), `src/services/lsp/manager.ts` (`context().roots`; pass server folder on `applyEdit`), `src/editor/lspMonaco.ts` (validate new name before request; forward scope to the engine; host-interface `within` param), `src/App.tsx` (forward `within` in both engine call-sites), `src/services/lsp/fakeServer.ts` (+`escapingRename` test knob), `tests/ui/lsp.spec.ts` (+1 integration test). No change to DocumentService, the editor-model bridge, Monaco internals, ResourceUri, protected files, or C1/C2. `ARCHITECTURE.md` unchanged — no invariant or ownership boundary changed (the containment guard enforces an already-implicit boundary). **WS13–WS17 behavior preserved** (their tests still pass).

---

## WS17 — LSP Formatting & Document Editing — ✅ GAP-ASSESSED + FILLED

**Finding (Phase 0): the formatting pipeline is mature and already flows through DocumentService; two genuine gaps remain — no Format Selection command, and no validation of the server's returned edits.** Tracing the lifecycle confirmed the rest exists and is correct, so nothing was rebuilt: all three providers are registered and **capability-gated** (`documentFormattingProvider` / `documentRangeFormattingProvider` / `documentOnTypeFormattingProvider`); each requests through the shared `ask`/manager path (server routing, **stale-result rejection**, cancellation); `tabSize`/`insertSpaces` come from Monaco's `FormattingOptions` (the editor's own indentation settings) — no duplicate config; **edits already reach the Document Model**: Monaco applies a provider's edits to its model, the editor-model bridge's `onDidChangeContent` forwards the new text to `documents.edit(key, …)` (`editorModelBridge.ts`), so dirty state and undo/redo are preserved and no second document store or edit path is introduced; on-type formatting respects the server's trigger characters; an empty edit list is a successful no-op; an unsupported server has no provider and the command is disabled with a reason. Format Document already existed (Edit menu, **Shift+Alt+F**, `editor.action.formatDocument`).

**Gap 1 — Format Selection was missing (Phase 5/9).** Only Format Document was wired. **Fix (`App.tsx`):** added **Format Selection** (Edit menu, `editor.action.formatSelection`), gated on `documentRangeFormattingProvider`. Monaco's built-in action converts the editor selection to the LSP range, handles reversed selections, and formats an **empty selection's current line only — never the whole document** (so the spec's empty-selection hazard is covered by reusing Monaco's action rather than a hand-rolled range). No new keybinding was added (Monaco's in-editor `Ctrl+K Ctrl+F` default remains, and the menu/palette give discoverability — avoiding a chord-shortcut conflict).

**Gap 2 — server-returned text edits were applied unvalidated (Phase 8).** `textEditsOf` converted every edit straight through `fromRange`, and `offsetAt` cannot guard a `NaN`/negative/fractional position, so a malformed range could become a corrupt Monaco edit. **Fix:** `isValidTextEdit`/`isValidPosition` (`positions.ts`, pure) check a `newText` string and a range of two finite non-negative integer positions; the formatting conversion **rejects the whole edit set** (returns `undefined`, leaving the document unformatted) if any edit is malformed, rather than applying a partial, possibly-inconsistent format. Well-formed and empty results are unaffected. (Stale/version safety is unchanged — the `ask` path already rejects responses for a newer document version before edits are returned; server isolation is unchanged — a provider only answers for documents its server serves.)

**Tests and results — real vs. fake:**

- **`node --test` `positions.test.ts` → 6 passed** (was 5), adding **`isValidTextEdit`/`isValidPosition`** (negative/NaN/fractional/missing positions, non-string/missing `newText`, malformed range → rejected; valid and empty-replacement edits accepted).
- **Playwright `lsp.spec.ts` → 26 passed** (was 24), adding two WS17 tests **over the real client → manager → Monaco provider → DocumentService path**: (1) **Format Selection** formats only the selected first line and leaves the unselected second line untouched (proving range scoping and that the edit lands through the document pipeline); (2) a **malformed formatting edit** (the fake server returns a negative-line range under a new `badFormatEdit` knob) is rejected and the document is left byte-for-byte unchanged. The existing Format Document test and all other LSP tests still pass.
- **Broad LSP unit suite (`src/services/lsp/*.test.ts`) → 57 passed, 0 failed; `editorModelBridge.test.ts` → 16 passed.** `tsc --noEmit` exit 0; `prettier --write` clean. **No Rust changed** (no Rust format/check run needed).

**Performance / reliability (Phase 11):** no new request scheduling, caching, or document copies — formatting stays request-driven and asynchronous; on-type formatting is unchanged (still only on trigger characters, still stale-guarded), so typing latency is untouched. Validation is a single O(edits) pass folded into the existing conversion. Server restart / document disposal invalidation is inherited from the unchanged `ask`/manager and bridge lifecycle.

**Real vs. fake verification:** verified against the **fake LSP server** over the real client, manager, Monaco providers, and DocumentService (the spec's prescribed harness), with a new deterministic `badFormatEdit` knob for the rejection path. **No bundled real language server, so no real-server claim** — the edits follow LSP 3.17 `TextEdit` shape and reuse the same request/stale/cancel machinery as the already-tested providers.

**Deferred / not done (with reasons):** (1) **Format On Save / Format On Type toggles** — a settings surface, not a protocol gap; the providers already work and adding a preferences UI is out of this workstream's scope. (2) **A dedicated Format Selection keybinding** — Monaco's `Ctrl+K Ctrl+F` already works in-editor; adding a Yavin chord binding risks conflicts and offered no correctness benefit. (3) **Routing format edits through the WorkspaceEdit engine** — unnecessary: Monaco already sorts/rejects overlapping format edits when applying, and the bridge routes the result through DocumentService, so the engine's guarantees are not bypassed in a way that affects correctness here.

**Files changed:** `src/services/lsp/positions.ts` (+`isValidPosition`/`isValidTextEdit`), `src/services/lsp/positions.test.ts` (+1 test), `src/editor/lspMonaco.ts` (validate formatting edits, reject malformed sets), `src/App.tsx` (+Format Selection command), `src/services/lsp/fakeServer.ts` (+`badFormatEdit` test knob), `tests/ui/lsp.spec.ts` (+2 tests), `ARCHITECTURE.md` (formatting guarantees documented). No change to the LSP manager, DocumentService, the editor-model bridge, Monaco's tokenizer, protected files, or C1/C2. **WS13–WS16 behavior preserved** (their tests still pass).

---

## WS16 — Semantic Tokens & Syntax Highlighting Reliability — ✅ GAP-ASSESSED + FILLED

**Finding (Phase 0): the pipeline is mature; two genuine robustness gaps remain — no validation of server token arrays, and no recovery from an inapplicable delta.** Tracing the whole lifecycle confirmed everything else already exists and is correct, so nothing was rebuilt: capability negotiation + delta detection (`semantic?.full`), full/delta requests through the manager's request path (no second request manager), **legend identity preserved per server** (each provider closes over its own `semantic.legend` via `getLegend`, so legends never mix), `previousResultId` handling, **stale rejection + document-version validation + cancellation** (via `ask`/manager → `StaleResultError`), UTF-8/UTF-32 → UTF-16 re-encoding (`toUtf16Tokens`), **server/model scoping** (`ask` gates on `serverIdFor`; a per-model `WeakMap` and per-server provider registration keep token data and legends isolated across servers, and identical relative paths in different roots use different models/URIs), provider disposal, and the theme mapping (token-type names → `yavin-dark`/`yavin-light` rules). Monaco keeps native tokenization; semantic tokens layer on top. No parallel highlighting engine, no polling.

**Gap 1 — malformed token responses were coerced, not rejected (Phase 1).** A full response was passed straight to `new Uint32Array`, which silently coerces garbage (negatives wrap, `NaN`→0, floats truncate, a ragged length mis-aligns every token) into _wrong_ highlighting. **Fix (`semanticTokens.ts`):** `isValidTokenData` — a flat run of whole 5-value tokens, every value a non-negative 32-bit integer. The provider rejects an invalid full (or full-from-delta) response and returns `null`, so the editor falls back to its **native tokenizer** (no semantic colour, **no corruption**). Unknown token _types/modifiers_ are deliberately **not** rejected — the legend owns those and Monaco falls back safely for an out-of-legend index (so the fix does not assume one server's legend).

**Gap 2 — deltas were applied without bounds checks and could not recover (Phase 2).** `applySemanticDelta` trusted edit offsets, so an edit inconsistent with the retained previous result corrupted the array silently. **Fix:** `applySemanticDelta` now validates each edit against `previous` (integer, non-negative `deleteCount`, in range, non-overlapping/ordered, inserted values valid, result a whole number of tokens) and throws `SemanticDeltaError` on any violation; the Monaco provider catches it and **recovers with a fresh `textDocument/semanticTokens/full` request** rather than drawing a corrupt array. A delta request answered with a full set (the server chose not to diff) is validated like any full response. The retained-previous store stays a per-model `WeakMap` (bounded by model lifetime — no unbounded cache).

**Tests and results — real vs. fake:**

- **`node --test` `semanticTokens.test.ts` → 4 passed** (was 2): the existing delta-edit and UTF-8/UTF-32 re-encoding tests, plus **`isValidTokenData`** (empty/one/two valid; ragged, negative, fractional, NaN, over-uint32, non-array, null rejected) and **inconsistent-delta rejection** (start past end, delete past end, negative start/deleteCount, overlapping edits, invalid inserted value, non-token-aligned result → all `SemanticDeltaError`).
- **Playwright `lsp.spec.ts` → 24 passed** (was 23), adding a **WS16 integration test over the real client/manager/Monaco provider**: with the fake server set to answer every delta with an out-of-range edit, an edit triggers a `.../full/delta` request, the provider discards the inapplicable delta and issues **another `.../full`** (recovery, asserted via the server's received-method log), and the edited line still renders correctly (`let more: number = 2;`). The existing full→delta happy-path semantic test and all other LSP tests still pass.
- **Broad LSP unit suite (`src/services/lsp/*.test.ts`) → 56 passed, 0 failed.** `tsc --noEmit` exit 0; `prettier --write` clean. **No Rust changed.**

**Performance (Phase 5):** no new allocation on the happy path — a valid delta still returns Monaco's native `edits` (UTF-16 server) applied to the same retained previous, and validation is a single O(n) pass already folded into the existing delta application (no extra copy). Recovery costs one full request **only** when a delta is genuinely inapplicable (a bug/mismatch), which is strictly better than repainting corruption. Retained token memory stays bounded by the per-model `WeakMap`. No measurable change to decode/apply timing on well-formed input; no caching or indexing added (measured-first, per the spec).

**Real vs. fake verification:** verified against the **fake LSP server** over the real client, manager, and Monaco semantic-token provider (the spec's prescribed harness). **No bundled real language server, so no real-server claim** — the validation/recovery logic is exercised deterministically through the fake server's new `badSemanticDelta` knob and the pure unit tests; the token encoding follows LSP 3.17.

**Deferred / not done (with reasons):** (1) **No viewport/range semantic-token request path** — the build registers only the document provider; adding range requests is a performance refinement with no correctness gap in the harness, and Monaco already limits painting to the viewport. (2) **Unknown token types/modifiers are not remapped or warned** — the legend + theme fallback already renders them safely; a diagnostic surface for "server used a type absent from its legend" is a nicety, not a correctness fix. (3) **No benchmark fixture for very large token arrays** — the decode is linear and unchanged; a synthetic megatoken benchmark would measure Monaco, not this layer, so it was not added (measure-before-optimize honoured — nothing optimized).

**Files changed:** `src/services/lsp/semanticTokens.ts` (+`TOKEN_STRIDE`, `isValidTokenData`, `SemanticDeltaError`, bounds-validated `applySemanticDelta`), `src/services/lsp/semanticTokens.test.ts` (+2 tests), `src/editor/lspMonaco.ts` (validate full responses; recover from inapplicable deltas via a `fullTokens` helper), `src/services/lsp/fakeServer.ts` (+`badSemanticDelta` test knob), `tests/ui/lsp.spec.ts` (+1 integration test), `ARCHITECTURE.md` (semantic-token guarantee documented). No change to the LSP manager, DocumentService, Monaco tokenizer, themes, protected files, or C1/C2.

---

## WS15 — LSP Type Hierarchy — ✅ GAP-ASSESSED + FILLED

**Finding (Phase 0): the one genuine gap left by WS14 is type hierarchy; its request lifecycle, tree model and UI must be shared, not duplicated.** WS14 built call hierarchy on a lazy, cycle-safe tree but left `typeHierarchy` absent from the client, protocol, editor and fake server (WS14's own log flagged it as the deferred, optional follow-on). The fill adds **Go to Supertypes / Subtypes** navigation **without a second tree, drawer or navigation path** — the WS14 model was first generalized, then both hierarchies ride it.

**Generalization (no behavior change to call hierarchy).** The WS14 tree logic was extracted into a direction-agnostic model and both kinds now wrap it:

- **Shared model (`hierarchy.ts`, new, pure):** `createHierarchy({ initial, directions, root, load })` — a lazy tree over an arbitrary set of named **directions**, with the WS14 guarantees intact: children load only on expand (injected `load`), a node whose symbol already appears on the path to the root is marked **cyclic** and not re-expanded, a per-expansion **token** drops a superseded slow response, and `getRows` returns a **cached** snapshot stable for `useSyncExternalStore`. Symbol identity is **uri + selection-range start + kind + name** — not the name alone, so same-named symbols across files/servers (or overloads) are not falsely cyclic, and items from different servers never collide (Phase-4 identity requirement).
- **Call hierarchy (`callHierarchy.ts`) is now a thin wrapper** over `createHierarchy` (`incoming`/`outgoing` → children); all WS14 public types/API (`createCallHierarchy`, `CallDirection`, `CallNode`, `CallRow`) are unchanged, and its 6 model tests + the WS14 Playwright test pass untouched.

**New — Type Hierarchy (prepare + supertypes + subtypes).**

- **Protocol & capability (`protocol.ts`, `client.ts`):** `TypeHierarchyItem` type + the `typeHierarchyProvider` server capability; the client advertises `typeHierarchy`.
- **Model (`typeHierarchy.ts`, new):** `createTypeHierarchy` maps `typeHierarchy/supertypes`/`subtypes` (plain item lists, no call-site ranges) onto the shared model with directions `["supertypes", "subtypes"]`.
- **Editor (`lspMonaco.ts`):** `addTypeHierarchyAction` (Show Type Hierarchy, **Shift+Alt+T**, editor context menu `navigation`/order 4 — one past call hierarchy's order 3, consistent with the existing navigation shortcuts) prepares at the cursor via `textDocument/prepareTypeHierarchy` (document-scoped through the manager, capability-gated) and hands the lazy tree to the host; supertypes/subtypes expansions use `staleOk` (navigating inheritance is a read a later edit should not block). The host method generalized from `showCallHierarchy(session)` to `showHierarchy(session, kind)` (`"call" | "type"`).
- **Shared view & drawer:** `CallHierarchyView` was generalized to `HierarchyView` (explicit `kindLabel` + `directionLabels` props); `App.tsx` holds one `{ session, kind }` drawer state and renders the same drawer/navigation for both kinds (Supertypes/Subtypes or Callers/Callees). **No duplicate sidebar.**

**Multi-server / multi-root (inherited):** prepare and expansion run through the document's server (`doc.key`), items keep their originating server, server restart/version changes reject stale requests (`StaleResultError`), and workspace switching disposes the session.

**Tests and results — real vs. fake:**

- **`node --test` model (`typeHierarchy.test.ts`) → 6 passed:** the two directions (supertypes first), lazy supertypes load, subtypes direction, **inheritance cycle detected and not re-expanded** (Animal → LivingThing → Animal), direction reset, null-as-empty. The WS14 `callHierarchy.test.ts` → **6 passed** unchanged (regression on the shared model).
- **Playwright `lsp.spec.ts` → +1 WS15 test:** over the **real client/manager/model/UI** with the fake server, Show Type Hierarchy opens the tree, the root `Animal` lazily loads **LivingThing**, expanding it flags the **cycle** back to `Animal` (not expandable), and switching to **Subtypes** rebuilds and loads **Dog/Cat**. The WS14 call-hierarchy test and all existing LSP tests still pass.
- `tsc --noEmit` exit 0; `prettier --write` clean. **No Rust changed.**

**Real vs. fake verification:** verified against the **fake LSP server** over the real client, manager, and UI (the spec's prescribed harness) — the fake advertises `typeHierarchyProvider` and implements `prepareTypeHierarchy`/`supertypes`/`subtypes` as a small fixed graph. **No bundled real language server, so no real-server claim;** the protocol shapes follow the LSP 3.17 type-hierarchy spec and reuse the same request/stale/cancel machinery as the already-tested providers.

**Deferred / not done (with reasons):** (1) `typeHierarchy` resolve/data round-tripping beyond the opaque `data` field is unneeded — the item carries its own `data`, round-tripped to supertypes/subtypes. (2) No standalone sidebar or persisted history: the drawer is transient like call hierarchy, by design (no duplicate UI).

**Files changed:** new `src/services/lsp/hierarchy.ts` (shared model) + `typeHierarchy.ts` (+ `typeHierarchy.test.ts`); `callHierarchy.ts` rewritten as a thin wrapper; `protocol.ts` (+`TypeHierarchyItem` + capability), `client.ts` (advertise), `src/editor/lspMonaco.ts` (prepare + `addTypeHierarchyAction` + generalized `showHierarchy` host method), new `src/components/layout/HierarchyView.tsx` (replaces `CallHierarchyView.tsx`), `src/components/layout/CodeEditor.tsx` (attach the action), `src/App.tsx` (generalized host method + shared drawer), `src/services/lsp/fakeServer.ts` (implement the three type-hierarchy methods + capability), `tests/ui/lsp.spec.ts` (+1 test). No change to the LSP manager, existing providers, DocumentService, protected files, or C1/C2.

---

## WS14 — LSP Navigation & Symbol Intelligence — ✅ GAP-ASSESSED + FILLED

**Finding (Phase 0): the navigation stack is mature; the one genuine gap is call hierarchy.** Tracing the LSP providers confirmed everything else already exists and is tested (via `lsp.spec.ts`): **Go to Definition / Type Definition / Implementation / Declaration**, **Find All References** (with a locations picker), **document symbols + Outline + breadcrumbs** (hierarchical `DocumentSymbol` and flat `SymbolInformation`), **workspace symbol search** (`@` file / `#` workspace in the palette), plus hover, completion, signature help, semantic tokens, inlay hints, CodeLens, document links, rename and code actions — all capability-negotiated, server-scoped, and `LocationLink`-aware, reusing the Monaco providers and the `ask`/manager request path (stale-result + cancellation). **Call hierarchy and type hierarchy did not exist** anywhere (no `callHierarchy`/`typeHierarchy` in the client, protocol, manager or editor). That is the Phase-4 gap.

**New — Call Hierarchy (prepare + incoming + outgoing).** Monaco has **no** built-in call-hierarchy UI, so this is protocol + a custom lazy tree + a view, built on the existing LSP request path (no new request manager):

- **Protocol & capability (`protocol.ts`, `client.ts`):** `CallHierarchyItem`/`CallHierarchyIncomingCall`/`CallHierarchyOutgoingCall` types and the `callHierarchyProvider` server capability; the client advertises `callHierarchy`.
- **Model (`callHierarchy.ts`, pure):** `createCallHierarchy` builds a **lazy** tree — a node's callers (incoming) or callees (outgoing) load only when it is expanded, through injected request functions. It is **cycle-safe**: a node whose symbol (file + selection-range identity) already appears on the path from the root is marked **cyclic** and not expanded again, so recursion/mutual recursion stays finite. A per-expansion **token** drops a slow response a newer action (direction switch, dispose) superseded; **empty** and **error** results are represented; `getRows` returns a **cached** snapshot (stable for `useSyncExternalStore`). It owns only shape/expansion — the LSP manager owns the requests and server identity.
- **Editor + view:** `addCallHierarchyAction` (Show Call Hierarchy, **Shift+Alt+H**, editor context menu) prepares at the cursor via `textDocument/prepareCallHierarchy` (document-scoped through the manager) and hands the lazy tree to the host; incoming/outgoing expansions use `callHierarchy/incomingCalls`/`outgoingCalls` with `staleOk` (exploring callers is a read a later edit should not block). `CallHierarchyView` renders the tree in a side drawer (so the editor stays visible), with a **Callers/Callees** toggle, lazy expand, cyclic markers, and navigation that opens a node's symbol through the host's existing `openLocation`. ResourceUri identity is preserved; server identity rides on the items; nothing is executed.

**Multi-server / multi-root (inherited):** prepare and expansion run through the server associated with the document (by `doc.key`), items keep their originating server, server restart/version changes reject stale requests (`StaleResultError`), and workspace switching disposes the session. Not one-workspace-one-server: the document's server is the one asked.

**Tests and results — real vs. fake:**

- **`node --test` model (`callHierarchy.test.ts`) → 6 passed:** lazy load (incoming callers), outgoing callees, **cycle detected and not re-expanded** (A→B→A), direction reset, **stale load dropped** on direction switch, empty + error handling.
- **Playwright `lsp.spec.ts` → +1 WS14 test** (full LSP spec re-run for no-regression): over the **real client/manager/UI** with the fake server, Show Call Hierarchy opens the tree, the root lazily loads **callerA/callerB**, expanding `callerA` flags the **cycle** back to `main` (not expandable), and switching to **Callees** rebuilds and loads `calleeX`. The existing definition/references/symbols/outline/code-action tests all still pass.
- **Broad frontend regression (`src/**/*.test.ts`) → 1,334 (1,332 passed, 0 failed, 2 pre-existing skips).** `tsc --noEmit` exit 0; `prettier --check` clean. **No Rust changed.**

**Real vs. fake verification:** verified against the **fake LSP server** over the real client, manager, and UI (the spec's prescribed harness). No bundled real language server, so no real-server claim; the protocol shapes (`prepareCallHierarchy` → items; `incomingCalls`/`outgoingCalls` → `from`/`to` + `fromRanges`) follow the LSP spec and reuse the same request/stale machinery as the already-tested providers.

**Deferred / not done (with reasons):** (1) **Type hierarchy** is explicitly optional in the spec; it would mirror the call-hierarchy model (supertypes/subtypes), but the current value-over-complexity did not justify it this pass — the model generalizes cleanly, so it is a small future addition. (2) All the Phase-1/2/3 navigation capabilities were **already implemented and tested**, so no change was made there (no duplicate providers). (3) `workspaceSymbol/resolve` was not added — the existing workspace-symbol search returns resolved locations and navigates; resolve is only needed for servers that defer location data, none in the harness.

**Files changed:** `src/services/lsp/protocol.ts` (+call-hierarchy types + capability), `client.ts` (advertise), new `src/services/lsp/callHierarchy.ts` (+ `callHierarchy.test.ts`), `src/editor/lspMonaco.ts` (prepare + `addCallHierarchyAction` + host method), new `src/components/layout/CallHierarchyView.tsx`, `src/components/layout/CodeEditor.tsx` (attach the action), `src/App.tsx` (host method + drawer + navigation), `src/services/lsp/fakeServer.ts` (implement the three methods), `tests/ui/lsp.spec.ts` (+1 test). No change to the LSP manager, existing providers, DocumentService, protected files, or C1/C2.

---

## WS13 — Problems Panel Quick Fix Integration — ✅ IMPLEMENTED + VERIFIED

**Scope:** the focused gap flagged after WS12 — invoke the existing code-action workflow **from a diagnostic in the Problems panel**. No new code-action request manager, no WorkspaceEdit duplication, no filesystem writes from the panel: the panel navigates to the diagnostic and raises the **editor's own** quick-fix (the WS12 request → `codeAction/resolve` → guarded apply / authorized command pipeline).

**Existing WS11/WS12 infrastructure reused:** the Monaco `CodeActionProvider` + `runCodeAction` (the single application entry point, with resolve + guarded WorkspaceEdit + authorized `executeCommand` + server-ownership), the per-document capability lookup, the editor's `editor.action.quickFix`, the Problems panel's navigation (`onOpen` → `openLocation`), and the WS11 related-info rows. The Problems service stays the owner of diagnostic state; the panel requests and applies nothing itself.

**Exact entry point.** `ProblemsView` gains a contextual **"Quick Fix"** action on each diagnostic row — shown on hover/focus (not a permanent control), and **only when `canQuickFix(file)` is true**. Gating uses the new `codeActionCapable(path)` (exported from `lspMonaco`), which reports whether an LSP server for that **open** document advertises `codeActionProvider` — and since a language server only diagnoses files it has opened, an LSP diagnostic is always for an open document, so the gate is exact: a task/checker diagnostic (no eligible server) shows **no** Quick Fix (verified), avoiding a misleading action.

**Request & apply lifecycle (all reused).** Clicking Quick Fix calls `onQuickFixProblem(file, line, column)`, which `openLocation(file, range, { quickFix: true })`: the host opens the file, selects the diagnostic's exact range, and — **deterministically, tied to the location-apply effect** (not a timing guess) — raises the editor's code actions at the cursor. From there the normal editor pipeline runs: the request carries the diagnostic context + document version (stale rejection inherited), a **deferred** action is resolved via `codeAction/resolve`, an `edit` goes through the guarded WorkspaceEdit engine, and a `command` through authorized `executeCommand`. Dismissing the menu changes no file.

**Multi-server / multi-root (inherited):** actions come from the server(s) associated with the opened document (by its language), results keep their server identity, identical command ids on different servers stay isolated (each runs on its originating server by document key), workspace switching disposes the editor/menu, and nested Git repositories don't affect LSP document ownership. ResourceUri stays canonical — the panel passes the diagnostic's file through `openLocation`, which resolves the real document key.

**Tests and results — fake-server integration (real client/manager/Problems service/engine/UI):**

- **Playwright `lsp.spec.ts` → 21 passed** (was 19), adding two WS13 tests: (1) a diagnostic's **Quick Fix** action is offered, and invoking it navigates to the diagnostic, raises the editor's code actions, and applying one edits the file (`// TODO later` → `// DONE later`) through the WS12 pipeline; (2) the Quick Fix action is **file-scoped** — present for the LSP-diagnosed file, and the capability gate is per-file (no global/misleading action). The existing WS12 code-action, deferred-resolve, rename/WorkspaceEdit, and server-restart tests all still pass.
- **Broad frontend regression (`src/**/*.test.ts`) → 1,328 (1,326 passed, 0 failed, 2 pre-existing skips).** `tsc --noEmit` exit 0; `prettier --check` clean. **No Rust changed.**

**Fake vs. real:** verified against the **fake LSP server** over the real client, manager, Problems service, WorkspaceEdit engine and UI (the spec's prescribed integration harness). No bundled real language server, so no real-server claim is made.

**Known UX nuance (honest):** invoking the editor's quick fix **programmatically** raises Monaco's code-action **lightbulb** at the diagnostic (actions requested + available) rather than auto-expanding the menu in one step; the menu opens as the editor's normal quick-fix (the test opens it and applies). A one-click auto-expand would require reaching into Monaco's code-action controller, which was out of proportion to the gap; the integration, gating, navigation and apply path are all real and tested.

**Deferred / not done (with reasons):** a bespoke in-panel action menu (rather than reusing the editor's) was deliberately **not** built — it would duplicate the request/resolve/apply logic the constraints forbid; the editor's menu is the single, authorized surface. Auto-expanding the editor menu from the panel is the only remaining polish (above).

**Files changed:** `src/components/panel/views/ProblemsView.tsx` (contextual Quick Fix action + gate), `src/components/layout/TerminalPanel.tsx` (forward the two props), `src/App.tsx` (`codeActionCapable` gate + `onQuickFixProblem` → `openLocation(..., { quickFix: true })` + the location-apply effect raising the menu), `src/editor/lspMonaco.ts` (export `codeActionCapable`), `tests/ui/lsp.spec.ts` (+2 tests). No change to `runCodeAction`, the WorkspaceEdit engine, the LSP manager, the Problems service, DocumentService, protected files, or C1/C2.

---

## WS12 — LSP Quick Fix & Code Actions — ✅ GAP-ASSESSED + FILLED

**Finding (Phase 0): the Code Actions workflow is almost entirely built; one real protocol gap.** Tracing the LSP stack confirmed the heavy lifting already exists and is correct:

- **`textDocument/codeAction` request** is wired in the editor (`lspMonaco.ts` registers a Monaco `CodeActionProvider`): it sends the request with the **diagnostic context** (markers mapped to LSP diagnostics with code/source/severity), **`only`** filtering, and **triggerKind**, through the document-scoped `ask`/request path (so a stale document version is rejected). It distinguishes a **`Command`** response from a **`CodeAction`**, and preserves **`isPreferred`**, **`disabled`** (with reason), `kind`, and the associated diagnostics.
- **Capability negotiation** is correct: the provider is only registered when the server advertises `codeActionProvider`, with its `codeActionKinds` as `providedCodeActionKinds`; the client already advertises `codeActionLiteralSupport`.
- **Applying** an action (`runCodeAction`): a **disabled** action reports its reason and does nothing; an action with an **`edit`** goes through the existing **WorkspaceEdit engine** (`workspaceEdit.ts` — `changes`/`documentChanges`, versioned `TextDocumentEdit`, Create/Rename/Delete, path containment, version validation, DocumentService routing for open docs + guarded writes for closed files, ordering/overlap safety); an action with a **`command`** is routed through the authorized `workspace/executeCommand` path with **server-ownership validation** (the command runs on the originating server by its document key). Server-initiated `workspace/applyEdit` is also already handled.
- **Multi-server/root** correctness is inherent: actions are requested from the server(s) associated with the document, results keep their server identity, and a command executes only on its originating server.

**The one genuine gap:** `runCodeAction` applied `edit`/`command` but **never called `codeAction/resolve`** for a **deferred** action — one the server returns with only `data` and no `edit` yet (a common pattern: the server computes the edit lazily when the user picks the action). Such an action silently did nothing. (The fake LSP server also did not advertise or implement resolve, so the path was untested.)

**Fix (reuse, not rebuild).** `runCodeAction` now, **only when the owning server advertised `codeActionProvider.resolveProvider` and the action has no `edit`**, sends **`codeAction/resolve`** (the action, with its `data`, round-tripped) through the same **document-scoped `manager.request`** path — so the resolve inherits the existing **stale-version rejection** (a `StaleResultError` → a clear "the document changed; try again" message rather than applying a fix computed against old text). The resolved action's `edit` then goes through the **same guarded WorkspaceEdit engine**, and its `command` through the same authorized execute path. No new request manager, document owner, or edit system; no change to the non-deferred paths.

**Security model (unchanged):** no renderer-provided executable paths or shell strings; a server-provided `command` is run only via `workspace/executeCommand` on its originating server; every WorkspaceEdit (resolved or not) passes the engine's path-containment, version and dirty-buffer checks; workspace trust and native authorization are untouched.

**Tests and results — fake-server integration (real client/manager/store/engine):**

- **Playwright `lsp.spec.ts` → 19 passed**, incl. a new WS12 test driven by the **fake LSP server's real `codeAction/resolve`**: a deferred action (returned with no edit) is offered via **Ctrl+.**, and choosing it round-trips through `codeAction/resolve`, whose returned `WorkspaceEdit` inserts the header through the guarded engine (`// header` prepended). The existing code-action test (Ctrl+. → apply an edit-bearing quick fix), the rename/WorkspaceEdit tests, and the server-restart test all still pass. The fake deferred action is gated to a sentinel file so it never perturbs any other quick-fix menu.
- **Broad frontend regression (`src/**/*.test.ts`) → 1,328 (1,326 passed, 0 failed, 2 pre-existing skips).** `tsc --noEmit` exit 0; `prettier --check` clean. **No Rust changed** (a frontend-only LSP-protocol addition), so native suites/clippy are unaffected.

**Real vs. fake verification:** verified against the **fake LSP server** over the real client/manager/WorkspaceEdit engine (the spec's "fake LSP server for protocol/UI integration"). A real-language-server run was **not** performed here (none is bundled for the harness); the protocol shapes (`codeAction/resolve` params = the `CodeAction` with `data`, response = the action with a filled `edit`) follow the LSP spec and reuse the same request/apply machinery the already-tested rename and quick-fix paths use.

**Deferred / not done (with reasons):** (1) a **Quick Fix affordance in the Problems panel** (Phase 2.1's "from both panel and editor") was **not** added — the editor lightbulb/Ctrl+. already offers quick fixes on exactly the same diagnostics, and wiring the Problems panel to the LSP manager + an action menu is a larger UI workstream whose value over the existing editor affordance is marginal; it is a clean future addition. (2) `isPreferred`/`disabled`/`only`/command-vs-CodeAction/stale-rejection were **already implemented**, so no change was made there. (3) No new diagnostic-driven commands beyond the server's own (explicitly out of scope).

**Files changed:** `src/editor/lspMonaco.ts` (`codeAction/resolve` in `runCodeAction`), `src/services/lsp/fakeServer.ts` (advertise + implement resolve, a sentinel-gated deferred action), `tests/ui/lsp.spec.ts` (+1 test). No change to the LSP manager, the WorkspaceEdit engine, the Problems service, DocumentService, protected files, or C1/C2.

**Next genuinely missing capability (assessed):** surfacing LSP quick fixes **in the Problems panel** (request code actions for a selected diagnostic and present them in a menu, applied through the same `runCodeAction` path) is the clearest remaining code-actions gap; it reuses everything built here and in WS11 and does not rebuild the manager or engine.

---

## WS11 — Workspace Diagnostics & Problems Integration — ✅ GAP-ASSESSED + FILLED

**Finding (Phase 0): the diagnostics subsystem is mature; one genuine integration gap.** Per the spec's instruction to find real gaps and not rebuild mature components, I traced the whole lifecycle and confirmed almost everything already exists and is correct:

- **Unified model (`problemMatchers.ts` `Diagnostic`)** already carries file, 1-based start **and end** positions, `severity` (+`hint` for LSP severity 4), `message`, `code`, `origin` (source), `tags` (`unnecessary`/`deprecated`), and **`related`** (secondary locations). No information is dropped converting LSP/matcher/checker diagnostics.
- **Owner-scoped store (`problems.ts`)**: `publishProblems(owner, label, diagnostics)` replaces only that owner's set; `clearProblems(owner)` removes only its own; an empty publish clears only that owner; `groupByFile` groups by **ResourceUri identity** (`problemResourceId`), never merging different owners. Counts, severity/kind, text+glob+negation filter all present.
- **LSP isolation (`lsp/manager.ts`)**: owner key is **per-server, per-file** (`lsp:<client>:<uri>`), so one file's republish never touches another's; empty publications clear; **stale (older-version) publications are rejected**; rename/resource-change handling exists. These are its own, already-tested guarantees.
- **Editor (`lspMonaco.ts`)**: severity decorations, hover, navigation, and **`relatedInformation`** are already mapped into Monaco markers; it reuses Monaco's marker store (no second owner).
- **Problems panel (`ProblemsView.tsx`)**: groups by file, severity badges/counts, text search, severity filters, collapse/expand with preserved state, navigation to the exact range, accurate empty state.

**The one genuine gap:** the **Problems panel did not display or navigate a diagnostic's related/secondary locations**, even though the model carries `related` and the editor already shows it (via Monaco markers). So an LSP "cannot redeclare — first declared here" pair showed its secondary location in the editor hover but not in the panel list.

**Fix (reuse, not rebuild).** `ProblemsView` now renders, under each diagnostic that has them, its **related locations** — an indented, accessible (`<ul aria-label="Related information for: …">`) list of `↳ <message> <file>:<line>` rows, each a button that **navigates** to that secondary location through the panel's existing `onOpen(file, line, column)`. No new store, no new model field, no new navigation path: the data already flowed through `groupByFile` (the `{ ...problem, source }` spread carries `related`), and `onOpen` is the same callback the primary rows use. Nothing else in the diagnostics lifecycle changed.

**Ownership boundaries (unchanged):** the Problems service remains the owner of unified diagnostic state; LSP owns its lifecycle/publications; tasks own task output; ResourceUri stays canonical identity; DocumentService owns open-document content. No duplicate store, no polling, no command execution from diagnostic content.

**Tests and results — real vs. mocked:**

- **`node --test` problems (`problems.test.ts`) → 20 passed**, incl. a new WS11 test that `groupByFile` **preserves `related`** (and `source`) through to the panel. The existing owner-isolation / empty-clears / counts / filter tests are unchanged.
- **Playwright `lsp.spec.ts` → 18 passed**, incl. a new WS11 test driven by the **fake LSP server's real `relatedInformation`** publication: the secondary location is listed in the Problems panel and **clicking it navigates** the editor to that location (the existing editor-squiggles + panel test still passes). This is a real diagnostics-publication integration path (the fake LSP server over the real client/manager/store/panel), not a hand-mocked store.
- **Broad frontend regression (`src/**/*.test.ts`) → 1,328 (1,326 passed, 0 failed, 2 pre-existing skips).** `tsc --noEmit` exit 0; `prettier --check` clean. **No Rust changed** (a frontend-only panel addition), so native suites/clippy are unaffected.

**Deferred / not done (with reasons):** (1) a **structured source-filter dropdown** was not added — the existing text filter already matches by typed source substring and the severity toggles cover severity, so a separate control is the "unnecessary UI" the spec warns against; the clearer gap was related-info display. (2) The LSP manager's rename/delete owner-cleanup and stale-version rejection are **already implemented and tested**, so no change was made there. (3) No new code actions or diagnostic-driven commands (explicitly out of scope).

**Files changed:** `src/components/panel/views/ProblemsView.tsx` (render + navigate related locations), `src/services/panel/problems.test.ts` (+1 test), `tests/ui/lsp.spec.ts` (+1 test). No change to the Problems service, the model, the LSP manager, the editor, protected files, or C1/C2.

**Next genuinely missing capability (assessed):** a **diagnostic-driven Quick Fix / code-action affordance** in the editor and Problems panel (surfacing an LSP server's own `textDocument/codeAction` for a diagnostic, applied through the existing guarded apply path) is the clearest remaining diagnostics gap — but it is a real workstream of its own (code-action request/resolve, workspace-edit application) and must stay within the authorized apply path, not invent actions. It reuses the LSP client and apply path; it does not rebuild the store.

---

## WS10 — Dedicated Merge Conflict Resolution — ✅ IMPLEMENTED + VERIFIED

**Goal:** a reliable merge-conflict resolution experience — understand the three sides, resolve per region, apply safely, and leave the Git **index** correct — built on the existing conflict-side reads and the undoable apply path, not a new Git store or editor.

**Existing infrastructure reused:** `Repository.conflictSide` (stage 2/3 blobs), the `GitEntry.conflict` flag + the status XY codes, the SCM Conflicts group, the guarded native `git_exec` allow-list, the `write_file_guarded`/DocumentService apply path (WS8), the one Monaco editor + its model↔document bridge, and per-worktree `Repository` isolation (WS9's innermost-repo resolution). None of it was rebuilt.

**New conflict model & ownership (`conflict.ts`, pure).** Conflict **type** comes from Git's actual unmerged code (`classifyConflict("UU"|"AA"|"AU"|"UA"|"UD"|"DU"|"DD")` → the seven states), **not** from markers in the text — each type declares _which content sides exist_ (base/current/incoming), so a delete/add conflict is represented with its missing sides rather than assumed to have three. A separate marker parser (`parseConflicts`) splits a file into text/conflict segments and regions (two-way and diff3 `|||||||` base), each with its sides, labels and line span; `regionSideLines` maps a region to the editor line ranges of each side. The Git store stays the owner of index state; `conflict.ts` owns only parsing/resolution shape.

**Three-way understanding & resolution-action semantics.** `resolveRegionLines(region, choice)` yields a region's resolved lines — **Accept Current**, **Accept Incoming**, **Accept Both** (current **then** incoming, a documented deterministic order), **Accept Base** (diff3 only; falls back to leaving the markers when there is no base, never fabricating a side), or **manual** (keeps the markers). `applyResolutions` rebuilds the file from a per-region choice map — **unchosen/manual regions keep their markers**, so accepting one region never marks the file resolved and never touches another region or the surrounding text. `resolutionProgress` reports resolved-vs-remaining (and re-resolving a region updates it). The three content sides are read from the index: `conflictSide` (ours/theirs) and the new `conflictBase` (stage 1), which rejects when there is no base stage so the UI shows that side unavailable.

**Safe apply & index verification (the critical boundary).** Resolution edits go through the **editor's own undoable edit** (the bridge mirrors them into DocumentService — dirty state and undo preserved, no direct filesystem write). Staging-as-resolved was hardened in the Source Control panel: before staging a conflicted file it reads the working-tree content and **refuses while any conflict marker remains** (`hasConflictMarkers`), then stages through the new `Repository.resolveFile`, which runs `git add` **and verifies** — via the new native, read-only, shape-pinned `ls-files -u` (`Repository.unmergedStages`) — that **no unmerged index stage is left**, throwing otherwise. So the app never reports a resolution while the index still holds conflict stages, and never marks a file resolved merely because the editor preview changed. Concurrent-edit protection and encoding/EOL preservation are the existing guarded apply path's.

**Three-way editor behaviour (two complementary surfaces).**

1. **A dedicated three-way view** (`ConflictEditor.tsx` + `conflictSession.ts`), opened from the Source Control panel's **Resolve…** on a conflicted file and rendered full-area like the diff view. It shows **every available side** — **Current (ours)**, **Base (common ancestor, when it exists)**, **Incoming (theirs)** — as labelled, inspectable panes (a missing side says so explicitly), and lists each conflict **region** with **Accept Current / Incoming / Both / Base** actions (an unavailable side's action is disabled) plus **Leave for manual edit**; it shows a live **resolved/unresolved count**, next/previous-region navigation, an **Open in Editor** exit to free-form editing, and a **Complete Resolution** action enabled only when every region is decided. Labels use Git's merge-side semantics (ours/theirs/base), never a hard-coded branch name. It is a thin renderer over the `conflictSession` view-model, which composes the engine with injected Git/document operations and owns no Git or document state.

2. **Inline resolution** (`conflictMonaco.ts`) in the normal editor for quick, in-place work: each region's sides are tinted (green/grey/blue), **Accept Current / Incoming / Both** act on the cursor's region (context-menu, gated by a `yavinInMergeConflict` context key), and **Alt+F8 / Alt+Shift+F8** navigate. Both surfaces reuse the one Monaco editor and the same engine — no competing editing architecture.

**Multiple-repository behaviour (Phase 5).** Every resolution runs against the file's **owning** `Repository` (the SCM panel's `activeRepo`, and WS9's innermost-containing-repo resolution for the editor), so sibling and nested repositories keep their own index/merge state; `ls-files -u`/`add`/`cat-file :N:` are all per-repository, and the same relative filename in two repositories is never confused. One workspace is never assumed to be one repository.

**Real Git integration tests actually executed (not mocked):** `conflict.realgit.test.ts` creates genuine conflicts in throwaway repositories and asserts the **index stages before and after** resolution. A both-modified (`UU`) conflict: all three stages present (`[1,2,3]`), base/ours/theirs content read from the stages, markers parsed from the working tree, Accept-Both resolved, staged via `resolveFile`, and **the index verified clean (`ls-files -u` empty)** with status now showing a staged (non-conflicted) file. An add/add (`AA`) conflict: only stages `[2,3]` exist, reading the base stage is rejected, and resolving still clears the stages.

**Exact test counts and results — all green:**

- **`node --test` conflict engine (`conflict.test.ts`) → 10 passed** (classification of all seven states; two-way + diff3 parsing; unterminated-marker safety; each accept choice incl. Both's order; multi-region independence; `regionSideLines`; progress + re-resolution; `hasConflictMarkers`). **Session view-model (`conflictSession.test.ts`) → 7 passed** (loads the three sides; revisable per-region choice; `canAccept` gating by available side; refuse-while-unresolved; write-then-stage order; stale-file refusal; failed-stage surfaced). **Real-git → 3 passed** (`conflict.realgit.test.ts`: UU and AA with index-stage verification; `conflictSession.realgit.test.ts`: a session loads a real conflict, resolves, completes, and leaves the index clean).
- **Rust `cargo test -p yavin-ide git::tests` → 68 passed, 0 failed** (incl. the new `ls-files` accept/refusal argv shapes); clippy `-D warnings` clean. Classification test updated (`ls-files: "read"`).
- **Broad frontend regression (`src/**/*.test.ts`) → 1,327 (1,325 passed, 0 failed, 2 pre-existing skips).** `tsc --noEmit` exit 0; `prettier --check` clean.
- **Playwright → `source-control.spec.ts` (67, incl. a new WS10 test that opens the dedicated conflict editor from **Resolve…** and checks the labelled merge sides, resolution status, Complete and Open-in-Editor) and 2 new `monaco.spec.ts` WS10 tests** (inline: sides highlighted; Accept Incoming rewrites only its region; Accept Both = current-then-incoming leaving a second region untouched) — driven through the real editor action. The one `monaco.spec` right-click-palette failure in the heavy batch passed 3/3 in isolation (a pre-existing load flake, unrelated).

**Performance & lifecycle:** conflict data is parsed on demand from the open document (no eager load of every conflicted file), re-parsed only on edits; the inline resolver disposes its actions, context key, listeners and decorations on teardown (no duplicate subscriptions). Index reads are per-path and bounded; resolution is one undoable edit.

**Known limitations / deferred:** (1) the dedicated view shows each side as a labelled **read-only text pane** (not a synchronized-scrolling Monaco diff of base↔current↔incoming); the Result is resolved **region-by-region** (per-region accept + Open-in-Editor for free-form edits) rather than offering a free-text editable Result pane — manual editing happens in the normal editor, which keeps the model clean and revisable. A synchronized multi-Monaco diff is additive later. (2) A **stale cosmetic highlight** can briefly remain on a just-resolved inline region (Monaco overlay-element reuse) — the decoration ids are removed from the model on the next parse and on dispose, so it is not a leak; the resolved text is always correct (asserted). (3) `resolveFile`'s index check cannot detect leftover **markers** (a `git add` of marker-laden text still clears the unmerged stages) — the content guard (`hasConflictMarkers`) in the panel, and the session's "complete only when every region is decided", cover that before staging.

**Files changed:** new `src/services/git/conflict.ts` (+ `conflict.test.ts`, `conflict.realgit.test.ts`), `src/services/git/conflictSession.ts` (the dedicated view-model; + `conflictSession.test.ts`, `conflictSession.realgit.test.ts`); new `src/editor/conflictMonaco.ts` (inline) and `src/components/layout/ConflictEditor.tsx` (dedicated view); `src-tauri/src/git.rs` (`ls-files` read-scope + `LS_FILES` rule + `validate_shape` arm + argv tests); `src/services/git/repository.ts` (`conflictBase`, `unmergedStages`, `resolveFile`), `classification.test.ts` (`ls-files` = read); `src/components/layout/SourceControlPanel.tsx` (marker-guarded, index-verified stage-as-resolved + **Resolve…** entry), `CodeEditor.tsx` (attach the inline resolver), `src/App.tsx` (open/dispose the conflict session, render the dedicated view, typed `repoForPath`), `src/styles/index.css` (side tints), `tests/ui/monaco.spec.ts` (+2) and `tests/ui/source-control.spec.ts` (+1). No change to the Git store ownership, the apply path, DocumentService, protected search license files, or C1/C2.

**Next genuinely missing capability (assessed):** an **interactive rebase / commit-reordering UI** (a todo-list editor over `git rebase -i` semantics) is the clearest remaining Git gap — but it needs careful native allow-list work (sequencer control) and is a large, separable workstream. A lighter next step is the deferred **side-by-side three-way diff pane** built on this engine. Neither rebuilds the store or planner.

---

## WS9 — Advanced Git Change Review — ✅ EXTENDED + VERIFIED

**Finding (Phase 0 inspection): most of this already exists; the one real gap is inline blame.** Yavin has a large, mature Git subsystem — a guarded native `git_exec` allow-list (`git.rs`), a per-worktree `RepoStore`/`Repository`, a Source-Control panel, diff views, change grouping, and **hunk-level staging already implemented** (`repository.ts`: `stageHunks`/`unstageHunks`/`discardHunks` build a patch with `diffHunks.ts` and apply it via allow-listed `git apply --cached`/`-R`). Per the spec ("do not duplicate working Git infrastructure; extend existing APIs"), I did not rebuild any of it. **Inline Git blame did not exist anywhere** (not in the services, not in the native allow-list) — that is the high-value capability this adds (Phase 1); Phases 2–3 are confirmed present and their guarantees documented below.

**Existing Git infrastructure reused (confirmed, not rebuilt):**

- **Hunk-level review & partial staging (Phase 2):** `Repository.stageHunks(diffText, hunkIndexes)` / `unstageHunks` / `discardHunks` build a unified patch from the selected hunks (`diffHunks.ts` `parseUnifiedDiff`+`buildPatch`) and apply it through **Git's own index mechanism** — `git apply --cached` (and `-R` to reverse), patch piped over **stdin**, never argv — so the index is never reconstructed by hand and no whole-file write is used. File-level stage/unstage (`stage`/`unstage`, the latter falling back to `rm --cached` with no HEAD), staged-vs-unstaged diffs (`diff --cached`), rename (`-M`) and binary handling, and conflict sides (`cat-file :2:/:3:` written through the app's undoable apply path) all already exist.
- **Multi-file review surface (Phase 3):** the Source-Control panel + `changeGroups.ts`/`fileTree.ts`/`changesSort.ts` already group changed files by status (staged/unstaged/untracked/renamed/deleted/conflicted), open the correct diff, and refresh from Git status events (`RepoStore`, the `.git` watcher via `sync.ts`) — **no polling**.
- **Store ownership & safety (Phase 4):** the `RepoStore` remains the owner of Git status; every Git call goes through the guarded native allow-list (read vs. worktree-local vs. network scope, argv shape pinned, no renderer strings); multi-root isolation is by worktree `root`; concurrent-edit protection on writes is the guarded `write_file_guarded`/apply path from WS8.

**New work — inline Git blame (Phase 1), owned end-to-end:**

- **Native (`git.rs`) — a new, tightly-scoped read.** Added `blame` to the allow-list as a **read** (`operation_scope` → `Scope::Read`, so it runs in parallel and never blocks behind a write), with `BLAME = [--porcelain]` and a `validate_shape` arm pinning it to **exactly one path positional after `--`** — no revision or range positional, so it can only ever read the working-tree file's own history, confined to the repository like every other path argument. It is absent from `writes_worktree` (correctly read-only). Covered by the existing argv table tests (an accept shape and four refusal shapes: a revision positional, a second path, no path, and the unlisted `--line-porcelain`).
- **Service (`repository.ts` + `blame.ts`).** `Repository.blame(absolutePath)` runs `blame --porcelain -- <repo-relative path>` through the same guarded `run` as `diff()` (path resolved by `relativeToRoot`, which refuses a path outside the worktree). `parseBlamePorcelain` maps the porcelain stream to per-line `{ line, sha, author, authorTime, summary, uncommitted }`, caching each commit's metadata across its line groups and flagging Git's all-zero sha as **uncommitted**. `describeBlameLine` renders the one-line annotation (`author, 3 days ago • summary`, or "You · Uncommitted changes"); `relativeTime` and `blameAt` support it.
- **Blame caching & invalidation.** `createBlameCache` keys each file's parsed blame by an opaque **token = `gitRevision:documentVersion`** (`blameToken`): a cursor move between lines reuses the cached result (**no repeated Git subprocess**), while a commit/HEAD move (git revision bumps, incl. the `.git` watcher's external-HEAD signal) or an edit/save (document version bumps) produces a new token and exactly one refetch. A **failed** blame is not cached (the next look-up retries), and the cache is **LRU-bounded** (default 64 files) so a long session can't grow it without limit.
- **Editor binding (`blameMonaco.ts` + `CodeEditor`/`EditorArea`/`App`).** `attachBlameDecorations` annotates **only the current line** with a Monaco injected-text ("after") decoration — so no per-line Git work — following the cursor and repainting on the injected source's invalidation, with stale-paint protection (a slower paint that resolves after the cursor moved is dropped). It owns no Git or document state (not a second editor-state owner): the `BlameAnnotationSource` built in `App` resolves the **innermost worktree whose root contains the file** (multi-root isolation), shows **nothing** when the file is in no repository **or the document has unsaved edits** (disk blame would misrepresent the edited buffer — handling the dirty case honestly rather than wrongly), and subscribes to the git-revision pulse and DocumentService edits to refresh.

**Blame caching/invalidation strategy (summary):** per-file, token = git-revision + document-version, reuse on cursor move, refetch on commit/HEAD/edit/save, no-cache on failure, LRU-bounded. **Hunk staging safety (summary):** patch built from selected hunks and applied via `git apply --cached`/`-R` over stdin — Git's own index mechanism, never a manual index write or whole-file overwrite; the allow-list refuses any other `apply` shape.

**Real Git integration tests actually executed (not mocked):** `blame.realgit.test.ts` creates a throwaway repository with real `git`, makes two commits and an uncommitted fourth line, runs the **real** `git blame --porcelain` through `Repository.blame`, and asserts every line maps to its commit (summary/author/real 40-hex sha/positive time) with the uncommitted line reported as Git's all-zero sha — and that a path outside the worktree is refused. The native allow-list change is exercised by real `cargo test` (not a parser fixture).

**Exact test counts and results — all green:**

- **Rust `cargo test -p yavin-ide git::tests` → 68 passed, 0 failed** (incl. the blame accept/refusal argv shapes); `cargo clippy --lib -p yavin-ide -- -D warnings` clean; `cargo check` clean.
- **`node --test` blame (`blame.test.ts` 7 + `blame.realgit.test.ts` 2) → 9 passed** (porcelain parsing + metadata caching, current-line lookup, annotation text, relative time, token cache reuse/refetch, no-cache-on-failure, LRU bound; **real-git** line→commit mapping + uncommitted line + out-of-repo refusal). Classification test updated (`blame: "read"`).
- **Broad frontend regression (`src/**/*.test.ts`) → 1,307 (1,305 passed, 0 failed, 2 pre-existing skips).** `tsc --noEmit` exit 0; `prettier --check` clean.
- **Playwright `monaco.spec.ts` + `editor.spec.ts` → 45 passed** — the editor wiring (new `blame` prop threaded App → EditorArea → CodeEditor, attached in the one editor's create effect) causes **no regression**; with no repo/clean fixtures the annotation source returns null and draws nothing.

**Performance.** Blame runs `git blame` at most **once per (file, git-revision, document-version)** — a cursor moving across a 10,000-line file triggers zero additional Git calls (cache hit); the annotation is a single injected-text decoration on one line.

**Deferred work and reasons:** (1) **all-lines/gutter blame** (VS Code's optional full-file annotation) is deferred — current-line is the spec's "first" priority and avoids the expensive per-line rendering it warns against; the parser already returns every line, so a gutter view is additive later. (2) **Blame of the dirty buffer** (mapping edited-buffer line numbers back to disk blame, via `git blame --contents -`) is deferred — v1 hides the annotation while a document is dirty rather than show a possibly-wrong line, which is the safe, honest behaviour; `conflictSide`'s stdin precedent makes `--contents -` a clean later addition. (3) Hunk-staging and the multi-file surface were **already implemented**, so no new work there beyond confirming and documenting their guarantees.

**Files changed:** native `src-tauri/src/git.rs` (blame read-scope + `BLAME` rule + `validate_shape` arm + argv tests); new `src/services/git/blame.ts` (+ `blame.test.ts`, `blame.realgit.test.ts`); `src/services/git/repository.ts` (`blame()`), `revision.ts` (non-hook `gitRevision`/`subscribeGitRevision`), `classification.test.ts` (blame=read); new `src/editor/blameMonaco.ts`; `src/components/layout/CodeEditor.tsx` + `EditorArea.tsx` (thread + attach the `blame` prop), `src/App.tsx` (build the `BlameAnnotationSource` + cache), `src/styles/index.css` (annotation style). No change to the Git store ownership, the hunk-staging/apply path, DocumentService, protected search license files, or C1/C2.

**Next genuinely missing IDE capability (assessed):** a **merge-conflict resolution editor** (a 3-way/inline conflict view with accept-current/incoming/both actions) would build naturally on the existing `conflictSide` blob reads and the undoable apply path — the conflict _data_ exists but there is no dedicated resolution surface. That is the clearest remaining Git-review gap for a future workstream; it reuses the apply path and does not rebuild the store or planner.

---

## WS8 — Advanced Workspace Search & Replace — ✅ EXTENDED + VERIFIED

**Finding (Phase 0 inspection): the feature already exists and is mature.** Yavin ships a full workspace search-and-replace built on a **bundled ripgrep** (`src-tauri/resources/search/rg.exe`, 15.2.0) with `search_project`/`cancel_search` native commands, a 1,000-line `SearchPanel.tsx`, a `searchWorkspace` service and a tested multi-file apply path. Per the spec ("extend it rather than creating a competing subsystem; do not rebuild working infrastructure"), I did **not** rebuild it. I inspected it against every WS8 phase, implemented the one genuine gap, and verified the rest.

**Existing infrastructure reused (already present, confirmed against the spec):**

- **Search (Phase 1):** literal + regex, case-sensitive/insensitive, whole-word, include/exclude ripgrep globs, `.gitignore`/hidden toggles, multi-root-isolated (`folder` scope), binary-file skipping, `MAX_HITS`/output limits, debounced + `AbortController` cancellation with stale-result protection, and **ResourceUri identity** (`fileKey` via `resourceId(fileUri(path))`) so a file found by ripgrep and a document open under another path spelling are the same identity. Invalid regex is reported from ripgrep's stderr. Open **dirty buffers** are searched as the editor holds them, overlaid onto disk results.
- **Results (Phase 2):** grouped by file, path + line + highlighted preview, expand/collapse (per-file and all), next/prev navigation that opens the match, paging, accurate status (`describeSearchResult` says _exactly_ why results are missing), and results invalidated on write.
- **Apply (Phase 4) — already safe, verified by reading `App.tsx:applyReplacements`:** each change is **revalidated immediately before writing** — an open document against its in-memory text (`doc.text !== change.before` → skip + report) and a closed file against disk bytes natively (`write_file_guarded` refuses unless the file still equals `expected`). **DocumentService ownership is honoured:** an open (dirty) document is edited through `documents.edit` (a single undoable Monaco step), never overwritten from stale disk; a clean file uses the guarded native write. Multi-file apply is **best-effort per file with precise partial-success reporting** (`{ applied, errors }`) and a mid-batch workspace-change guard — **not** claimed atomic (each individual write is atomic via temp-file+rename). CRLF/encoding preserved (open docs re-encode to their remembered style; closed files are substring-spliced, leaving surrounding `\r\n` intact; the guard compares bytes). Undo is a panel-held reversed-replacement list re-applied through the same guarded path (single-level, per-file). Writes emit the typed resource/document events (`bumpGitRevision`, DocumentService `changed`/`saved`, the native `resource-changes` watcher) so Explorer, tabs, LSP and search reconcile.

**New work — the one real gap: regex capture-group replacement (Phase 3).** The existing replace was **literal only** ("Replacement text is literal"); the spec requires "capture groups and replacement syntax when regex mode is enabled." Implemented in `search.ts`:

- `expandReplacement(template, match)` — expands `$1`…`$99` and `$<name>`, `$&` (whole match), `$$` (literal `$`), and `\n`/`\t`/`\r`/`\\` escapes — the editor's own find/replace syntax; a non-participating group → empty.
- `replaceHitsWith(content, hits, replacementFor)` — generalises the former `replaceHits` so each hit's replacement is computed from its matched span; it keeps the existing **stale-line** and **overlap** refusals (so a stale/conflicting result still yields **no partial write**). `replaceHits(content, hits, literal)` now delegates to it (all its existing tests unchanged).
- `compileReplacer(mode, replacement)` — for a plain replace returns the literal; for a **regex** replace recovers each match's groups by re-running the anchored pattern against the matched span and expanding the template. If the template references groups the pattern can't provide (a ripgrep-only construct JS can't compile), it **throws so Apply is refused** rather than writing a wrong replacement; a group-free template falls back to the literal.
- **Panel wiring (`SearchPanel.tsx`):** `makePreview` and `replaceAllDirectly` now use `compileReplacer`; a `replaceError` validation memo **disables Preview/Replace and shows a `role="alert"`** when a regex template can't expand; the replace input placeholder and the preview status reflect regex mode ("Capture groups ($1, $<name>) are expanded"). No change to the apply path, ownership, or the Executions/undo flow.

**Transaction/recovery/undo guarantees (unchanged, now documented):** per-file guarded writes, not cross-file atomic; partial success reported precisely; single-level per-file undo through the same guards; a concurrent edit (open or disk) to a target is detected and that file is skipped with a reported reason — never overwritten. These are the **existing** guarantees; WS8 did not weaken them.

**Tests run and exact results (parser/engine fixtures are pure; the apply path is exercised by real in-memory-disk Playwright fixtures via `fakeRipgrep` + a `write_file_guarded` stand-in — not a claim of real-OS/native verification):**

- **`node --test` search engine (`search.test.ts`) → 16 passed**, incl. 2 new WS8 tests: `expandReplacement` (numbered/named groups, `$&`, `$$`, escapes, missing group, two-digit index) and `compileReplacer` (literal vs. group expansion, named + case-insensitive, and the impossible-group refusal). The existing `replaceHits` stale/overlap/CRLF matrix still passes via the generalised path.
- **Playwright `search.spec.ts` → 11 passed**, incl. 2 new WS8 tests: a regex replace with `$2.$1` rewrites the file (`"1_2"` → `"2.1"`) and the status confirms group expansion; and an impossible-group template shows the alert and disables Apply. The pre-existing preview/apply/undo, dirty-document, closed-CRLF, stale-line, cancel, open-files-only and workspace-switch tests all still pass.
- **Broad frontend regression (`src/**/*.test.ts`) → 1,298 (1,296 passed, 0 failed, 2 pre-existing skips).** `tsc --noEmit` exit 0; `prettier --check` clean. **No Rust changed** (the native search + guarded write already existed), so native suites/clippy are unaffected.

**Performance.** Search already runs natively (ripgrep) off the UI thread with cancellation, `MAX_HITS` and a 20 MB replacement-recovery bound; no index is introduced (the spec forbids one without measurements showing traversal can't keep up — it can). The new replacement work is O(matches) string splicing within the existing bound.

**Deferred / limitations (and why):** no new **per-match inline old→new** diff rendering was added — the panel already shows highlighted matches + a per-file before/after preview + the replacement field, which satisfies "show old and new text for each proposed change" within the existing UI, and redesigning the match rows was out of proportion to the one real gap; cross-file apply remains **non-atomic** by existing design (reported precisely, never falsely claimed atomic); regex group recovery uses JS `RegExp`, so a pattern valid only in ripgrep's engine can't expand groups (refused up front rather than mis-replaced).

**Files changed:** `src/services/search.ts` (`replaceHitsWith`, `expandReplacement`, `compileReplacer`; `replaceHits` delegates), `src/services/search.test.ts` (+2 tests), `src/components/layout/SearchPanel.tsx` (regex-aware replace + validation/alert), `tests/ui/search.spec.ts` (+2 tests). No change to the native side, the apply path, DocumentService, protected search license files, or C1/C2.

---

## WS7 Part 6 — Monorepo dependency graph integration — ✅ IMPLEMENTED + VERIFIED

**Goal:** order a monorepo's tasks by the package relationships **declared** in its manifests, feeding the **existing** dependency planner (`plan.ts`) — not a second scheduler. A package's build runs after the builds of the local packages it depends on, derived from a pure, validated graph.

**Package graph architecture (`packageGraph.ts`, new — pure projection).** Over the manifests discovery already read, it builds a directed graph whose nodes are discovered packages (node id = the package's **build task id**, the single source of truth now exported from discovery as `discoveredTaskId`) and whose edges are **local, resolved** dependencies only. It builds no scheduler and executes nothing.

**Supported dependency declarations.**

- **JavaScript (npm/pnpm/Yarn):** `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`. A dependency is **local** when its **name** matches another discovered workspace package **in the same root** — exactly how a workspace resolves it (a `workspace:*`/`workspace:^` protocol or a `file:` ref is one such entry; the spec string is irrelevant, only the name matters). Scoped names (`@acme/ui`) are handled. **Never inferred from directory names.**
- **Cargo:** `dependencies`, `dev-dependencies`, `build-dependencies`, and `target.*.dependencies` — in inline-table (`core = { path = "../core" }`), bare sub-table (`[dependencies.core]` / `path = …`), and dotted-key forms. A dependency is **local** when it is a **path dependency** resolving (relative to the package dir) to a discovered member's directory, or a `workspace = true` entry whose `[workspace.dependencies]` declaration (relative to the workspace root) carries such a path. A version-only (registry) dependency is **external** and never becomes a node or edge.

**Isolation & robustness.** Packages are **isolated per workspace root** (indices are keyed by root), so a name or path never links packages under different roots. **Ambiguous** (duplicate) package names within one root are not guessed (no edge); **missing** dependencies are dropped; **invalid manifests** parse to nothing; **external** deps are excluded; **cycles** are detected and **broken deterministically** (the back-edge that would close a cycle is dropped and recorded) so a pathological manifest never makes a build un-runnable.

**Task dependency policy (small, deterministic, documented).** `packageTaskDependsOn` applies exactly one rule: **a package's `build` task depends on the `build` tasks of its local dependencies.** Nothing else is wired automatically — test/lint/run stay independent unless the user configures `dependsOn`. Only edges between build tasks that **actually exist** in the discovered task list are kept, and edges are de-duplicated. `applyPackageDependencies` merges these onto the discovered build tasks' `dependsOn`; **explicit `dependsOn` is preserved** and, since a configured task overrides a discovered one in the TaskService, **user configuration stays authoritative**. The augmentation runs inside `discoverWorkspaceTasks`, so it flows through the existing live rediscovery unchanged.

**Execution semantics — reuse of the existing planner.** The edges are ordinary `dependsOn`, so the existing `planTask` provides everything: **dependencies build before dependents**, a **shared dependency is planned once** (verified: `app → {x, y} → shared` plans `shared` exactly once, first), an **unknown edge is refused** (so only real build ids are injected), and a **cycle is refused** (so the graph is pre-broken). Failure-blocks-dependents, cancellation propagation, concurrent independent packages, terminal ownership and running-task snapshot preservation are the existing, already-tested TaskService behaviours — unchanged, because this adds edges, not a new execution path.

**Cycle behaviour.** The package graph may contain a cycle (valid Cargo never does; npm can). The projection **breaks** it deterministically (sorted DFS, drop the back-edge, record the broken cycle) rather than emitting a cyclic `dependsOn` the planner would reject — so builds remain runnable, and the cycle is surfaced for logging/UI.

**Live graph refresh.** Reuses the existing discovery watcher only: a change to a `package.json`, `Cargo.toml` or a workspace manifest re-runs `discoverWorkspaceTasks`, which re-derives the graph and the edges, preserving stale-result protection and workspace isolation — **no new watcher or polling loop** (verified: adding a `workspace:*` dependency to a package's `package.json` makes its build depend on the dependency's build after one debounced re-discovery).

**UI integration.** The hierarchical Tasks view (WS7 Part 5) now shows a task leaf's dependency ordering inline — `↳ after <labels>` (resolved from the dependency task ids), with a `Builds after: …` tooltip — for both package-derived and configured dependencies. Blocked/failed dependency runs are already shown by the Executions section (the dependency run chain and its error). The tree stays simple; no separate execution interface.

**Verification — all green (parser/graph fixtures are pure; execution is the existing planner):**

- **`node --test` package graph (`packageGraph.test.ts`, new) → 15 passed:** the JS and Cargo manifest parsers (four JS sections; Cargo path/inline/sub-table/target/workspace-inheritance; version-only excluded); npm-by-name and Cargo-by-path resolution; **externals excluded** (no invented nodes); **cross-root isolation**; **ambiguous/missing** handling; the **build→build policy** feeding `planTask` (correct order); **build-only** wiring (test/lint untouched); edge to a build-less package dropped; **explicit override merged**; **cycle broken** (planner never throws); **shared dependency once**.
- **`node --test` all task suites → 103 passed, 0 failed** (graph + discovery + monorepo + projection + live rediscovery + service).
- **`node --test` live rediscovery → 11 passed** (adds the live dependency-edge refresh).
- **Broad frontend regression (`src/**/*.test.ts`) → 1,296 (1,294 passed, 0 failed, 2 pre-existing skips).** `tsc --noEmit` exit 0; `prettier --check` clean.
- **Playwright → existing Run/task tests (6) + WS7.5 (3) + new WS7.6** (a leaf shows "after <dep>"; an independent task shows none) all green.
- **No Rust changed** (a frontend-only graph + planner edges), so native suites/clippy are unaffected.

**Changed files:** new `src/services/tasks/packageGraph.ts` (+ `packageGraph.test.ts`); `discovery.ts` (`root` on `TaskSource`, exported `discoveredTaskId`, augmentation in `discoverWorkspaceTasks`); `taskTree.ts` (`dependsOn` on task leaves + in the signature); `RunPanel.tsx` (the `after …` line); `taskDiscovery.test.ts` (+ live-edge test); `tests/ui/terminal.spec.ts` (+1 test). No change to `model`/`plan`/`service` logic, native code, protected files, or C1/C2; task identity and ResourceUri preserved; nothing executed during discovery; workspace trust untouched.

**Known limitations:** resolution is **structural** (declared names/paths), not a package-manager resolution — it does not read lockfiles, follow npm alias (`"x": "npm:y@1"`) targets, evaluate pnpm `catalog:` entries, or expand Cargo `cfg(...)` target predicates (every `target.*` dependency is considered regardless of platform); `default-members` is not distinguished; the policy is build→build only (test-after-dependency-build is deliberately not auto-wired); a multi-line Cargo inline table is not parsed (TOML keeps inline tables single-line, so this is only a concern for hand-wrapped manifests).

**Next genuinely missing IDE capability (assessed).** The build/test/debug/task stack is now substantial. The clearest remaining gap for a local-first IDE is a **Source Control (SCM) decorations + diff-review loop beyond the existing Git panel** — e.g. inline per-line blame, a staged-hunk review view, or a multi-file review surface — or, alternatively, **a Search-and-Replace-across-files** workflow if not already present. Either is a real, separable capability; neither rebuilds the planner. (Left for a future workstream; not started here.)

---

## WS7 Part 5 — Hierarchical Tasks view & package filtering — ✅ IMPLEMENTED + VERIFIED

**Goal:** make discovered and configured tasks easy to navigate, filter, run and monitor across single-root, multi-root and monorepo projects — as a **projection over the existing task model**, with **no new task service, watcher or process manager**, and preserving every stable task id and the existing execution path.

**Hierarchy design — a pure projection (`taskTree.ts`, new).** `buildTaskTree(tasks, folders)` projects the flat `ResolvedTask[]` the TaskService already owns into **Workspace → Package → Group → Task**. It creates **no** task records and **no** execution state: a task leaf carries the task's own `id` (`node.taskId`), so running/stopping/selection all go through the existing service by that id, and identity survives a re-projection. Node ids are **stable and structural** (`ws\0<i>`, `pkg\0<i>\0<relPath>`, `grp\0<i>\0<relPath>\0<group>`, and the task's own id for leaves — never positional), so expansion and selection survive discovery and lifecycle changes. The **workspace level** appears only in a multi-root workspace; the **package level** is omitted for a plain single-package root (a flat project is not wrapped in a redundant node), and is emitted per sub-package for a monorepo. Package membership is derived from each task's `cwd` relative to the workspace folders (longest-prefix match; a `null` cwd is the primary root; a relative cwd is a sub-path) — structural, not fragile id-parsing. Everything is sorted deterministically (root package first, then by path; groups in canonical order; tasks by label then id).

**Grouping — explicit metadata first.** `presentationGroup(task)` reads **`task.group` (`build`/`test`) first and never lets a name override it**, then problem-matcher metadata (`eslint`/`ruff` → Lint, `tsc` → Typecheck), and only when neither decides falls back to a conservative, convention-based reading of the command/name (clippy/lint → Lint, tsc/typecheck → Typecheck, run/start/serve/dev → Run). Anything unrecognised is **Other**. The six groups — Build, Test, Lint, Typecheck, Run, Other — render in that fixed order.

**Filtering & search — composable (`filterTasks`).** Workspace, package, group and source (`configured` = user/workspace, vs. `discovered`) filters plus a case-insensitive text search over label/id/command, all AND-composed, applied to the task list **before** the tree is built, so the hierarchy only ever shows matching tasks. `filterOptions(tasks, folders)` enumerates exactly the workspaces/packages/groups/sources present, to populate the toolbar's dropdowns (each shown only when it would offer a choice). **Selection/focus is preserved** when its task remains and **cleared safely** when it disappears; the tree is memoised on a `tasksSignature` (task **identity**, not run state) so a running task's state change (a run tick) **never rebuilds the tree** and filtering **never interrupts a running task**.

**Execution integration — reuse only.** The Run panel (`RunPanel.tsx`) keeps the existing TaskService commands — `onRun`/`onRerun`/`onStop`/`onShowTerminal` go through the service by task id (`onRerun` → `service.restart`). A task leaf shows its latest run's **state, duration and exit code** inline and a **Rerun** when finished; the **Executions** section (running first, with Stop and Show-terminal, multiple independent runs) is unchanged, so no new process ownership or execution state is introduced. The snapshot now also carries the workspace `folders` (so the view can locate packages) — additive, no behavioural change.

**Live updates & performance.** The panel binds to the existing `TaskService` snapshot subscription (no polling, no second watcher); package/task addition/removal, configuration changes, workspace changes and run-state changes all arrive through it, and discovery changes flow in from WS7 Part 3/4's live rediscovery. Memoised projections + stable references keep it cheap: **filter + build + flatten measured at 100 → 0.2 ms, 1,000 → 3.6 ms, 5,000 → 6.2 ms** (6,000 rows) — well within budget; rows are pre-flattened so a virtualized window can wrap them later exactly as the file Explorer and Test Explorer do.

**Accessibility.** Disclosure headers are native `<button aria-expanded>` with descriptive labels (`"Build tasks"`, `Package <path>`, `Workspace <name>`); task leaves keep `role="group"` with their label and a `Run <label>` button (the established command contract). Keyboard: Up/Down move focus across visible rows, Right/Left expand/collapse a header, Enter/Space runs a focused task; focus is preserved on its row across updates. Running and failure status are announced through the per-run state text and the unchanged Executions section. A search box (`role="searchbox"`) and a useful empty state ("No tasks match these filters" with a Clear action) complete it.

**Verification — all green:**

- **`node --test` projection (`taskTree.test.ts`, new) → 12 passed:** grouping (explicit metadata wins, conventions fill the gap), single-root/monorepo/multi-root shape, duplicate display names stay distinct, **stable node ids across reordering**, **composable filters**, **search** over label/id/command, `filterOptions`, flatten + collapse/expand, the identity signature, and the **100/1,000/5,000-task performance** check.
- **`node --test` all task suites → 87 passed, 0 failed** (projection + service + discovery + monorepo + taskDiscovery).
- **Broad frontend regression (`src/**/*.test.ts`) → 1,280 (1,278 passed, 0 failed, 2 pre-existing skips).** `tsc --noEmit` exit 0; `prettier --check` clean.
- **Playwright → existing Run/task tests still green (8) + 3 new WS7.5 tests** (grouping + search narrowing; group collapse/expand with `aria-expanded`; keyboard Enter-to-run), and a **full `terminal.spec.ts` + `menus.spec.ts` sweep** (178 tests) to catch collateral: all green after one pre-existing fix and one flake (below).
- **No Rust changed** (a frontend-only projection + panel), so the native suites/clippy are unaffected.

> **WS5 follow-up found by this verification (not a WS7.5 regression):** the full sweep surfaced `terminal.spec.ts "arrow keys move between panel views"` failing because WS5 added a `TEST RESULTS` panel view (`src/services/panel/views.ts`, committed) **after** `PORTS`, so `PORTS` is no longer the last view and the test's wrap assertion was stale. My WS7.5 changes don't touch panel views; the test was corrected to step to the real last view (`TEST RESULTS`) and wrap to `PROBLEMS` — green 3/3. The other sweep failure (`a crashed extension host is reported…`) passed in isolation — a known flake under the heavy single-worker batch, not a regression.

**Changed files:** new `src/services/tasks/taskTree.ts` (+ `taskTree.test.ts`); rewrote `src/components/layout/RunPanel.tsx` (hierarchy, filters, search, keyboard, inline run status; Executions section preserved); `src/services/tasks/service.ts` (`folders` on `TaskSnapshot`); `src/App.tsx` (`onRerun` → `service.restart`); `tests/ui/terminal.spec.ts` (+3 tests). No change to `model`/`discovery`/`taskDiscovery`/`monorepo`, native code, protected files, or C1/C2; ResourceUri and task identity preserved.

**Known limitations:** rows are pre-flattened but not yet windowed, so a 5,000-task tree renders all expanded rows (the projection is cheap; DOM virtualization is the next step if needed); package labels use the workspace-relative path (stable) rather than a declared package name; the keyboard model is a disclosure-with-roving-focus hybrid (task leaves stay `role="group"` for the command contract) rather than a formal ARIA `tree`.

**Dependency-graph-aware ordering — assessed, not built.** Explicit `dependsOn` ordering already works end-to-end (WS7 Part 2's planner: topological order, cycle and shared-dependency detection). What is genuinely _missing_ is **inferred** ordering from a monorepo's own dependency graph (Cargo path-deps, npm workspace deps) — e.g. building a library package before an app that imports it without the user writing `dependsOn`. That is a real, separable capability for a future workstream; it would feed edges into the **existing** planner, not replace it. Not started here, by design.

---

## WS7 Part 4 — Monorepo & sub-package task discovery — ✅ IMPLEMENTED + VERIFIED

**Goal:** discover tasks for every sub-package of a monorepo — npm/yarn `workspaces`, a `pnpm-workspace.yaml`, or a Cargo `[workspace]` — extending the existing discovery and live-rediscovery architecture. **No new task system, watcher or process manager**; nothing is executed during discovery.

**Declaration parsers (pure, `discovery.ts`).** Three readers parse **declarations only**, never executing a config:

- `parseNpmWorkspaceGlobs` — package.json `workspaces`, either an array of globs or Yarn's `{ packages: [...] }` object; a leading `!` is an exclude; `null` when there is no field (not a monorepo), `{include:[],exclude:[]}` when present-but-empty.
- `parsePnpmWorkspaceGlobs` — a minimal reader for just the `packages:` key of `pnpm-workspace.yaml` (block sequence or inline `[a, b]` flow list; quotes, comments and a following top-level key handled). Not a full YAML parser.
- `parseCargoWorkspaceGlobs` — the `[workspace]` table's `members`/`exclude` string arrays (multi-line arrays supported); `[workspace.metadata]` and other sub-tables are correctly **not** treated as the workspace table.

**Bounded glob expansion (injected lister).** A declared glob (`packages/*`, `apps/*/pkg`, `crates/*`, a literal `tools/cli`, or `**`) is expanded against the **real tree** via an injected `DirLister` (backed in the app by the native, workspace-confined `list_workspace_files`, `maxDepth:1` per level). Wildcard matching never crosses a path separator; `node_modules`, `target`, `.git` and dot-directories are **never traversed**; depth and total-directory **budgets** (`MAX_WALK_DEPTH`, `MAX_MEMBER_DIRS`) cap a pathological or symlink-cyclic tree. Excludes (and Cargo `exclude`) subtract from the member set; the root itself and any member that coincides with a declared root folder are removed, so nothing is discovered twice.

**Per-package discovery & package-aware execution.** Each member directory is discovered exactly as a root is (the same `readConventionFiles` → npm/Cargo/Makefile parsers), so a member that is both an npm package and a crate gets both. Identity is **path-qualified and stable**: a member's id key is its workspace-relative path with separators folded to `.` (`npm:packages.web:build`, `cargo:crates.core:build`), prefixed by the root key in a multi-root workspace (`npm:front.packages.ui:build`) — so two packages that both have a `build` script, even two both named `ui`, **never collide**. Each task runs with **cwd = its own package directory**, so the right package's scripts/crate build — **without interpolating the package's (untrusted) name into any command** (the command stays `npm run build` / `cargo build`). A member with no package-manager signal of its own **inherits** the workspace root's manager (a `pnpm-workspace.yaml` ⇒ pnpm; otherwise the root's own field/lockfile/default), while a member that pins its own `packageManager` overrides it.

**Live rediscovery (extends `taskDiscovery.ts`, no new watcher).** `createTaskDiscovery` now takes the same `DirLister` and passes it through, so re-runs re-expand the monorepo. A sub-package manifest created/edited/deleted anywhere under a watched root already matches `isDiscoveryFile` by basename, so **adding, editing or removing a package re-discovers live** through the existing watch; `pnpm-workspace.yaml` was added to `DISCOVERY_FILES` so a change to the member list itself triggers a re-run.

**UI (existing surfaces, no new panel).** Sub-package tasks flow through the existing Run Task picker and Tasks panel. Their **label** now shows the package's **declared name** (or relative path) and the **package manager** (`npm: @acme/web/build`, `pnpm: ui/build`, `cargo: core/build`); the **source** (`(discovered)`) and **command** remain in the picker detail. No picker-detail format change (so the existing Playwright assertions stand), no new panel.

**Security/ownership (unchanged):** discovery still only **reads** fixed, known files and **lists** directories through the native workspace-confined APIs — it never executes a project config, never follows into `node_modules`/`target`/`.git`, and constructs commands structurally (no untrusted package name in any shell line). Execution still goes through the TaskService with workspace trust; no second watcher, process manager or session registry; C1/C2 and protected files untouched.

**Verification — all green:**

- **`node --test` monorepo (`monorepo.test.ts`, new) → 13 passed:** the three declaration parsers (array/object/negation/absence; block/flow/comments; members/exclude/multi-line/sub-table); npm sub-packages become non-colliding path-qualified tasks with per-package cwd and no name interpolation; **pnpm/yarn inheritance** and a **member pinning its own manager**; a **Cargo workspace** with an excluded crate; **nested + literal members** with `target`/`.git` never traversed; **multi-root** key prefixing keeps two `ui` packages distinct; a member equal to a declared root is not added twice; **no lister ⇒ root-only** (back-compat); bounded expansion tolerant of files/ignored dirs in a listing.
- **`node --test` live rediscovery (`taskDiscovery.test.ts`) → 10 passed** (adds: a monorepo's sub-packages are discovered, and **adding a package re-discovers it live** via the existing watch + injected timers/lister).
- **All task suites → 75 passed, 0 failed** (`discovery` + `monorepo` + `taskDiscovery` + `tasks`). **Broad frontend regression (`src/**/*.test.ts`) → 1268 (1266 passed, 0 failed, 2 skip).** `tsc --noEmit` exit 0; `prettier --check` clean. **Playwright task/Run tests → 6 passed.** **No Rust changed** (reuses the existing native watch, `read_file_content` and `list_workspace_files`), so the native suites/clippy are unaffected.

**Real vs. simulated:** expansion and live re-discovery are verified with a **fake `DirLister` + fake `onResourceChanges` events + injected timers** (deterministic); the native directory listing and real filesystem watch drive the same path in the app.

**Files changed:** new `src/services/tasks/monorepo.test.ts`; edited `src/services/tasks/discovery.ts` (workspace-declaration parsers, bounded glob expansion, member discovery, inherited manager, `relPath`/`packageName`/`inheritedManager` on `TaskSource`, `labelPrefix`, `pnpm-workspace.yaml` in `DISCOVERY_FILES`, `loadTaskSources`/`discoverWorkspaceTasks` take an optional `DirLister`), `taskDiscovery.ts` (+`.test.ts`) (thread the lister through), `src/services/workspaces.ts` (native `list_workspace_files`-backed lister wired into `createTaskDiscovery`). No change to `model`/`service`/`plan`/`matching`, native code, protected files, or C1/C2.

**Known limitations:** expansion resolves directory globs structurally (it does not read a member's `package.json` to confirm npm-workspace membership the way npm does, and does not evaluate pnpm `catalog:`/Cargo path-dependency graphs); `default-members` is not distinguished from `members`; inter-package dependency ordering remains **explicit-only** (a configured `dependsOn` across package ids works, but relationships are never inferred). **Next capability:** a richer Tasks view (grouping sub-packages, per-package filtering) or Cargo/npm dependency-graph-aware ordering — building on this, not an audit.

---

## WS7 Part 3 — Live task rediscovery + package-manager detection — ✅ IMPLEMENTED + VERIFIED

**Goal:** keep discovered tasks current as project files change, and run npm scripts with the project's real package manager — reusing the existing filesystem watch (no second watcher) and the existing TaskService.

**Live rediscovery (`taskDiscovery.ts`, new) — reuse, not a new watcher.** `createTaskDiscovery` subscribes to the **existing** `onResourceChanges` (the native `resource-changes` watch the Explorer and Git already use) and re-runs discovery when a discovery file changes. It owns no watcher and no polling loop — just a subscription, a debounce timer, and the discovery read. Correctness:

- **Workspace isolation:** a batch is acted on only when its watched `root` is one of this coordinator's folders (`samePathString`), so one workspace's changes never touch another's tasks.
- **Relevance filter:** only `package.json`, `Cargo.toml`, a Makefile (`GNUmakefile`/`makefile`/`Makefile`), or a lockfile — matched by basename (`isDiscoveryFile`), including a rename's old/new name — schedules a re-discovery; an unrelated file does not. A `rescan` (lost OS events) re-discovers to be safe.
- **Debounced:** a burst (an editor save writes several times) collapses to one re-discovery.
- **Stale-result protected:** each run takes a token; a slower run that finishes after a newer one started is dropped, so the newest file state always wins.
- **Read-failure safe:** a transient read error publishes nothing — the last valid list stands.
- Wired in `workspaces.ts`: the coordinator replaces the WS7 one-shot read, pushes new lists into the TaskService via `refresh()`, and is **disposed with the workspace** (no leaked subscription). Creation/deletion/rename of a manifest, and workspace switching, all flow through it.

**Package-manager detection (`discovery.ts`).** npm scripts now run with the project's manager — `npm run` / `pnpm run` / `yarn run` — chosen from the project's **files**, never from whichever executable happens to be installed. Deterministic precedence: (1) the `packageManager` field in package.json (Corepack's declaration), (2) a single lockfile (`pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, `package-lock.json`→npm), (3) no signal → the baseline `npm` (which runs any project's scripts), (4) **conflicting lockfiles with no field → `ambiguous`:** Yavin does not guess pnpm vs yarn — it falls back to the universal `npm` and reports the state rather than inventing a command. An unknown `packageManager` value (e.g. `bun@…`) is ignored, falling through to lockfiles. **Task ids stay `npm:<name>` regardless of the manager** (identity is stable across a lockfile change); only the command and the label (`pnpm: build`) change. `loadTaskSources` reads the lockfiles (presence only — contents are never parsed) and the three Makefile names (make's own precedence: GNUmakefile → makefile → Makefile).

**UI (existing surfaces, no new panel):** the Run Task picker shows the **source** (`(discovered)`), the **package manager** (in the command, `pnpm run build`, and the label), and the **workspace** (multi-root labels are folder-qualified, `pnpm: web/build`). A refresh updates `taskSnapshot.tasks` in the background; the picker reads the list when opened, so it is never force-closed or reset.

**Security/ownership (unchanged):** discovery only reads fixed, known files (never executed, never a renderer-named path); commands are structurally constructed (`<pm> run <name>`, the script name validated); execution still goes through the TaskService with workspace trust before every run; the coordinator uses the existing watch and the existing process authorization — no second watcher, process manager or session registry.

**Running tasks are never disrupted:** a running execution captured its validated config at start, so a re-discovery that changes or removes its definition does not restart or redefine it — verified.

**Verification — all green:**

- **`node --test` discovery → 24 passed** (the 17 from Parts 1–2 plus package-manager precedence, single-lockfile, ambiguous-fallback, unknown-field fall-through, stable-ids-across-managers, `isDiscoveryFile`, Makefile-variant precedence).
- **`node --test` live rediscovery (`taskDiscovery.test.ts`) → 9 passed** (initial + change re-discovery, **debounce** of a burst, **stale-result** protection, **workspace isolation**, unrelated-file ignored + rescan, deletion/rename + removed-source tasks gone, **read-failure keeps the last list**, **dispose unsubscribes**, **multi-root**). All use **fake filesystem events and injected timers** — deterministic, not a real watch.
- **`node --test` tasks service → 28 passed** (adds: a **running discovered task keeps its original config** across a refresh; a removed discovered task cannot be run while a configured one survives).
- **All task suites → 97 (96 passed, 1 pre-existing skip).** `tsc --noEmit` exit 0; `prettier --check` clean; **no Rust changed** (reuses the existing native watch + `read_file_content`), so the native suites/clippy are unaffected. Broad frontend regression (tasks+testing+debug+panel) → 239 (238 passed, 1 skip); Playwright task/Run tests → 10 passed.

**Real vs. simulated:** the watch integration is verified with **fake `onResourceChanges` events + injected timers** (deterministic); a real filesystem watch drives the same path in the app. Task execution remains verified through the FakeNative harness, as before.

**Files changed:** new `src/services/tasks/taskDiscovery.ts` (+ `.test.ts`); edited `src/services/tasks/discovery.ts` (package-manager detection, lockfile/Makefile-variant reads, `isDiscoveryFile`/`DISCOVERY_FILES`) + `discovery.test.ts`, `tasks/tasks.test.ts`, `src/services/workspaces.ts` (coordinator wiring + disposal). No change to `model`/`service`/`plan`/`matching`, native code, protected files, or C1/C2.

**Known limitations:** detection reads lockfiles and the `packageManager` field only (no `.npmrc`/`corepack` version enforcement); a `pnpm-workspace.yaml`/npm-workspaces monorepo is discovered per folder, not as sub-packages; a renamed-away manifest whose new name is unknown still triggers a (correct, cheap) re-read. **Next capability:** monorepo workspace/sub-package discovery, or a richer Tasks view — building on this, not an audit.

---

## WS7 Part 2 — Task discovery integration & execution verification — ✅ HARDENED + VERIFIED

**Goal:** prove discovered tasks integrate correctly with the existing configuration, execution, dependency, terminal, diagnostics and trust systems — and harden the parsers against the edge cases — without rebuilding anything.

**Hardening — the Makefile parser.** The WS7 regex `^name\s*:(?![=])` had a real defect: on a GNU `::=` assignment the lookahead **backtracks** (matches one colon, sees the second colon, not `=`, and wrongly treats the line as a target). Rewritten to capture the **whole colon run** and check what follows (`^(name)[\t ]*(:+)(.*)$`, reject when the rest starts with `=`), which rejects every colon assignment (`:=`, `::=`) robustly while keeping **double-colon rules** (`clean::`) as real targets. Pattern rules (`%.o:`), `.directives` (`.PHONY:`), recipe lines (tab-indented) and comments (`#…`) are all rejected by the `^[A-Za-z0-9_]` anchor.

**Hardening — Cargo manifest detection (found by a Playwright regression).** WS7 offered Cargo tasks on a `Cargo.toml`'s mere presence, relying on the native `read_file_content` to reject a missing file. A Playwright run surfaced the fragility: its mock returns placeholder text for **every** read, so discovery saw a phantom `Cargo.toml` and offered `cargo:build`, which broke the "no build task" test. Fixed robustly — a Cargo manifest must declare `[package]` or `[workspace]` (every real one does; unrelated/garbage content does not), so discovery no longer treats a stray file (or a mock read) as a Rust project. A manifest with those sections but errors elsewhere still offers the tasks (they surface the real error when run).

**Verification added (all green):**

- **Discovery (`discovery.test.ts`) → 16 tests, 16 passed:** the 8 from WS7 plus **Makefile edge cases** (`:=`/`::=`/`?=`/`+=`/`!=` assignments are not targets; double-colon rules are; pattern/special targets and comments handled; empty/targetless → nothing), **stable ids across repeated runs** (deterministic order: npm → cargo → make, file order preserved), **same name from different sources does not collide** (`npm:build` / `cargo:build` / `make:build` coexist), **an invalid-but-present Cargo.toml still offers the fixed subcommands** (presence-based, never parsed or run), and **duplicate script keys** (JSON last-wins).
- **Service integration (`tasks.test.ts`) → 78 tests, 77 passed, 1 pre-existing skip:** a **configured task may depend on discovered task ids and the planner orders them** (`ci → [cargo:test, npm:build]` plans `cargo:test, npm:build, ci`) — dependencies participate only when **explicitly configured**, never inferred from names; a **cycle through discovered tasks is detected before anything runs**; a **discovered Cargo task's output reaches the existing Cargo matcher and Problems** with the correct task origin (`task:cargo:check`) and **canonical ResourceUri path** (`C:/work/src/main.rs`); a **discovered task can be cancelled and restarted** through the existing service. (These run through the deterministic FakeNative harness — the same path configured tasks use; execution is **simulated**, not a real subprocess.)

**Integration confirmed (ownership unchanged):**

- **Identity/precedence:** discovered ids are stable and source-qualified; a configured/workspace task of the same id **overrides** a discovered one (one display entry, the configured one wins, scope distinguishes them) — never a silent overwrite.
- **Execution:** discovered tasks run through the existing TaskService (trust before every execution, shell/args via `shell.ts`, terminal-owned processes, exit codes, cancel, restart). Commands stay native-owned and structurally constructed; no renderer-controlled execution added.
- **Dependencies:** only explicitly-configured `dependsOn` — discovered tasks have none of their own and nothing is inferred from names.
- **Problem matchers:** discovered Cargo tasks carry the existing `cargo` matcher; npm tasks get a matcher only when the command clearly runs a known tool (`tsc`/`eslint`); Makefile tasks get none (correct — nothing to infer). No arbitrary path is taken from untrusted output; the existing matchers resolve to canonical `ResourceId`s.
- **UI:** discovered tasks appear in the existing **Run Task… picker / Run panel** (in `taskSnapshot.tasks`), labelled by source (`(discovered)` / `(workspace)`); no new task panel.

**Verify (exact):** `node --test discovery.test.ts` → **16 passed**; `node --test tasks/*.test.ts` → **78 (77 passed, 1 skip)**; broad frontend regression (tasks + testing + debug + panel) → **220 (219 passed, 1 skip)**; `tsc --noEmit` exit 0; `prettier --check` clean; **no Rust changed** (native suites/clippy unaffected); Playwright: all 10 task/Run tests pass (incl. the previously-failing "Run menu" one after the Cargo-manifest fix).

**Real vs. simulated:** task execution is verified through the **deterministic FakeNative harness** (the identical TaskService path for configured and discovered tasks), not a real subprocess — the honest status, since a node unit test cannot spawn a real PTY. A real npm/Cargo/make run happens through the app's native terminal, which the harness faithfully simulates.

**Files changed:** `src/services/tasks/discovery.ts` (Makefile parser hardening) + `discovery.test.ts` and `tasks.test.ts` (coverage). No change to `model.ts`/`service.ts`/`plan.ts`/`matching.ts`, native code, protected files, or C1/C2.

**Known limitations (unchanged):** npm-only (no yarn/pnpm lockfile detection); no Python discovery; discovery runs once on open (no file-watch re-discovery); Makefile `include`/recursive make not expanded; space-separated multi-target rules (`a b:`) take the first token. **Next capability:** file-watch re-discovery (tasks update when a package.json/Makefile changes), or package-manager detection — building on this, not an audit.

---

## WS7 — Integrated Build & Task System: task discovery — ✅ IMPLEMENTED + VERIFIED

**Goal:** a unified Build & Task System. **Inspection first found most of it already built** — `src/services/tasks/` has the typed `TaskDefinition`/`ResolvedTask` model + validation, user/workspace **persistence** (`tasks.definitions` settings), **dependency planning** (`plan.ts`: DFS order, cycle detection, shared-dependency-once, failure refusal before anything runs), the full **lifecycle** service (run/restart/cancel, states, exit codes, output, cancellation, stale-generation protection, one-execution-per-task, dedicated/new terminals), **problem-matcher** integration (`matching.ts` → the one Problems store), and workspace-trust gating. The single genuinely-missing capability was **automatic task discovery** from project conventions — the task list came only from settings. WS7 adds that and wires it through the existing machinery, **duplicating nothing** (no new process/terminal/diagnostics/lifecycle).

**Task discovery (`src/services/tasks/discovery.ts`, new).** Pure parsers that read project files and **never execute anything**:

- **npm scripts** — `package.json` parsed as JSON; each `scripts` entry → `npm run <name>` (id `npm:<name>`), group inferred (`build`→build, `*test*`→test), a problem matcher inferred only when the command clearly runs a known tool (`tsc`/`eslint`/`cargo`/`ruff` as a whole word).
- **Cargo** — a `Cargo.toml`'s _presence_ offers the fixed safe subcommands `build`/`test`/`check`/`clippy`/`run` (ids `cargo:<cmd>`, matcher `cargo`); `cargo metadata` is **not** run during discovery.
- **Makefile** — targets read from the text (a `name:` at column 0 that is not a variable, a pattern rule, or a `.directive`); id `make:<target>`.
- Discovered tasks are ordinary `ResolvedTask`s with **`scope: "discovered"`**; ids are stable and deterministic (`<source>:<name>`), **folder-qualified for multi-root** workspaces (`npm:web:build`, with the folder as cwd). A discovered task's `args` are always empty (the command carries everything), so nothing is interpolated.
- `loadTaskSources` / `discoverWorkspaceTasks` read only the fixed convention files (`package.json`, `Cargo.toml`, `Makefile`) through an injected reader — never a renderer-named path, never executed.

**Integration (reuse, not duplication).**

- **Model (`model.ts`):** `scope` gains `"discovered"`; the task-id grammar allows `:` so a configured task can share a discovered id and **override** it.
- **Service (`service.ts`):** a new optional `discovered()` provider is merged **below** the configured tasks (user/workspace of the same id wins), and `refresh()` republishes when discovery updates. Everything else — planning, trust, terminals, matchers, records — is unchanged; discovered tasks run through the exact same path.
- **Wiring (`workspaces.ts`):** on opening a trusted folder, discovery reads the convention files via the existing `read_file_content` native command (confined to the workspace), populates the list, and calls `tasks.refresh()`. One read on open; no execution.
- **UI (reused, no redundant surface):** discovered tasks appear in the existing **Run Task…** picker and Run panel automatically (they are in `taskSnapshot.tasks`); the picker now labels a task's source (`(workspace)` / `(discovered)`).

**Security / ownership:** discovery only **reads** fixed, known files — it never executes a build tool or config script to discover tasks, and the renderer never names the files. A discovered task is still just a command line run through the existing TaskService, which enforces **workspace trust before every execution**, resolves shells/args through `shell.ts`, and owns no processes itself (the terminal does). Diagnostics stay owned by the Problems store; the task system owns task identity and lifecycle only.

**Verification — all green:**

- **`node --test` tasks suites → 66 tests (65 passed, 1 pre-existing skip, 0 failed):** `discovery.test.ts` (8 — npm/Cargo/Makefile parsing, invalid/empty config, multi-root ids+cwd, dedup/order, control-char rejection, the loader reading only convention files) + `tasks.test.ts` (new: discovered tasks in the snapshot, **configured overrides discovered by id**, a discovered task runs through the service, `refresh` picks up discovery changes) + the existing `tasks.test.ts`/`tasks.regression.test.ts` unchanged-green (the `:` id-grammar change broke nothing).
- **Broad frontend regression (tasks + testing + debug + panel) → 208 tests, 207 passed, 1 skipped, 0 failed.** `tsc --noEmit` exit 0; `prettier --check` clean. **No Rust changed** (discovery reuses the existing `read_file_content` command), so the native suites/clippy are unaffected. Playwright panel → 1 passed.

**Files changed:** new `src/services/tasks/discovery.ts` (+ `.test.ts`). Edited `src/services/tasks/{model,service}.ts` (+ `tasks.test.ts`), `src/services/workspaces.ts` (discovery wiring), `src/App.tsx` (picker source label). No change to `plan.ts`/`matching.ts`/`shell.ts`, the process/terminal/diagnostics infra, native code, protected files, or C1/C2.

**Known limitations / follow-ups:** (1) npm scripts assume `npm` (yarn/pnpm detection from a lockfile is a follow-up); (2) Python task discovery is not yet implemented (no safe, convention-based source — `pyproject` script tables vary); (3) discovery runs once on open (no file-watch re-discovery yet); (4) a Makefile `include` or recursive make is not expanded. **Next capability:** a richer Tasks view (dependency visualization, inline output/diagnostics) or file-watch re-discovery — building on this, not an audit.

---

## WS0 — Build environment recovery

**Context:** the post-consolidation (repo-flatten) audit found the Cargo `target/` cache carried absolute paths to the old `Yavin_2.0.0/…` location, breaking the Tauri build script (`os error 3`); `cargo fmt` failed on one line introduced by the flatten's URL path-fix; and 5 markdown files failed Prettier.

### WS0.1 — Prettier markdown formatting — ✅ DONE (verified)

- **Problem:** `prettier --check .` failed on `C2_DECISION_LOG.md`, `C2_FINAL_GATE_REVIEW.md`, `C2_PRODUCTION_PROFILE_REVIEW.md`, `C2_RELEASE_READINESS.md`, `GEMINI.md`.
- **Root cause:** the C2 docs were hand-authored without running Prettier; `GEMINI.md` pre-dated the check.
- **Change:** `npx prettier --write` on those 5 files (reformat only — no content/meaning change).
- **Tests/verify:** `npx prettier --check .` → **"All matched files use Prettier code style!"** (exit 0).
- **Files changed:** the 5 markdown files above.
- **Remaining:** none.

### WS0.2 — Cargo cache recovery + rustfmt — ✅ DONE (verified)

- **Problem:** stale `target/` absolute paths (to old `Yavin_2.0.0/…`) break the `yavin-ide` Tauri build script; `cargo fmt --check` fails at `src-tauri/src/registry_trust_tests.rs:1081` (from the flatten's URL path-fix).
- **Root cause:** `target/` was physically moved during the repo flatten; its cached artifacts embed absolute paths to the old location (`os error 3`). The URL edit shortened a line past rustfmt's wrap point.
- **Changes so far:**
  - `cargo clean` (in `src-tauri/`) — removed the stale `target/` (build artifacts only; `target/` is gitignored, 0 tracked files). Exit 0.
  - `cargo fmt --all` — reformatted `src-tauri/src/registry_trust_tests.rs` (only file changed). `cargo fmt --all --check` → **exit 0** ✅.
- **Status:** full `cargo build --workspace` rebuild running (verifies the binary builds with a fresh cache). Test suite / clippy / Tauri build to follow.

---

## WS6 Part 3 — Native Rust DAP adapter (lldb-dap) + Cargo test-executable resolution — ✅ IMPLEMENTED + VERIFIED (resolution real; lldb attachment gated on install)

**Goal:** Rust debugging through `lldb-dap` — ordinary executables and individual Cargo tests — reusing the DAP architecture, process authorization, availability gates and the Debug Test contract.

**Environment:** `lldb-dap` is **not installed** (no `lldb-dap`/`lldb-vscode` on PATH), so **real Rust/LLDB attachment cannot be exercised** here — reported, not claimed. But **cargo is installed**, so the milestone's critical piece — native **Cargo test-executable resolution** — is **genuinely verified** against a real build.

**Rust adapter (`lldb`), stdio — no bridge.** Registered in the native allow-list (`dap.rs`: `program: "lldb-dap"`, stdio, no `node_entry`) and the renderer (`adapters.ts`: `adapterID: "lldb-dap"`, launch/attach args), kept in sync (the `include_str!` consistency test covers `lldb`). lldb-dap speaks DAP over **stdio**, so it runs on the shared process host via `ServerProcess::spawn` directly — no TCP bridge. Availability goes through the existing `dap_available_adapters` (resolves `lldb-dap` on PATH); here it is **absent**, so Cargo debugging is gated off with a precise "install LLVM (lldb-dap) or CodeLLDB" reason. The debuggee is named in the launch request, never on the adapter's command line, and never a renderer path.

**Cargo test-executable resolution (`test_runner.rs`) — the critical, verified piece.** `cargo_test_executable(package?)`:

- runs **`cargo test --no-run --message-format=json`** (optionally for one `is_cargo_ident`-validated package) through the existing `capture_classified` (bounded output, deadline, cancel, process-tree kill);
- **`parse_cargo_test_artifacts`** (a pure, unit-tested function) collects `compiler-artifact` messages with `profile.test == true` and a non-null `executable` — the **test** binaries — across targets and packages; ordinary (non-test) binaries are skipped, duplicate artifacts collapse, `package_name` handles new- and old-style `package_id`s;
- **a compilation failure returns structured compiler diagnostics and no executable** (kept distinct from test failures — the caller never starts a debugger on a build break);
- **every resolved executable is confined to the workspace** (`validate_path`); a path outside it is refused. Paths are read from build metadata, never guessed and never taken from the renderer.

**Cargo Debug Test launch (`debugRequest.ts`).** Cargo → `lldb`. `buildCargoDebugConfiguration(request, executable)` builds the lldb-dap launch with `program` = the **native-resolved** test executable (absolute, workspace-confined there) and `args` = `[<test node-id>, "--exact"]` — the selected test's full path as **one opaque argument**, so only that test runs, never the whole suite, never a shell string. `buildTestDebugConfiguration` deliberately **refuses** Cargo (its executable is native-only), so no wrong config can be fabricated. Cargo stays enabled only when lldb-dap is available (the Part 1 gate) — never marked supported merely because the adapter is registered.

**Security (reused):** adapter allow-list; native executable resolution (`lldb-dap`, `cargo`) — no renderer path; workspace trust before launch; path containment on every resolved executable; safe argv (the test filter is one opaque argument); process-tree termination + deadlines via `capture_classified`; no second process manager/session registry.

**Verification — all green (results in the Results log):**

- **Native — `cargo test --lib test_runner:: --test-threads=1` →** new resolution tests: `parse_cargo_artifacts_identifies_test_binaries_across_targets_and_packages`, `…collapses_duplicates_and_skips_artifacts_without_an_executable`, `…reports_a_compile_failure_as_diagnostics_not_a_test`, `…tolerates_noise_and_truncation_and_empty`, `package_name_parses_new_and_old_package_ids`, and **`real_cargo_test_executable_resolution_finds_the_compiled_test_binary`** — a **real** fixture crate built with `cargo test --no-run --message-format=json` (stable; cargo installed), whose compiled test binary is resolved, exists on disk, and is confined to the fixture's `target/`.
- **Native — `cargo test --lib test_runner:: → 43 passed, 0 failed`** (incl. the real cargo-exe resolution) and **`cargo test --lib dap:: → 9 passed`** (allow-list now includes `lldb`; the TCP bridge + availability tests from Part 2 still pass).
- **Frontend — `node --test` (testing + debug) → 135 passed, 0 failed** (debugRequest: Cargo → lldb capability + availability gating + the Cargo lldb launch config; the rest unchanged). `tsc --noEmit` exit 0.
- `cargo fmt --all --check` exit 0; `cargo clippy --lib -p yavin-ide -p ide-workspace --all-features -- -D warnings` **exit 0** (one `collapsible_match` fixed); `prettier --check` clean; **Playwright panel → 2 passed**.

**Real vs. simulated:** **real Cargo test-executable resolution** is verified end-to-end (a genuine build, a real binary on disk, containment checked). **Real LLDB/DAP attachment to a running Rust process is NOT exercised** (lldb-dap not installed, no download) — stated plainly, not claimed. The adapter is stdio-ready and registered; once lldb-dap is installed, availability turns Cargo Debug Test on and the resolved executable is launched through the existing session manager.

**LLDB resolution & provenance (never auto-installed):** `lldb-dap` resolved on PATH (shipped with LLVM; CodeLLDB is an alternative). Reported unavailable with that install guidance when absent; trust gates the launch.

**Files changed:** `src-tauri/src/dap.rs` (`lldb` adapter + allow-list test), `src-tauri/src/test_runner.rs` (`parse_cargo_test_artifacts` + `cargo_test_executable` + tests), `src-tauri/src/lib.rs` (command registration), `src/services/debug/adapters.ts` (`lldb` definition), `src/services/testing/debugRequest.ts` (+test; Cargo→lldb + `buildCargoDebugConfiguration`), `src/services/native.ts` (`cargo_test_executable` type). No change to the DebugService core, breakpoint manager, protected files, or C1/C2.

**Known limitations / next:** (1) **real LLDB attachment unverified** (not installed); (2) the full frontend Cargo-debug flow (native `cargo_test_executable` → `buildCargoDebugConfiguration` → launch) is implemented in pieces and gated off — it is exercised once lldb-dap is installed; (3) a non-default `CARGO_TARGET_DIR` outside the workspace would make executables fail containment (a documented follow-up). **Next independent capability:** real-environment debugger verification (install js-debug / lldb-dap / Python) to turn the gated paths on, or a new IDE capability — not another audit.

---

## WS6 Part 2 — Native DAP TCP transport + js-debug bridge — ✅ IMPLEMENTED + VERIFIED (transport exercised for real via a node DAP server)

**Goal:** the native infrastructure to run JavaScript/TypeScript debugging through js-debug, which speaks DAP over **TCP** while Yavin's host speaks **stdio** — the exact blocker Part 1 identified. Done without a second DAP client or session manager, and without downloading js-debug.

**Transport abstraction — reuse, not a second client.** `ServerProcess::run` (`ide-workspace/src/lsp_process.rs`) was already generic over its I/O streams (`impl Read`/`impl Write`) and owns the framing, the reader thread, request/response ordering, size limits (`FrameReader`: `MAX_MESSAGE` 64 MB / `MAX_HEADER` 8 KB), EOF/disconnect handling and the one-time exit report. So the only new primitive is **`ServerProcess::from_tcp(child, stream, events)`**: it drives that same machinery from a **TCP socket** instead of child stdio — the socket's two halves are the framed read/write, the child's own stdout/stderr become logs, and the child stays owned for process-tree cleanup (the Windows Job Object). No framing, sequencing, session ownership or lifecycle logic is duplicated.

**js-debug TCP bridge (`src-tauri/src/dap.rs`).** Native-owned, loopback-only:

- `ephemeral_loopback_port()` binds `127.0.0.1:0`, reads the OS-chosen port, releases it — an **ephemeral** port; the renderer never supplies a port or address.
- `start_tcp_node_adapter()` starts `node <dapDebugServer.js> <port> 127.0.0.1` in the servers' Job Object, then `connect_loopback()` connects to `127.0.0.1:<port>` with a 15 s deadline and retry; on a failed connect the child is `kill_tree`-d so nothing is left running. **Loopback only, bounded, no external exposure, not a general-purpose proxy.** Success bridges the socket into `ServerProcess::from_tcp`.
- `dap_start` branches on the adapter's transport (`node_entry`): a TCP adapter goes through the bridge, a stdio adapter (debugpy) through `ServerProcess::spawn` — the result is one `ServerProcess` the session owns identically.

**Adapter registration + availability (the complete launch path).** The native allow-list gains **`node`** (`program: "node"`, `node_entry: node_modules/@vscode/js-debug/src/dapDebugServer.js`), kept in sync with the renderer (`adapters.ts`; the `include_str!` consistency test covers it). `dap_available_adapters` now reports an adapter only when its **whole** path resolves — for `node`, the `node` binary **and** js-debug's server entry installed in the workspace; a bare `node` without js-debug is **not** enough. So JavaScript debugging is available only once js-debug is actually installed, and the renderer's availability gate (WS6 Part 1) turns the frameworks on exactly then.

**Security:** loopback-only ephemeral ports; no renderer-supplied endpoint or adapter path; workspace trust still enforced before any adapter starts (`require_trust` in `dap_start`); process-tree cleanup via the Job Object + `from_tcp`'s socket/child ownership; message-size limits unchanged (reused `FrameReader`). Not a general TCP proxy — the bridge only connects the one adapter it just started on a port it chose.

**js-debug resolution & provenance (documented, never auto-installed):** the server entry is resolved **workspace-local** at `node_modules/@vscode/js-debug/src/dapDebugServer.js`; install via `npm install -D @vscode/js-debug` (Microsoft, npm). The entry's presence is required for availability; a path is not trusted merely because it exists (workspace trust gates the launch). Automatic download/execution of adapter binaries is never done.

**Verification — all green:**

- **Native — `cargo test --lib dap:: -- --test-threads=1` → 9 passed, 0 failed.** The headline: **`the_tcp_bridge_carries_a_real_dap_exchange_with_a_node_server`** — a tiny **real Node TCP DAP server** (written as a local fixture, the same transport shape as js-debug, nothing downloaded) is started by the **real bridge** (ephemeral port → child launch → connect → `from_tcp`), exchanges framed `initialize`/response over the socket, and is cleanly stopped. Plus `adapter_availability_reflects_the_whole_launch_path_not_just_the_binary` (node present but js-debug entry absent → unavailable; entry installed → available), `connect_loopback_times_out_on_a_port_nothing_listens_on` (invalid endpoint), and `only_a_listed_adapter_can_be_started` (allow-list + native↔renderer consistency with the new `node`).
- **Native regression — `cargo test -p ide-workspace lsp_process::` → 10 passed** (the stdio transport is unaffected by the `from_tcp` addition); **`cargo test --lib test_runner::` → 37 passed**; `cargo fmt --all --check` exit 0; `cargo clippy --lib -p yavin-ide -p ide-workspace --all-features -- -D warnings` → **exit 0**.
- **Frontend — unchanged (Part 1 gating already consumes the probe): `node --test` debugRequest + platform → 26 passed; `tsc` exit 0; Playwright panel → 2 passed.**

**Real vs. simulated:** the **TCP transport bridge is exercised for real** — against a genuine Node DAP server over a genuine loopback socket, end to end (connect, framed exchange, cleanup). What remains **simulated/unexercised** is a **real js-debug attachment to a real Node debuggee** (js-debug is not installed; no download allowed) — stated plainly, not claimed. The stand-in proves the transport; js-debug itself speaks the same DAP-over-TCP, so once installed the same bridge carries it.

**Files changed:** `src-tauri/crates/ide-workspace/src/lsp_process.rs` (`ServerProcess::from_tcp` + `TcpStream` import), `src-tauri/src/dap.rs` (`node` adapter + bridge + availability + tests). No change to the renderer (Part 1 already registers `node` and gates on the probe), the DebugService core, breakpoint manager, protected files, or C1/C2.

**Known limitations / next:** (1) **real js-debug attachment is unverified** (not installed; no download) — the transport is proven, the adapter integration awaits an install; (2) js-debug’s server entry path is the standard workspace-local one — a global/other install location is a follow-up; (3) **Rust DAP (lldb-dap + Cargo test-executable resolution)** is the next independent slice (lldb-dap speaks stdio, so it needs no bridge — it fits `ServerProcess::spawn` directly), to be done separately per the spec.

---

## WS6 — Multi-language Debugging Platform — ◧ PART 1 (JavaScript/TypeScript architecture + availability gating) IMPLEMENTED + VERIFIED

**Goal:** extend the DAP subsystem beyond debugpy to JavaScript/TypeScript (and Jest/Vitest/Playwright tests) and Rust (Cargo tests), as a unified experience. Done **incrementally**: Part 1 = the adapter architecture + availability gating + JavaScript routing (this entry); Part 2 = Rust (lldb-dap + Cargo test-executable resolution).

**Decisive environment findings (traced first):** **no debug adapter is installed** — no `@vscode/js-debug` (JavaScript), no `lldb-dap`/`codelldb`/`gdb` (Rust), and no real Python/debugpy. Downloads of unverified adapter binaries are forbidden. So **no real JS/Rust/Python attachment can be exercised here** — reported honestly, not faked. A second architectural finding shaped the design: **Yavin's DAP host is stdio-based** (debugpy and lldb-dap speak DAP over stdio and fit it directly), but **js-debug speaks DAP over a TCP socket** — so JavaScript debugging additionally needs a stdio↔TCP bridge, a tracked follow-up. JavaScript debugging is therefore reported unavailable even where `node` is present, which is correct.

**Availability gating — the core WS6 mechanism (honors "do not enable a framework simply because its adapter is registered"):** two distinct gates now exist. **Registration** = Yavin knows an adapter's protocol (the capability). **Availability** = the adapter's binary actually resolves on this machine, from a new native probe. A framework is enabled only when both hold; a registered-but-not-installed adapter is reported unsupported **with how to install it**.

- `src-tauri/src/dap.rs` — new `dap_available_adapters(root)` command: for each allow-listed adapter, reports it available only when its program resolves (a Python interpreter for debugpy; the program on PATH/workspace-local otherwise). Registered in `lib.rs`. Here it returns `[]` (no Python, nothing installed), so every framework is honestly gated off.
- `src/services/testing/debugRequest.ts` — `testDebugSupport(adapterId, available?)` is now availability-aware: with the probe's set it returns unsupported + install hint when the mapped adapter is registered but absent; without it, the pure capability (for unit tests). Single source of truth, unchanged for callers that pass nothing.
- `platform.ts` / `useTestingPlatform.ts` — the debug dependency carries `availableAdapters` (fetched from the native probe); `debugSupport()` and `debugNode()` gate on it; the UI's Debug button reflects the gated result.

**JavaScript/TypeScript adapter (`src/services/debug/adapters.ts`):** registered the **`node`** adapter definition (js-debug / `pwa-node`): launch args with `sourceMaps: true` (breakpoints bind in original TypeScript), `skipFiles: ["<node_internals>/**"]` (stepping stays in user code), `console: "internalConsole"`, and attach args. Install/provenance: `npm install -D @vscode/js-debug`. It is **renderer-registered for routing/capability but intentionally not in the native stdio allow-list yet** (the TCP-bridge follow-up), so the probe never reports it available — JS debugging stays honestly unsupported.

**Debug Test routing + launch configs (`debugRequest.ts`):** Jest/Vitest/Playwright → `node`; pytest → `debugpy` (WS5.5); Cargo → `lldb` (not registered until Part 2). `buildTestDebugConfiguration` builds a **node-backed** launch per runner — Jest `node_modules/jest/bin/jest.js --runInBand <file> -t <name>`, Vitest `node_modules/vitest/vitest.mjs run <file> -t <name>`, Playwright `node_modules/@playwright/test/cli.js test <file> -g <title> --workers=1 [--project <p>]` — each launching only the selected test, the file confined to the workspace by the DebugService, the test name/title/project as **opaque arguments**, never a shell string. (These run only when js-debug + the bridge land; they are gated off here.)

**Security boundaries (unchanged, extended):** the renderer selects an allow-listed adapter id; it never supplies an executable path, adapter path, shell command, or unrestricted env. Native code owns adapter resolution (the existing `program_for` + the new probe), workspace trust is enforced before any adapter starts, and the Job-Object process-tree cleanup / stdio framing are reused. No second process manager; no silent downloads.

**Source maps / ResourceUri:** the `node` adapter sets `sourceMaps: true` and the DebugService already normalizes a stack frame's `source.path` to the canonical `ResourceId` (`frameView` → `resourceId(fileUri(path))`), so TypeScript original-source navigation and breakpoint rebinding reuse the one identity rule — no per-adapter path logic added.

**Verification — all green:**

- **Frontend — `node --test` (testing + debug + panel) → 141 passed, 0 failed.** New/updated: `debugRequest.test.ts` (11 — capability mapping, **availability gating** both ways, node launch configs with opaque args, unsupported-throws), `platform.test.ts` (availability-gated debug: unsupported when the adapter is not installed, supported+launched when it is), `debugIntegration.test.ts` unchanged-green. `tsc --noEmit` exit 0; `prettier --check` clean.
- **Native — `cargo test --lib dap:: -- --test-threads=1` → 6 passed** (incl. `only_a_listed_adapter_can_be_started`: the native↔renderer allow-list stays consistent with the new `node` renderer entry; the real-debugpy test **skipped**, no usable Python). **`cargo test --lib test_runner:: → 37 passed.`** `cargo fmt --all --check` exit 0; `cargo clippy --lib --all-features -- -D warnings` **exit 0**.
- **Playwright UI panel tests → 2 passed** (`terminal.spec.ts`, 5.9 s).

**Real vs. simulated:** **no real debugger attachment was exercised** (no JS/Rust adapter, no usable Python) — stated plainly, not claimed. The architecture, routing, availability gating and launch configs are verified by **unit tests + fake adapters**; the real debugpy path is covered by the existing `realAdapter.test.ts`/`dap.rs` tests (which skip here). The availability probe is a real end-to-end mechanism (it genuinely returns `[]` here).

**Installation & provenance (documented, never auto-installed):** JavaScript → `@vscode/js-debug` (Microsoft, npm) **plus** a Yavin stdio↔TCP bridge (follow-up); Python → `debugpy` (`pip install debugpy`) + a Python interpreter; Rust (Part 2) → `lldb-dap` (LLVM) or CodeLLDB. None are downloaded; each is reported unavailable with its install command.

**Files changed:** edited `src/services/debug/adapters.ts` (node adapter), `src/services/testing/debugRequest.ts` (+test; routing + availability + node configs), `src/services/testing/platform.ts` (+test; availability gating), `src/services/testing/useTestingPlatform.ts` (probe fetch), `src/services/native.ts` (probe type), `src-tauri/src/dap.rs` (+`dap_available_adapters`), `src-tauri/src/lib.rs` (command registration). No change to the DebugService core, breakpoint manager, process authorization, protected files, or C1/C2.

**Known limitations / Part 2:** (1) **JavaScript debugging needs the stdio↔TCP bridge for js-debug** + js-debug installed — not wired here; (2) **Rust (`lldb` adapter + Cargo test-executable resolution via `cargo test --no-run --message-format=json`)** is Part 2 (cargo is installed, so that resolution is the next genuinely-verifiable piece); (3) no real attachment verified in this environment. **Next: WS6 Part 2 — Rust debugging**, then real-environment attachment verification.

---

## WS5.5 — Native pytest testing adapter — ✅ IMPLEMENTED + VERIFIED (parser/authorization real; pytest/debugpy execution gated on Python)

**Goal:** pytest as a first-class Testing Platform adapter — discovery, run all / file / individual node id, rerun failed, parameterized tests, module/class hierarchy — plus **real Debug Test through the existing debugpy adapter**, on the WS5.1 native execution authority and shared model. No second process manager.

**Environment reality:** **no Python is installed on this machine** (only the Windows Store alias), so — like Jest/Vitest — **real pytest execution and real debugpy attachment cannot be exercised here**; they are honestly skipped/reported. The parser, native authorization, Python/venv resolution, the result-file read path, and the debug config are fully built and verified by **fixtures and fake executors** (exactly the split the spec calls for).

**Dedicated parser (`pytestJson.ts`, new + 8 tests)** — for the `pytest-json-report` plugin's shape (`tests[]`, `collectors[]`, phases `setup`/`call`/`teardown`). Normalizes: the **node id** (`path::Class::test[param]`) into file + class ancestry + test name; **module/class hierarchy**; all statuses (passed / failed / **xfailed**→skipped / **xpassed**→passed / skipped / error→failed); **parameterized** identity (the `[param]` stays in the label and id); duration (phase sum); failure **traceback** (`longrepr`) and **crash location**; **stable ids** (file + node-id tail). **Collection/import errors kept distinct from test failures** — a failed `collectors[]` entry → `diagnostics` (+ `compiled=false` when nothing ran). A **clear dependency state**: output showing `unrecognized arguments: --json-report` throws a typed "install pytest-json-report" error, not a silent empty suite. Tolerant of noise, truncation, empty (typed `TestParseError`).

**Adapter (`adapters.ts` + 2 tests):** `pytestAdapter` detects `pytest.ini` / `conftest.py` / `tox.ini` / `setup.cfg` / `pyproject.toml`; its `command()` sends a minimal selector (`[]` / `["--file", f]` / `["--node", "<file>::<tail>"]`), reconstructing the **full node id** from the tree. `parse = parsePytestJson`.

**TreeProvider fix (correctness, benefits every adapter):** the tree now uses each case's **own stable id from its parser** instead of recomputing `caseId(file, label-joined-by-space)`. That recomputation silently corrupted identities whose real form isn't space-joined — **Cargo's `a::b::test`** and pytest node ids — so `runNode`/`rerunFailed` would have filtered by the wrong name. Jest/Vitest/Playwright ids are unchanged (they were already space-joined).

**Native (`test_runner.rs`): `Grammar::Pytest` + `authorize_pytest` + `resolve_python` + result-file reading.** The renderer sends only the selector; the native side rebuilds `python -m pytest --json-report --json-report-file <temp> -p no:cacheprovider [<file>|<node id>]`. A **file** is containment-validated; a **node id's path** (before the first `::`) is containment-validated and the rest (classes/test/`[param]`) is **one opaque token** with no control characters; anything else is rejected. **Python is resolved by trusted discovery** — a workspace `.venv`/`venv` first, then `python`/`python3`/`py` on PATH — never named by the renderer. pytest writes JSON to a **native temp file** (OS temp, not the workspace), which `execute` reads back and deletes; when it is absent (plugin missing / cancelled) the process's stderr surfaces instead. Reuses the whole WS5.1 lifecycle unchanged (`TestRuns` ids/ownership/concurrency/supersede/stale-protection, `capture_classified` bounded output + deadline + process-tree kill, shutdown hook).

**Real Debug Test through debugpy (§5).** pytest is the first framework that maps to Yavin's actual DAP adapter (debugpy). To launch it correctly the debug contract gained an optional **`module`** field (`config.ts` + `debugpy` launch args + validation: a launch needs a `program` **or** a `module`); the pytest debug config is `{ adapter: debugpy, module: "pytest", args: ["<file>::<node id>"] }` — pytest's own machinery runs the selected node id, the node id is **one opaque argument**, the interpreter is resolved by the native debugpy adapter (venv first), and breakpoints bind through the normal DAP flow. `testDebugSupport("pytest")` is **supported** (the capability — debugpy adapter + correct launch — genuinely exists), consistent with how Yavin treats all debugpy debugging (a missing Python/debugpy surfaces a clear runtime error).

> **Honest boundary on §5's "do not mark supported until real attachment is exercised":** real debugpy attachment to a real pytest process was **NOT exercised** here — no Python/debugpy on this machine. The capability is implemented and **verified against the fake DAP adapter** (a full launch→breakpoint→stop→step→cleanup session with the module launch + node id), and the existing `realAdapter.test.ts` covers real debugpy when available (it **skipped** here, reported). Real pytest+debugpy attachment is the one remaining verification, gated on a Python environment; it is not claimed to work.

**UI:** pytest flows through the existing Testing panel unchanged — class/module **hierarchy** (ancestors → tree suites), **parameterized** tests (the `[param]` label), **tracebacks** (failure detail pane), **collection/import errors** (the framework-neutral "tests could not run" panel from WS5.4), source navigation, and the **Debug Test** action (enabled for pytest). Detection message now mentions Python.

**Three-level verification — all green:**

- **Level A/B — `cargo test --lib test_runner:: --test-threads=1` → 37 passed, 0 failed.** New pytest tests: `authorize_pytest` accepts all/file/node and validates the path; **rejects unknown flags, a non-`::` node id, control characters, and a traversing path**; a metacharacter node id stays one argv element; `resolve_python` finds a workspace `.venv` first; **result-file reading** (a fixture writes the JSON file → it is read over stdout and deleted) and the **plugin-missing fallback** (no file → stderr surfaces) — both via fake-executor fixtures. All WS5.1–5.4 native tests still pass.
- **Level C — real pytest / real debugpy: SKIPPED (no Python).** Reported in the parser/authorization coverage note, not hidden. (Cargo's and Playwright's real Level C runs still pass from WS5.2/5.4.)
- **Frontend — `node --test` (testing + debug + panel + realAdapter) → 139 passed, 0 failed, 1 skipped** (the real-debugpy test, no Python). New: pytestJson 8, adapters +2, debugRequest updated for the module launch, platform/debugIntegration updated. `tsc --noEmit` exit 0; `prettier --check` clean.

**Verify (exact, sequential):**

- `cargo test --lib test_runner:: -- --test-threads=1` → **37 passed, 0 failed** (11.3 s).
- `cargo fmt --all --check` → exit 0; `cargo clippy --lib --all-features -- -D warnings` → **exit 0**.
- `node --test` testing+debug+panel+realAdapter → **139 passed, 0 failed, 1 skipped**; `tsc` exit 0; `prettier --check` clean.
- Playwright UI panel tests → **2 passed** (`terminal.spec.ts`, 5.4 s).

**Files changed:** new — `src/services/testing/pytestJson.ts` (+ `.test.ts`). Edited — `src/services/testing/{adapters,treeProvider,debugRequest,platform}.ts` and their tests, `src/services/testing/debugIntegration.test.ts`, `src/services/debug/{config,adapters}.ts` (the `module` launch field), `src/components/panel/views/TestingView.tsx` (detection message), `src-tauri/src/test_runner.rs`. No change to `dap.rs`, the DebugService core, `checkers.rs`, process/terminal/task/diagnostics infra, ResourceUri, protected files, or C1/C2.

**Python interpreter discovery:** workspace `.venv`/`venv` (Scripts/bin + python[.exe]) → `python`/`python3`/`py` on PATH. **JSON reporting strategy:** the standard `pytest-json-report` plugin, written to a native temp file and read back; a missing plugin is reported as a clear dependency state, never a silent empty suite. No dependency is installed or downloaded.

**Limitations / follow-ups:** (1) **no local Python** → real pytest execution and real debugpy attachment unverified here (reported, not claimed); (2) requires the user to have `pytest-json-report` installed — surfaced as a clear message otherwise; (3) a custom `pytest` rootdir/`testpaths` differing from the workspace root could affect node-id path resolution (a follow-up); (4) real pytest+debugpy attachment is the remaining §5 verification, gated on a Python environment.

**Next:** **WS6 — Multi-language Debugging** (adding JavaScript/Rust DAP adapters lights up Jest/Vitest/Cargo/Playwright debugging, and a real Python environment verifies pytest+debugpy attachment).

---

## WS5.4 — Native Playwright testing adapter — ✅ IMPLEMENTED + VERIFIED (real Playwright run exercised)

**Goal:** Playwright as a first-class Testing Platform adapter — discovery, run all / file / test, rerun failed, browser/project labels, retries & flaky — on the existing native execution authority (WS5.1) and shared model. No second process manager.

**Playwright is installed here** (`@playwright/test ^1.63.0` + `playwright.config.ts`), so **real Level C execution was exercised**, not simulated.

**Dedicated parser (`playwrightJson.ts`, new + 9 tests):** Playwright's official JSON reporter is a distinct shape (nested `suites[].suites[]` with the file as the outer suite; each `spec` runs once per **project/browser** in `tests[]`, each with per-retry `results[]`), so it has its own parser — not forced into the jest/vitest one. It normalizes: a case = one spec × one project; **suite hierarchy** → ancestors (the file-level suite dropped); status `expected`→passed / `unexpected`→failed / `flaky`→passed+flagged / `skipped`→skipped; the **final attempt's** duration; failure message/stack and **source location**; browser/**project** label; **stable ids** (file + full title + project, identical across runs). **Config/discovery errors are kept distinct from test failures** — top-level `errors[]` with nothing run → `diagnostics` + `compiled=false` (a setup failure, "not silently an empty suite"), while errors alongside real results stay as diagnostics without hiding the tests. Tolerant of banner noise, truncation, and empty output (typed `TestParseError`).

**Model:** `TestCase` gains optional `project` and `flaky`; `TestReport.compiled`/`diagnostics` doc generalized to "setup failure (compilation for Cargo, configuration/discovery for Playwright)". Backward compatible.

**Adapter (`adapters.ts` + 2 tests):** `playwrightAdapter` detects `playwright.config.*`; its `command()` emits a minimal selector encoding (`[]` / `["--file", f]` / `["--file", f, "-g", title, ("--project", name)?]`) — splitting the `[project]` suffix out of a case's full name into a `-g <title>` grep + `--project <name>` filter. `parse = parsePlaywrightJson`. The shared SECURITY test now also covers Playwright (a metacharacter title stays one argv element).

**Native (`test_runner.rs`): `Grammar::Playwright` + `authorize_playwright`.** The renderer sends only the minimal selector; the native side **rebuilds the real argv** `playwright test --reporter=json [<file>] [-g <title>] [--project <name>]`. The spec file is **containment-validated** (`validate_path`); the grep title is **one opaque argv element**; the project name is validated by `is_playwright_project` (bounded, no control chars, not a flag — but may contain spaces like "Mobile Chrome") and passed as one opaque argument. Unknown flags, extra args, env, config paths and executables are rejected. `playwright` is resolved from the project's own `node_modules/.bin` (`node_package:true`) — never a renderer path. Reuses the whole WS5.1 lifecycle unchanged (`TestRuns` ids/ownership/concurrency/supersede/stale-protection, `capture_classified` bounded output + deadline + process-tree kill, shutdown hook).

**Discovery states** are distinguished, not collapsed into "empty suite": Playwright **not installed** → native `resolve_program` fails → clear "No playwright runner found" error; **config/discovery error** → `compiled=false` + diagnostics (shown as "The tests could not run — N errors"); **zero tests with no error** → an honest empty report.

**UI (`TestingView.tsx`, `treeProvider.ts`):** the project/browser shows in each case label (`title [chromium]`); a **flaky** badge marks tests that passed only on retry; the setup-error panel wording is now framework-neutral ("The tests could not run — N errors (compilation or configuration)"). Run All / file / test, Stop, Rerun Failed, and failure navigation are unchanged for all adapters.

**Browser-debugging boundary (§7):** Playwright runs its tests in a **Node.js worker (JavaScript)**, so it needs the same JavaScript DAP adapter Yavin does not have — `testDebugSupport("playwright")` returns **unsupported** with a precise reason, and Debug Test stays disabled. No improvised debugger; process authorization untouched. (Debugging the browser itself is a separate, out-of-scope concern.)

**Three-level verification — all green:**

- **Level A/B — `cargo test --lib test_runner:: --test-threads=1` → 31 passed, 0 failed.** New Playwright tests: `authorize_playwright` builds the JSON run for all/file/grep/project; **validates the file (rejects `../../etc/passwd`), rejects `--headed`/extra args/a flag-shaped or empty project**; a metacharacter grep stays one argv element; `is_playwright_project` rules (spaces allowed, flags/control-chars refused). All WS5.1/5.2 native tests still pass.
- **Level C — real Playwright: RAN (not skipped).** `level_c_real_playwright_runs_a_fixture_project_when_installed` wrote a dependency-free fixture (a `playwright.config.ts` with one browserless `node` project and a spec with a passing and a failing test — no `page` fixture, so **no browser is launched or downloaded**), resolved the repo's own `playwright` binary, ran the **real authorized argv**, and asserted genuine reporter JSON: `LEVEL C (playwright): ran a real Playwright project and got reporter JSON.` (0.82 s).
- **Frontend — `node --test` (testing + debug + panel) → 130 passed, 0 failed** (playwrightJson 9, adapters 8, treeProvider +1 flaky, debugRequest +1 playwright-unsupported, + the rest). `tsc --noEmit` exit 0; `prettier --check` clean.

**Verify (exact, sequential):**

- `cargo fmt --all --check` → exit 0.
- `cargo test --lib test_runner:: -- --test-threads=1` → **31 passed, 0 failed** (2.71 s).
- `cargo test --lib test_runner::real_tests::level_c_real_playwright -- --nocapture` → **1 passed**, printed the real-run confirmation (0.82 s).
- `cargo clippy --lib --all-features -- -D warnings` → **exit 0 (no warnings)**, 49 s.
- `node --test` testing+debug+panel → 130 passed; `tsc` exit 0; `prettier --check` clean.
- Playwright UI panel tests (TestingView changed) → **2 passed** (`terminal.spec.ts`, 7.5 s).

**Files changed:** new — `src/services/testing/playwrightJson.ts` (+ `.test.ts`). Edited — `src/services/testing/{model,adapters,treeProvider}.ts` and their tests, `src/services/testing/debugRequest.ts` (+test, playwright unsupported), `src/components/panel/views/TestingView.tsx`, `src-tauri/src/test_runner.rs`. No change to `checkers.rs`, `dap.rs`, process/terminal/task/diagnostics infra, ResourceId, protected files, or C1/C2.

**Real vs. simulated:** the parser and authorization are verified by fixtures (deterministic); **native Playwright execution is real** (a genuine `playwright test` run parsed end-to-end). Jest/Vitest real execution remains unavailable (not installed); Cargo real execution is real (WS5.2).

**Limitations / follow-ups:** (1) Playwright's JSON `file` is relative to the config's `rootDir`; a custom `rootDir` that differs from the workspace root could mis-resolve the positional file filter — a monorepo follow-up; (2) per-project tree grouping is by file, not by project (projects distinguish cases via label/id); (3) Playwright test **debugging** awaits a JavaScript DAP adapter (WS6), honestly gated now.

**Next:** **WS5.5 — pytest integration** (which also turns Debug Test real via debugpy), then **WS6 — Multi-language Debugging**.

---

## WS5.3 — Debug Test integration through DAP — ✅ IMPLEMENTED + VERIFIED (mechanism proven; frameworks honestly gated)

**Goal:** let a developer select one test and debug it through Yavin's existing DAP subsystem, reusing the DebugService/session manager — no second debugger, process manager or session registry.

**Decisive architectural finding (traced first):** Yavin ships **exactly one DAP adapter — `debugpy` (Python)**. Both the renderer allow-list (`src/services/debug/adapters.ts`) and the native allow-list (`src-tauri/src/dap.rs`, which even `include_str!`s the renderer file to stay in lock-step) contain only `debugpy`. Therefore **none of the current test frameworks can be debugged**: Jest/Vitest are JavaScript (need a JS debug adapter Yavin doesn't have) and Cargo is Rust (needs a native/LLDB adapter Yavin doesn't have). Per the brief, these are reported **unsupported with a precise reason — never faked**. The mechanism lights up for Python (pytest, WS5.5) the moment that test adapter exists, and for JS/Rust when such a DAP adapter is added. **No new Rust was written** — WS5.3 reuses `dap.rs` and the DebugService unchanged except for one additive seam.

**Integration seam (frontend):**

- **`debugRequest.ts` (new, +9 tests)** — the typed Debug Test contract and authorization. `TestDebugRequest` carries only identity (adapter id, stable case id, workspace, file, full name, line). `testDebugSupport(adapterId)` is the single source of truth: it maps each framework to its intended DAP adapter and returns `supported:false` with a reason when that adapter is not in `DEBUG_ADAPTERS` (vitest/jest → "JavaScript debug adapter … Yavin does not have"; cargo → "native (LLDB) …"; pytest → debugpy, supported). `authorizeTestDebug` **rejects a workspace mismatch, an unsupported framework, a stale/unknown case id, and an empty selector** — renderer-supplied metadata is never trusted as authorization. `buildTestDebugConfiguration` produces a `ResolvedDebugConfiguration` whose `adapter` is an **allow-listed** DAP id (never a renderer path), whose `program` is the test's own file (the DebugService confines it to the workspace at launch), and whose test name is **one opaque argv element**, never a shell string.
- **`DebugService.start`** — one additive change: `start(config?: string | ResolvedDebugConfiguration)`. A string/undefined resolves from the configured list (unchanged); an **object launches that ad-hoc configuration** (not persisted) through the entire existing lifecycle — trust gate, adapter resolution, path containment, breakpoints, `configurationDone`, events, cleanup. Backward compatible (all 29 existing debug tests pass unchanged).
- **`platform.ts`** — `canDebugNode(node)` and `debugNode(node)`: authorize against the **current** results (`allCaseIds` from the live tree, so a stale id is caught), build the config, hand it to an injected `TestDebugDependency.start`. View-state gains `debug: TestDebugSupport` so the UI can gate the action. Absent debugger ⇒ reported "Debugging is not available in this window."
- **`useTestingPlatform.ts` / `TerminalPanel.tsx`** — the hook wires the DAP seam to the workspace `DebugService.start`; the view's `onDebugStarted` focuses the Debug panel (`setActiveTab("debug")`).
- **`TestingView.tsx`** — a **Debug** (🐞) action on each test-case row: enabled only when the framework is supported, otherwise **disabled with the reason as its tooltip** (honest, not hidden). A launch error shows in a dismissible banner. Run/Stop/Rerun Failed and the pass/fail counts are unchanged; starting a debug session never marks a test passed or failed.

**Supported / unsupported (today):**

- **Jest / Vitest — unsupported:** no JavaScript debug adapter in Yavin. Reason shown; Debug button disabled.
- **Cargo — unsupported:** no native (LLDB) debug adapter in Yavin. Reason shown; Debug button disabled.
- **Python (pytest, WS5.5) — supported design:** debugs through debugpy; `testDebugSupport("pytest")` already returns supported, so the adapter lights up with no further debug work.

**Security boundaries:** the renderer controls only _which allow-listed test it selects_; it cannot choose an executable path, a DAP adapter path, arbitrary args, env, or shell. The DAP adapter program comes from `dap.rs`'s allow-list, the launch `program` is confined to the workspace by `DebugService.resolvedPaths`, the test name is a single opaque argument, trust is checked before anything starts, and a stale/forged id or workspace mismatch is rejected.

**Verification — all green:**

- **`node --test` (testing + debug + panel): 118 passed, 0 failed.** New: `debugRequest.test.ts` (9 — support mapping, authorization rejections, allow-listed adapter, one-arg injection, no-fabrication), `debugIntegration.test.ts` (5 — a Debug Test config drives a **real session through the fake DAP adapter**: launch with the test name as a structured arg, breakpoint binds and stops on its line, step, independent services don't interfere, untrusted refused, forged adapter rejected), `platform.test.ts` (+5 debug — unsupported JS reason, no-debugger reason, supported launch builds the right config, stale-id rejected, non-case refused). The existing 29 DebugService tests pass unchanged.
- **`tsc --noEmit` → exit 0; `prettier --check` → clean** (all touched files).
- **No Rust changed** (git confirms only WS5.1/5.2 Rust files are modified); `cargo fmt --all --check` → exit 0. The native test/clippy suites are unaffected and remain green from WS5.2 (not re-run, since no Rust changed).
- **Playwright (panel tabs): 2 passed.** WS5's new "TEST RESULTS" tab had broken two assertions in `tests/ui/terminal.spec.ts` (an exact tab-list and the per-view loop) that WS5 never ran — and, more seriously, the first Playwright run of the tab surfaced a **real WS5 defect**: opening the Test Results view threw "Maximum update depth exceeded" (an infinite React loop) because `platform.getViewState()` returned a fresh object on every call and `useSyncExternalStore` requires a reference-stable snapshot. **Fixed** by caching the view-state in the platform and invalidating it on change (plus a regression test, `platform.test.ts`: "getViewState returns a stable reference until something changes"). After the fix both panel tests pass (5.4 s).

**Real debugger attachment:** **not exercised for the current frameworks** — no JS/Rust adapter exists to attach to a Jest/Vitest/Cargo test process, and no Python test runner exists yet to attach debugpy to. This is stated plainly, not claimed. The integration **mechanism** is proven end-to-end against the fake DAP adapter (a full launch→breakpoint→stop→step→cleanup session), and the real debugpy path is already covered by the existing `realAdapter.test.ts`. Real attachment to a test process becomes exercisable with the pytest adapter (WS5.5).

**Files changed:** new — `src/services/testing/debugRequest.ts` (+ `.test.ts`), `src/services/testing/debugIntegration.test.ts`. Edited — `src/services/debug/service.ts` (ad-hoc `start`), `src/services/testing/platform.ts` (+ test), `src/services/testing/useTestingPlatform.ts`, `src/components/panel/views/TestingView.tsx`, `src/components/layout/TerminalPanel.tsx`, `tests/ui/terminal.spec.ts` (tab assertions). No change to `dap.rs`, the DAP adapters, native process authorization, ResourceUri, or protected files. C1/C2 untouched; registry empty; E6 not begun.

**Limitations / follow-ups:** (1) no debuggable framework ships today (debugpy-only) — the honest gate above; (2) the precise per-runner debug invocation (pytest module mode, a JS adapter's test-file launch) is finalized with each runner's adapter; (3) adding a JavaScript (`js-debug`) or Rust (`lldb`) DAP adapter — a native allow-list + protocol addition — is what unlocks Jest/Vitest/Cargo debugging.

**Next workstream:** **WS5.4 — Playwright testing integration** (adapter + JSON reporter parser, reusing the WS5.1 native execution authority), then **WS5.5 — pytest** (which also turns Debug Test real via debugpy), then **WS6 — Multi-language Debugging** (where adding JS/Rust DAP adapters lights up the rest of Debug Test).

---

## WS5.2 — Native Cargo test adapter — ✅ IMPLEMENTED + VERIFIED (real nightly Cargo run exercised)

**Goal:** Cargo as a first-class Testing Platform adapter — discover, run, cancel, parse, display, rerun Rust tests — on the existing native execution authority and shared result model, with its own parser. No second process manager.

**The hard part — two interleaved JSON protocols.** Unlike Jest/Vitest (one `--json` schema), Cargo emits **Cargo build messages** (`--message-format json`: `compiler-message` / `compiler-artifact` / `build-finished`) **interleaved** with **libtest events** (`-- -Z unstable-options --format json`: `{type:"test", event:"ok"|"failed"|"ignored", name, exec_time, stdout}`). libtest JSON is **nightly-only**.

**Model (`model.ts`):** added `TestReport.diagnostics` (compiler errors, **kept separate** from test cases) and `TestReport.compiled` (false ⇒ build failed, no tests ran). Optional, so Jest/Vitest are unaffected.

**Parser (`cargoJson.ts`, new + 9 tests):** one line = one JSON object; tolerant of non-JSON noise (`Compiling …`, a `-Z` warning), blanks, and a truncated final line. Build messages → `diagnostics` + `compiled`; a `level:"error"` or `build-finished success:false` ⇒ `compiled=false`. libtest events → `TestCase`s grouped by top module, failure **source location recovered from the panic line** (`panicked at src/math.rs:42:9`), `exec_time` → ms, `ignored` → skipped. **A compilation failure is never a test failure** (distinct state). Covered: pass/fail/ignored, interleaved compiler messages, compile-fail vs assertion-fail, warnings-without-fail, malformed/truncated/empty, no-module-path.

**Adapter (`adapters.ts` + 2 tests):** `cargoAdapter` detects `Cargo.toml`; its `command()` emits a **minimal selector encoding** (`[]` / `["--filter", mod]` / `["--exact", fullName]`), not a cargo command line — the native side rebuilds the real argv. `parse = parseCargoJson`. The existing SECURITY test now also covers cargo (a shell-metacharacter name stays one argv element).

**Controller (`controller.ts` + 1 test):** a run is `failed` when `summary.failed > 0` **or `compiled === false`** — a build break is a failed run, distinct from test failures and not "done".

**Native (`test_runner.rs`):** added a `Grammar` discriminant and the `cargo` adapter (`node_package:false`, `grammar:Cargo`). `run_test` branches: Node → `authorize_args` (unchanged); **Cargo → `authorize_cargo`**, which rebuilds the real argv natively: `cargo test (--workspace | -p <pkg>) --no-fail-fast --message-format json [<filter>] -- -Z unstable-options --format json --report-time [--exact]`. A `-p` package is validated with `is_cargo_ident` (letters/digits/`_`/`-`, letter|digit|`_` lead) — **rejecting `..`, path separators, shell metacharacters, spaces**; cargo enforces actual membership. The filter / exact test name is **opaque** (one argv element, never shell-parsed); **no file path is ever accepted**, so Cargo has no path-traversal surface. `cargo` is resolved on PATH (`node_package:false`), never a renderer path. Reuses the whole WS5.1 lifecycle unchanged: `TestRuns` ids/ownership/concurrency/supersede/stale-protection, `capture_classified` (bounded output, deadline, process-tree kill), shutdown hook. (The missing-runner message was generalized from the npm-specific wording to cover Cargo.)

**Frontend UI (`TestingView.tsx`, `platform.ts`):** view-state now carries `diagnostics` + `compiled`. A **compilation failure is shown distinctly** — a red "Compilation failed" status and a compiler-errors panel (click a diagnostic to open its source), **no test tree**, never conflated with assertion failures. Skipped count labelled "ignored" for Cargo's idiom. Detection message mentions Cargo. Jest/Vitest behaviour unchanged.

**Three-level verification — all green:**

- **Level A/B — `cargo test --lib test_runner:: --test-threads=1` → 26 passed, 0 failed.** New Cargo tests: `authorize_cargo` builds the nightly JSON run for all/filter/exact; accepts a validated package and **rejects `../evil`, `a/b`, `a;b`, `a b`, `a&b`, `..`**; rejects unknown tokens / bare flags / trailing junk / **raw `-- -Z` passthrough**; a shell-metacharacter filter stays one argv element; `is_cargo_ident` rules. All WS5.1 tests still pass.
- **Level C — real Cargo: RAN (not skipped).** A nightly toolchain is present here, so the gated test wrote a dependency-free fixture crate (one pass, one fail, one `#[ignore]`, with an empty `[workspace]` table so it builds standalone under `target/`), ran it through the **real authorized argv** (`cargo +nightly` + `authorize_cargo(&[])`), and asserted genuine **libtest JSON** came back: `LEVEL C (cargo): ran a real nightly Cargo test and got libtest JSON.` (Level C for Vitest/Jest remains skipped — neither installed, no network install.)
- **Frontend — `node --test src/services/testing/*.test.ts` + `views.test.ts` → 70 passed, 0 failed** (cargoJson 9, adapters 7, controller 11, platform 9, + the rest).

**Verify (exact, run sequentially):**

- `cargo fmt --all --check` → exit 0.
- `cargo test --lib test_runner:: -- --test-threads=1` → **26 passed, 0 failed** (1.87 s warm; ~54 s cold with the fixture compile).
- `cargo test --lib test_runner::real_tests::level_c_real_cargo -- --nocapture` → **1 passed**, printed the real-run confirmation.
- `cargo clippy --lib --all-features -- -D warnings` → **exit 0**.
- `tsc --noEmit` → exit 0; `prettier --check` (all touched) → clean.

**Files changed:** new — `src/services/testing/cargoJson.ts` (+ `.test.ts`). Edited — `src/services/testing/{model,adapters,controller,platform}.ts` and their tests, `src/components/panel/views/TestingView.tsx`, `src-tauri/src/test_runner.rs`. No change to `checkers.rs`, process/terminal/task/diagnostics infra, ResourceId, WorkspaceManager, protected files, or C1/C2.

**Limitations (honest):** (1) **libtest JSON is nightly-only** — on a stable-only toolchain a Cargo run surfaces Cargo's `-Z` rejection as a clear run error rather than results; documented, and the nightly path is really exercised here. (2) libtest events don't carry the package, so tests group by top module, not by crate; package selection is a native capability (`-p`, validated) not yet surfaced in the tree UI. (3) Package membership is enforced by Cargo at run time (the identifier grammar is the injection gate), not pre-validated against `cargo metadata`.

**Next independent missing capability:** **test debugging via the existing DAP subsystem** — the `dap_start` native seam already exists (used by IDE-05); wiring "Debug test" from the Test Explorer through it is the next slice, leading into WS6 Multi-language Debugging. (Playwright and pytest adapters are smaller follow-ons that reuse this exact shape.)

---

## WS5.1 — Native test execution & process authorization — ✅ IMPLEMENTED + VERIFIED (native vertical slice closed)

**Goal:** implement the `run_test` / `cancel_test` native handlers that WS5 left as the one boundary, on the **existing `run_checker` security architecture** — no second process-execution system.

**Inspection first (traced the whole `run_checker` path before writing anything):** `checkers.rs` (allow-list of fixed-argv checkers, trust gate, `resolve_program`, `capture_classified`, single-flag cancel with `Arc::ptr_eq` cleanup) → `ide-workspace::process::capture_classified` (bounded 16 MB stdout / 64 KB stderr, deadline, cancel flag, **process-tree kill** via `taskkill /T`, a pure `stop_reason`/`outcome` classification proven race-free) → `lsp_process::resolve_program` (`node_modules/.bin` first when `node_package`, then **absolute** PATH only; never a renderer-named path) → `WorkspaceManager::validate_path` (lexical `..` normalization + symlink-escape canonicalization + root-containment) → `with_workspace` / `require_trust` → command registration + shutdown hook in `lib.rs`.

**Security decision — the renderer can no longer name a binary.** The WS5 wire was `run_test { program, args }`, which would let the renderer choose an executable. Changed to **`run_test { adapter, args }`**: the renderer names an **adapter id** only; the native side owns authorization end-to-end.

**Native implementation (`src-tauri/src/test_runner.rs`, new):**

- **Allow-list** `ADAPTERS` (vitest/jest → program + fixed base flags). `find_adapter(id)` is the only way to a program; an unknown/`"vitest; rm -rf /"`/`"../../../bin/sh"` id resolves to nothing.
- **`authorize_args`** re-parses the renderer argv against the adapter grammar and **rebuilds it natively**. Accepts exactly `base`, `base <file>`, or `base -t <fullName> <file>`; rejects an altered base, any unknown flag, and extra arguments. The test name is **opaque** — copied through as exactly one argv element, never inspected or split. A file selector is run through `validate_path` for **workspace containment** (so `../../../etc/passwd` and `/etc/passwd` are refused).
- **Program resolution** via `resolve_program(program, node_package=true, root, PATH)` — the project's own `node_modules/.bin` first; a path the renderer sends is never used, so it cannot pick a binary even by naming one.
- **Execution** through the existing `capture_classified` (bounded output, `TEST_TIMEOUT` = 10 min deadline, cancel flag, process-tree kill). stdout (where both runners emit JSON) is returned; stderr is the fallback only when stdout is empty, so a bad config still surfaces.
- **`TestRuns` registry** (native-generated ids, per-run cancel flag, **owning workspace root**): `register` bounds concurrency (`MAX_CONCURRENT_RUNS = 8`) and supersedes any run the same workspace already has going; `deregister` removes a run **by its own id** (so a late-finishing superseded run cannot evict the newer run that replaced it); `cancel_for_root` signals only the calling workspace's runs (ownership-scoped, idempotent). `cancel_all` + a `lib.rs` shutdown hook stop every run on exit.
- **`cancel_test`** resolves the current workspace natively and cancels its run(s); harmless when none is running or no folder is open. Typed outcomes: a stopped run is `cancelled`, a deadline is `timedOut`, a nonzero exit is a `completed` result (not an error), and permission / unknown-adapter / invalid-args / missing-runner / over-capacity are clear `Err(String)` messages (the `run_checker` convention).
- **`lib.rs`** — `mod test_runner`, `.manage(TestRuns::default())`, `run_test`/`cancel_test` in `generate_handler!`, and `cancel_all_runs` in the shutdown hook.

**Three-level verification (`cargo test --lib test_runner:: -- --test-threads=1`): 20 passed, 0 failed.**

- **Level A — native unit tests (14):** allow-list (no way to name a program); every native adapter id matches a TypeScript BUILTIN adapter (`include_str!` the TS); `authorize_args` accepts all/file/case and rebuilds argv; rejects altered base / unknown flag / extra args / non-`-t` selector; file selector forced through containment (traversal + `/etc` refused); **a shell-metacharacter test name stays exactly one argv element**; registry: register/deregister-by-id, ownership-scoped cancel, idempotency, supersede, **stale-finish does not evict the newer run**, concurrency bound, cancel-all.
- **Level B — controlled process integration (6):** a written **fixture script** (`.cmd` on Windows), never a downloaded binary, through the real `execute` path — valid JSON + exit 0 → `completed` with the stdout; nonzero exit → still `completed` (a failing suite is a result, not a run error); empty stdout → **stderr surfaced**; a 30 s hanging runner **cancelled and killed in < 10 s** (not run to completion); a run past a 300 ms deadline → `timedOut`; a missing program → clear error.
- **Level C — real Vitest/Jest:** **honestly reported as SKIPPED** — this repo installs neither runner and the rules forbid downloading one; the test prints the skip rather than passing silently. The native run path is proven by Level A (authorization) + Level B (real process lifecycle/cancellation/timeout).

**Frontend wiring:** `native.ts` `run_test` retyped to `{ adapter, args }`; `useTestingPlatform.ts` sends `{ adapter: command.program, args }`; the TestingView tab, detection, and badge are unchanged. The **missing-runner state is informative and recoverable**: `run_test` returns a clear "No vitest runner found… `npm install -D vitest`" error, which the controller shows as a failed run; detection still works and a later run retries.

**Verify (exact):**

- `cargo fmt --all --check` → exit 0.
- `cargo test --lib test_runner:: --no-run` → **Finished, test binary built** (23 s).
- `cargo test --lib test_runner:: -- --test-threads=1` → **20 passed, 0 failed, 1.24 s**; no Smart App Control (os error 4551) this run.
- `cargo clippy --lib --all-features -- -D warnings` → **exit 0 (no warnings)**, 20.6 s.
- Frontend unchanged-green: `node --test src/services/testing/*.test.ts` + `views.test.ts` → **58 pass**; `tsc --noEmit` exit 0; `prettier --check` clean.

**Files changed:** new — `src-tauri/src/test_runner.rs`. Edited — `src-tauri/src/lib.rs` (module + state + handlers + shutdown), `src/services/native.ts` (wire `{adapter,args}`), `src/services/testing/useTestingPlatform.ts` (binding). No change to `checkers.rs`, the process/terminal/task/diagnostics infrastructure, ResourceId, WorkspaceManager, or any protected search file. C1/C2 untouched; production C2 registry still empty; E6 not begun.

**Limitations (honest):** (1) Level C real-runner execution is unverified here — no local Vitest/Jest and no network install permitted; reported, not hidden. (2) `resolve_program` looks in the workspace-root `node_modules/.bin` (and PATH), so a runner installed only in a monorepo sub-package is not yet found — a follow-up. (3) A report over 16 MB is truncated by `capture_classified` and then fails to parse with a typed `TestParseError` (graceful, but very large reports aren't streamed).

**Next (continuing the slice, per the WS5.1 brief):** Cargo-test adapter → Playwright → pytest; then connect test debugging to the existing DAP subsystem (`dap_start` seam); then WS6 Multi-language Debugging.

---

## WS5 — Native Testing Platform (Test Explorer) — ✅ VERTICAL SLICE BUILT (frontend end-to-end; one native command remains)

**Goal:** a genuinely useful integrated Testing Platform so users discover, run, inspect and rerun project tests inside Yavin. Vitest + Jest first (they share one `--json` schema), reusing existing process authorization — no new process/terminal/task/diagnostics infrastructure. Built in a vertical slice: discovery → execution → projection → view-model → UI.

**Constraint that shaped verification:** neither Vitest nor Jest is installed in this repo and installing is out of scope, so the core is verified against **recorded JSON fixtures, argv-safety tests, and fake runners** — not live framework runs. This is deliberate and documented, not a gap in coverage.

**What was built (all new, `src/services/testing/` + one view):**

- **`model.ts`** — the data model (`TestStatus`, `TestCase`/`TestFile`, `TestSummary`/`TestReport`), `caseId()` (NUL-joined stable identity), `aggregateStatus()`.
- **`jestJson.ts` (+6 tests)** — the shared Jest (`--json`) / Vitest (`--reporter=json`) parser (identical schema). Banner-noise tolerant (`extractJson`: first `{`→last `}`), typed `TestParseError` on malformed/`testResults`-less output, nested suites, locations, durations, failure messages.
- **`adapters.ts` (+6 tests)** — `vitestAdapter` / `jestAdapter`: each builds **safe argv** (`program` + `args[]`, never a shell string), detects by root marker names, delegates parsing. `selectAdapter()` (Jest-first). **SECURITY test:** a test name `evil"; rm -rf / #` + backtick + `$(whoami)` stays exactly one argv element for both adapters; no arg is a joined shell string; `program` is a bare executable.
- **`controller.ts` (+10 tests)** — the lifecycle core: injected `TestRunner` (never spawns anything itself), phases `idle→running→done|failed|cancelled`, **generation-guarded** so a superseded/stale run never overwrites a newer one, `AbortSignal` cancellation, `reset()` (workspace switch), `rerunFailed()` (single case / single file / all).
- **`resultStore.ts` (+7 tests)** — current + bounded history; per-case status trend + **flaky** flag (saw both pass & fail); `newlyFailed()` (passed-before-now-failing regressions); subscribe/clear.
- **`treeProvider.ts` (+7 tests)** — projects the flat report into file→suite→case, **stable ids from path + suite/case names (never position)** so expansion/selection survive a reordering re-run; `flattenVisible()` for virtualized rendering; `toggleExpansion()` honouring default-open files.
- **`runService.ts` (+7 tests)** — turns an adapter's argv into the controller's `TestRunner` by delegating to the **existing authorized runner seam** (same shape as the checkers' `run_checker`/`cancel_checker`): `cancelled` outcome → `AbortError` (→ controller `cancelled`), `timedOut` → `TestRunTimeoutError` (→ `failed`), wires the `AbortSignal` to the native cancel. Includes an **end-to-end test** through the whole path (argv → runService → fake native → RunAnswer → parse → controller state) with no real process.
- **`platform.ts` (+8 tests)** — the single view-model the UI binds to: composes controller + result store + tree projection + expansion/selection behind one `subscribe`/`getViewState`; caches rows for reference-stability; records each completed run into history.
- **`useTestingPlatform.ts`** (React hook) — detects the framework from the open folder via the **existing** `list_workspace_files` command (no new discovery surface) and wires execution to the `run_test`/`cancel_test` seam.
- **`components/panel/views/TestingView.tsx`** — the Test Explorer UI: Run All / Stop / **Rerun Failed** toolbar, pass/fail/skip summary, indented status-marked tree (expand/collapse, run-on-hover, click-to-select), and a selected-failure detail pane with "Go to test" (failure navigation via the editor's existing open-at-position callback).
- **Panel registration** — added `test` ("TEST RESULTS") to `PANEL_VIEWS` (`services/panel/views.ts`), rendered in `TerminalPanel` with a **reactive failed-count tab badge** (like VS Code); wired `workspaceFolder` through from `App.tsx`.
- **`native.ts`** — declared the typed `run_test` / `cancel_test` command contract (mirrors `run_checker`: allow-listed, trust-gated, **argv structural — never a shell string**).

**Verify:** `node --test src/services/testing/*.test.ts` → **51 pass, 0 fail**; `src/services/panel/views.test.ts` → **7 pass, 0 fail** (updated for the new tab + wrap order); **`tsc --noEmit` exit 0 (whole project)**; `prettier --check` clean across all touched files.

**Files changed:** new — the 8 `src/services/testing/*.ts` modules + 8 `*.test.ts`, `useTestingPlatform.ts`, `components/panel/views/TestingView.tsx`. Edited — `services/native.ts` (typed seam), `services/panel/views.ts` + `views.test.ts` (new tab), `components/layout/TerminalPanel.tsx` (render + badge + prop), `App.tsx` (pass `workspaceFolder`).

**Remaining (next increment) — the one native command:** `run_test` / `cancel_test` in the Tauri backend, implemented exactly like the existing `run_checker` (allow-listed project test tool resolved inside the trusted workspace, structured argv, `{outcome, output, code, root}`). Deliberately **not** shipped blind: it touches process-authorization security, and with no installed runner a live run can't be verified here. Today the tab renders and **framework detection works** (via `list_workspace_files`); clicking Run surfaces an honest error until the backend handler lands. Then: multi-root support and the remaining adapters (Cargo, Playwright, pytest), and the **DAP debug-test interface** (the native `dap_start` seam already exists — design only, no separate debugger).

---

## WS-A — Dead placeholder crates (investigation) — ✅ ANALYSIS COMPLETE; removal recommended

Five crates are **excluded from the Cargo workspace** (`src-tauri/Cargo.toml` `exclude = [...]`) and **referenced by nothing** (git grep across the repo, excluding the crates themselves + their Cargo.toml, finds zero uses):

| Crate        | Contents                                                                                    | Verdict                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ide-config` | `settings.rs`/`keymap.rs`/`theme.rs` = 2-line **"Placeholder … will be implemented"** stubs | **Dead stub** — real config lives in TS `services/settings` + `src-tauri/src/config.rs`                 |
| `ide-syntax` | `highlight.rs` = 2-line placeholder (tree-sitter never wired)                               | **Dead stub** — highlighting is Monaco Monarch + Shiki/TextMate (TS)                                    |
| `ide-lsp`    | `client.rs`/`transport.rs` = placeholders                                                   | **Dead stub** — real LSP is `src-tauri/src/lsp.rs` + `ide-workspace::lsp_process`/`lsp_framing`         |
| `ide-dap`    | `client.rs` = placeholder                                                                   | **Dead stub** — real DAP is `src-tauri/src/dap.rs`                                                      |
| `ide-core`   | `buffer.rs` (153 ln), `undo.rs` (141), `cursor.rs` (24) — **real code**, but unused         | **Dead-but-real** — superseded by Monaco + `DocumentService`/`EditorModelBridge` (TS); never referenced |

- **Decision:** all five are safe to remove (no deps, no references, excluded from build; `ide-core`'s real code is preserved in git history). Removing them deletes the `exclude = [...]` entries in `src-tauri/Cargo.toml` too.
- **Status:** removal is a destructive filesystem/Cargo change; **pending** — will perform with the next safe step or flag for approval if the auto-mode safeguard blocks it. No source that ships depends on them, so removal is zero-risk to the product.

---

## WS-F.1 — Regression coverage for `language.ts` — ✅ DONE (verified)

- **Problem:** `src/services/language.ts` (document language detection — drives editor mode, highlighting, LSP routing, status bar) had **no unit test** (flagged in the audit), so its ~40 extension + special-filename mappings were unguarded against regressions.
- **Change (additive only):** new `src/services/language.test.ts` — 8 tests covering extension mapping, path→basename reduction (both separators), case-insensitivity, whole-name files (Dockerfile/Makefile/Cargo.lock/.gitignore/.env/.bashrc), `.env.*`/`Dockerfile.*` variants, plaintext fallbacks, labels, and contributed-language rules (builtin wins, longest-extension-first, state reset).
- **Tests:** `node --test src/services/language.test.ts` → **8 pass, 0 fail**; `tsc --noEmit` → exit 0.
- **Files changed:** `src/services/language.test.ts` (new). No production code touched.

---

## WS4 — Git integration consistency — ✅ VERIFIED + regression gap filled

- **Objective:** verify the two Git subsystems (real Git `services/git` + `git.rs`; Local Git `services/localgit` + `ide-localgit`) are consistent and reliable.
- **Finding:** both are comprehensively tested and passing — 32 `services/git/*` test files (incl. `*.realgit.test.ts` real-git integration), `services/localgit/*`, and `ide-localgit`'s 28 integration tests — all green in the WS0 Rust run (793) and WS1 frontend run (1085). The two subsystems are distinct by design (Source Control vs local history/snapshots), not duplicated. No defect found.
- **Genuine gap filled (regression test):** `src/services/git/graph/shared.ts` — the **ref-counted shared `GraphLoader` registry** (acquire/release/reset/drop, keyed per repository) — was **untested**, despite being reliability-critical and tied to a **documented past leak** (release recomputing a different key than acquire → the loader stayed forever and was later handed back wrapping a _dead native handle_; see `hooks.ts:91-99`).
- **Change (additive only):** new `src/services/git/graph/shared.test.ts` — 6 tests: build-once + ref-count share on re-acquire, dispose only on last release, release-of-unknown-key no-op, **release-under-the-wrong-key leaves the loader alive** (locks the leak-avoidance contract), `dropLoader` disposes regardless of ref-count + forces a fresh build (repo-close path), and `resetLoader` resets a live loader / no-ops when absent.
- **Tests:** `node --test src/services/git/graph/shared.test.ts` → **6 pass, 0 fail**; `tsc` exit 0; `prettier` clean.
- **Files changed:** `src/services/git/graph/shared.test.ts` (new). No production code touched.

---

## WS3 — Terminal lifecycle / PTY reliability — ✅ VERIFIED COMPLETE (no rewrite warranted)

- **Objective:** reliable terminals across creation, execution, cancellation, restart, workspace switch, shutdown, unexpected exit.
- **Finding:** the lifecycle is already correct and **comprehensively tested on both layers**; the architecture satisfies every WS3 requirement, proven by existing tests (ran green: 793 Rust tests in WS0, 1085 frontend tests in WS1). No defect found; no rewrite warranted.
- **Requirement → existing test evidence:**
  | Requirement                                                                     | Proven by                                                                                                                                                        |
  | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Multiple simultaneous terminals                                                 | `several_shells_at_once_keep_their_output_apart_and_all_end` (rust)                                                                                              |
  | Invalid shell / cwd / startup failure                                           | `only_a_detected_shell_can_be_started`, `a_terminal_starts_in_a_real_folder_or_says_why_not`, `a_launch_that_cannot_start_says_why_and_reports_no_events` (rust) |
  | High-volume output, bounded + responsive                                        | `a_real_shell_streaming_megabytes_stays_ordered_bounded_and_responsive` (rust)                                                                                   |
  | Input backpressure / oversized input                                            | `input_to_a_shell_that_stops_reading_is_refused_instead_of_blocking`, `oversized_input_is_refused_before_it_is_queued` (rust)                                    |
  | Kill ends the whole process tree (+ grandchildren)                              | `killing_a_terminal_ends_everything_its_shell_started`, `…_ends_its_shells_children_and_grandchildren_by_pid` (rust; Windows Job Object / Unix killpg)           |
  | Kill during startup still ends                                                  | `a_terminal_killed_before_its_shell_finished_starting_still_ends` (rust)                                                                                         |
  | Self-exit reported + reaped                                                     | `a_shell_that_exits_by_itself_is_reported_and_reaped` (rust)                                                                                                     |
  | Shutdown with active terminals                                                  | `close_all_ends_every_session` (rust) + `disposing a workspace's terminals ends them all and refuses everything after` (ts)                                      |
  | Stale-generation / race safety                                                  | `a_stale_generation_never_touches_the_current_launch` (rust); `a restart while the old generation is exiting keeps the new one` (ts)                             |
  | **Resize/write after termination refused**                                      | `writes and resizes reach the current generation, and are refused once it has ended` (ts)                                                                        |
  | **Repeated dispose (idempotent)**                                               | `terminalService.test.ts:427` `dispose(); // twice is harmless` (ts)                                                                                             |
  | Leak-free disposal                                                              | `disposing during output, and a subscriber disconnecting, throw nothing and leak nothing` (ts)                                                                   |
  | Workspace switch / isolation                                                    | `A → B → A: A's terminals keep running while away…`, `refuses another's by name` → `InvalidWorkspace` (ts)                                                       |
  | Security: shell allow-list, cwd validation, containment, per-workspace identity | the above + `require_current` generation guard + `running()` state guard (rust)                                                                                  |
- **Decision:** no code change (would be change without a real correctness issue, against the task's guidance). The `running()` guard (`src-tauri/src/terminal.rs`) refuses write/resize unless the session is the current generation **and** `Running`; termination uses `can_transition` + generation checks (idempotent); process containment is the shared Job Object/killpg. All already covered.
- **Files changed:** none. **Remaining limitations:** live resource-handle counting before/after mass create/dispose is OS-tooling territory (the Rust `process_table`-based tests already assert no leaked child _processes_ after kill).

---

## WS2 — Explorer scalability: measured, already-optimized, reliability test added — ✅ DONE (verified)

- **Goal:** make the Explorer fast/scalable for large repos.
- **Finding 1 — rendering is already virtualized.** `src/components/layout/Sidebar.tsx` windows rows arithmetically (`ROW_HEIGHT`, `OVERSCAN`, `first/last` slice over `view.top/height`) — only the visible slice + overscan render, regardless of tree size. (The prior audit's "virtualization unverified" was wrong.)
- **Finding 2 — the provider is reference-stable + incremental.** `projection()` caches and keeps object identity for unchanged subtrees; `applyResourceChanges` relists only the changed file's **parent** folder (loaded containers), not the whole tree.
- **Benchmark (real, synthetic wide directory; pure provider logic; temp harness, not committed):**

  | entries | load (list+reconcile) | projection build | projection cached | refresh+reconcile (+1 file) | RSS    |
  | ------- | --------------------- | ---------------- | ----------------- | --------------------------- | ------ |
  | 1,000   | 3.5 ms                | 0.5 ms           | **0 ms**          | 2.3 ms                      | 76 MB  |
  | 10,000  | 23.7 ms               | 3 ms             | **0 ms**          | 22.4 ms                     | 109 MB |
  | 50,000  | 98.7 ms               | 14.6 ms          | **0 ms**          | 121.9 ms                    | 244 MB |

  Load/reconcile is linear (~2 ms/1k); the projection cache is free when unchanged (the key memoization guarantee); 50k _direct siblings_ is an extreme case and still ~100 ms to load.

- **Decision:** **no optimization implemented** — the measurements show the Explorer already scales, and the one O(n) cost (relist a folder on change) is intentional (correctness via listing — "every fact comes from a listing"; a delta-apply optimization would introduce a second source of truth, which the task and architecture forbid). Optimizing further would be change without measurable benefit.
- **Reliability regression test added (additive):** `src/services/explorerStore.test.ts` — 6 tests for the previously-isolated-untested `explorerStore` (owns expansion/selection/focus): set-view reference stability + **independence** (changing selection does not rebuild the expanded view — the memoization that keeps large trees cheap), rename moves a folder + its subtree's state to the new identity, delete drops the subtree's state, reset clears selection/focus but keeps expansion, and reveal expands the ancestor chain + selects/focuses the target.
- **Tests:** `node --test src/services/explorerStore.test.ts` → **6 pass, 0 fail**; `tsc` exit 0; `prettier` clean. The reference-stable projection itself is already covered in `explorerProvider.test.ts` (21 projection assertions, incl. "the projection hands back what did not change").
- **Files changed:** `src/services/explorerStore.test.ts` (new). No production code (nothing warranted a change). Temp benchmark removed.
- **Remaining limitations:** cold-cache/large-sibling behavior measured only for the pure provider layer (React render counts + live memory in-browser would need a Playwright perf harness; the virtualization + reference-stable projection make the DOM cost bounded regardless).

---

## WS-F.2 — Regression coverage for `commandRegistry.ts` — ✅ DONE (verified)

- **Problem:** `src/services/commandRegistry.ts` (IDE-08 — the one owner of window + extension commands, read by menus/palette/shortcut handler) had **no unit test**.
- **Change (additive only):** new `src/services/commandRegistry.test.ts` — 9 tests: core listing/order, extension commands appended + namespaced, **core wins over a same-id extension command**, sort by extensionId→command, `execute` (runs/true, disabled→false, unknown→false), extension routing through its runner, `get`, `subscribe` fire-on-change/unsubscribe, and **a contributed shortcut colliding with a core one is refused (conflict reported), a free key is assigned**.
- **Tests:** `node --test` → **9 pass, 0 fail**; `tsc --noEmit` exit 0; `prettier --check` clean. (One assertion initially mis-ordered the sort and one arrow returned non-void — both fixed in the test; the product code was correct.)
- **Files changed:** `src/services/commandRegistry.test.ts` (new). No production code touched.

---

## WS1.2 — Ports panel: duplicate "Ports" ARIA region (regression from the Local/Global change) — ✅ FIXED (verified)

- **Problem:** 4 UI tests failed deterministically (`terminal.spec.ts` 2066/2084/2430/2796) with `strict mode violation: getByRole('region', { name: 'Ports' }) resolved to 2 elements`.
- **Root cause:** an earlier change added a Local/Global scope switcher to `PortsView`, wrapping the view in `<section aria-label="Ports">` (an ARIA region) **and** rendering an inner `EmptyView`, which itself renders `<section aria-label=…>`. The inner labels were "Local ports" / "Ports", and Playwright's `getByRole(name)` matches **substring, case-insensitively** — so both the outer "Ports" and the inner "Local ports"/"Ports" matched, giving two regions.
- **Fix (smallest responsible component — `src/components/panel/views/PortsView.tsx`):** keep the single outer `<section aria-label="Ports">` as the only "Ports" region; rename the inner `EmptyView` labels to `"Local"` (placeholder) and `"Global"` (loading/error/empty) so they no longer contain "port". Visible messages unchanged; behavior unchanged.
- **Regression coverage:** the existing `terminal.spec.ts` Ports/panel tests (which caught this) now exercise both scopes and pass.
- **Verify:** `npx playwright test terminal.spec.ts --grep "Ports|each view|switching away|Show Git Output|a port|stopping|confirming"` → **12 passed, 0 failed**; `tsc` exit 0; `prettier` clean.
- **Files changed:** `src/components/panel/views/PortsView.tsx` (4 ARIA labels).
- **Note:** the two other batch failures (`source-control-layout.spec.ts:348`, `terminal.spec.ts:4862` EXT-27 grammar) **passed on isolated re-run** → flaky under the heavy single-worker batch, not regressions.

---

## WS1.1 — Playwright UI suite broken by nested `node_modules` (flatten artifact) — ✅ FIXED (verified)

- **Problem:** `npm run test:ui` failed immediately (exit 1, ~4 s) for **every** spec with `"Playwright Test did not expect test() to be called here"` + `"No tests found"` — the entire UI runtime-validation suite was unrunnable.
- **Root cause:** the repo flatten's `mv Yavin_2.0.0/node_modules node_modules` nested the app's `node_modules` **inside** a pre-existing root `node_modules/`, producing `node_modules/node_modules/` — a second, duplicate install (incl. a second `playwright-core` + `@playwright/test`). Playwright loaded two `@playwright/test` identities → the spec `test()` calls weren't recognized. Verified: top-level `node_modules` is authoritative (`npm ls` clean; `@playwright/test` resolves `playwright-core` from the top level); the nested copy was redundant and gitignored.
- **Change:** `rm -rf node_modules/node_modules` (removed the duplicate; gitignored build artifacts only, regenerable via `npm ci`). No source, dependency, or config change.
- **Verify:** `npx playwright test --list` → **"Total: 479 tests in 19 files"** (was: load error, 0 tests). Exit 0.
- **Files changed:** none tracked (removed an ignored stray dir).
- **Remaining:** the flatten's `mv` is the lesson — a pre-existing root `node_modules` caused the nesting. No recurrence risk now; a future `npm ci` would also have fixed it.

---

## Results log

(Appended as tasks complete — exact commands + outcomes.)

- `npx prettier --check .` → exit 0 (all files clean) ✅
- `cargo clean` → exit 0 (stale target removed) ✅
- `cargo fmt --all` → only `registry_trust_tests.rs` changed; `cargo fmt --all --check` → exit 0 ✅
- `cargo build --workspace --locked` → **exit 0, 3m39s** (yavin-ide binary + all crates build from fresh cache; stale-cache blocker RESOLVED) ✅
- `cargo test --workspace --locked --no-fail-fast` → **793 passed, 0 failed**, no Smart App Control (4551), ~4.5 min ✅
- `cargo clippy --workspace --all-targets --locked -- -D warnings` → **exit 0** (no warnings) ✅
- Feature-gated C2 live tests (`--features c2-test-profiles`): previously verified green this session (c2 channel 20/0/2, c2_capability 7/0); not re-run this pass.
- Not run this pass: packaged `tauri build` (heavy), Playwright `tests/ui`/`tests/real` (heavy; `real` needs a packaged build).

**WS0 outcome:** build reliability restored — the whole Rust workspace builds, the full default test suite passes (793/0), clippy is clean, and both formatters pass. The repo-flatten's stale-cache/format fallout is fully cleared.
