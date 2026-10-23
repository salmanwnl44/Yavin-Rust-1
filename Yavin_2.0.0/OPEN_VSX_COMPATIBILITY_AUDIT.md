# Open VSX compatibility audit

- **Part G:** EXT-31, webviews and workbench integration (2026-10-23).
- **Part F:** EXT-30, VSIX package compatibility (2026-10-23).
- **Part E:** EXT-29, core VS Code API completion (2026-10-22).
- **Part D:** EXT-28, JavaScript runtime compatibility (2026-10-22).
- **Part C:** EXT-27, VS Code API behavioural conformance (2026-10-20).
- **Part A:** EXT-26, the gap audit and roadmap (2026-10-20).
- **Part B:** the EXT-25 record, corrected where Part A found it wrong.

Every number is counted from records in [`benchmark/openvsx/`](benchmark/openvsx/) produced on this machine. Nothing is estimated unless it says so.

**Not claimed:** that all Open VSX extensions work, or will.

---

# Part G: EXT-31, webviews and workbench integration

**Base:** `main` at `0cd1303` (EXT-25 to EXT-30). EXT-29's outstanding item stays outstanding: the packaged Windows foreground-focus test (§E6, §F7).

**The question.** `window.createWebviewPanel` was the first failure of two benchmark extensions at EXT-30 (Bookmarks at activation; SVG Preview's two preview commands), and the most-named unsupported API in the static scan (12 of 50 entry points). EXT-31 provides webview panels, only as far as their isolation can be shown in the installed application. Tree views and other workbench contributions were to follow if the evidence supported them.

## G1. What WebView2 and Tauri do, measured

Each fact below decided part of the design. Each was checked in the packaged application (`tests/real/webview.spec.ts`) or in the libraries' sources (Tauri 2.11.5, wry 0.55.1, webview2-com 0.38.2).

| Fact                                                                                                                                                                                                                                               | Consequence                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On Windows, WebView2 adds the application's initialization scripts to **every frame**: wry documents that subframes always get them, whatever `for_main_frame_only` says. Measured: a webview frame has `__TAURI_INTERNALS__` and `chrome.webview` | A frame cannot be kept free of Tauri's IPC script. What it can do with the script must be nothing                                                                                                                                      |
| Tauri treats a registered custom protocol (`http://<scheme>.localhost`) as a **local** origin (`is_local_url`), and local origins may call application commands                                                                                    | Webviews are not served by a Tauri protocol. They come from `https://yavin-webview.invalid`, answered by Yavin's own `WebResourceRequested` handler. To Tauri this origin is remote, and no capability grants a remote origin anything |
| From a webview frame in the installed application, `__TAURI_INTERNALS__.invoke("extensions_list")` and `invoke("extensions_set_enabled", …)` **never answer** (4 s), and the extension stays enabled. `fetch("http://ipc.localhost/…")` is refused | Recorded as "not through": no answer and no effect. The test checks the effect (the extension still running, its card still Enabled), not only the answer                                                                              |
| `chrome.webview.postMessage` from a frame goes to that frame's own WebView2 event, not to the window's. Measured: a frame's `extensions_webview_close` for its own page never ran                                                                  | A second channel that reaches nothing                                                                                                                                                                                                  |
| A cancelled frame navigation leaves **WebView2's error page** in the frame, not the old page                                                                                                                                                       | Cancelling alone would destroy the panel. The window pings the frame after every load. A frame that does not answer within 1 s is served its page again with its saved state (at most 3 times a minute)                                |
| A frame's `load` can come before the page's own "ready" message, and `pagehide` does not always fire before WebView2 replaces the page                                                                                                             | Readiness is a ping and its answer (the bootstrap's listener runs first and stops the event, so the page's scripts never see it), not a flag that can go stale                                                                         |

## G2. What was implemented

| Part                                               | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The layer (`vscode.js`)                            | `createWebviewPanel(viewType, title, showOptions, options)`: `webview.html`, `options`, `cspSource`, `asWebviewUri`, `postMessage` (resolves `true` once delivered or queued), `onDidReceiveMessage`; the panel's `title`, `viewColumn`, `active`, `visible`, `reveal`, `dispose`, `onDidChangeViewState` and `onDidDispose`. Changes are sent once per microtask. Options Yavin does not keep are said once in the extension's log (`enableCommandUris`, `enableForms`, `portMapping`, view columns) |
| Protocol and permissions                           | Five requests (`webview.create`, `update`, `postMessage`, `reveal`, `dispose`) on an id the extension owns (`<id>#webview#n`, checked by `extension_permissions.rs` and `permissions.ts` from the shared cases), and three events sent to the owner only. 35 bridge methods                                                                                                                                                                                                                           |
| The window (`webviews.ts`, `ExtensionWebview.tsx`) | A tab of Yavin's editor area holding `<iframe sandbox="allow-scripts">` (opaque origin, no referrer, `allow=""`). It relays messages only from that frame's `contentWindow`, only in the bootstrap's shape, and only once the page is ready. It keeps state and disposes panels. Bounds are in G3                                                                                                                                                                                                     |
| Native (`extension_webviews.rs`)                   | The token is bound once to its window and extension. The page is served with the policy header and the bootstrap. Files come from the extension's verified copy inside its roots. Frame navigation is guarded (`FrameNavigationStarting`). Everything is dropped on reload and close                                                                                                                                                                                                                  |
| The page's API (`webview_bootstrap.js`)            | `acquireVsCodeApi()` once (as VS Code), with `postMessage`, `getState` and `setState`; VS Code's theme variables and `vscode-dark`/`vscode-light` body classes in Yavin's colours; links that do not navigate; the ping answer                                                                                                                                                                                                                                                                        |
| `console.debug`, `console.trace`                   | Added to the layer's `console`. SVG Preview's preview calls `console.debug` first; without it, the command failed with "not a function"                                                                                                                                                                                                                                                                                                                                                               |

**Not implemented, with the reason.**

- **`registerWebviewPanelSerializer`.** A restored panel would get state and HTML that the window kept across a reload. That needs a trust decision about the kept data, and no benchmark extension's main feature needs it (golang.go names it). Panels close on reload.
- **`registerWebviewViewProvider` and custom editors.** Each is a different surface: a sidebar view, or an editor that owns a document. Named by one extension each (code-spell-checker; tomoki1207.pdf, whose activation stops there).
- **Tree views (`createTreeView`, `registerTreeDataProvider`).** Named by 9 and 6 entry points, but **no measured first failure** is a tree view. Todo Tree stops at `registerTextDocumentContentProvider`, Project Manager at `os.homedir`, File Utils at load, Bookmarks at `workspace.fs` (G4). Implementing them now would unlock no measured feature, so they are deferred until a first failure needs them.

## G3. Security boundaries

| Boundary             | Enforced by                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No IPC               | A remote origin to Tauri (its ACL refuses application commands); `connect-src 'none'`; a sandboxed frame's `null` origin; `chrome.webview` messages that reach no handler                                                                                                                                     |
| No network           | The page's CSP header: `default-src 'none'`, `connect-src 'none'`, scripts, styles, images, fonts and media only from the webview origin (`data:`/`blob:` for images, fonts and media). An extension's own CSP can only narrow it. Measured: a remote image and a remote script are refused                   |
| No navigation        | `FrameNavigationStarting` cancels every frame navigation that is not to a live panel's page. The window's CSP allows frames only from the webview origin. The sandbox has no `allow-top-navigation`. Measured: the window stays at `tauri.localhost`; a page that navigates itself is restored with its state |
| No window access     | The sandbox gives an opaque origin: no DOM of the window, no storage, no popups, no forms. Measured: all four refused                                                                                                                                                                                         |
| No files but its own | The extension's verified copy, inside its declared `localResourceRoots`. Paths are canonicalized and must stay inside, links are refused, and files are at most 16 MiB. A root outside the copy loads nothing. Never the workspace. Measured: a file of the package outside its roots is refused              |
| Ownership            | The token (32 hex digits from the OS's random source) is bound once to window and extension. Pages and files are served only to that window. Requests on another extension's panel are refused by both permission checks and by the store. Events go to the owner only                                        |
| Bounds               | Messages 1 MiB of JSON each way; 500 frame messages a second (then dropped, said once); 64 queued until ready; HTML 4 MiB; state 256 KiB, written natively at most every 200 ms; 16 resource roots; 16 panels an extension, 32 a window; 8 kept alive while hidden                                            |
| Lifetime             | Disposed on tab close; on the extension's stop, disable, crash or uninstall; on a workspace switch; on the window's reload (`on_page_load` closes all of its panels natively) and its closing (`Destroyed`)                                                                                                   |
| Fail closed          | `.invalid` never resolves: without Yavin's handler, nothing loads. A WebView2 without `ICoreWebView2_22` falls back to the plain filter; anything else unknown is refused (only GET, only the origin, only a live token)                                                                                      |

## G4. Real extensions

Measured in the benchmark's sandboxed activation run (`benchmark/openvsx/ext31/`; the same 64 packages as EXT-30) and in the installed application.

| Extension               | EXT-30                                                                 | EXT-31                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bookmarks               | Activation stops at `createWebviewPanel` (its What's New page)         | The panel is created. Activation then stops at `workspace.fs.readFile` of its own package's `vscode-whats-new/ui/whats-new.html`: `NoPermissions`, because `workspace.fs` reaches only the workspace. **Main feature: No** (next blocker outside webviews)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| SVG Preview (jock.svg)  | Preview All and Preview SVG fail at `createWebviewPanel`; 3/6 commands | 4/6 commands in the benchmark (Preview All runs). **In the installed application** (`tests/real/webview-svg.spec.ts`, the Open VSX package served by a signed loopback mirror): Preview All's page loads sandboxed, its script runs, and its message reaches the extension. The extension then stops at `workspace.findFiles` (unsupported), so the list stays empty. Preview SVG runs (after the `console.debug` fix) but opens nothing: it previews only documents whose language is `svg`, and Yavin keeps `.svg` as its own XML (EXT-25's rule that an extension adds languages and never changes Yavin's). **Main feature: Partly**, as before (grammar, snippets, minify) |
| PDF viewer (tomoki1207) | Stops at `registerCustomEditorProvider`                                | Unchanged (custom editors are not provided)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Benchmark totals:** commands run 50/82 (49 at EXT-30). Main feature: 18 yes, 5 partly, 41 no, **unchanged**. Verdicts: 9 Compatible, 14 with limitations, 41 Incompatible, unchanged. No extension's main feature became usable through webviews alone. Each of the two extensions that reached `createWebviewPanel` now stops at a core API behind it: `workspace.fs` outside the workspace, `workspace.findFiles`, or the language rule.

## G5. Tests

| Where                                                    | New | What                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src-tauri/src/extension_webviews_tests.rs` (new)        | 11  | Tokens and relative paths; the policy's sources (none wildcard or scheme-wide); the bootstrap before the page's own head; state escaped (`<` as `<`); binding, ownership and bounds, with an update of scripts and roots; a page served only to its window; files only inside the copy and its roots; a junction refused; navigation only to a live page; content types; only GET                |
| `src/services/extensions/vscodeWebview.test.ts` (new)    | 13  | Creation, token and HTML; messages both ways, bounded, queued, and not heard before ready; the flood limit; state; view state and close; dispose and reveal; isolation between extensions (no event of a panel sent to another extension); stop disposes; `asWebviewUri` and roots; unsupported options and the bound of 16; `setShown` news only on change; the restore bound; ping and leaving |
| `crates/ide-plugin-host/tests/core_api.rs`               | 2   | A webview panel speaks the protocol in the real host; `console.debug` and `console.trace`                                                                                                                                                                                                                                                                                                        |
| Permissions (both sides, shared cases)                   | —   | The five webview requests need an owned id; webview events need nothing; 35 methods                                                                                                                                                                                                                                                                                                              |
| `tests/ui/terminal.spec.ts` (mock window)                | 1   | The real bootstrap and policy served to a frame: sandbox; the page cannot reach the window or storage; the API once; the theme class; the ping does not reach the page; state kept across hide and reload; close disposes                                                                                                                                                                        |
| `tests/real/webview.spec.ts` (installed application)     | 1   | An isolation probe from a signed mirror: its own image and script load, messages pass; IPC (with a side-effect check), `ipc.localhost`, the window's DOM, top navigation, popups, storage, remote loads and a file outside its roots all fail; its self-navigation is restored with its state; closing disposes                                                                                  |
| `tests/real/webview-svg.spec.ts` (installed application) | 1   | SVG Preview from Open VSX (runs when `YAVIN_E2E_SVG_VSIX` names its package): see G4                                                                                                                                                                                                                                                                                                             |

## G6. Verification

In the module's order; memory checked before each mutation (at least 2 GiB free, measured 4.5 to 5.3 GiB).

| Check                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Targeted: `vscodeWebview.test.ts`, `vscodeCompatibility.test.ts`                | 15/15                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Targeted: `extension_webviews` (native), `core_api.rs`, `vscode.rs` (inventory) | 11/11, 8/8, 4/4                                                                                                                                                                                                                                                                                                                                                                                                            |
| Tree views and workbench contributions                                          | Not implemented (G2): no measured first failure needs them, so there are no tests                                                                                                                                                                                                                                                                                                                                          |
| TypeScript (`npm test`)                                                         | **1076 passed, 0 failed**, 1 skipped, 1 todo                                                                                                                                                                                                                                                                                                                                                                               |
| `tsc --noEmit`; `prettier --check .`                                            | clean                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Security mutations, EXT-31 (W01–W12)                                            | **12 of 12 caught**, each by its intended test                                                                                                                                                                                                                                                                                                                                                                             |
| Conformance mutations, EXT-31 (V01–V09)                                         | **9 of 9 caught**. V04 (a page heard before it is ready) and V06 (a panel's messages sent to every extension) first survived. The tests did not look: no page message was sent before "ready", and the other extension's layer silently drops a message for a panel it does not own. The tests now post before ready, and record every event the window sends, by extension and panel. Both are caught by those assertions |
| Mutations rerun on files EXT-31 changed                                         | **35 of 35 caught**: security EXT-25 P1–P2, EXT-29 P1–P2; conformance EXT-27 B1–B9, W5, W6, EXT-28 R3–R6, EXT-29 C1–C9, S1–S7                                                                                                                                                                                                                                                                                              |
| Packaged (installed application, MSI built 2026-10-23 with EXT-31)              | `webview.spec.ts` 1/1 (isolation). `webview-svg.spec.ts` passed 4 of 5 runs: one early run failed at the panel's first check, before its diagnostics existed, cause not found; it then passed 1 + 3 (`--repeat-each=3`) on the same MSI. One earlier run refused the install (detail not captured) and the next installed it                                                                                               |
| **Not completed**                                                               | The full Rust suite (`cargo test --workspace`) was stopped by the system for low memory while compiling, before any test ran, and was not restarted. Also not run: clippy `-D warnings` in both builds, `cargo fmt --check`, the `test-registry` build's tests, the full mock UI suite, the full packaged suite on a fresh MSI, and the packaged focus test (unresolved since EXT-29)                                      |

## G7. Known limitations

- No serializer: panels close when the window reloads. No webview views, custom editors or tree views.
- One editor area: `viewColumn` and `preserveFocus` are not kept; a panel opens and reveals in front.
- No `enableCommandUris`, `enableForms`, `portMapping`. `retainContextWhenHidden` keeps at most 8 hidden panels alive; others reload from their HTML and state when shown.
- Resources only from the extension's own package: a root in the workspace (SVG Preview's base URL for an SVG's relative images) loads nothing.
- Theme: VS Code's main variables and body classes in Yavin's dark or light colours, not every colour token.
- Files are read synchronously on WebView2's UI thread (at most 16 MiB each).
- Tauri's IPC script is present in every frame (WebView2). It is unusable from the webview origin, as measured, but present.

---

# Part F: EXT-30, VSIX package compatibility

**Base:** `main` at `26ff399` (EXT-24), with the uncommitted changes of EXT-25 to EXT-29 in place. EXT-29's outstanding item stays outstanding: the packaged Windows foreground-focus test has not passed on an idle machine (§E6).

**The question.** Of the benchmark's 64 extensions, 12 never installed: their packages were refused before any of their contents could be used. EXT-30 asks why, from the packages themselves, and changes only what the evidence shows to be a compatibility restriction rather than a security control.

## F1. Why packages were refused

The 12 refused at EXT-29 (`benchmark/openvsx/ext29/results.json`), downloaded again on 2026-10-22, each matching the registry's SHA-256, and measured from their ZIP central directory (nothing extracted):

| Package (variant)                   | Entries | Unpacked  | Largest file          | Ratio¹ | Longest name | Refused for                                          |
| ----------------------------------- | ------- | --------- | --------------------- | ------ | ------------ | ---------------------------------------------------- |
| sumneko.lua (win32-x64)             | 2732    | 42.5 MiB  | 8.5 MiB               | 7.3    | 115          | 1000 entries                                         |
| slevesque.shader                    | 2599    | 12.7 MiB  | 0.5 MiB               | –      | 103          | 1000 entries                                         |
| zignd.html-css-class-completion     | 1790    | 7.3 MiB   | 1.0 MiB               | –      | 74           | 1000 entries                                         |
| vscode-icons-team.vscode-icons      | 1695    | 6.8 MiB   | 1.5 MiB               | 7.0    | 55           | 1000 entries                                         |
| pkief.material-icon-theme           | 1278    | 1.8 MiB   | 0.4 MiB               | –      | 53           | 1000 entries                                         |
| oderwat.indent-rainbow              | 1233    | 8.6 MiB   | 0.7 MiB               | –      | 97           | 1000 entries                                         |
| charliermarsh.ruff (win32-x64)      | 23      | 27.9 MiB  | 25.0 MiB (`ruff.exe`) | 5.1    | 70           | a wrong-platform variant; a file over 16 MiB         |
| eamodio.gitlens                     | 238     | 18.5 MiB  | 3.9 MiB               | 13.3   | 56           | `package.json` of 1066 KiB (limit 1024)              |
| tamasfe.even-better-toml            | 21      | 68.9 MiB  | 34.1 MiB              | 3.4    | 45           | 21.0 MiB archive (limit 20)                          |
| shd101wyy.markdown-preview-enhanced | 250     | 63.0 MiB  | 16.1 MiB              | 3.8    | 100          | 23.6 MiB archive                                     |
| hediet.vscode-drawio                | 2618    | 107.3 MiB | 17.2 MiB              | 8.2    | 116          | 48.9 MiB archive                                     |
| waderyan.gitblame                   | 30      | 0.1 MiB   | –                     | –      | 59           | an ES module (EXT-28, deferred): not a package limit |

¹ The highest unpacked/compressed ratio of an entry over 1 MiB (the bomb check's floor).

No package had a link, an absolute or climbing path, a duplicate, or two names differing only in case.

**A wrong variant.** Open VSX answers `/api/{ns}/{name}/{version}` with one variant of a version built per platform, and not this machine's: on 2026-10-22 it answered `sumneko.lua` with `darwin-arm64` and `charliermarsh.ruff` with `alpine-arm64`. Its `downloads` names every variant (ruff: nine). Yavin installed whatever it was given. Its OpenAPI document (`/v3/api-docs`) has `/api/{namespace}/{extension}/{targetPlatform}/{version}`, with the twelve platforms VS Code knows. A package records its platform in `extension.vsixmanifest`: `<Identity … TargetPlatform="win32-x64"/>`; a universal package names none.

## F2. Security controls and compatibility restrictions

| Rule                                                                                                                                                            | Verdict                                                           | EXT-30                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| Entry names: no absolute, drive, UNC, `..`, backslash, `:`, reserved device names, control characters, trailing dot or space; components ≤ 255 bytes, ≤ 32 deep | Security: path traversal and Windows name tricks                  | Kept; a whole name now ≤ 400 bytes (new) |
| No two entries that are one file on a case-insensitive file system; no file that is also a folder                                                               | Security: ambiguity on Windows                                    | Kept                                     |
| No links, no encrypted entries                                                                                                                                  | Security                                                          | Kept                                     |
| Unpacked only into a fresh folder, `create_new`; removed whole on any refusal                                                                                   | Security: nothing written through, no partial copy                | Kept                                     |
| Ratio 100:1 per entry above 1 MiB, counted while reading                                                                                                        | Security: zip bombs (the highest legitimate measured: 13.3)       | Kept                                     |
| 1000 entries                                                                                                                                                    | Compatibility restriction: refused six legitimate, small packages | 5000                                     |
| 20 MiB archive, 16 MiB a file, 64 MiB unpacked                                                                                                                  | Resource bounds, set below real packages                          | 32 / 48 / 128 MiB                        |
| `extension/package.json` ≤ 1 MiB                                                                                                                                | Resource bound, below GitLens                                     | 2 MiB                                    |
| No time bound                                                                                                                                                   | Missing control                                                   | 120 s (new)                              |
| No platform check                                                                                                                                               | Missing control: a package for another OS installed               | Checked (new)                            |
| Checksum, Open VSX signature under a pinned key, signed index, inventory and copy digest                                                                        | Security                                                          | Unchanged                                |

**Why these numbers.** 5000 entries is 1.8 times the most measured (2732) and half the installed-copy digest's bound (10,000 files). 32 MiB admits the largest archive within reach (23.6 MiB); a downloaded archive is held in memory once while its signature is checked, so this bounds that too. 48 MiB a file admits the largest measured script (34.1 MiB) and a platform binary (25 MiB, which Yavin never runs). 128 MiB unpacked is four times the archive and half the digest's 256 MiB. Code Yavin loads is still bounded where it is read (8 MiB a script, 24 MiB and 2000 files in all). The draw.io package (48.9 MiB) stays refused.

## F3. What was implemented

- **Limits** (`extension_package.rs`): as above, each still counted while reading; the whole archive within 120 s. A refusal at any point removes everything written.
- **The package's platform** (`extension_package::target_platform`, `platform_check`): read from `extension.vsixmanifest` before anything is written. Accepted: none or `universal`, or this Yavin's (`win32-x64` for the MSI). Refused: another platform, `web`, an unknown value, two `<Identity>` elements, a `TargetPlatform` named twice or malformed. A manifest with no `<Identity>` makes no claim (the EXT-04 fixtures).
- **Choosing the variant** (`openvsx::choose_variant`): this platform's from `downloads`, else the universal one, else `UnsupportedPlatform` naming what is published, before any package is fetched. The chosen variant's own metadata must say it is that variant (`ManifestMismatch`). Its checksum and signature are verified exactly as before, and the package's own `TargetPlatform` must agree with the choice (`ManifestMismatch`). Platform selection never decides trust. A malformed `downloads` or `targetPlatform` is refused, never guessed.
- **File icon themes** (`vsix.rs`, `manifest.ts`, `registry.ts`, `iconThemes.ts`, `FileIcons.tsx`, the `explorer.iconTheme` setting): see `ARCHITECTURE.md`. Data only, no extension code; icons kept inside the package; SVG only, at most 256 KiB, drawn as images from `data:` URLs; bounded; resolved as VS Code does, with the light variant. Font and PNG icons, the high-contrast variant and product icon themes are not shown.

## F4. Evidence from real packages

Through Yavin's own install path (`openvsx_benchmark_tests.rs`: the registry's record, the download under the marketplace policy, its SHA-256, its signature under the pinned key, unpacking, the adapter), on 2026-10-23, the catalogue's versions:

| Package                             | EXT-29                                             | EXT-30                                                                                  |
| ----------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| pkief.material-icon-theme           | refused: 1278 entries                              | **installs** (1278 files, 1.8 MiB); its theme: 1251 SVG icons, all drawn, 8188 names    |
| vscode-icons-team.vscode-icons      | refused: 1695 entries                              | **installs** (1695 files, 6.8 MiB); its theme: 1504 SVG icons, all drawn, 3009 names    |
| slevesque.shader                    | refused: 2599 entries                              | **installs** (2599 files, 12.7 MiB); 3 languages and 2 grammars apply                   |
| sumneko.lua                         | refused: 2717 entries (the darwin-arm64 package)   | **installs its win32-x64 package** (2732 files, 42.5 MiB)                               |
| charliermarsh.ruff                  | refused: a 16 MiB+ file (the alpine-arm64 package) | **installs its win32-x64 package** (23 files, 27.9 MiB; `ruff.exe` 25 MiB, never run)   |
| zignd.html-css-class-completion     | refused: 1790 entries                              | **installs** (1790 files, 7.3 MiB)                                                      |
| oderwat.indent-rainbow              | refused: 1233 entries                              | **installs** (1233 files, 8.6 MiB)                                                      |
| tamasfe.even-better-toml            | refused: over 20 MiB                               | **installs** (21 files, 68.9 MiB)                                                       |
| eamodio.gitlens                     | refused: `package.json` over 1 MiB                 | unpacks; refused by the adapter: more commands than a generated manifest holds (64 KiB) |
| shd101wyy.markdown-preview-enhanced | refused: over 20 MiB                               | unpacks; refused by the adapter: its scripts are over the 8 MiB code bound              |
| hediet.vscode-drawio                | refused: over 20 MiB                               | refused: over 32 MiB (48.9 MiB)                                                         |
| waderyan.gitblame                   | an ES module                                       | the same (EXT-28)                                                                       |

Activation in the real AppContainer host (`open_vsx_benchmark_activation`): the two icon themes and Indent Rainbow activate (no unsupported API reached; their commands fail); Even Better TOML needs a `Worker`; ruff reads files with Node.js `fs`; Lua's code runs out of the host's memory while loading; the shader package's code is past what Yavin loads (2000 files or 24 MiB, refused natively and recorded); HTML CSS Class Completion fails to load (a class constructor called without `new`). Every host ran in the AppContainer sandbox (50/50).

The real icon theme files were also read by the window's parser from their unpacked packages: for `package.json`, `README.md`, `main.rs`, `Cargo.toml`, `app.tsx`, `index.ts`, `app.test.ts`, `.gitignore`, `Dockerfile`, `src/`, `node_modules/` and `.git/`, each theme gives its own icon (Material: nodejs, readme, rust, toml, react_ts, typescript, test-ts, git, docker, folder-src, folder-node, folder-git).

## F5. Tests

| Where                                                    | New tests | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/extension_package.rs`                     | 8         | A 2801-entry package unpacked whole (its copy digest within bounds); 5001 entries refused; a 401-byte name and 33-deep nesting refused, the longest measured accepted; the time bound; 200 files written then a bomb: nothing left; `TargetPlatform` read strictly (all twelve platforms, quoting, a look-alike attribute, unknown, empty, two `<Identity>`, named twice, unquoted, unclosed, malformed); only this platform's or a universal package unpacked (another, `web`, unknown: refused before anything is written); a 1.1 MiB `package.json` read, 2.1 MiB refused                                                                                                                                                      |
| `src-tauri/src/openvsx_tests.rs` (a local fake Open VSX) | 2         | `choose_variant`: answered with this platform's or universal; no platform fields; another's answered and this one's fetched; this one's preferred to universal; universal as fallback; only others or `web` published: refused naming them; malformed `targetPlatform` or `downloads` refused; unknown platforms and non-URL downloads not offered. End to end through the inventory: this platform's variant installed, signed and checksummed, and the other's never fetched; only another's published: refused before any package; lying metadata: refused before any package; a package that says it is another platform's: refused; a universal choice whose package is a platform's: refused; a universal package installed |
| `src-tauri/src/vsix_tests.rs`                            | 1         | Material Icon Theme's contribution kept with its file; product icon themes still reported; refused for a bad id, a non-JSON path, a missing file, a path leaving the package; at most 50 kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/services/extensions/iconThemes.test.ts` (new)       | 11        | The theme file (SVG only; font, PNG, outside and empty paths said); malformed files; bounds; paths kept inside the package; VS Code's choice of icon and the light variant; SVG drawn only as an image; the store (read once, on use; switching; a disabled extension; unreadable and invalid themes); the setting; the manifest's check; a registry change that leaves the themes unchanged redraws nothing                                                                                                                                                                                                                                                                                                                      |
| `tests/ui/terminal.spec.ts` (mock window)                | 1         | A theme chosen in Settings: its icons in the explorer by extension, name, folder and default, drawn as images (a scripted SVG never runs); an icon missing from the package or outside it is Yavin's; the editor tab's icon; back to Yavin's; the choice kept across a reload                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## F6. Benchmark: before and after

The same 64 extensions; EXT-27's catalogue; the records in [`benchmark/openvsx/ext30/`](benchmark/openvsx/ext30/) (`scripts/openvsx-benchmark.mjs` now also checks icon themes with the window's own parser).

| Measure                                        | EXT-29                                             | EXT-30                                                     |
| ---------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Installed through Yavin's install path         | 52/64 (81.3%)                                      | **60/64 (93.8%)**                                          |
| With code the layer runs / loaded / activated  | 42 / 34 / 14                                       | 50 / 39 / **17**                                           |
| Declarative checks passed                      | 108/110                                            | 119/121 (two icon themes added)                            |
| Main feature works                             | 15 yes, 5 partly, 44 no                            | **18 yes**, 5 partly, 41 no                                |
| Verdicts (gap analysis)                        | 9 Compatible, 11 with limitations, 44 Incompatible | 9 Compatible, **14** with limitations, **41** Incompatible |
| Hosts confirmed in the AppContainer sandbox    | 42/42                                              | 50/50                                                      |
| Platform packages installed as this platform's | 0 (whatever Open VSX answered)                     | 2 (sumneko.lua, charliermarsh.ruff: win32-x64)             |

**What this means.** Three main features now work that did not: the two file icon themes and the shader grammars. Five more packages install but their main feature still does not work, for reasons the package limits never touched: a language server or binary (Lua, ruff, Even Better TOML), or code the runtime does not run (HTML CSS Class Completion; Indent Rainbow's decorations are not verified). The four still refused are refused by bounds kept on purpose: draw.io's 48.9 MiB archive, GitLens's command count, Markdown Preview Enhanced's code size, and Git Blame's ES module.

A first native run on 2026-10-23 lost nine downloads to the network (`No such host`, `Peer disconnected`); the run was repeated whole, and those records are the repeat's.

## F7. Verification

In the module's order; one memory-intensive suite at a time, memory checked before each mutation.

| Check                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Targeted: `extension_package`, `openvsx`, `vsix`, `marketplace`         | 15/15, 12/12 (2 network tests ignored), 8/8, 10/10; `iconThemes.test.ts` 11/11; the EXT-30 UI test 1/1                                                                                                                                                                                                                                                                                                                       |
| Rust, default build (`cargo test --workspace --no-fail-fast`)           | **923 passed, 0 failed**, 27 ignored, all 47 test binaries run, none blocked. Four real-host tests had their extension's load interrupted by the deadline under the full parallel run and passed alone (`the_hosts_memory_is_capped_as_a_whole`, `a_retired_host_cannot_act_through_the_bridge`, `two_windows_hold_different_extensions`, `two_windows_run_the_same_extension_independently`)                                |
| Rust, `test-registry` build                                             | 522 of 522; three real-host tests interrupted the same way passed alone                                                                                                                                                                                                                                                                                                                                                      |
| Clippy `-D warnings`, both builds; `cargo fmt --check`                  | clean                                                                                                                                                                                                                                                                                                                                                                                                                        |
| TypeScript (`npm test`)                                                 | **1063 passed, 0 failed**, 1 skipped, 1 todo                                                                                                                                                                                                                                                                                                                                                                                 |
| `tsc --noEmit`; `prettier --check .`                                    | clean                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Security mutations, EXT-30 (`scripts/security-mutations.json`, X01–X14) | **14 of 14 caught**, each by its intended test. X12 (a variant's lying metadata) first survived: a later check still refused the package, so the test could not tell them apart; the test now requires the refusal at the metadata step, before any package is fetched, and catches it                                                                                                                                       |
| Security mutations rerun on changed files                               | EXT-09 M1, M7, M10, EXT-20 M8, M9, EXT-21 M12, EXT-25 C1: 7 of 7 caught                                                                                                                                                                                                                                                                                                                                                      |
| Conformance mutations, EXT-30 (I1–I8, icon themes)                      | **8 of 8 caught**                                                                                                                                                                                                                                                                                                                                                                                                            |
| Mock UI suite (`tests/ui`, 4 workers)                                   | **478 of 478**: 477 in the run; `long histories page in and render only the rows in view` (Local History) failed while a game used the CPU, alone too and at the same rate with or without EXT-30's icon code (3 of 4 each), then passed alone 3/3 once the machine was idle                                                                                                                                                 |
| Benchmark                                                               | Native install and activation rerun (§F4, §F6); records in `benchmark/openvsx/ext30/`                                                                                                                                                                                                                                                                                                                                        |
| Packaged: a freshly built MSI (`scripts/e2e-real-host.mjs`)             | **17/17** (Yavin IDE 2.2.0, built 2026-10-23), install, upgrade, marketplace, trust and recovery tests. **Unresolved: the foreground-focus test** (the 18th, EXT-29's open item). Run twice on this MSI once the machine was idle (390 s and more): both times Playwright's trace-recording fixture timed out in setup (180 s), before the test's body ran; no Code Integrity block was logged. It is not counted as passing |

**Environment.** Smart App Control blocked binaries throughout (os error 4551, Code Integrity events 3077). An interrupted mutation run had left the debug build without some libraries' `.rlib` files; the debug profile was cleared and rebuilt, which took eight rounds of deleting blocked build-script folders and retrying. No security control was changed. The mutation runner's `--only` selects ids by prefix (`EXT-30 X1` matched X10–X14); the interrupted run left X10 applied, which was found by the target check and restored exactly, and the EXT-30 ids were renumbered X01–X14 so that none is a prefix of another.

## F8. Security implications

- **Larger bounds, the same controls.** Every name, link, case and ratio rule is unchanged, and two controls are new (a whole name's length, a time limit). The larger byte bounds raise the worst case of a hostile package to 128 MiB of disk for at most 120 s, refused and removed if it exceeds them.
- **The right package.** Before EXT-30, a platform package from Open VSX could be another OS's: a Linux or macOS binary unpacked into the store. Now only this platform's or a universal package installs. Nothing in a package is run at install, as before.
- **Icons.** An icon theme reaches the window as text through the existing contained read; an icon is drawn only as an image (no script, no external load, CSP `img-src 'self' data:` as before); paths cannot leave the package.
- **Unchanged:** signatures, checksums, the signed index, the inventory and copy digests, the native capability checks, and the sandbox.

## F9. Known limitations

- Archives over 32 MiB (draw.io), files over 48 MiB, more than 5000 entries.
- `web` packages (VS Code in a browser) are not installed, though Yavin runs extensions' `browser` entry: Open VSX's `web` target is a different distribution, not tested here.
- Platform selection is Open VSX's; Yavin's own registry has no platform packages.
- Icon themes: no font-character or PNG icons, no high-contrast variant, no product icon themes, no `hidesExplorerArrows`. Theme icons appear wherever Yavin draws a file's icon (the explorer, editor tabs, search results, Source Control, diffs, the welcome page); the Problems view draws none.
- ES modules (Git Blame) remain unsupported (EXT-28).

---

# Part E: EXT-29, core VS Code API completion

**Base:** `main` at `26ff399` (EXT-24), with the uncommitted changes of EXT-25 to EXT-28 in place.

**The question.** EXT-28 removed the runtime from the path of five extensions; their next blockers, and the most-named unsupported APIs in the benchmark's static scan, were VS Code's core editor APIs (phase P2, §A6). EXT-29 implements a small, coherent set of them end to end: in the layer, the protocol, both permission checks, the window, and Yavin's own UI. Each is tested in the real host and in the window.

## E1. The evidence that chose the work

From EXT-28's records (`benchmark/openvsx/ext28/`):

| API                                                          | First failure at EXT-28                                      | Named by (static scan of 42 entry points) |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------- |
| `workspace.createFileSystemWatcher`                          | Better TOML, SVG (activation)                                | 17                                        |
| `window.showQuickPick`                                       | Change Case's 17th command; npm IntelliSense's command       | 17                                        |
| `window.showInputBox`                                        | Rewrap's commands                                            | 15                                        |
| `languages.registerDocumentFormattingEditProvider` and range | —                                                            | 13 and 12                                 |
| `workspace.onDidSaveTextDocument`, `onWillSaveTextDocument`  | —                                                            | 13 and 12                                 |
| `languages.registerCodeActionsProvider`                      | shellcheck (activation)                                      | 11                                        |
| `window.onDidChangeTextEditorSelection`                      | markdownlint (activation), Vim                               | 8                                         |
| `languages.createDiagnosticCollection` (PARTIAL)             | shown as underlines only, not in Problems; no related places | —                                         |

markdownlint's web bundle uses exactly this set: selection events, diagnostics, code actions, save events and file watchers.

**Deferred, with the reason:**

- `createQuickPick` and `createInputBox` (7 and 5 extensions name them). They are stateful widgets with buttons, busy states and item events. The simple forms come first and cover every benchmark failure.
- `languages.getDiagnostics` and `onDidChangeDiagnostics` (Error Lens). They need the Problems store's contents from all owners, which is a read across extensions, and a privacy decision of its own.
- File-operation events (`onDidCreateFiles` and similar) and webviews: no benchmark failure in this set.

## E2. What was implemented

| API                                                                      | How                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `showQuickPick`                                                          | `window.quickPick` with an id the extension owns (`<id>#prompt#n`), shown in Yavin's dialog style, naming the extension (`ExtensionPrompt.tsx`). Items or a promise of items (at most 5000), separators, `canPickMany`, `matchOnDescription`/`matchOnDetail`, `title`, `placeHolder`, `ignoreFocusOut`, a cancellation token. The answer is validated (indices). |
| `showInputBox`                                                           | `window.inputBox`: value, selection, prompt, placeholder, password, `ignoreFocusOut`. `validateInput` is asked back (`prompt.validate`, 150 ms after typing stops and on accept); an error blocks accepting.                                                                                                                                                     |
| Prompt lifetime                                                          | One `AbortController` per prompt in `host.ts`. A token's cancellation, the extension's next prompt, its stop, crash or disable, and the window closing each answer it with null. Prompts of different extensions queue (at most 8 waiting); no extension can answer or cancel another's.                                                                         |
| `createFileSystemWatcher`                                                | Yavin's native watcher batches, forwarded as `files.change` (the workspace only, at most 500 changes an event, `workspace.fs.read`). Globs and `RelativePattern`, the three ignore flags, dispose, at most 500 watchers. A rename is a delete, then a create; a rename from outside the workspace is a create.                                                   |
| `onDidSaveTextDocument`, `onWillSaveTextDocument`                        | `documents.save` after a save; `documents.willSave` before one, through one hook in `DocumentService.save` that does not re-enter. `waitUntil` only synchronously (as VS Code). Edits only with `documents.edit`, through `DocumentService` (undoable). All extensions share a 1.5 s budget per save; the save never waits longer or fails because of them.      |
| `onDidChangeTextEditorSelection`                                         | The active editor's selections (primary first, at most 100, `reversed`) and kind (keyboard, mouse, command), from Monaco through `cursorStatus`; `documents.read`.                                                                                                                                                                                               |
| `registerDocumentFormattingEditProvider`, `…RangeFormattingEditProvider` | Provider kinds on `provider.invoke`, 5 s limit. Then `provider.cancel` cancels the provider's token. Edits apply only to the model version asked about; out-of-range or overlapping edits are refused; at most 5000 edits and 4 MB.                                                                                                                              |
| `registerCodeActionsProvider`                                            | Monaco's quick fixes: title, kind, `isPreferred`, `disabled`, the extension's own diagnostic objects in the context, edits to the document asked about, a command run in the extension (`codeAction.run`, offered handles only). An action that edits other files is shown disabled, with the reason.                                                            |
| `createDiagnosticCollection`                                             | Now in the Problems view and the editor's markers: batched `diagnostics.set` and `diagnostics.clear` for a collection the extension owns. Range, severity (hint included), source, code and target, tags and related places are validated. Owners are `ext:<generation>:<collection>:<resource>`: one extension never clears another's problems.                 |

**Permissions.** Both checks (`extension_permissions.rs`, `permissions.ts`, the shared `permissions.cases.json`) know every new method and event. Prompts and collections must be the extension's own. File events need `workspace.fs.read`; save, will-save and selection events need `documents.read`. There are now 30 bridge methods on each side; anything else is still denied by default.

**Defects found and fixed while testing:**

- **Provider tokens.** A cancel that arrived while the document was being fetched was lost, because the token was created only afterwards. Tokens now exist from the request on.
- **Cancelled prompts.** A cancelled prompt waited for the window's answer. As in VS Code, it now settles at once, and a late answer is dropped.
- **Already-cancelled tokens.** A listener added to a token that was already cancelled was never called. VS Code calls it, and so does the layer now.
- **Test harnesses.** The bootstrap was assembled with `String.replace` and a string replacement, so `$&` in the layer expanded; they now use function replacements.
- **Mutation runners.** A run in which Smart App Control refused the host (`code: 4551` inside a test's output) counted as "caught". Both runners now call such a run BROKEN.

## E3. Behavioural tests

| Where                                                       | Tests | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/ide-plugin-host/tests/core_api.rs` (new, real host) | 6     | Picker and input box options, answers, invalid indices and a token cancelled before and while open; validation while the box is open and for an unknown id; diagnostics batches, codes, tags, related places, dispose; formatting, a cancelled range formatting, code actions and their commands, an action never offered; save, selection and will-save (a throwing listener, non-edits dropped); watchers with globs, `RelativePattern`, ignore flags, renames and malformed events. |
| `src/services/extensions/vscodeCoreApi.test.ts` (new)       | 12    | The window side: picks; cancellation by token, by stop and by window close; two extensions' queue and replacement; input validation; diagnostics in the Problems store, the workspace's files only, each collection its own, cleared by a stop; formatting and its cancellation; code actions; save and will-save, without `documents.edit` and past the budget; selection events; watchers, and watchers without `workspace.fs.read`.                                                 |
| `tests/ui/terminal.spec.ts` (mock window)                   | 1     | The picker and input box as Yavin's dialogs naming the extension; filtering, separators; Escape cancels; a value failing validation is refused with the extension's message; the diagnostic in Problems.                                                                                                                                                                                                                                                                               |
| Updated                                                     | —     | `conformance.rs` and `vscodeConformance.test.ts`: diagnostics are in the Problems store, not decorations. `vscode.rs`: the unsupported examples are now `showOpenDialog` and `registerRenameProvider`. `permissions.cases.json`: the new methods and events.                                                                                                                                                                                                                           |

## E4. Real extensions: what changed

The benchmark's selection and packages are unchanged (EXT-27's downloads). Activation was run again in the real AppContainer host; the records are in [`benchmark/openvsx/ext29/`](benchmark/openvsx/ext29/). The benchmark's stand-in window answers prompts as cancelled. So a command that asks a picker "runs" there; the picker itself is tested in the window (§E3).

| Extension                         | EXT-28                                                | EXT-29                                                     | What now stops it                                            |
| --------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| bungcip.better-toml               | fails at activation: `createFileSystemWatcher`        | **activates**                                              | its validation is a language server (`net`)                  |
| jock.svg                          | fails at activation: `createFileSystemWatcher`        | **activates; minify and copy-data-URI run** (3/6 commands) | preview is a webview; `fs.lstat`                             |
| wmaurer.change-case               | 16/17 commands (`showQuickPick`)                      | **17/17 commands; verdict Compatible**                     | —                                                            |
| christian-kohler.npm-intellisense | command fails: `showQuickPick`                        | **command runs**                                           | its items come from reading `package.json` (`fs`)            |
| stkb.rewrap                       | 0/3 commands (`showInputBox`)                         | **1/3** (rewrapCommentAt)                                  | Rewrap Comment: an undefined thenable; configuration inspect |
| davidanson.vscode-markdownlint    | fails at activation: `onDidChangeTextEditorSelection` | fails at activation, later                                 | `vscode.CustomExecution` (tasks)                             |
| vscodevim.vim                     | 0/3: `onDidChangeTextEditorSelection`                 | 0/3, later                                                 | `onDidChangeTextEditorVisibleRanges`; the type command       |
| timonwong.shellcheck              | fails at activation: `registerCodeActionsProvider`    | fails at activation, later                                 | `registerDocumentLinkProvider`; shellcheck is a process      |

| Measure                                | EXT-28                                             | EXT-29                                                 |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| Installed                              | 52 of 64                                           | 52                                                     |
| Activate                               | 12                                                 | **14**                                                 |
| Contributed commands run without error | 43/52                                              | **49/58** (more commands reached)                      |
| Main feature works                     | 15 yes, 5 partly, 44 no                            | 15 yes, 5 partly, 44 no                                |
| Verdicts                               | 8 Compatible, 12 with limitations, 44 Incompatible | **9** Compatible, 11 with limitations, 44 Incompatible |
| EXT-29's APIs in the unsupported scan  | 9 APIs, named by 8 to 17 extensions each           | **none**                                               |

**What this means.** EXT-29 changes no main-feature judgment. Every extension it unblocked stops next at something else: a language server, a webview, Node.js's file system, tasks, or another editor API. It removes the most-named core gap from the path, and gives Change Case its last command. It does not make the linters or formatters work, because each of those runs a process or a language server (phases P5 and P6).

## E5. Inventory

Nine entries moved from UNSUPPORTED to PARTIAL, each with L2 evidence (both test files), and L3 or L4 where shown: `showQuickPick`, `showInputBox`, `onDidChangeTextEditorSelection`, `createFileSystemWatcher`, `onDidSaveTextDocument`, `onWillSaveTextDocument`, both formatting providers, and `registerCodeActionsProvider`. `createDiagnosticCollection` stays PARTIAL: it is now in Problems, and its notes say what is bounded. All are PARTIAL because each notes a documented subset.

| Status      | EXT-28 | EXT-29 |
| ----------- | ------ | ------ |
| FULL        | 22     | 22     |
| PARTIAL     | 88     | **97** |
| UNSUPPORTED | 83     | **74** |
| Entries     | 193    | 193    |

## E6. Verification

Run in the order the module asks for. One memory-intensive suite at a time; memory was checked before each mutation.

| Check                                                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Targeted: `core_api.rs`, `vscodeCoreApi.test.ts`, conformance, permissions       | 6/6; 12/12; 16/16 and 13/13; window-side permission tests pass                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Rust, default build (`cargo test --workspace --no-fail-fast`)                    | **912 passed, 0 failed**, 27 ignored, all 47 test binaries run. Smart App Control refused 10 binaries on the first pass and 4 on the second (os error 4551); each was rebuilt and run. `a_lone_read_is_sent_within_the_batch_latency` (terminal) took 289 ms under load and passed alone.                                                                                                                                                                                                                   |
| Rust, `test-registry` build (`cargo test -p yavin-ide --features test-registry`) | 511 of 511 pass. `secrets_are_kept_natively_and_never_reach_the_window` failed once in the parallel run (the OS credential store under contention), then passed alone 3/3                                                                                                                                                                                                                                                                                                                                   |
| Clippy `-D warnings`, both builds; `cargo fmt --check`                           | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| TypeScript (`npm test`)                                                          | **1052 passed, 0 failed**, 1 skipped, 1 todo. In one earlier full run, a grammar test hit its tokenizer time limit under load; it passed alone 3/3 and in the next full run.                                                                                                                                                                                                                                                                                                                                |
| `tsc --noEmit`; `prettier --check .`                                             | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Conformance mutations, EXT-29 (`scripts/conformance-mutations.json`)             | **16 of 16 caught**: C1–C9 (window side), S1–S7 (layer). Two first survived, C2 (a stop leaves problems) and C6 (clear() of one collection clears the others); each got a test, then was caught. S3–S7: the runner's BROKEN runs were Smart App Control refusing the mutated build; replayed until an unblocked run, each failed its test (S4 by hand).                                                                                                                                                     |
| Conformance mutations, earlier ones near EXT-29's code                           | EXT-27 W1, W3–W8 (window side): 7 of 7 caught. B3, B4 and B6 (layer; B6 retargeted to the new severity mapping): caught                                                                                                                                                                                                                                                                                                                                                                                     |
| Security mutations (`scripts/security-mutations.json`)                           | **4 of 4 caught**: EXT-29 P1–P2 (native ownership of collections and prompts), and EXT-25 P1–P2 rerun, since `extension_permissions.rs` changed. No other native file changed.                                                                                                                                                                                                                                                                                                                              |
| Mock UI suite (`tests/ui`, 4 workers)                                            | **477 of 477**: 476 in the run; `long histories page in and render only the rows in view` (local history) timed out under load and passed alone 2/2. The new EXT-29 test: 3/3.                                                                                                                                                                                                                                                                                                                              |
| Benchmark                                                                        | Activation rerun in the real host (§E4); analysis and gaps in `benchmark/openvsx/ext29/`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Packaged: a freshly built MSI (`scripts/e2e-real-host.mjs`)                      | **17/17** (Yavin IDE 2.2.0). Smart App Control refused the first two builds' `yavin-ide.exe` (`spawn UNKNOWN`, Code Integrity 3077); the third link ran. **Not counted: the foreground-focus test** (the 18th), reported apart as environmental contention. It ran once after 127 s idle, but the user became active during its 27 s; the other window took the foreground, and Yavin still showed itself focused. No 5-minute idle window came in the next 15 minutes, so it is outstanding, as at EXT-28. |

## E7. Security

- **No new reach.** No file system, process or Node.js access. Watchers see only the workspace's paths that Yavin's watcher already reports, and only with `workspace.fs.read`.
- **Bounded.** Prompt items (5000), waiting prompts (8), watchers (500), file events (500 changes, 5000 a batch), diagnostics (200 files a request, 1000 a file, 5000 files an extension), provider edits (5000, 4 MB), offered code actions (500), the will-save budget (1.5 s a save) and the formatting limit (5 s).
- **Owned.** Prompt ids and collections are checked natively and in the window. An extension cannot answer, validate or cancel another's prompt, or clear another's problems. A late answer, from a stopped host or a cancelled prompt, is dropped.
- **URIs.** They are canonical: Yavin's spelling, the drive with its colon, inside the workspace. Untitled documents' diagnostics are skipped. Related places outside the workspace are dropped.
- **Edits.** Formatting, code actions and will-save edits go through `DocumentService` or the editor's own edit operations: checked against the version, undoable, the document left dirty. Will-save edits need `documents.edit`.

## E8. Known limitations

- `createQuickPick` and `createInputBox`, `onDidSelectItem`, item buttons and icons in pickers.
- Selection events for the active editor only (Yavin shows one).
- Watchers for the opened folder only; no file-operation events.
- Code actions: no `resolveCodeAction`, no provider metadata, no edits to other files.
- Diagnostics: not readable by extensions (`languages.getDiagnostics`, `onDidChangeDiagnostics`).
- Will-save edits are dropped once the shared 1.5 s budget is spent, as the save goes on.

---

# Part D: EXT-28, JavaScript runtime compatibility

**Base:** `main` at `26ff399` (EXT-24), with EXT-25's, EXT-26's and EXT-27's uncommitted changes in place.

**The question.** EXT-26's roadmap put runtime globals first (phase P1, §A6). EXT-28 asks which runtime gaps stop real extensions, and implements what can be done correctly in QuickJS, with behavioural tests and failure cases. Importing a global is not counted as compatibility.

## D1. The evidence that chose the work

Measured on the benchmark's 42 extensions with code (EXT-27's records, `benchmark/openvsx/ext27/`):

| Gap                     | First failure of                                                | Used by (static scan of the packages) | What they use                                                                                        |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `URL`                   | Code Spell Checker (at load)                                    | 15                                    | `new URL`, `URLSearchParams`                                                                         |
| `Intl`                  | markdownlint, Go (at load); Sort Lines' natural sort (when run) | 7                                     | `Collator` (4), `ListFormat` (3), `Segmenter` graphemes (3), `DateTimeFormat` (1); no `NumberFormat` |
| `crypto`                | YAML (at load)                                                  | 6                                     | `getRandomValues` (6), `randomUUID` (2)                                                              |
| `process.versions.node` | File Utils, Git History (at load)                               | 13                                    | parsing Node.js's version                                                                            |
| `AbortController`       | none                                                            | 8                                     | `AbortController`, `AbortSignal`                                                                     |
| `structuredClone`       | none                                                            | 2                                     | deep copies                                                                                          |
| ES modules              | none (Git Blame refused at install)                             | 1                                     | `type: module`                                                                                       |

The engine's own globals were probed in the real host (quickjs-ng 0.16.2):

- **Present:** `performance`, `WeakRef`, `FinalizationRegistry`, `DOMException`, Unicode property escapes, `normalize`.
- **Absent:** `URL`, `URLSearchParams`, `Intl`, `crypto`, `structuredClone`, `EventTarget`, `Event`, `AbortController`, `AbortSignal`, `navigator`.

QuickJS's native `localeCompare` compares code units (`B a b á`). Node.js gives `a á b B`, and 20 of the packages call it.

## D2. What was implemented

Everything is JavaScript inside the sandboxed host, except one native function: `__yavin_random`, the operating system's random bytes. It is captured and removed from `globalThis` before any extension code runs. Each global is installed only where the engine has none, so Node.js and browser realms keep their own.

| Feature                                                  | Where                        | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `URL`, `URLSearchParams`                                 | `ide-plugin-host/src/web.js` | The WHATWG URL Standard's basic parser (every state), serializer, origin and setters, with these parts: <br>- IPv4 and IPv6 parsing and serialization; <br>- percent-encode sets; <br>- opaque paths; <br>- Windows drive letters in file URLs; <br>- application/x-www-form-urlencoded. <br>`canParse` and `parse`; `searchParams` linked to its URL. A host with non-ASCII letters: lower-case, NFC, Punycode (RFC 3492); an undecodable `xn--` label is refused.                                                                                                                                                               |
| Node.js `url`                                            | `vscode.js`                  | `URL`, `URLSearchParams`, `domainToASCII`; `fileURLToPath` and `pathToFileURL` with Node.js's Windows rules: <br>- the drive keeps its case (EXT-27's layer lower-cased it); <br>- UNC paths; <br>- encoded separators are refused; <br>- a rooted path without a drive goes on the extension folder's drive; <br>- a relative path fails with `UnsupportedApi` (no working directory).                                                                                                                                                                                                                                           |
| `Intl`                                                   | `intl.js`                    | `Collator` (root collation for Latin: accents, case, the expansions `ß` and `æ`, digits and numeric runs, ASCII punctuation, every option; sort keys, cached), `Segmenter` (extended grapheme clusters, UAX #29, including GB9c), `ListFormat` (every type and style), `DateTimeFormat` (the en-US patterns, UTC and the host's zone), `getCanonicalLocales`, `supportedLocalesOf`. `Collator` and `DateTimeFormat` may be called without `new`, as ECMA-402 allows. `String.prototype.localeCompare` uses the collator. English only.                                                                                            |
| `crypto`                                                 | `web.js`, `runtime.rs`       | `getRandomValues` (integer typed arrays, at most 65,536 bytes) and `randomUUID`, from `getrandom` (ProcessPrng on Windows); never `Math.random`. `crypto.subtle` fails with `UnsupportedApi`; `CryptoKey` cannot be constructed.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Node.js `crypto`                                         | `vscode.js`                  | The random part only: <br>- `randomBytes` (sync or with a callback, in 64 KiB parts); <br>- `randomInt` (unbiased); <br>- `randomUUID`, `getRandomValues`, `randomFillSync`, `webcrypto`. <br>Hashes and ciphers fail with `UnsupportedApi`.                                                                                                                                                                                                                                                                                                                                                                                      |
| `EventTarget`, `Event`, `AbortController`, `AbortSignal` | `web.js`                     | Listeners (`once`, `signal`, `handleEvent` objects), cancelable events, `onabort`, `throwIfAborted`, `AbortSignal.abort`, `timeout` and `any`. A listener's failure is logged and the dispatch goes on.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `structuredClone`                                        | `web.js`                     | Values, `Date`, `RegExp`, binary data, `Map`, `Set`, arrays, objects and errors, with shared references and cycles. Anything else is a `DataCloneError`; `transfer` is unsupported.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `navigator`                                              | `web.js`                     | Node.js 21+ has one. Said as it is: `userAgent` "Yavin-Extension-Host (Windows NT 10.0; Win64; x64)" (no browser or Node.js claimed), `language` `en-US`, `platform` `win32`, `hardwareConcurrency` 1.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CommonJS, as Node.js                                     | `vscode.js`                  | <br>- One `require.cache` for the extension, keyed by file name; deleting an entry loads the file again. <br>- A module whose code throws is not kept: requiring it again runs it again (before, it returned the half-built exports). <br>- `module.parent`, `children`, `require`, `path`, `paths`; `require.main`, with `id` `"."`. <br>- `require.resolve` of a built-in is its name; `require.resolve.paths`. <br>- An absolute path is found only inside the extension's package, and climbing out of the package is `MODULE_NOT_FOUND`; the native side sends only the package's `extension/` files, and no symbolic links. |
| Unhandled promise rejections                             | `runtime.rs`                 | Before EXT-28 they were lost. Now said in the extension's log once the entry's jobs have run, as Node.js says them: a rejection handled later in the same entry is not reported; at most ten per entry, and the rest are counted.                                                                                                                                                                                                                                                                                                                                                                                                 |

## D3. Deferred, with the evidence

| Feature                                                                                                                               | Why it is deferred                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ES modules                                                                                                                            | One benchmark extension, Git Blame, is an ES module, and its main feature runs `git`, a process (phase P6), so loading it would gain nothing. Doing it properly needs QuickJS's module loader with a resolver held to the package: `rquickjs`'s `loader` feature, a new dependency (`relative-path`). Emulating module linking in JavaScript would be the misleading stub the module forbids. |
| `process.versions.node`                                                                                                               | File Utils and Git History parse it at load. Giving a Node.js version would claim a runtime Yavin does not have. Both extensions' main features then need `fs` or `git` anyway (phases P2 and P6), so nothing would be gained.                                                                                                                                                                |
| `Intl.NumberFormat`, `PluralRules`, `RelativeTimeFormat`, `DisplayNames`, `Locale`, `DurationFormat`; `Segmenter` by word or sentence | No benchmark extension uses them. Each fails with `UnsupportedApi`, named and logged once, rather than answering wrongly.                                                                                                                                                                                                                                                                     |
| Locales other than English; IANA time zones                                                                                           | They need CLDR and tz data, which QuickJS has no source for. Any other locale resolves to `en-US`. The host's own zone is named by its offset (`UTC`, or one such as `+05:30`, which ECMA-402 allows); the window's IANA name would need a protocol change.                                                                                                                                   |
| UTS #46's full mapping table                                                                                                          | For hosts, Yavin lower-cases, applies NFC and Punycode. A few exotic inputs (fullwidth letters, deviation characters) map differently from a browser. None is in the benchmark's packages.                                                                                                                                                                                                    |
| `crypto.subtle`, Node.js hashes and ciphers                                                                                           | Implementing cryptography in JavaScript is not a decision for this module. These fail with `UnsupportedApi`.                                                                                                                                                                                                                                                                                  |
| `package.json` `exports` maps, `require.extensions`                                                                                   | No benchmark extension's bundle needs them: bundles resolve through `main` and `index`.                                                                                                                                                                                                                                                                                                       |

## D4. Behavioural tests

`crates/ide-plugin-host/tests/runtime.rs` (17 tests) runs each feature in the real host process, under the production limits (64 MiB, 2 s per call).

**Against Node.js's own answers.** `scripts/runtime-vectors.mjs` takes them from Node.js 24 (ICU, the WHATWG URL parser) into `tests/fixtures/runtime-vectors.json`; the extension compares and returns what differs (nothing):

- 121 URL inputs: valid, failing and relative, special and opaque, IPv4 and IPv6, IDNA, file URLs, dot segments, percent-encoding;
- 36 setters;
- `URLSearchParams` parsing and operations;
- Node.js's `url` module on Windows;
- 9 collator option sets over 79 words (every pair);
- every `ListFormat` type and style;
- 16 grapheme texts (emoji ZWJ sequences, flags, Hangul, Indic conjuncts, CRLF, lone surrogates);
- 23 date formats, at 3 dates.

**Semantics and failures:**

- **URL errors:** `TypeError` with the code `ERR_INVALID_URL`, and malformed input terminates.
- **Locales:** canonical names, `RangeError`.
- **`Intl`:** what it does not provide is `UnsupportedApi`, said once.
- **Random values:**
  - the native function is not reachable;
  - replacing `Math.random` changes nothing;
  - 64 KiB of bytes are near-uniform;
  - the quota and type errors are DOMExceptions;
  - 1,000 distinct v4 UUIDs;
  - Node.js's `randomBytes` and `randomInt` bounds and errors;
  - a request beyond the memory limit is refused, and the host goes on.
- **Events and abort signals:** `once`, a listener's failure, `AbortSignal.timeout` firing through the host's timers.
- **`structuredClone`:** cycles and the values it refuses.
- **CommonJS:**
  - a circular require sees the partial exports;
  - a module whose code threw runs again;
  - deleting from `require.cache` reloads;
  - malformed JSON is not kept;
  - absolute paths inside the package, in either case, load;
  - outside it, or climbing out, `MODULE_NOT_FOUND`.
- **Unhandled rejections:** said; one handled later is not; ten at most, then counted.
- **Timers:** a throwing interval goes on; microtasks run before timers; after unload, nothing runs.
- **Isolation:** two extensions do not share prototypes, `Intl`, `require.cache` or random values.
- **Speed:** sorting by the collator fits a call. In the release host, 2,000 lines take 70 ms and 500 accented lines 29 ms (debug: 0.66 s and 0.21 s).

**Mutations.** `conformance-mutations.json` gains R1–R21, each caught (§D6).

## D5. Real extensions: what changed

The benchmark's selection is unchanged. Native install outcomes cannot change, since runtime code runs only at load and activation. EXT-27's downloaded packages were reused. Activation was run again in the real AppContainer host; the records are in [`benchmark/openvsx/ext28/`](benchmark/openvsx/ext28/).

| Extension                             | EXT-27                                                                 | EXT-28                                              | What now stops it                                                          |
| ------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| tyriar.sort-lines                     | active; 13 of 14 commands (natural sort failed: `Intl is not defined`) | **active; 14 of 14 commands edit the document**     | —                                                                          |
| redhat.vscode-yaml                    | fails at load: `crypto is not defined`                                 | **loads and activates**, no unsupported API reached | its features are a language server in a worker                             |
| davidanson.vscode-markdownlint        | fails at load: `Intl is not defined`                                   | **loads**; fails at activation                      | `window.onDidChangeTextEditorSelection` (P2)                               |
| golang.go                             | fails at load: `Intl is not defined`                                   | **loads**; fails at activation                      | `ExtensionContext.environmentVariableCollection` (P2); gopls is a process  |
| streetsidesoftware.code-spell-checker | fails at load: `URL is not defined`                                    | **loads**; fails at activation                      | `ExtensionContext.globalStorageUri` (P2); its checker is a language server |

| Measure                                      | EXT-27                                             | EXT-28                                         |
| -------------------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| Installed                                    | 52 of 64                                           | 52                                             |
| Activate                                     | 11                                                 | **12**                                         |
| Fail at load                                 | 12                                                 | **8**                                          |
| Fail at activation                           | 19                                                 | 22 (the three that now load)                   |
| Main feature works                           | 15 yes, 5 partly, 44 no                            | 15 yes, 5 partly, 44 no                        |
| Verdicts                                     | 8 Compatible, 12 with limitations, 44 Incompatible | the same                                       |
| Blocked first by a missing JavaScript global | 6                                                  | **2** (both `process.versions.node`, deferred) |

**What this means.**

- **Sort Lines:** the one main-feature gain within a feature already counted as working. Its natural sort now runs, and its verdict stays "Compatible with limitations" for its menus and keybindings.
- **The other four:** their next blockers are VS Code APIs (phase P2) and language servers (P6). EXT-28 removed the runtime from their path; it did not make them work.
- **Everything else:** all 37 other activation outcomes are identical to EXT-27's. A few gained request counts or install retries (os error 4551).

## D6. Verification

| Check                                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime conformance (`tests/runtime.rs`)                                                  | **17/17**, in the real host under the production limits; against Node.js's answers where it has them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Extension host crate                                                                      | conformance 16, runtime 17, `host` 10, `vscode` 4, unit 3: all pass. One EXT-27 expectation was corrected to Node.js's answer: `fileURLToPath` keeps the drive's case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Rust, default build (`cargo test --workspace --no-fail-fast`)                             | **906 passed, 0 failed**, 27 ignored, all 46 test binaries run (EXT-27: 889 in 45; the 17 runtime tests are the new binary)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Rust, `--features test-registry`                                                          | **906 passed, 0 failed**, 27 ignored, all 46 binaries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `cargo fmt --check`; `cargo clippy --workspace --all-targets -- -D warnings`, both builds | Clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TypeScript (`npm test`), `tsc --noEmit`, Prettier (whole repository)                      | **1040 passed, 0 failed** (1 skipped and 1 to-do, both from before); typecheck clean; Prettier clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `scripts/runtime-vectors.mjs --check`                                                     | The fixture is what Node.js 24 writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Security mutations (`security-mutations.mjs`, 109)                                        | **109/109 caught.** <br>- **Runs:** 26 in a full run, until memory ran out (Claude Code stopped it, during EXT-11 N8); the other 83 in ten batches of 4–11, one mutation at a time, with free memory checked before each (lowest: 5.5 GB). <br>- **Two interruptions** (the memory stop, and a session ending during EXT-19 M1) each left one mutation applied, EXT-11 N8 and EXT-19 M10. Each was reverted exactly, and every target was checked in its original form before going on.                                                                                                                                                                            |
| Conformance mutations (`conformance-mutations.mjs`, 38)                                   | **38/38 caught**, in five batches: EXT-27 B1–B9 and W1–W8; EXT-28 R1–R21. All 148 mutation targets of both sets were in their original form after every mutation and at the end.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Mock UI (Playwright, 4 workers)                                                           | **476/476** (8.0 min), including the EXT-27 window test with the new layer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Packaged: the full suite on a freshly built MSI (`scripts/e2e-real-host.mjs`)             | **18/18** (Yavin IDE 2.2.0, built for this run)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Packaged: the EXT-28 runtime in the installed host                                        | The VS Code probe of `tests/real/vscode.spec.ts` now shows a status item computed at activation from `URL`, `Intl.Collator` and `crypto`. It read "Runtime https://e.com/b?x=1 x9,x10 4" in **3 of 3** runs. <br>In 2 of those runs, the same test's later OS focus steps failed: "Probe focused" expected, "Probe unfocused" read. During them the user was working on the machine (the foreground window was their browser), so Windows' foreground lock takes the foreground back. The focus steps passed 5/5 at EXT-27, again in the 18/18 run above, and in the third run here. **Classed environmental**, assertions unchanged; to rerun on an idle machine. |
| Benchmark                                                                                 | Activation rerun (§D5); analysis and gaps in `benchmark/openvsx/ext28/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Protected files (`resources/search/COPYING`, `LICENSE-MIT`, `UNLICENSE`, `VERSION.txt`)   | Untouched; SHA-256 unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**How each failure was classed.**

- **Regressions:** none open.
- **Defects found while building EXT-28, and fixed before the final runs:**
  - collation too slow for whole files (sort keys and a cache);
  - `Intl.DateTimeFormat()` not callable without `new` (YAML's first EXT-28 failure);
  - the `host` setter rolling back on a bad port;
  - ICU's U+202F in date parts against a space in `format()`.
- **Environmental:**
  - memory exhaustion (other applications; the mutation runs left no processes);
  - os error 4551 (Smart App Control), on test binaries and build scripts;
  - OS focus taken by the user's own activity.

## D7. Security and performance

- **No new reach.**
  - Every new global is computation inside the extension's runtime.
  - The one new native function returns random bytes, at most 65,536 per call. It is captured by the bootstrap and removed from `globalThis` before extension code runs, and a test proves it is not reachable.
  - `getrandom` 0.3.4 is already in the lockfile (MIT OR Apache-2.0), so no new crate.
  - The AppContainer, Job Object, memory and time limits, permissions and the protocol are unchanged.
- **Module boundary.**
  - The native side still sends only the package's `extension/` files (`extensions::read_modules`: no symbolic links, real paths checked).
  - The loader adds its own check: an absolute path outside the package, or a relative one climbing out of it, is `MODULE_NOT_FOUND`.
- **Isolation.** Each extension has its own runtime, so its globals, prototypes, `require.cache` and collator caches are its own (tested).
- **Limits.**
  - Random requests over the quota are a `QuotaExceededError`. Node.js's `randomBytes` is filled in parts, and one beyond the memory limit is refused without ending the host (tested).
  - The collator's key cache holds at most 20,000 strings per collator.
  - Unhandled rejections are bounded at ten reports per entry.
- **Cost.**
  - Load time grows by the installed code: 2,038 lines (88 KB) of JavaScript, parsed once per extension (the bootstrap carries it for every extension, as it does `vscode.js`; only a VS Code extension's runs it). Measured on the 30 benchmark extensions that loaded both times (debug host): median load 446 ms at EXT-27, 450 ms now; median difference 37 ms.
  - Sorting by the collator costs a sort key per string, then native string comparisons (§D4).

## D8. Known limitations

- **Locales, zones and host mapping:** English only; the host's offset as its time zone; UTS #46 approximated (§D3).
- **Collation:** other scripts sort by code point after Latin, and the rarer Unicode punctuation after ASCII's. ICU orders them by the root collation's tables.
- **Timeouts:** a call that runs past its deadline is ended and said as the host's error, as before (EXT-25). A request then has no answer of its own.

---

# Part C: EXT-27, VS Code API behavioural conformance

**Base:** `main` at `26ff399` (EXT-24), with EXT-25's and EXT-26's uncommitted changes in place.

**The question.** EXT-26 graded the inventory by evidence and found most of it unproven: 63 entries NOT VERIFIED and two STUB. EXT-27 tests what each provided member _does_, fixes what those tests found, and grades again from the tests alone. "Does" covers:

- its behaviour, events and disposal;
- its permissions;
- what reaches Yavin's own services.

## C1. The harness

| Layer                    | Where                                                                                              | What is real                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real host                | `crates/ide-plugin-host/tests/conformance.rs` (16 tests)                                           | The QuickJS host process, `bootstrap.js` and `vscode.js`, the protocol. A fake window (`World`) answers every request and records it, so each test asserts both what the extension saw and what it asked of the window.                                                                                                         |
| Window side              | `src/services/extensions/vscodeConformance.test.ts` (13 tests), harness `testing/vscodeHarness.ts` | The window's host (`host.ts`) and manager, the registry, settings, storage, the document service, the decoration, provider and status bar stores, and the permission rules. The extension's code runs in an in-process QuickJS double that loads the real `bootstrap.js` and `vscode.js` (`inProcessHost.ts`, now with timers). |
| Focus and edits          | `src/services/windowFocus.test.ts` (5 tests)                                                       | Both focus sources, and the window's edit path (`extensions/documentEdit.ts`).                                                                                                                                                                                                                                                  |
| The window               | `tests/ui/terminal.spec.ts`, "EXT-27 a VS Code extension in the window"                            | The application's React window in a browser, its in-page host running the real layer: the status bar item and its click, the native side's focus events, the language, grammar and comment toggle, an edit and its undo.                                                                                                        |
| The packaged application | `tests/real/vscode.spec.ts`                                                                        | The installed MSI, end to end (§C3).                                                                                                                                                                                                                                                                                            |

**The probe.** Every layer uses a probe extension that runs one step at a time (`probe.run`), so each test says exactly what it does and what it expects. No test waits for an arbitrary time: tests wait for a condition, or let the queue settle through the extension itself.

**Mutation testing.** `scripts/conformance-mutations.mjs` breaks one behaviour at a time and runs the tests that should notice, through Cargo, Node.js or Playwright. Each of the 17 mutations in `scripts/conformance-mutations.json` is caught (§C6).

Two candidates were dropped rather than counted, because no test can observe what they break:

- **The host's own `statusBar.*` check.** It sits behind the permission rule, which decides first, so W6 targets the rule itself.
- **The once-per-entry guard of late activation.** The host never retries a failed activation anyway; the test still asserts that a failing extension is tried once.

## C2. Defects found by the tests, and fixed

| #   | Defect                                                                                                                                                                                                                                                                                              | Since  | Fix                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| D1  | **No extension edit reached a document in the application.** The application's window proxy (`workspaces.ts`) forwarded neither `documents.edit` nor the focus. Window-side tests had passed because they gave the host its window directly; the benchmark's stand-in window answered edits itself. | EXT-25 | `createWindowProxy` (`extensions/window.ts`) forwards every member. A test checks each one, and mutation W1 removes the edit. |
| D2  | **`window.state` was a stub** (always focused), and `onDidChangeWindowState` never fired.                                                                                                                                                                                                           | EXT-25 | Implemented (§C4).                                                                                                            |
| D3  | **An extension installed or enabled after the window started never activated on `onStartupFinished` (or `*`)** until the next window. VS Code activates it at once. Found by the packaged test.                                                                                                     | EXT-25 | The manager starts it when it appears: once per registry entry, never while extensions are held (`manager.ts`). Mutation W7.  |
| D4  | **A status bar text kept surrounding white space** ("Ready ").                                                                                                                                                                                                                                      | EXT-25 | Trimmed after control characters are removed (`host.ts`).                                                                     |
| D5  | **EXT-27's own first focus source was unreliable** (Tauri's focus API, §C4): the packaged test failed in 2 of 5 runs. Found by repeating that test.                                                                                                                                                 | EXT-27 | The OS's foreground window (`window_focus.rs`).                                                                               |

**A test-build-only trust anchor.** The packaged test needs a signed Open VSX mirror on the loopback to stand in for open-vsx.org:

- `package_trust.rs` pins `YAVIN_TEST_OPENVSX`, with the key `YAVIN_TEST_OPENVSX_KEY`, only in `test-registry` builds, as `YAVIN_TEST_REGISTRY` already is.
- A release build ignores both, and a test checks both builds.

## C3. The packaged application

`tests/real/vscode.spec.ts` installs a signed VS Code package from a loopback Open VSX mirror through the real path:

1. search, the record, the download, its SHA-256 and its Ed25519 signature;
2. unpacking and the VS Code adapter;
3. the consent dialog ("Install and allow");
4. the inventory, then the sandboxed host.

Then, in the installed application, it checks that:

- the extension activates at once on `onStartupFinished` (D3);
- its status bar item reports the native window's focus;
- its language and grammar apply under the application's CSP;
- its text-editor command edits the document through the application's window (D1), and the saved file holds the edit;
- it hears each change when the window's focus is changed through the OS, the way a user changes it. Another application's window takes the foreground, Yavin gets it back, Yavin is minimized, then restored.

With the final focus source, the test passed 5 times out of 5 in a row, and again in the full packaged suite (§C6).

## C4. `window.state` and `onDidChangeWindowState`

**Implemented, not removed.**

- **The host.** `vscode.js` reads `window.state` at activation, follows the `window.state` events, and fires `onDidChangeWindowState` once per change.
- **Permissions.** Neither the request nor the event needs one. Both are in the native and window permission tables, and in their shared cases.
- **The window.** It sends the event only on a change.
- **The focus source** (`services/windowFocus.ts`). In the packaged application it is the OS: whether Windows has Yavin's window as its foreground window, not minimized (`src-tauri/src/window_focus.rs`). The window reads it with the `window_focused` command at start, then hears `yavin://window-focus` events, sent from WinEvent hooks on the UI thread when the foreground changes or a window is minimized or restored, and only when the answer changes. A browser window, as in the mock UI tests, uses the DOM's focus and blur.
- **No focus reported.** A window that does not report its focus makes `window.state` an `UnsupportedApi`, never an invented value.

**Why the OS's foreground window.** This was decided by measurement in the packaged application, in two steps.

1. When another application took the foreground or the window was minimized, WebView2's `document.hasFocus()` stayed true and no DOM `blur` arrived. The DOM does not follow the OS.
2. Tauri's own focus API, tried next, made the packaged test fail in 2 of 5 runs. Its focus events follow WebView2's keyboard focus, so a window activated while its web view already held the focus reported nothing. Its `is_focused` answered false for 20 s while the window was in front.

With the foreground window as the source, the test, now stricter (the first activation included, and the OS's answer checked at each step), passed 5 of 5 in a row and in the full suite (§C6).

**Why PARTIAL, not FULL.**

- `active` is the same as `focused`: Yavin does not track recent interaction.
- Only Windows follows changes. Elsewhere, Yavin reads Tauri's state and follows no changes. Yavin ships for Windows only.

**Evidence.**

- **Unit tests:** both sources, changes only, and a late answer never overriding a newer event.
- **Real host:** read at activation, followed, no duplicate, and UnsupportedApi when unreported.
- **Window side and the window UI test.**
- **The packaged application:** four OS transitions.
- **Mutations:** B1, B2, W2, W4 and W8.

## C5. The inventory, graded again

**The module's definitions.**

- **FULL:** the meaningful behaviour is implemented and shown by tests.
- **PARTIAL:** a documented subset is implemented and tested.
- **STUB:** it exists without meaningful behaviour.
- **UNSUPPORTED:** intentionally unavailable, with a reason.
- **NOT VERIFIED:** too little evidence.

**Evidence levels.** Each provided entry's `evidence` field names its tests:

- **L2:** behaviour in the real host, or on the window side;
- **L3:** the benchmark;
- **L4:** the window UI test, or the packaged application.

| Status       | EXT-26 | EXT-27 | API | Runtime | Contributions |
| ------------ | ------ | ------ | --- | ------- | ------------- |
| FULL         | 5      | **21** | 17  | 4       | 0             |
| PARTIAL      | 31     | **80** | 60  | 13      | 7             |
| STUB         | 2      | **0**  | 0   | 0       | 0             |
| NOT VERIFIED | 63     | **0**  | 0   | 0       | 0             |
| UNSUPPORTED  | 83     | 83     | 74  | 4       | 5             |
| **Total**    | 184    | 184    | 151 | 21      | 12            |

- **By tier (API only):**
  - Tier 1: 12 FULL, 42 PARTIAL, 12 UNSUPPORTED.
  - Tier 2: 5 FULL, 16 PARTIAL, 34 UNSUPPORTED.
  - Tier 3: 2 PARTIAL, 28 UNSUPPORTED.
- **Evidence:** every one of the 101 provided entries has L2 or higher; 10 have L4.
- **FULL (21):**
  - `workspace.name`, `isTrusted`, `onDidGrantWorkspaceTrust`, `getWorkspaceFolder`, `asRelativePath`;
  - `env.appName`, `uiKind`, `isTelemetryEnabled`, `onDidChangeTelemetryEnabled`;
  - `ExtensionContext.subscriptions`, `extensionUri`, `extensionPath`, `asAbsolutePath`, `extensionMode`;
  - `Position`, `Range`, `Selection` and `Location`;
  - `Disposable`, `EventEmitter` and the cancellation classes;
  - the enums, the Node.js console, the timers, `atob`, `btoa`, `queueMicrotask`, and deep recursion.
- **PARTIAL (80):** these do a documented subset of what VS Code does, tested as such, and each entry's `notes` says what is left out. For example:
  - completion items lose snippets' placeholders;
  - configuration cannot be written;
  - `openTextDocument` opens no untitled documents;
  - `withProgress` shows no progress;
  - CommonJS has no live `require.cache` and no `module.parent`. This one was FULL at EXT-25 and was downgraded at EXT-27.

**Not claimed:** a label on every row is not conformance. FULL means the behaviour tests cover what the entry promises, not that every VS Code edge case was tried.

## C6. Verification

| Check                                                                                     | Result                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust, default build (`cargo test --workspace --no-fail-fast`)                             | **889 passed, 0 failed**, 27 ignored, across all 45 test binaries. One binary (`lg05_scale`, 1 test, ignored by default) was blocked by os error 4551; it was relinked and run alone.                                                                                                                                           |
| Rust, `--features test-registry`                                                          | **889 passed, 0 failed**, 27 ignored (the same, and the same binary run alone)                                                                                                                                                                                                                                                  |
| Extension host crate (within the above)                                                   | conformance 16, `host` 10, `vscode` 4, unit 3                                                                                                                                                                                                                                                                                   |
| `cargo fmt --check`; `cargo clippy --workspace --all-targets -- -D warnings`, both builds | Clean. Clippy's default build first hit os error 4551 on a cached build script; that one folder was rebuilt. Smart App Control stayed on.                                                                                                                                                                                       |
| TypeScript (`npm test`), `tsc --noEmit`, Prettier (whole repository)                      | **1040 passed, 0 failed** (1 skipped and 1 to-do, both from before); typecheck clean; Prettier clean                                                                                                                                                                                                                            |
| Window-side conformance; focus                                                            | `vscodeConformance.test.ts` 13/13; `windowFocus.test.ts` 5/5                                                                                                                                                                                                                                                                    |
| Mock UI (Playwright, 4 workers)                                                           | **475 passed, 1 failed**: `local-history.spec.ts:441`, an existing load-sensitive test (EXT-25's record says the same) in code EXT-27 does not touch. Alone, it failed 2 of 3 runs, then passed. **Flaky, existing**; its assertions are unchanged. The EXT-27 test passed in the suite, and again after the last focus change. |
| Packaged: the EXT-27 test (`tests/real/vscode.spec.ts`)                                   | **5/5** in a row with the final focus source (§C4)                                                                                                                                                                                                                                                                              |
| Packaged: the full suite (`scripts/e2e-real-host.mjs`, fresh MSI)                         | **18/18**                                                                                                                                                                                                                                                                                                                       |
| Conformance mutations (`conformance-mutations.mjs`)                                       | **17/17 caught**; the 8 window-side ones caught again after the last focus change                                                                                                                                                                                                                                               |
| Security mutations (`security-mutations.mjs`)                                             | **109/109 caught**. 101 in the full run; the other 8 hit os error 4551 three times each and were caught when rerun alone. Every mutated source was checked and is back in place.                                                                                                                                                |
| Benchmark                                                                                 | Reproduced (§C7)                                                                                                                                                                                                                                                                                                                |
| Protected files (`resources/search/COPYING`, `LICENSE-MIT`, `UNLICENSE`, `VERSION.txt`)   | Untouched; SHA-256 unchanged                                                                                                                                                                                                                                                                                                    |

**How each failure was classed.**

- **Regressions:** none remain. D5, EXT-27's own first focus source, was found by repetition and replaced before the final runs.
- **Existing defects:** the D2 stub, and D1, D3 and D4. All fixed (§C2).
- **Flaky, existing:**
  - `local-history.spec.ts:441`, left as it is.
  - `timers_are_the_hosts_bounded_and_interruptible` (EXT-25) failed once in a full run, and alone in 1 of 8 runs and then in run 3 of a second series. Its timeout was due at 50 ms, against an interval whose third run lands near 50 ms on Windows' ~15.6 ms timer ticks. Its due times now keep 100 ms margins, with every assertion unchanged, and it passed 40 runs out of 40.
- **Environmental:**
  - os error 4551: clippy, eight mutations, one test binary, install retries;
  - one Open VSX download timeout (§C7).

## C7. The benchmark, reproduced

**The selection.** The same 64 extensions at the same pinned versions (`catalogue.json`, unchanged), through the same three stages. The records are in [`benchmark/openvsx/ext27/`](benchmark/openvsx/ext27/): `native.json`, `activation.json`, `results.json` and `results.md`, `gaps.json` and `gaps.md`. EXT-25's and EXT-26's records are kept as history.

| Stage                                             | Result                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native (install path, 64)                         | Identical to EXT-26, field by field, excluding timings. One download (`alefragnani.Bookmarks`) timed out (`MarketplaceUnavailable: timeout: global`), an environmental failure. Retried alone, once, it gave the same SHA-256, signature and size; the retry is recorded in `native.json`. |
| Activation (42 with code, real AppContainer host) | Every outcome identical to EXT-26. The differences, by kind, are below.                                                                                                                                                                                                                    |
| Analysis and gaps                                 | Every row of `gaps.json` identical to EXT-26.                                                                                                                                                                                                                                              |

**What differed at activation, and why:**

- **Request counts.** Each extension makes one more request (`window.state`) and one more event subscription, because the layer now follows the window's focus.
- **Install retries.** A few installs needed a retry, for os error 4551: Smart App Control, retried by design.
- **Error stacks.** Two of them carry line offsets inside `vscode.js`, which grew.

**One fixture correction.** On the first run, `alefragnani.Bookmarks` failed on `window.state` ("this window does not report whether it is focused"), while EXT-26 had it failing later, on `window.createWebviewPanel`. The benchmark's stand-in window did not answer `window.state`, which the application's window always does.

- **The fix:** the stand-in now answers as a window in the foreground does (`extension_host_real_tests.rs`).
- **The result:** Bookmarks again reaches `createWebviewPanel`, as in the application.

| Measure            | EXT-26                                                        | EXT-27 |
| ------------------ | ------------------------------------------------------------- | ------ |
| Installed          | 52 of 64                                                      | 52     |
| Activated          | 11                                                            | 11     |
| Main feature works | 15 yes, 5 partly, 44 no                                       | same   |
| Verdicts           | 8 Compatible, 12 Compatible with limitations, 44 Incompatible | same   |

**Corrected verdicts: none in the benchmark.** EXT-27 changes no install or activation outcome, and the benchmark drives the host directly. Its fixes (D1, D3, the native focus) are in the application, which the benchmark does not run.

**What D1 does change is the application's side of two verdicts.** The main features of `tyriar.sort-lines` and `wmaurer.change-case` are edits.

- Before D1, they worked only in the benchmark's stand-in window: in the application their edits never reached the document.
- Their "Main feature: yes" is now true in the application too, as the window UI and packaged tests show for the same edit path.

**The supplement** (`ms-python.python`, `vscode.simple-browser`; EXT-26's `supplement*.json`) was not rerun. It is outside the 64, and EXT-27 changes neither of its findings.

## C8. Remaining gaps, and why they are deferred

- **The 83 UNSUPPORTED entries.** Webviews; the SCM, testing and debugging APIs; tasks, terminals and authentication; quick picks and input boxes; custom editors, notebooks and more. They are the roadmap's phases P1–P7 (§A6), that is EXT-28 to EXT-34, outside this module.
- **The PARTIAL subsets.** What each entry's `notes` names: configuration updates, snippet placeholders, untitled documents, a progress UI, `active` in the window state, `require.cache`. Each needs product work in the window, not only in the layer.
- **Not exercised by any test:**
  - a provider cancelled by the window (Yavin passes the token, but never cancels it);
  - `ThemeColor`, `ThemeIcon`, `SymbolInformation` and `RelativePattern` as values (they are data only);
  - circular `require`.
- **Packaged coverage.** One VS Code package, with a status bar item, a command, a language and a grammar. Providers, diagnostics and tree views are proven in the real host and on the window side, but not yet in the packaged application.

---

# Part A: EXT-26, compatibility gap audit and roadmap

**Base:** `main` at `26ff399` (EXT-24), with EXT-25's 62 uncommitted changes (verified in place, not taken from its report).

**EXT-26's own changes are evidence only, no product code:**

- `scripts/openvsx-gaps.mjs`, the gap analysis;
- `benchmark/openvsx/supplement.json` and `benchmark/openvsx/ext26/`, the reproduction records;
- the inventory's statuses, graded by evidence (`src/services/extensions/vscodeApi.json`);
- this Part A;
- one correction to `ARCHITECTURE.md`.

## A1. Verified baseline

**Reproduction.** The EXT-25 benchmark was re-run from nothing, into a fresh folder: Yavin's install path, then activation in the sandboxed host. Its records are in [`benchmark/openvsx/ext26/`](benchmark/openvsx/ext26/). It **reproduces EXT-25's numbers exactly**:

| Measure                                  | EXT-25 report     | EXT-26 reproduction |
| ---------------------------------------- | ----------------- | ------------------- |
| Installed                                | 52/64             | 52/64               |
| Generated manifests valid in the window  | 52/52             | 52/52               |
| With code that runs / loaded / activated | 42 / 30 / 11      | 42 / 30 / 11        |
| Commands run without error               | 42/52 (27 edited) | 42/52 (27 edited)   |
| Declarative checks                       | 108/110           | 108/110             |
| Host crashes; hosts in the sandbox       | 0; 42/42          | 0; 42/42            |
| EXT-25 verdicts (C / L / I / NV)         | 8 / 25 / 30 / 1   | 8 / 25 / 30 / 1     |

**The two reported cases** (`supplement.json`, run through the same stages) reproduce exactly:

| Extension                      | Install                                      | Activation                                                  | Cause                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ms-python.python` 2026.4.0    | **Refused**: 2382 entries, the limit is 1000 | —                                                           | 2231 of the entries are `python_files/lib`: Python libraries run by a **Python interpreter**. Its extension pack adds Pylance, debugpy and the environments extension. Raising the entry limit would install it, but its features (interpreter, linting, tests, debugging) are processes. **The limit is not its real blocker.** |
| `vscode.simple-browser` 1.95.3 | Installs                                     | Loads; **fails** on `window.registerWebviewPanelSerializer` | A webview showing a URL. It needs webviews, plus a network policy for what it loads.                                                                                                                                                                                                                                             |

**What the reproduction corrects about EXT-25:**

1. **Verdicts ignored the main feature.** EXT-25 classed an extension by whether it activated and whether a theme, snippets or grammar of its own applied. By its main advertised feature (§A3), 19 of 64 verdicts change:

   |                             | Compatible | Compatible with limitations | Incompatible | Not verified |
   | --------------------------- | ---------- | --------------------------- | ------------ | ------------ |
   | EXT-25 rule                 | 8          | 25                          | 30           | 1            |
   | **EXT-26, by main feature** | **8**      | **12**                      | **44**       | 0            |
   - **ESLint** activates and 5 of its 6 commands run, but linting is its language server, a Node.js process.
   - **Vim**, **rust-analyzer**, **Go**, **YAML**, **Jest**, **Vitest** and **LLDB** were "with limitations" on activation or a grammar alone; none does its main job.
   - **color-highlight** and **better-comments** activate, but their colours are not shown.

   All 8 Compatible extensions are declarative (themes, grammars, language configuration). **No extension with code is fully compatible.** Two (sort-lines, change-case) do their main job with one command each missing.

2. **The inventory's statuses were not evidence.** EXT-25's test proves that every member listed as provided _exists_, not that it _works_. Graded by evidence (§A2), most of what it called FULL or PARTIAL is NOT VERIFIED. It also reported 0 STUB; 2 entries are stubs.
3. **Untested window paths.** The renderer side of every request EXT-25 added has no test of its own (§A5): `documents.edit` (`host.ts` → `App.tsx`), status bar items (`host.ts`, `StatusBar.tsx`, `activateStatusItem`), contributed languages in Monaco, and the grammar worker in the browser. Only their permission decisions are tested. No benchmark extension called `statusBar.set`.

## A2. API inventory, graded by evidence

_Superseded at EXT-27 (§C5): graded again from behavioural tests, the inventory has no STUB and no NOT VERIFIED entries. This section is EXT-26's record._

[`vscodeApi.json`](src/services/extensions/vscodeApi.json) now gives every entry an `evidence` field:

- **L1:** present (the conformance test);
- **L2:** behaviour tested in the real host;
- **L3:** exercised by real extensions in the benchmark.

A provided entry with only L1 evidence is **NOT VERIFIED**. Its `implemented` field keeps what the code does. The conformance test (`the_inventory_matches_the_layer`) still passes.

| Status       | EXT-25 claim | EXT-26 (verified) | API | Runtime | Contributions |
| ------------ | ------------ | ----------------- | --- | ------- | ------------- |
| FULL         | 24           | **5**             | 1   | 4       | 0             |
| PARTIAL      | 77           | **31**            | 17  | 10      | 4             |
| STUB         | 0            | **2**             | 2   | 0       | 0             |
| NOT VERIFIED | 0            | **63**            | 57  | 3       | 3             |
| UNSUPPORTED  | 83           | 83                | 74  | 4       | 5             |
| **Total**    | 184          | 184               | 151 | 21      | 12            |

- **By tier (API only):**
  - Tier 1: 1 FULL, 14 PARTIAL, 39 NOT VERIFIED, 12 UNSUPPORTED.
  - Tier 2: 3 PARTIAL, 2 STUB, 16 NOT VERIFIED, 34 UNSUPPORTED.
  - Tier 3: 2 NOT VERIFIED, 28 UNSUPPORTED.
- **STUB:** `window.state` (always "focused") and `window.onDidChangeWindowState` (never fires). Inert values that are documented but not separate entries: `TextEditor.options` (fixed `tabSize` 4) and `visibleRanges` (the whole document).
- **Verified (L2 or L3):**
  - `require("vscode")`, `commands.registerCommand`, the three message functions;
  - `activeTextEditor`, `TextDocument`, `TextEditor.edit`, `.selection`, `.setDecorations`;
  - `createTextEditorDecorationType`, `getConfiguration`, `textDocuments`, global and workspace state;
  - the core classes;
  - the CommonJS loader, the Node.js policy, Buffer, timers, `process`, deep recursion;
  - themes, snippets and the code-contribution mapping.
- **Not verified (L1)**, among others:
  - providers (completion, hover, definition, references, symbols), registered by 3 benchmark extensions but never invoked;
  - diagnostics, tree views (registered by 3, rows never asked for), status bar items;
  - document and editor events, `showTextDocument`, `applyEdit`, `openTextDocument`, `workspace.fs.readFile`;
  - output channels, `withProgress`, secrets, `executeCommand` and `registerTextEditorCommand`;
  - languages, language configuration and grammars in the editor.

## A3. The 64 extensions: install, activation, main feature

The **main feature** column is judged in `scripts/openvsx-gaps.mjs`, with its reason; the rest is measured. The full table, with each reason and the APIs reached or named, is [`ext26/gaps.md`](benchmark/openvsx/ext26/gaps.md).

| Category     | n   | Install | Activate | Main feature works | Partly |
| ------------ | --- | ------- | -------- | ------------------ | ------ |
| themes       | 7   | 5       | 2        | 5                  | 0      |
| grammars     | 6   | 5       | 0        | 5                  | 0      |
| langconfig   | 4   | 3       | 0        | 3                  | 0      |
| formatters   | 4   | 4       | 1        | 0                  | 0      |
| linters      | 5   | 4       | 1        | 0                  | 0      |
| lsp          | 5   | 4       | 0        | 0                  | 0      |
| providers    | 4   | 3       | 1        | 0                  | 1      |
| commands     | 5   | 5       | 4        | 2                  | 0      |
| views        | 3   | 3       | 0        | 0                  | 0      |
| scm          | 4   | 2       | 0        | 0                  | 0      |
| testing      | 3   | 3       | 0        | 0                  | 0      |
| debuggers    | 3   | 3       | 0        | 0                  | 0      |
| webviews     | 4   | 2       | 0        | 0                  | 1      |
| productivity | 7   | 6       | 2        | 0                  | 3      |

| Extension                             | Category     | Install       | Activation          | Main feature                              | Works  | Root causes                         | EXT-26 verdict              |
| ------------------------------------- | ------------ | ------------- | ------------------- | ----------------------------------------- | ------ | ----------------------------------- | --------------------------- |
| dracula-theme.theme-dracula           | themes       | yes           | no code             | Colour theme                              | Yes    | —                                   | Compatible                  |
| zhuangtongfa.material-theme           | themes       | yes           | activates           | Colour theme (One Dark Pro)               | Yes    | —                                   | Compatible with limitations |
| github.github-vscode-theme            | themes       | yes           | no code             | Colour theme                              | Yes    | —                                   | Compatible                  |
| jdinhlife.gruvbox                     | themes       | yes           | no code             | Colour theme                              | Yes    | —                                   | Compatible                  |
| pkief.material-icon-theme             | themes       | no (unpack)   | no code             | File icon theme                           | No     | package policy, icon theme          | Incompatible                |
| vscode-icons-team.vscode-icons        | themes       | no (unpack)   | no code             | File icon theme                           | No     | package policy, icon theme          | Incompatible                |
| catppuccin.catppuccin-vsc             | themes       | yes           | activates           | Colour theme                              | Yes    | —                                   | Compatible with limitations |
| scala-lang.scala                      | grammars     | yes           | no code             | Scala grammar                             | Yes    | —                                   | Compatible                  |
| mathiasfrohlich.kotlin                | grammars     | yes           | no code             | Kotlin grammar and snippets               | Yes    | —                                   | Compatible with limitations |
| slevesque.shader                      | grammars     | no (unpack)   | no code             | Shader grammars and snippets              | No     | package policy                      | Incompatible                |
| bungcip.better-toml                   | grammars     | yes           | fails at activation | TOML grammar                              | Yes    | —                                   | Compatible with limitations |
| jeff-hykin.better-cpp-syntax          | grammars     | yes           | no code             | C++ grammar                               | Yes    | —                                   | Compatible                  |
| 13xforever.language-x86-64-assembly   | grammars     | yes           | no code             | Assembly grammar                          | Yes    | —                                   | Compatible                  |
| mrmlnc.vscode-apache                  | langconfig   | yes           | no code             | Apache config grammar and configuration   | Yes    | —                                   | Compatible                  |
| coolbear.systemd-unit-file            | langconfig   | yes           | no code             | systemd grammar and configuration         | Yes    | —                                   | Compatible                  |
| nwolverson.language-purescript        | langconfig   | yes           | no code             | PureScript grammar and configuration      | Yes    | —                                   | Compatible with limitations |
| tamasfe.even-better-toml              | langconfig   | no (download) | no code             | TOML language server (taplo, WebAssembly) | No     | package policy, worker              | Incompatible                |
| esbenp.prettier-vscode                | formatters   | yes           | fails at activation | Formatting with Prettier                  | No     | core API                            | Incompatible                |
| foxundermoon.shell-format             | formatters   | yes           | fails at load       | Formatting shell scripts (shfmt)          | No     | process, Node fs/os                 | Incompatible                |
| ms-python.black-formatter             | formatters   | yes           | fails at activation | Formatting Python (Black)                 | No     | process                             | Incompatible                |
| xaver.clang-format                    | formatters   | yes           | activates           | Formatting C/C++ (clang-format)           | No     | process, core API                   | Incompatible                |
| dbaeumer.vscode-eslint                | linters      | yes           | activates           | Linting with ESLint                       | No     | worker, process                     | Incompatible                |
| streetsidesoftware.code-spell-checker | linters      | yes           | fails at load       | Spell checking                            | No     | JS globals, worker                  | Incompatible                |
| timonwong.shellcheck                  | linters      | yes           | fails at activation | Linting shell scripts (shellcheck)        | No     | process, core API                   | Incompatible                |
| davidanson.vscode-markdownlint        | linters      | yes           | fails at load       | Linting Markdown                          | No     | JS globals, core API                | Incompatible                |
| charliermarsh.ruff                    | linters      | no (unpack)   | no code             | Linting Python (ruff)                     | No     | package policy, process             | Incompatible                |
| redhat.vscode-yaml                    | lsp          | yes           | fails at load       | YAML language support                     | No     | JS globals, worker                  | Incompatible                |
| rust-lang.rust-analyzer               | lsp          | yes           | fails at activation | Rust language server                      | No     | process, core API                   | Incompatible                |
| golang.go                             | lsp          | yes           | fails at load       | Go language support (gopls)               | No     | JS globals, process                 | Incompatible                |
| llvm-vs-code-extensions.vscode-clangd | lsp          | yes           | fails at load       | C/C++ language server                     | No     | process                             | Incompatible                |
| sumneko.lua                           | lsp          | no (unpack)   | no code             | Lua language server                       | No     | package policy, process             | Incompatible                |
| christian-kohler.path-intellisense    | providers    | yes           | fails at activation | File path completion                      | No     | core API                            | Incompatible                |
| christian-kohler.npm-intellisense     | providers    | yes           | activates           | npm module completion                     | Partly | core API                            | Compatible with limitations |
| zignd.html-css-class-completion       | providers    | no (unpack)   | no code             | CSS class completion in HTML              | No     | package policy, core API            | Incompatible                |
| formulahendry.auto-rename-tag         | providers    | yes           | fails at activation | Renaming paired HTML tags                 | No     | Node fs/os                          | Incompatible                |
| tyriar.sort-lines                     | commands     | yes           | activates           | Sorting lines                             | Yes    | —                                   | Compatible with limitations |
| wmaurer.change-case                   | commands     | yes           | activates           | Changing case                             | Yes    | —                                   | Compatible with limitations |
| alefragnani.bookmarks                 | commands     | yes           | fails at activation | Bookmarks with gutter icons               | No     | webview, core API                   | Incompatible                |
| vscodevim.vim                         | commands     | yes           | activates           | Vim emulation                             | No     | core API                            | Incompatible                |
| stkb.rewrap                           | commands     | yes           | activates           | Rewrapping comments                       | No     | core API                            | Incompatible                |
| gruntfuggly.todo-tree                 | views        | yes           | fails at activation | TODO tree                                 | No     | core API, process                   | Incompatible                |
| alefragnani.project-manager           | views        | yes           | fails at load       | Project list                              | No     | Node fs/os, core API                | Incompatible                |
| sleistner.vscode-fileutils            | views        | yes           | fails at load       | File operations                           | No     | JS globals, Node fs/os              | Incompatible                |
| eamodio.gitlens                       | scm          | no (unpack)   | no code             | Git insights                              | No     | package policy, process, webview    | Incompatible                |
| mhutchie.git-graph                    | scm          | yes           | fails at activation | Git graph                                 | No     | core API, process, webview          | Incompatible                |
| donjayamanne.githistory               | scm          | yes           | fails at load       | Git history                               | No     | JS globals, process, webview        | Incompatible                |
| waderyan.gitblame                     | scm          | no (adapt)    | code does not run   | Git blame                                 | No     | ESM, process                        | Incompatible                |
| hbenl.vscode-test-explorer            | testing      | yes           | fails at activation | Test explorer                             | No     | core API, process                   | Incompatible                |
| vitest.explorer                       | testing      | yes           | fails at activation | Vitest                                    | No     | debug/test/SCM, process             | Incompatible                |
| orta.vscode-jest                      | testing      | yes           | fails at load       | Jest                                      | No     | Node fs/os, process, debug/test/SCM | Incompatible                |
| vadimcn.vscode-lldb                   | debuggers    | yes           | fails at load       | Debugging with LLDB                       | No     | debug/test/SCM, process             | Incompatible                |
| ms-python.debugpy                     | debuggers    | yes           | fails at activation | Debugging Python                          | No     | debug/test/SCM, process             | Incompatible                |
| firefox-devtools.vscode-firefox-debug | debuggers    | yes           | fails at activation | Debugging in Firefox                      | No     | debug/test/SCM, process             | Incompatible                |
| hediet.vscode-drawio                  | webviews     | no (download) | no code             | Draw.io editor                            | No     | package policy, webview             | Incompatible                |
| tomoki1207.pdf                        | webviews     | yes           | fails at activation | PDF viewer                                | No     | webview                             | Incompatible                |
| jock.svg                              | webviews     | yes           | fails at activation | SVG preview and editing                   | Partly | core API, webview                   | Compatible with limitations |
| shd101wyy.markdown-preview-enhanced   | webviews     | no (download) | no code             | Markdown preview                          | No     | package policy, webview             | Incompatible                |
| editorconfig.editorconfig             | productivity | yes           | fails at load       | Applying .editorconfig                    | No     | Node fs/os                          | Incompatible                |
| usernamehw.errorlens                  | productivity | yes           | fails at activation | Inline diagnostics                        | No     | core API                            | Incompatible                |
| oderwat.indent-rainbow                | productivity | no (unpack)   | no code             | Coloured indentation                      | No     | package policy, core API            | Incompatible                |
| yzhang.markdown-all-in-one            | productivity | yes           | fails at activation | Markdown editing helpers                  | No     | Node fs/os                          | Incompatible                |
| naumovs.color-highlight               | productivity | yes           | activates           | Highlighting colour values                | Partly | core API                            | Compatible with limitations |
| aaron-bond.better-comments            | productivity | yes           | activates           | Coloured comment annotations              | Partly | core API                            | Compatible with limitations |
| mechatroner.rainbow-csv               | productivity | yes           | fails at activation | Coloured CSV columns                      | Partly | core API                            | Compatible with limitations |

**Summary:**

- 52 install; 11 activate.
- Main feature works: 15 Yes, 5 Partly, 44 No.
- Verdicts by main feature: 8 Compatible, 12 with limitations, 44 Incompatible.

## A4. Root causes and shared blockers

Each extension's blockers (judged, from measured and static evidence; one extension can have several):

| Root cause                                                                                     | Extensions | Kind                                                              | Examples                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Starts a process**: language servers, formatters, linters, git, debug adapters, test runners | **21**     | Security decision (no process capability) and external dependency | rust-analyzer, clangd, Go, Lua, Black, clang-format, shellcheck, ruff, ESLint, GitLens, Git Graph, Git History, Git Blame, Todo Tree (ripgrep), test explorers, debuggers                              |
| **Needs a VS Code API that can run in the sandbox but is not implemented**                     | **21**     | Missing API                                                       | Prettier (language status, formatting), markdownlint (diagnostics, code actions), Error Lens (`getDiagnostics`), path/npm IntelliSense, Rewrap, Vim, colour decorations, Todo Tree's content provider  |
| **Refused by a package limit**                                                                 | **11**     | Package policy                                                    | Entries: icon themes ×2, shader, Lua, HTML CSS completion, indent-rainbow (and Python). Size: even-better-toml, Draw.io, Markdown Preview Enhanced. Large binary: ruff. Large `package.json`: GitLens. |
| **Needs webviews or custom editors**                                                           | **8**      | Missing subsystem                                                 | PDF, SVG preview, Draw.io, Markdown Preview Enhanced, Bookmarks (at activation), GitLens, Git Graph, Git History (and Simple Browser)                                                                  |
| **Node.js fs or os directly** (often synchronous, often at load)                               | **7**      | Runtime incompatibility                                           | EditorConfig (`readFileSync`), Markdown All in One (`readdirSync`), Auto Rename Tag (`lstat`), Project Manager (`homedir`), File Utils, shell-format, Jest (`cwd`)                                     |
| **A JavaScript global QuickJS lacks** (Intl, URL, crypto, `process.versions.node`)             | **6**      | Runtime incompatibility                                           | markdownlint, Go (Intl), Code Spell Checker (URL), YAML (crypto), File Utils and Git History (`process.versions.node`)                                                                                 |
| **Debug, testing or source-control APIs**                                                      | **5**      | Missing subsystem                                                 | LLDB, debugpy, Firefox debugger, Vitest, Jest                                                                                                                                                          |
| **A worker or separate JS runtime** (an in-package language server)                            | **4**      | Runtime incompatibility                                           | YAML, Code Spell Checker, ESLint, even-better-toml (WebAssembly)                                                                                                                                       |
| **Icon themes**                                                                                | 2          | Missing contribution point                                        | Material Icon Theme, vscode-icons                                                                                                                                                                      |
| **ES modules**                                                                                 | 1          | Runtime incompatibility                                           | Git Blame                                                                                                                                                                                              |
| Native modules                                                                                 | 0          | —                                                                 | None of the 64 ships a `.node` file; 2 ship executables (ruff, Lua)                                                                                                                                    |

**The unsupported APIs that matter most**: how many of the 42 entry points with code name or reach each (static scan plus runtime records).

| API                                                                                                                                                                             | Count   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `window.showQuickPick`, `workspace.createFileSystemWatcher`                                                                                                                     | 17 each |
| `env.openExternal`, `window.showInputBox`                                                                                                                                       | 15 each |
| `languages.registerDocumentFormattingEditProvider`, `workspace.onDidSaveTextDocument`                                                                                           | 13 each |
| `languages.registerCodeLensProvider`, `…RangeFormattingEditProvider`, `window.createWebviewPanel`, `workspace.onWillSaveTextDocument`                                           | 12 each |
| `languages.registerCodeActionsProvider`, `workspace.findFiles`                                                                                                                  | 11 each |
| `workspace.onDidRenameFiles`                                                                                                                                                    | 10      |
| `env.clipboard`, document links, folding ranges, `window.tabGroups`, file create/delete events                                                                                  | 9 each  |
| Semantic tokens, inlay hints, rename, signature help, workspace symbols, colours, document highlights, on-type formatting, `createTerminal`, selection events, `showOpenDialog` | 8 each  |

The **first failures** (what stops loading or activation, measured, 31 extensions):

| First failure             | Extensions |
| ------------------------- | ---------- |
| `fs.readFileSync`         | 3          |
| Intl                      | 2          |
| `process.versions.node`   | 2          |
| `createFileSystemWatcher` | 2          |
| Each of 19 others         | 1          |

## A5. Compatibility matrix by subsystem

| #   | Subsystem                                                                       | Source                                                                                            | Status (verified)                                                                                                                                                                                                                                                       | Tests                                            | Benchmark extensions depending on it                                       | Missing                                                                                              | Security                                                      |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | VSIX parsing, extraction, archive safety                                        | `extension_package.rs`                                                                            | FULL for the policy: names, links, 1000 entries, 16 MiB per file, 64 MiB total, 100:1 ratio                                                                                                                                                                             | Unit tests and mutation proofs                   | All; 11 refused by it                                                      | A VS Code-specific entry policy (§A6 P3)                                                             | Zip-bomb and path safety; do not relax the byte limits        |
| 2   | Open VSX search, metadata, versions, install, update                            | `openvsx.rs`, `openVsxProvider.ts`, `installer.ts`                                                | PARTIAL. Install: FULL with signature and SHA-256 (EXT-25 fixed checksums). **Update tracking for Open VSX: unsupported** ("updates are empty", EXT-03). **Platform-specific packages (`targetPlatform`): not selected** (ruff, shellcheck, Lua, debugpy publish them). | Unit and packaged tests                          | All                                                                        | Updates by origin; choosing `win32-x64`                                                              | Signature pinned; no change needed                            |
| 3   | Manifests, engines, activation events                                           | `vsix.rs`, `manifest.ts`                                                                          | PARTIAL: mapping L2; `engines.vscode` shown, not enforced; `workspaceContains` becomes every folder; `onUri`, `onWebviewPanel` and others are not raised                                                                                                                | `vsix_tests.rs`                                  | All with code                                                              | `onFileSystem`, `onWebviewPanel`, `onUri` with their subsystems                                      | —                                                             |
| 4   | QuickJS runtime and loader                                                      | `vscode.js`, `runtime.rs`                                                                         | PARTIAL: CommonJS L2/L3 (30 of 42 load); **ESM unsupported**; Node pure built-ins L2; system modules fail on use; Intl, URL and crypto absent                                                                                                                           | `vscode.rs`, `host.rs`                           | 42                                                                         | URL, Intl subset, crypto RNG (P1); synchronous workspace file reads (P2); ESM (P2)                   | No system reach; memory, time and stack limits                |
| 5   | The VS Code API layer                                                           | `vscode.js`, `vscodeApi.json`                                                                     | 5 FULL, 31 PARTIAL, 2 STUB, 63 NOT VERIFIED, 83 UNSUPPORTED                                                                                                                                                                                                             | Inventory test (existence) and 4 behaviour tests | 42                                                                         | Tests for what exists (P0); the APIs in §A4                                                          | Every call is a checked protocol request                      |
| 6   | Activation, context, subscriptions, storage                                     | `bootstrap.js`, `vscode.js`, `host.ts`                                                            | PARTIAL: activation L3; `globalState` L3; deactivation of VS Code extensions NOT VERIFIED; `storageUri` and `globalStorageUri` unsupported                                                                                                                              | `host.rs` (Yavin extensions)                     | Git Graph and Project Manager need storage folders                         | Per-extension storage folders (P2)                                                                   | A folder per extension, never the workspace                   |
| 7   | Commands, keybindings, menus, configuration, notifications                      | `vsix.rs`, `vscode.js`, `host.ts`                                                                 | PARTIAL: commands L3 (42/52 ran); keybindings and menus L2 (adapter only); configuration read L2, `update` unsupported; message buttons unsupported                                                                                                                     | Adapter and host tests                           | 10 register commands                                                       | Quick pick, input box, message buttons, `configuration.update` (P2)                                  | Owned ids; pickers are window UI                              |
| 8   | Documents, editors, workspace, URIs, events                                     | `vscode.js`, `App.tsx`                                                                            | PARTIAL: active editor and edits L2/L3; **events, `showTextDocument`, `applyEdit` and `openTextDocument` NOT VERIFIED**; selection events unsupported; the selection is the cursor only (Yavin sends no selection range)                                                | `vscode.rs`                                      | 30                                                                         | Selection range and events, save events, file watchers, `findFiles` (P2)                             | Through `documents.read` and `edit` grants                    |
| 9   | Providers, diagnostics, completion, hover, navigation, formatting, code actions | `vscode.js`, `host.ts`, `extensionMonaco.ts`                                                      | Five providers NOT VERIFIED (registered by 3, never invoked); diagnostics NOT VERIFIED (underlines only, not the Problems view); formatting, code actions, code lens and the rest unsupported                                                                           | none for VS Code providers                       | Prettier, markdownlint, Error Lens, path and npm IntelliSense, Rainbow CSV | Formatting, code actions, code lens, semantic tokens, `getDiagnostics`, language-less selectors (P2) | Provider calls are bounded and time out                       |
| 10  | Themes, grammars, snippets, language configuration, icon themes                 | `declarative.ts`, `textmate.ts`, `declarativeMonaco.ts`                                           | Themes and snippets PARTIAL (L2 and UI test); **grammars, configuration and languages NOT VERIFIED in the editor** (engine tested); icon themes unsupported                                                                                                             | `declarative.test.ts`, `textmate.test.ts`        | 13 declarative                                                             | UI tests (P0); icon themes (P3); injections                                                          | Regexes in a killable worker; configuration patterns screened |
| 11  | Webviews, serializers, views, trees, custom editors                             | `vscode.js`, `host.ts`                                                                            | Tree views NOT VERIFIED (registered by 3, rows never asked for); webviews and custom editors unsupported                                                                                                                                                                | —                                                | 8 (and Simple Browser)                                                     | Webviews (P4); tree item commands with arguments                                                     | A new isolated surface (§A7)                                  |
| 12  | Language servers and diagnostics routing                                        | `ide-workspace/lsp_process`, `services/lsp/` (Yavin's own); `vscode-languageclient` in extensions | Yavin's own LSP: separate, working. **Extensions' language servers: unsupported** (process or worker).                                                                                                                                                                  | Yavin's LSP tests                                | 9 LSP and linter extensions                                                | A brokered process (P6) or a worker (P5)                                                             | Processes are the largest new surface                         |
| 13  | Tasks, terminals, debugging, testing, source control                            | —                                                                                                 | Unsupported (`ide-dap` is Yavin's own)                                                                                                                                                                                                                                  | —                                                | 8                                                                          | P7                                                                                                   | Processes                                                     |
| 14  | Dependencies, packs, policy, UI contributions                                   | `vsix.rs`                                                                                         | Dependencies and packs are not installed (listed); view containers and tree views PARTIAL; status bar NOT VERIFIED; walkthroughs, `viewsWelcome`, submenus unsupported                                                                                                  | Adapter tests                                    | Python (pack), debugpy and others                                          | Packs as a list to install (P3)                                                                      | Each pack member installs and is consented to separately      |
| 15  | Security, permissions, resource limits, recovery                                | `extension_permissions.rs`, `extension_service.rs`, sandbox                                       | FULL for what exists: 109/109 mutation proofs, AppContainer 42/42, grants, integrity, inventory recovery                                                                                                                                                                | Mutation proofs, unit tests, packaged tests      | All                                                                        | Each new capability needs its own (§A7)                                                              | —                                                             |
| 16  | Packaged-app behaviour, messaging, regression coverage                          | `tests/real`, `vscodeCompatibility.ts`, `ExtensionDetails.tsx`                                    | PARTIAL: 17/17 packaged tests, but **none installs or runs a VS Code extension**; the verdict UI has a mock UI test for one case                                                                                                                                        | Packaged and mock UI                             | —                                                                          | A packaged test with a real VS Code extension (P0)                                                   | —                                                             |

## A6. Prioritized roadmap

Ranked by:

- extensions unlocked (main feature) and their importance;
- what users see;
- effort;
- risk to the architecture and to security;
- testability.

The unlock counts are cumulative and are an **upper bound**: an extension counts when every blocker that was measured or named in its bundle falls within the phase. A minified bundle can hide more.

| Phase  | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | New main features (upper bound)                                                                                                                                                           | Effort      | Risk                                                                                                                                                                | Why this order                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **P0** | **Make what exists true.** Tests for every NOT VERIFIED entry (providers invoked, tree rows, status bar, events, diagnostics, edits through `App.tsx`), UI tests for languages, grammars and status bar items, and a packaged test that installs and runs a real VS Code extension. Verdicts by main feature in the UI, not by activation. Remove or document the 2 stubs.                                                                                                                                                                                                                                                                                                                                                                            | 0 (prevents false claims)                                                                                                                                                                 | M           | Low                                                                                                                                                                 | Everything later builds on these paths, and none is verified end to end |
| **P1** | **Runtime globals** that are computation: `URL`/`URLSearchParams`, an Intl subset (Collator, NumberFormat, DateTimeFormat, PluralRules), and `crypto.getRandomValues`/`randomUUID` from a native RNG passed into the runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 0 alone; a prerequisite for 4 (markdownlint, Go, Spell Checker, YAML)                                                                                                                     | S–M         | Low; the RNG is the only new native function                                                                                                                        | Cheap; removes first failures                                           |
| **P2** | **Core in-sandbox APIs:**<br>- quick pick, input box, message buttons;<br>- formatting (document, range), code actions, code lens, semantic tokens, `getDiagnostics` and `onDidChangeDiagnostics`, language status items;<br>- language-less selectors;<br>- file watchers and `findFiles`, `workspace.fs.stat` and `readDirectory`, save events;<br>- per-extension storage folders (`globalStorageUri`, `storageUri`);<br>- selection ranges and events;<br>- decorations with validated colours and before/after text;<br>- `configuration.update` (own settings);<br>- **synchronous workspace reads** for Node.js `fs.readFileSync`, `existsSync` and `statSync` on workspace paths (a blocking host call under the deadline);<br>- ESM loading. | **12**: Prettier, markdownlint, path IntelliSense, npm IntelliSense, Auto Rename Tag, Rewrap, File Utils, EditorConfig, Error Lens, Markdown All in One, color-highlight, better-comments | L (largest) | Medium. New window UI (pickers), new native watchers, a synchronous call path. All inside existing capabilities (`workspace.fs.read`, `documents.*`), plus storage. | Highest unlock per risk; these APIs are the most named                  |
| **P3** | **Package policy for VS Code packages:** an entry limit of about 5000 with the byte limits unchanged; choosing `targetPlatform` packages; installing extension packs as listed, separately consented installs; **icon themes** (SVG through data URIs, `img-src` already allows `data:`)                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **+5**: two icon themes, Shader, HTML CSS completion, indent-rainbow                                                                                                                      | M           | Medium: relaxes a validation limit, so it needs its own review and a mutation proof                                                                                 | Popular (icon themes are among the most installed)                      |
| **P4** | **Webviews and custom editors:** sandboxed iframes on their own origin with a strict CSP, no Node.js, `postMessage` only, resources from the extension's own folder, network off by default (Simple Browser asks per site), serializers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **+7**: Bookmarks, Project Manager, Draw.io (also needs P3 for size), PDF, SVG, Markdown Preview Enhanced (P3), Rainbow CSV (and Simple Browser)                                          | L           | High: the largest new UI surface; untrusted HTML and JavaScript in the window                                                                                       | Unlocks a whole category                                                |
| **P5** | **Workers:** `Worker` and `MessagePort` as a second isolated QuickJS runtime in the same host, for web-built language servers (`vscode-languageclient/browser`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **+2**: even-better-toml (with P3 and WebAssembly), YAML (with P1)                                                                                                                        | M–L         | Medium, inside the existing sandbox                                                                                                                                 | Language support without processes                                      |
| **P6** | **A brokered process capability:** an extension may start only executables from its own verified package, or ones the user names, after consent per executable, in an AppContainer and job of their own, with workspace access the user grants; stdio only; routed through Yavin's LSP and process code                                                                                                                                                                                                                                                                                                                                                                                                                                               | **+13**: Black, clang-format, shellcheck, ruff, rust-analyzer, clangd, Lua, Todo Tree, GitLens, Git Graph, Git History, Git Blame, Test Explorer                                          | XL          | **Highest:** arbitrary native code on the user's machine                                                                                                            | The single largest unlock, and the hardest to make safe                 |
| **P7** | **Debug, testing, source control, terminals, tasks:** the APIs and their UI, through Yavin's own DAP, test and Git services                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **+10**: shell-format, ESLint, Spell Checker, Go, Vim, Vitest, Jest, LLDB, debugpy, Firefox                                                                                               | XL          | High                                                                                                                                                                | Depends on P6 for almost all                                            |

**Cumulative upper bound of main features working:**

| After | Extensions | Share                  |
| ----- | ---------- | ---------------------- |
| Today | 15         | 23%                    |
| P2    | 27         | 42%                    |
| P3    | 32         | 50%                    |
| P4    | 39         | 61%                    |
| P5    | 41         | 64%                    |
| P6    | 54         | 84%                    |
| P7    | 64         | 100% (by construction) |

The bound is 100% by construction (every blocker maps to a phase), not a promise; P6 and P7 are where most remaining value is and where security costs most.

### Acceptance tests per phase

| Phase | Acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | Every inventory entry is FULL or PARTIAL only with L2 or L3 evidence (the inventory test fails otherwise). Host tests invoke each provider kind, tree rows, status bar items, diagnostics and every event. Renderer unit tests for `documents.edit` (stale version, read-only, overlapping edits, undo) and the status bar (ownership, limit, click). UI tests: a grammar colours a document; a language configuration comments a line; a status bar item shows and runs. A packaged test installs a real VS Code extension from a file and runs a command. The benchmark's verdict rule uses the main feature. |
| P1    | `new URL` and URLSearchParams pass a WHATWG test subset. Intl subset golden tests. `getRandomValues` is non-repeating and bounded in size. markdownlint, Go, Spell Checker and YAML get past their first failures in the benchmark.                                                                                                                                                                                                                                                                                                                                                                             |
| P2    | Per API: a host test and a renderer test. In the benchmark: Prettier formats a scratch document; markdownlint reports and fixes; Error Lens shows inline text; path completion lists the workspace (never outside it); a quick pick is answered from the UI; `readFileSync` outside the workspace is refused; storage folders are per extension and removed on uninstall. Mutation proofs for each new grant check.                                                                                                                                                                                             |
| P3    | The icon themes install and render in the Explorer. A package over 64 MiB unpacked is still refused, and so is a 100:1 ratio; a mutation proof for the new limit. Platform packages pick `win32-x64`.                                                                                                                                                                                                                                                                                                                                                                                                           |
| P4    | A webview cannot reach `ipc:` or Yavin's origin, has no Node.js, and no network unless allowed; a resource outside the extension is refused; CSP violations are reported; PDF and SVG previews render; packaged tests.                                                                                                                                                                                                                                                                                                                                                                                          |
| P5    | A worker is a separate runtime with its own memory limit; the YAML web language server answers completion; ending the extension ends its workers.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| P6    | Only a consented executable from the verified package starts; it runs in its own AppContainer and job; killing Yavin ends it; it cannot read outside the granted folder; rust-analyzer gives hover and diagnostics in the benchmark; mutation proofs for every check.                                                                                                                                                                                                                                                                                                                                           |
| P7    | Per subsystem, with Yavin's own services; packaged tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## A7. Security and architecture constraints

- **No capability by being a VS Code extension.** Every new API is a protocol request checked natively and in the window (EXT-07). New capabilities are granted by the user, per copy, and revoked at once (EXT-16).
- **The sandbox stays.** The host keeps its AppContainer with no capabilities, its Job Object, QuickJS without std/os, and its memory, time and stack limits. P2's synchronous reads are host-to-Yavin calls under the deadline, not file access from the host.
- **Package limits relax only where the byte totals stay bounded** (P3). Each relaxation needs a mutation proof.
- **Webviews (P4)** need an origin of their own, CSP, no `ipc:`, and no access to Yavin's DOM. This is a new attack surface and needs a threat model before code.
- **Processes (P6)** are the boundary decision of the roadmap. Starting a vendor's binary means running arbitrary native code with the user's data. This needs:
  - a written threat model;
  - consent per executable (by SHA-256);
  - a sandbox per process (AppContainer with a granted folder capability, Job Object, no network unless granted);
  - integrity binding to the verified package;
  - and it must never extend to downloading executables at run time (shell-format, rust-analyzer's updater).

### QuickJS, or a Node.js worker?

|                        | QuickJS (today)                                                                                                                                       | A Node.js worker                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compatibility          | 30/42 load. Failures are missing globals (fixable, P1), Node fs at load (P2 sync reads) and process needs (which a sandboxed Node cannot meet either) | Higher activation. Features that need processes, the network or the filesystem still fail inside a sandbox.                                                                    |
| Attack surface         | Small engine; one native function out, plus timers                                                                                                    | All of Node.js: `process.binding`, native addons, `fs`, `net`, `child_process` exist and must be denied by the OS sandbox alone                                                |
| Isolation              | Per-extension runtime, memory limit, interrupt deadline, watchdog                                                                                     | Per-process isolation; deadlines need process kills; memory per process                                                                                                        |
| Size and start         | Built in                                                                                                                                              | About 70 MiB of Node.js to ship and patch, and its own update cadence                                                                                                          |
| Evidence for switching | —                                                                                                                                                     | **None.** 11 of 31 load failures are filesystem or OS reads at load, which a sandboxed Node.js would also refuse. 21 extensions need processes, which Node.js does not change. |

**Recommendation: keep QuickJS.** Do P1, P2 and P5 inside it. Revisit Node.js only with a threat model and evidence that the extensions P1–P5 cannot reach would then work in a sandbox.

## A8. Unsupported extension categories, and why

| Category                                                      | Why                                                                | When                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------- |
| Language servers, formatters and linters that run executables | No process capability                                              | P6                     |
| Node-based language servers (ESLint, Spell Checker)           | A separate Node.js runtime                                         | P5 (web builds), or P6 |
| Debuggers                                                     | Debug adapters are processes, and the debug API is not implemented | P6 + P7                |
| Testing                                                       | Runners are processes, and the testing API is not implemented      | P6 + P7                |
| Source control (GitLens, Git Graph, Git History, Git Blame)   | git is a process; webviews; ESM                                    | P4 + P6 (+ P2 for ESM) |
| Webview previews and custom editors                           | No webviews                                                        | P4                     |
| Icon themes                                                   | Contribution not supported; package size                           | P3                     |
| Notebooks, terminals, tasks, authentication, chat             | Not designed                                                       | Not planned            |
| Anything that downloads and runs code at run time             | Never: it bypasses package verification                            | Never                  |

## A9. An honest estimate for broad VS Code compatibility

**Today:** about a quarter of the benchmark works. In practice that is themes, grammars, language configuration and simple text commands.

**After P0–P3** (in-sandbox APIs and packaging, months of work): about half. These are the editing helpers, formatters and linters that are pure JavaScript, plus icon themes.

**After P4** (webviews): about three in five.

**Beyond that** the remaining categories (language servers, debuggers, testing, source control) need processes. Even with P6 and P7, "comparable to VS Code" holds only for extensions whose servers ship in their verified package and behave inside a sandbox; extensions that download tools, need the network or expect VS Code's own services stay out.

**Full VS Code compatibility is not a realistic target** for a sandboxed host. The realistic target is the largest set that works safely, measured by this benchmark at each phase.

## A10. EXT-26 test and reproduction record

| Check                                            | Result                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Benchmark reproduction (native, then activation) | Identical to EXT-25 (§A1); records in `benchmark/openvsx/ext26/` |
| Supplement (Python, Simple Browser)              | As reported (§A1)                                                |
| Inventory conformance test after grading         | Passed (`the_inventory_matches_the_layer`)                       |
| Product code                                     | Not changed                                                      |

---

# Part B: the EXT-25 record

**Errata (EXT-26):**

- **§1 and §7:** the verdicts there are by activation and stand-alone contributions. By main feature they are 8 / 12 / 44 / 0 (§A1).
- **§4:** "STUB 0", "24 FULL" and "77 PARTIAL" counted existence, not behaviour. Graded by evidence: 5 FULL, 31 PARTIAL, 2 STUB, 63 NOT VERIFIED, 83 UNSUPPORTED (§A2).
- **§10:** the window paths of `documents.edit`, status bar items, languages and grammars have no tests (§A1 point 3).

**Date:** 2026-10-20. **Base:** `26ff399` (EXT-24), plus EXT-25's uncommitted changes. **Candidate version:** 2.2.0, unchanged. The extension API moves from 2.0.0 to **2.1.0**; the change is additive. Every `^2.0.0` or `>=2.0.0` extension still fits. One pinned to exactly `2.0.0` no longer does, as an exact version means; none in the repository is. Every number below was produced in this session on this machine, from the records in [`benchmark/openvsx/`](benchmark/openvsx/). Nothing is estimated. A check that did not run says **not verified**.

**Not claimed:** that all Open VSX extensions work. Of 64 popular ones, 8 are fully compatible and 25 work with limitations. The other 31 do not work or were not verified.

## B1. Summary

| Measure (64 real Open VSX extensions, 14 categories)                            | Before EXT-25                | After                                  |
| ------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------- |
| Installed through Yavin's own install path                                      | 7 (10.9%)                    | **52 (81.3%)**                         |
| Generated manifests the window accepts                                          | —                            | 52/52                                  |
| Extensions whose code Yavin runs                                                | 0 (no VS Code code ever ran) | 42                                     |
| Code loaded / activated in the sandboxed host                                   | 0 / 0                        | **30 / 11** of 42 (26.2% activate)     |
| Contributed commands run without error (scratch document)                       | —                            | 42/52, of which 27 edited the document |
| Declarative checks passed on real files (themes, snippets, languages, grammars) | themes and snippets only     | 108/110                                |
| **Compatible**                                                                  | —                            | 8 (12.5%)                              |
| **Compatible with limitations**                                                 | —                            | 25 (39.1%)                             |
| **Incompatible**                                                                | —                            | 30 (46.9%)                             |
| **Not verified**                                                                | —                            | 1 (1.6%)                               |
| Host crashes during the benchmark                                               | —                            | 0 (one found earlier and fixed, §8 D2) |
| Hosts confirmed in the AppContainer sandbox                                     | —                            | 42/42                                  |
| Package signatures verified under the pinned Open VSX key                       | —                            | 61/61 downloaded (`registrySigned`)    |

Before EXT-25 no verdicts were given, so that column is blank. The 7 packages that installed then contributed only colour themes and snippets.

## B2. Repository audit: what existed (EXT-01 … EXT-24)

| Area                                                            | Before EXT-25                                                                                                                                                             | Source                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Open VSX browsing, record, download, SHA-256, Ed25519 signature | Implemented (EXT-03, EXT-09)                                                                                                                                              | `src-tauri/src/openvsx.rs`, `package_trust.rs`                                  |
| VS Code package installation                                    | **Declarative only**: JSON colour themes and snippets. Anything else in a package made it `UnsupportedPackage`. A manifest with a `vsix` report and a `main` was invalid. | `src-tauri/src/vsix.rs`, `src/services/extensions/manifest.ts`                  |
| Open VSX listing gate                                           | A record whose categories named neither Themes nor Snippets was Incompatible and never downloaded                                                                         | `marketplace/versions.ts`                                                       |
| Extension code                                                  | Yavin's own API v2 (`yavin`) in QuickJS. One file per extension, at most 2 MiB, 1 MiB per message. No `require`, no Node.js, no timers.                                   | `crates/ide-plugin-host/src/{bootstrap.js,runtime.rs,lib.rs}`                   |
| Isolation                                                       | AppContainer with no capabilities, plus a Job Object (EXT-10). Every request checked natively against grants (EXT-07) and in the window. Watchdog.                        | `extension_host.rs`, `extension_permissions.rs`, `ide-workspace/src/sandbox.rs` |
| Languages and grammars                                          | Yavin's fixed table of languages (`services/language.ts`) and Monaco Monarch tokenizers. No TextMate engine, no extension-contributed languages.                          | `services/language.ts`, `editor/monacoHost.ts`                                  |
| Language servers                                                | Yavin's own native LSP manager for servers it knows (`lsp_process`). Unrelated to extensions.                                                                             | `ide-workspace`, `services/lsp/`                                                |

## B3. Baseline: what failed and why (`baseline-native.json`)

| Stage            | Count | Cause                                                                                                                                                                          |
| ---------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Installed        | 7     | Themes and snippets only                                                                                                                                                       |
| Download refused | 17    | **15: a defect.** Open VSX's file host serves many `.sha256` files as `application/octet-stream`, which Yavin rejected as "unexpected content" (§8 D1). 3: larger than 20 MiB. |
| Unpack refused   | 8     | More than 1000 entries (6: icon themes, large language packs); a 16 MiB binary (ruff); `package.json` over 1 MiB (gitlens).                                                    |
| Adapter refused  | 32    | Code, grammars and languages were not supported.                                                                                                                               |

## B4. Compatibility inventory

The full, machine-readable inventory is [`src/services/extensions/vscodeApi.json`](src/services/extensions/vscodeApi.json): 151 API entries, 21 runtime entries and 12 contribution-point entries. Each has its tier, its status, its status before EXT-25, and notes. A test (`crates/ide-plugin-host/tests/vscode.rs`, `the_inventory_matches_the_layer`) loads it in the real host. Every member listed FULL or PARTIAL must exist and must not be a stand-in. Every member listed UNSUPPORTED must fail with `UnsupportedApi`. Flipping an entry makes the test fail; this was checked.

| Status       | Count (API, runtime, contribution entries)                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| FULL         | 24                                                                                                                   |
| PARTIAL      | 77                                                                                                                   |
| STUB         | **0**: there are no success-returning stubs                                                                          |
| UNSUPPORTED  | 83: each fails with `UnsupportedApi: <api> is not supported by Yavin`, logged once and shown on the extension's page |
| NOT VERIFIED | 0 entries                                                                                                            |

The three entries closest to stubs are documented, not hidden:

- `OutputChannel.show/hide`: lines go to the extension's log, and no view opens.
- `withProgress`: the task runs and no progress is shown.
- `commands.executeCommand("setContext")`: accepted, because Yavin evaluates no `when` clauses.

**By namespace** (the notes in the JSON give each limitation):

| Namespace                                                                                 | Provided (FULL / PARTIAL)                                                                                                                                                                                                                                                                            | Unsupported, the most used first (static counts, §7.4)                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands`                                                                                | registerCommand, registerTextEditorCommand, executeCommand (own commands, `setContext`, `vscode.open`), getCommands                                                                                                                                                                                  | registerDiffInformationCommand; other extensions' and VS Code's built-in commands                                                                                    |
| `window`                                                                                  | Messages (no buttons), output channels, status bar items, `setStatusBarMessage`, activeTextEditor and visibleTextEditors, onDidChangeActiveTextEditor, showTextDocument, decoration types (fixed styles), tree views, withProgress                                                                   | showInputBox (15), showQuickPick (15), createWebviewPanel (12), onDidChangeTextEditorSelection, custom editors, terminals, URI handlers, tab groups                  |
| `workspace`                                                                               | workspaceFolders, getConfiguration (own settings), onDidChangeConfiguration, textDocuments, open/change/close events, openTextDocument, applyEdit (text), fs.readFile, asRelativePath, isTrusted                                                                                                     | createFileSystemWatcher (17), onDidSaveTextDocument (13), onWillSaveTextDocument (12), findFiles (11), file events (10), fs.stat/writeFile, content providers, tasks |
| `languages`                                                                               | Completion, hover, definition, references and document symbol providers; diagnostics (as underlines); match                                                                                                                                                                                          | Formatting (13), code lens (12), range formatting (12), code actions (11), document links (9), semantic tokens, rename, signature help, …                            |
| `env`                                                                                     | appName, language (`en`), uiKind, uriScheme, isTelemetryEnabled (false)                                                                                                                                                                                                                              | openExternal (15), clipboard (9), machineId, sessionId, shell                                                                                                        |
| `extensions`, `l10n`                                                                      | Its own extension; `l10n.t` without translations                                                                                                                                                                                                                                                     | Other extensions                                                                                                                                                     |
| `debug`, `scm`, `tasks`, `tests`, `notebooks`, `comments`, `authentication`, `chat`, `lm` | —                                                                                                                                                                                                                                                                                                    | Everything                                                                                                                                                           |
| Classes and enums                                                                         | Position, Range, Selection, Location, Uri, Disposable, EventEmitter, cancellation, MarkdownString, SnippetString, CompletionItem, Hover, TextEdit, WorkspaceEdit, Diagnostic, symbols, TreeItem, ThemeColor/Icon, and the data classes of unsupported providers (so that subclasses load); all enums | —                                                                                                                                                                    |

**Security implications per area:**

- Every provided API is a protocol request that Yavin checks natively and in the window, exactly as for a Yavin extension: ownership, permission grants, workspace containment.
- The layer itself runs inside the extension's QuickJS context and is not a boundary.
- New capabilities and requests are listed in §9.

## B5. Runtime audit (QuickJS) and the Node.js question

| Question                 | Finding                                                                                                                                                                          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CommonJS                 | VS Code extensions are CommonJS bundles (webpack, esbuild, tsc).                                                                                                                 | **Implemented**: a CommonJS loader in the layer over the package's own `.js`, `.cjs` and `.json` files (`node_modules` resolution, relative files, JSON, `require.resolve`). Native side: `extensions::read_modules`, at most 2000 files and 24 MiB, from the verified copy.                                                                                                                                                                                                                                       |
| ES modules               | 1 of 64 (`waderyan.gitblame`) is ESM (`"type": "module"`).                                                                                                                       | **Unsupported**, said by the adapter. QuickJS could run ESM, but chunk loading and top-level await would need an asynchronous loader. Deferred.                                                                                                                                                                                                                                                                                                                                                                    |
| `require("vscode")`      | —                                                                                                                                                                                | The layer (§4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Node.js built-ins        | Named in 22 of 42 entry points (`path` 22, `fs` 18, `util` 18, `os` 16, `child_process` 15, `crypto` 13, `net` 11).                                                              | Pure computation is **provided**: path (win32 and posix), events, util, assert, url's file URLs, Buffer, `os` (platform only), `http` (status codes only), tty (`isatty` false), console. Anything that reaches the system **loads, and fails with `UnsupportedApi` when used**. `process.env` is `{}`.                                                                                                                                                                                                            |
| Native modules (`.node`) | 0 of 64 packages ship one; 2 ship executables (ruff, lua).                                                                                                                       | Never loaded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Timers                   | Needed by nearly every extension.                                                                                                                                                | **Implemented in the host** (`runtime.rs`): at most 1000 waiting, intervals of at least 10 ms, each firing under the call deadline and the watchdog.                                                                                                                                                                                                                                                                                                                                                               |
| A Node.js worker         | It would raise activation to most of the 31 that fail at load (§7.3). But it means running each extension in a full Node.js runtime with filesystem, network and process access. | **Not introduced.** Inside the AppContainer it would have only Yavin's protocol, but Node's attack surface replaces QuickJS's small one, and making it equal to today's boundary needs a design and threat-model review this module does not provide. The evidence: 11 of the 31 load failures (§7.3) are reads of the filesystem or the OS at load, which a sandbox must still refuse. So a Node worker would not by itself make them work. Not justified by this evidence; recorded as a possible future module. |

## B6. Language tooling (reported separately)

| Kind                                | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Evidence                                                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Grammars** (TextMate)             | **PARTIAL, new.** JSON and property-list grammars for languages without a tokenizer of Yavin's own, in a Web Worker that the window ends after 4 s (`editor/textmate.worker.ts`). The engine is `@shikijs/vscode-textmate` 10.0.2 with `@shikijs/engine-javascript` 4.5.0 (pure JavaScript: the CSP allows no WebAssembly). Tokens map through the same scope table themes use. Injection grammars are not applied, and patterns JavaScript cannot express are skipped. | All 13 grammar files of the catalogue load and tokenize a sample (`results.json`, `declarative.grammars`). Kotlin's real grammar tokenizes correctly (`textmate.test.ts` covers the engine with written grammars). |
| **Language configuration**          | **PARTIAL, new**: comments, brackets, auto-closing and surrounding pairs, folding, word pattern, indentation and on-Enter rules. Patterns with nested unbounded repetition are refused, because they run on the window's thread (`languageConfiguration.ts`).                                                                                                                                                                                                           | Every configuration in the catalogue is read (`declarative.languages`).                                                                                                                                            |
| **Languages**                       | **PARTIAL, new**: ids, extensions, file names and aliases, for files Yavin does not know itself. Yavin's own languages are never re-labelled.                                                                                                                                                                                                                                                                                                                           | `services/language.ts`.                                                                                                                                                                                            |
| **Language servers**                | **Unsupported for extensions.** Of the 5 LSP extensions, 3 fail before activation and 2 fail at it: they start a server process or a Web Worker, and an extension may start neither. Yavin's own native LSP manager is unaffected.                                                                                                                                                                                                                                      | §7.3                                                                                                                                                                                                               |
| **Extension providers via the API** | **PARTIAL**: completion, hover, definition, references, symbols. Formatting and code actions are unsupported (the most-named missing providers).                                                                                                                                                                                                                                                                                                                        | §4                                                                                                                                                                                                                 |

## B7. The benchmark

### 7.1 Method

1. **Catalogue** ([`catalogue.json`](benchmark/openvsx/catalogue.json)): 64 real extensions in the module's 14 categories. Versions are pinned to the latest on open-vsx.org on 2026-10-20; each entry has its page link.
2. **Native stage** (`src-tauri/src/openvsx_benchmark_tests.rs`, ignored test) runs **Yavin's own install path** for each extension, short of the inventory commit:
   - the version record;
   - the download under the marketplace policy;
   - the published SHA-256;
   - the Ed25519 signature under the pinned Open VSX key;
   - `extension_package::unpack`, then `vsix::adapt`.
     It records the digest, size, signature status, generated manifest and timings. Run before the changes (`baseline-native.json`) and after (`after-native.json`).
3. **Activation stage** (`extension_host_real_tests::open_vsx_benchmark_activation`, ignored test) runs each package with code:
   - installed from its downloaded file through the real inventory (staged, verified, committed);
   - granted what it requests;
   - loaded into the **real host in its AppContainer**, confirmed per host (42/42);
   - activated in a disposable workspace whose only document is a three-line scratch text. No user data, no credentials.
     Each contributed command is then run once (`after-activation.json`).
4. **Analysis** (`scripts/openvsx-benchmark.mjs`):
   - validates every generated manifest with the window's own `readManifest`;
   - runs the window's own theme, snippet, configuration and grammar code on each package's real files;
   - scans entry points as text for VS Code APIs and Node.js modules;
   - classifies each extension and writes `results.json` (machine-readable) and `results.md` (per extension).

Nothing of an extension ran outside the sandbox. Static scans read text only.

**Classification.**

- **Compatible:** installed, and every contribution applies. If it has code, it activated, met no unsupported API, ran every contributed command, and the adapter left nothing out.
- **Compatible with limitations:** it works in part. Either its code activated with something missing, or its code failed but a theme, snippets or a grammar of its own still applies.
- **Incompatible:** not installed, or nothing of it works.
- **Not verified:** it activated but has nothing the benchmark can check.

### 7.2 Per category

| Category                                 | n      | Installed before → after | With code | Activated | Compatible | With limitations | Incompatible | Not verified |
| ---------------------------------------- | ------ | ------------------------ | --------- | --------- | ---------- | ---------------- | ------------ | ------------ |
| Themes and icon themes                   | 7      | 3 → 5                    | 2         | 2         | 3          | 2                | 2            | 0            |
| Grammars and snippets                    | 6      | 1 → 5                    | 1         | 0         | 3          | 2                | 1            | 0            |
| Language configuration                   | 4      | 1 → 3                    | 0         | —         | 2          | 1                | 1            | 0            |
| Formatters                               | 4      | 0 → 4                    | 4         | 1         | 0          | 0                | 3            | 1            |
| Linters                                  | 5      | 1 → 4                    | 4         | 1         | 0          | 3                | 2            | 0            |
| Language servers                         | 5      | 1 → 4                    | 4         | 0         | 0          | 3                | 2            | 0            |
| Completion, hover, definitions           | 4      | 0 → 3                    | 3         | 1         | 0          | 1                | 3            | 0            |
| Commands, menus, keybindings, status bar | 5      | 0 → 5                    | 5         | 4         | 0          | 4                | 1            | 0            |
| Explorer and custom views                | 3      | 0 → 3                    | 3         | 0         | 0          | 0                | 3            | 0            |
| Source control                           | 4      | 0 → 2                    | 2         | 0         | 0          | 0                | 4            | 0            |
| Testing                                  | 3      | 0 → 3                    | 3         | 0         | 0          | 2                | 1            | 0            |
| Debuggers                                | 3      | 0 → 3                    | 3         | 0         | 0          | 1                | 2            | 0            |
| Webviews and custom editors              | 4      | 0 → 2                    | 2         | 0         | 0          | 1                | 3            | 0            |
| Productivity                             | 7      | 0 → 6                    | 6         | 2         | 0          | 5                | 2            | 0            |
| **All**                                  | **64** | **7 → 52**               | **42**    | **11**    | **8**      | **25**           | **30**       | **1**        |

Install success is the package installing. Activation success is its code activating. Feature success is its commands running and its contributions applying. These are three separate facts, recorded separately per extension in `results.json`.

Where "with limitations" depends on a stand-alone part (linters, LSP, testing), it means that part works and the extension's main feature does not. For example, rust-analyzer's grammar and snippets apply, but its language server does not run.

### 7.3 What stops code (first failure at load or activation, 31 extensions)

| First failure                                                                                                                                                                                                                                                                                                                                                               | Extensions |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Node.js `fs.readFileSync` at load                                                                                                                                                                                                                                                                                                                                           | 3          |
| `Intl` (no internationalisation API in QuickJS)                                                                                                                                                                                                                                                                                                                             | 2          |
| `process.versions.node` read (there is no Node.js)                                                                                                                                                                                                                                                                                                                          | 2          |
| `workspace.createFileSystemWatcher`                                                                                                                                                                                                                                                                                                                                         | 2          |
| `ExtensionContext.globalStoragePath`, `fs.lstat`, `fs.readdirSync`, `os.homedir`, `process.cwd`, `URL`, `crypto`, language-less selectors, `debug.*` (3), `tests.createTestController`, `registerCodeActionsProvider`, `registerCodeLensProvider`, `createLanguageStatusItem`, `getDiagnostics`, custom editors, webviews, semantic tokens, text document content providers | 1 each     |

**Missing at runtime in extensions that activated:** `window.showQuickPick` (2), `workspace.createFileSystemWatcher` (2), `WorkspaceConfiguration.update`, `workspace.fs.stat`, `fs.readFile`.

### 7.4 Most frequently named unsupported APIs (static scan of 42 entry points)

`workspace.createFileSystemWatcher` 17 · `env.openExternal` 15 · `window.showInputBox` 15 · `window.showQuickPick` 15 · `languages.registerDocumentFormattingEditProvider` 13 · `workspace.onDidSaveTextDocument` 13 · `languages.registerCodeLensProvider` 12 · `languages.registerDocumentRangeFormattingEditProvider` 12 · `window.createWebviewPanel` 12 · `workspace.onWillSaveTextDocument` 12 · `languages.registerCodeActionsProvider` 11 · `workspace.findFiles` 11.

This scan is a text heuristic over minified bundles. It finds names reached through the `vscode` module or a short alias, and may miss or over-count some. The runtime records (§7.3) are the measured evidence.

### 7.5 Performance and stability

- **Median times:** install 3657 ms (network included), load 506 ms, activation 6 ms.
- **Crashes:** none in the final run. One crash (a stack overflow) was found and fixed (§8 D2).
- **Long-running commands:** none of the 52 commands needed more than its deadline.

### 7.6 Security outcomes

- **Signatures:** all 61 downloaded packages verified under the pinned key.
- **Limits:** 8 packages were refused by the unchanged package limits, and 3 by the unchanged size limit.
- **Sandbox:** every host ran in its AppContainer.
- **Access:** no extension read anything outside the scratch workspace; the only document was synthetic.
- **Unsupported calls:** every one ended in a named `UnsupportedApi` error. None was silently accepted.

## B8. Defects found and fixed

| Id  | Defect                                                                                                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                               | Proof                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| D1  | Open VSX checksums served as `application/octet-stream` were refused, so 15 of 64 packages could not be installed.                                                                                                                                                                                                                       | A `Checksum` content kind accepts `text/plain` and octet streams. The content is still checked strictly (64 hex digits, at most 256 bytes), and the signature check is unchanged. | `content_types_must_match_what_was_asked`; mutation **EXT-25 C1** (a page accepted as a checksum is caught)          |
| D2  | **Deep recursion overflowed the host's native stack and ended the process (`0xC00000FD`).** QuickJS's default limit (1 MiB) equals a Windows main thread's stack, so any extension, Yavin's included, could crash its host. It is not an escape, since only the sandboxed process ends, but it was a crash. Found on `orta.vscode-jest`. | Extensions run on a 32 MiB thread, and QuickJS is limited to 8 MiB, so a too-deep recursion is a `RangeError`.                                                                    | `deep_recursion_is_an_error_and_the_host_lives`; mutation **EXT-25 S1**                                              |
| D3  | Load errors said only the message.                                                                                                                                                                                                                                                                                                       | The stack's first lines are carried with `LoadFailed` (the extension's page and the benchmark).                                                                                   | `after-activation.json`                                                                                              |
| D4  | Proxy invariants in the layer's module objects broke bundler interop (graceful-fs, `__importStar`) during development.                                                                                                                                                                                                                   | ownKeys and descriptors made complete.                                                                                                                                            | `what_yavin_does_not_provide_fails_with_an_error_that_names_it` (marked and cloned `fs`, `__importStar` of `vscode`) |

## B9. Security review of EXT-25

| Change                                               | Threat                       | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Status                                                                   |
| ---------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| VS Code code from Open VSX now runs (`vsix.runtime`) | Untrusted third-party code   | Same boundary as any Yavin extension: AppContainer with no capabilities, Job Object, QuickJS with no std/os, memory and time limits, watchdog, native permission checks, trusted folders only (`untrustedWorkspaces` is never set for VS Code code), whole-folder integrity binding (EXT-17/19) over every module file, signature verified at install (EXT-09). Copies installed before EXT-25 keep their manifest without `main`, so their code still never runs. | No capability added by being a VS Code extension                         |
| Requested permissions                                | Over-broad requests          | A VS Code package **asks** for `documents.read`, `documents.edit`, `editor.control`, `workspace.fs.read` and `secrets`. **Nothing is granted** until the user allows each one (EXT-07). Denials are deterministic `PermissionDenied`.                                                                                                                                                                                                                              | Tested (`privileged_requests_need_their_grant…`, cases)                  |
| New capability `documents.edit`                      | Silent modification of files | Edits open documents only, as one unsaved, undoable change through the document service. Writes no file. Refused on a stale version, a proposal, or a read-only document. Needs a grant.                                                                                                                                                                                                                                                                           | Native and window rules, shared cases; mutation **EXT-25 P1**            |
| New requests `statusBar.set/remove`                  | Spoofing Yavin's UI          | Owned ids (`<id>#status#n`), at most 20 per extension, plain text in Yavin's style, the tooltip naming the extension, no colours or markup.                                                                                                                                                                                                                                                                                                                        | Shared cases; mutation **EXT-25 P2**                                     |
| Timers in the host                                   | CPU exhaustion               | At most 1000 waiting, intervals of at least 10 ms, each fire under the call deadline and the watchdog, the Job Object's CPU cap.                                                                                                                                                                                                                                                                                                                                   | `timers_are_the_hosts_bounded_and_interruptible`; mutation **EXT-25 T1** |
| `load` up to 32 MiB (modules)                        | Memory                       | Native read bounded (2000 files, 24 MiB, each `.js` ≤ 8 MiB, `.json` ≤ 1 MiB). Every other message still ≤ 1 MiB. QuickJS memory limit unchanged (the window's setting).                                                                                                                                                                                                                                                                                           | `read_modules`; protocol                                                 |
| Node.js built-ins                                    | Access to the system         | No module reaches the system. Members fail with `UnsupportedApi`; `process.env` is empty; `os` gives the platform only, never the user, folders, host name or network.                                                                                                                                                                                                                                                                                             | `what_yavin_does_not_provide…`                                           |
| TextMate grammars (third-party regexes)              | ReDoS in the window          | Tokenized in a Web Worker the window terminates after 4 s; per-line 50 ms and per-document 1.5 s budgets.                                                                                                                                                                                                                                                                                                                                                          | `textmate.test.ts` (bounds)                                              |
| Language configuration regexes                       | ReDoS on the window's thread | Nested unbounded repetition refused; length ≤ 1000; compile failures left out.                                                                                                                                                                                                                                                                                                                                                                                     | `textmate.test.ts`                                                       |
| Checksum content type (D1)                           | Accepting a substitute       | Content strictly parsed; authenticity is the signature, which is unchanged.                                                                                                                                                                                                                                                                                                                                                                                        | Mutation C1                                                              |
| New npm dependencies                                 | Supply chain                 | `@shikijs/vscode-textmate` 10.0.2, `@shikijs/engine-javascript` 4.5.0, `oniguruma-to-es` 4.3.6 and their dependencies. All MIT, all published at least two weeks earlier, pinned exactly and by `overrides`, lockfile integrity hashes. They run in the window's worker only and are never given extension code, only grammar data.                                                                                                                                | Recorded                                                                 |

**Limits deliberately not changed** (they refuse 11 benchmark packages): entries ≤ 1000 per package (icon themes, large language packs), package ≤ 20 MiB, file ≤ 16 MiB, `package.json` ≤ 1 MiB (gitlens). Raising them would increase compatibility by weakening package validation, which this module may not do. **Recommendation (operator decision):** a VS Code-specific entry limit (for example 5000) under the same byte totals would admit the 6 entry-limited packages. It needs its own review.

Mutation proofs: **109/109** (104 from EXT-24 plus 5 new), each caught by its test, sources byte-identical afterwards (`scripts/security-mutations.mjs`; §11).

## B10. Compatibility UX and the `engines.vscode` policy

- **Before installing**, an Open VSX extension is **"Not verified"**. Its listing says what installs (themes, snippets, languages, grammars, and code running in the sandbox with only the permissions the user allows) and that its page will say how well it works. Categories no longer gate installation: the package decides (`marketplace/versions.ts`).
- **On an installed extension's page**, the _VS Code compatibility_ section shows:
  - a **verdict** (Compatible / Compatible with limitations / Incompatible / Not verified);
  - the **installed** parts;
  - the **activation** state ("not activated yet", "active", "failed: …");
  - the APIs it **used that Yavin does not provide**;
  - what was not supported, refused, and not applied.

  Install and activation are separate rows (`vscodeCompatibility.ts`; the host records `UnsupportedApi` reports per extension).

- **`engines.vscode`** is shown, **never enforced**. Yavin implements no VS Code version as a whole; it implements the APIs listed in `vscodeApi.json`. A range therefore says nothing Yavin can check. `vscode.version` reports `1.90.0`, the API level the inventory was audited against. Anything an extension uses that Yavin lacks fails by name.

## B11. Test results (this session)

| Suite                                                       | Result                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust fmt; clippy (default and `test-registry`, all targets) | clean                                                                                                                                                                                                                                                                                                            |
| Rust workspace, default                                     | **872 passed, 0 failed**, 27 ignored (866 at EXT-24). The first full run had 4 failures: 3 were tests of contracts EXT-25 changes (API 2.1.0, 24 bridge methods, `read_modules` reading code), updated to the new contract; 1 (`terminal_stream` batch latency) passed 3/3 alone (load-sensitive, pre-existing). |
| Rust workspace, `test-registry`                             | **872 passed, 0 failed**, 27 ignored                                                                                                                                                                                                                                                                             |
| Host tests (`ide-plugin-host`)                              | 3 unit, 10 `host`, 4 `vscode` (layer, unsupported APIs, timers, inventory), all passed                                                                                                                                                                                                                           |
| Security mutations                                          | **109/109 caught** (104 + 5 new). In the full run, EXT-17 M6 was reported as broken because its build or test process did not start; it was caught on its own run. Sources byte-identical afterwards (every anchor checked).                                                                                     |
| TypeScript tests, typecheck, prettier                       | **1022 passed, 0 failed** (1014 at EXT-24); typecheck clean; prettier clean. Mock UI (Playwright, 4 workers): **475/475**. Updated: one expectation for the 2.1.0 API and the two Open VSX tests for the new policy. One load-sensitive test (`local-history.spec.ts:441`) passed alone.                         |
| Packaged MSI through `npm run test:real-host`               | **17/17** on the freshly built 2.2.0 test MSI (`--skip-build` rerun). The first run failed 1 test, 3 not run: two WebView2 processes outlived the app for 30 s on the first launch after the build (`profileReleased`); then passed.                                                                             |
| Open VSX benchmark                                          | As above (native, activation, analysis)                                                                                                                                                                                                                                                                          |

## B12. Outstanding EXT-24 release operations (not resolved by EXT-25)

| Id  | Item                            | Status                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4  | Registry signing key custody    | **FAIL**: unchanged. One unencrypted file, no backup. | No new evidence. Not read in this session.                                                                                                                                                                                                                                                                                                                                                         |
| R8  | CI on the EXT-24 commit         | **FAIL** (was NOT VERIFIED)                           | GitHub's public API, 2026-10-20: run 39412312928 on `26ff399` concluded **failure**. The `rust` job failed in `cargo test --workspace --locked`; `release-gate` failed because of it. version, typescript, ui and registry passed. The cause is **not verified**: job logs need an authenticated session. The same suite passes locally (§11). EXT-25 has not been pushed, so CI has never run it. |
| R2  | Renewal with the production key | **NOT VERIFIED**: never exercised                     | —                                                                                                                                                                                                                                                                                                                                                                                                  |
| N10 | 365-day index validity          | Open (operator decision)                              | —                                                                                                                                                                                                                                                                                                                                                                                                  |
| N11 | Installer code signing          | Open                                                  | —                                                                                                                                                                                                                                                                                                                                                                                                  |

**Release recommendation: unchanged, NO-GO** for the reasons EXT-24 gave, now including a red CI on its commit. EXT-25 itself adds no blocker it does not test.
