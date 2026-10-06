// Builds the extension host (IDE-08) and puts it where Yavin's bundle takes it from:
// src-tauri/resources/extension-host/, a bundle resource (tauri.conf.json `bundle.resources`),
// as the search tool is. The Tauri build runs this first (`beforeBuildCommand`, `--release`) and
// so does `tauri dev` (`beforeDevCommand`), so an installer never ships without the host.
//
//   node scripts/build-extension-host.mjs [--release]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const release = process.argv.includes("--release");
const tauri = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const name = process.platform === "win32" ? "yavin-extension-host.exe" : "yavin-extension-host";

execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "-p",
    "ide-plugin-host",
    "--bin",
    "yavin-extension-host",
    ...(release ? ["--release"] : []),
  ],
  { cwd: tauri, stdio: "inherit" },
);

const target = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : join(tauri, "target");
const built = join(target, release ? "release" : "debug", name);
if (!existsSync(built)) throw new Error(`The extension host was not built: ${built} is missing.`);
const destination = join(tauri, "resources", "extension-host");
mkdirSync(destination, { recursive: true });
copyFileSync(built, join(destination, name));
console.log(
  `Packaged the extension host (${release ? "release" : "debug"}, ${statSync(built).size} bytes) into ${destination}`,
);
