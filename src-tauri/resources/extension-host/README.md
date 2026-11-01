# Extension host

`yavin-extension-host(.exe)` -- the process extensions run in (IDE-08, crate `ide-plugin-host`) -- is
placed here by `node scripts/build-extension-host.mjs`, which the Tauri build runs first, and is
shipped with Yavin as a bundle resource (`bundle.resources` in `tauri.conf.json`). The binary is
built, never committed. Yavin finds it at `<resources>/resources/extension-host/` when installed.
