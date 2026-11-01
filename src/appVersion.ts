/**
 * Yavin's version, as the window shows and reports it (EXT-24). The one source is
 * `src-tauri/tauri.conf.json`'s `version` -- what the installer carries -- read by Vite at build
 * time (`vite.config.ts`); nothing else spells it out. Outside a Vite build (the unit tests) it is
 * `0.0.0-dev`.
 */
declare const __YAVIN_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __YAVIN_VERSION__ === "string" ? __YAVIN_VERSION__ : "0.0.0-dev";
