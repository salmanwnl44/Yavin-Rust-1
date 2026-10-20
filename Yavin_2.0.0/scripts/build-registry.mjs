// Builds Yavin's extension registry (IDE-09) -- `registry/index.json`, `registry/packages/`,
// `registry/docs/`, `registry/icons/` -- from `registry/catalog.json` and the extensions' source
// folders. Packages are deterministic (sorted entries, fixed timestamps), so the same sources
// always give the same SHA-256. Served as static files over HTTPS (the repository's raw files),
// the registry is what `YavinRegistryProvider` reads.
//
//   node scripts/build-registry.mjs           write the registry
//   node scripts/build-registry.mjs --check   fail if the written registry is out of date, or its
//                                             index expires within YAVIN_REGISTRY_WARN_DAYS days
//                                             (default 90): then it must be renewed
//   node scripts/build-registry.mjs --renew   sign the index again with the next sequence and new
//                                             dates though nothing changed (EXT-24) -- a release
//                                             operator's step, with the production key; publish
//                                             only the result, then check it with
//                                             scripts/verify-registry.mjs
//
// The index is signed (EXT-20): `registry/index.json.sig`, Ed25519 over a domain prefix and the
// exact bytes of `index.json`, with the key Yavin pins (`src-tauri/src/registry_anchors.json`).
// The private key is never in the repository: `YAVIN_REGISTRY_SIGNING_KEY` names it (a PKCS#8
// PEM; default `~/.yavin-registry/signing-key.pem`). It is needed only when the content changes:
// then `sequence` rises and the dates are renewed; unchanged content keeps the published index
// and signature, byte for byte (so `--check` needs no key), unless `--renew` is given. The
// registry id and key id are the ones `registry_anchors.json` pins (the key must be active), and
// every new signature is verified against the pinned public key over the exact bytes written,
// before anything is written. A sequence is never reused: it is always the previous one plus one.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, deflateSync } from "node:zlib";
// Yavin's own manifest validator: a package the installer would refuse is never published.
import { readManifest } from "../src/services/extensions/manifest.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Tests point these elsewhere (a copy, a test key's anchors); a release uses the defaults.
const out = process.env.YAVIN_REGISTRY_OUT ?? join(root, "registry");
const anchorsFile =
  process.env.YAVIN_REGISTRY_ANCHORS ?? join(root, "src-tauri", "src", "registry_anchors.json");
const check = process.argv.includes("--check");
const renew = process.argv.includes("--renew");
if (check && renew) {
  console.error("--check and --renew do not go together.");
  process.exit(1);
}
const catalog = JSON.parse(readFileSync(join(out, "catalog.json"), "utf8"));

// --- zip (store/deflate, no timestamps, no extra fields) ------------------------------------
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const header = (signature, extra) => {
      const b = Buffer.alloc(extra ? 46 : 30);
      let i = 0;
      const u32 = (v) => ((i = b.writeUInt32LE(v >>> 0, i)), undefined);
      const u16 = (v) => ((i = b.writeUInt16LE(v, i)), undefined);
      u32(signature);
      if (extra) u16(20); // version made by
      u16(20); // version needed
      u16(0x0800); // UTF-8 names
      u16(stored ? 0 : 8);
      u16(0); // time
      u16(0x21); // date: 1980-01-01
      u32(crc);
      u32(body.length);
      u32(data.length);
      u16(nameBytes.length);
      u16(0); // extra
      if (extra) {
        u16(0); // comment
        u16(0); // disk
        u16(0); // internal attributes
        u32(0); // external attributes: a plain file
        u32(offset);
      }
      return b;
    };
    const local = Buffer.concat([header(0x04034b50, false), nameBytes, body]);
    central.push(Buffer.concat([header(0x02014b50, true), nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function filesOf(folder) {
  const all = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        all.push({ name: relative(folder, path).replaceAll("\\", "/"), data: readFileSync(path) });
    }
  };
  walk(folder);
  return all;
}

// --- icons (64x64 PNG, drawn here) ---------------------------------------------------------
function png(draw) {
  const size = 64;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const rounded = (x, y, s, r) => {
  const cx = Math.min(Math.max(x, r), s - 1 - r);
  const cy = Math.min(Math.max(y, r), s - 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const ICONS = {
  hello: (x, y, s) => {
    if (!rounded(x, y, s, 12)) return [0, 0, 0, 0];
    const d = Math.hypot(x - 32, y - 30);
    return d < 14 ? [255, 255, 255, 255] : [79, 70, 229, 255];
  },
  count: (x, y, s) => {
    if (!rounded(x, y, s, 12)) return [0, 0, 0, 0];
    const bars = [
      [14, 22, 40],
      [27, 35, 28],
      [40, 48, 16],
    ];
    return bars.some(([a, b, top]) => x >= a && x < b && y >= top && y < 50)
      ? [255, 255, 255, 255]
      : [5, 150, 105, 255];
  },
  todo: (x, y, s) => {
    if (!rounded(x, y, s, 12)) return [0, 0, 0, 0];
    const onCheck =
      Math.abs(y - (x < 28 ? 34 + (x - 18) : 44 - (x - 28) * 1.2)) < 4 && x > 16 && x < 50;
    return onCheck ? [255, 255, 255, 255] : [217, 119, 6, 255];
  },
};

// --- the registry ----------------------------------------------------------------------------
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const written = new Map();
const extensions = [];
for (const entry of catalog.extensions) {
  const versions = [];
  let latest = null;
  for (const version of entry.versions) {
    const folder = join(root, version.source);
    const manifest = JSON.parse(readFileSync(join(folder, "yavin-extension.json"), "utf8"));
    const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
    if (id !== entry.id) throw new Error(`${version.source} is ${id}, not ${entry.id}`);
    const valid = readManifest(manifest);
    if (!valid.ok)
      throw new Error(
        `${version.source}: its manifest is not valid: ${valid.problems
          .filter((p) => p.severity === "error")
          .map((p) => `${p.field}: ${p.message}`)
          .join("; ")}`,
      );
    if (versions.some((v) => v.version === manifest.version))
      throw new Error(`${entry.id} ${manifest.version} is listed twice in the catalog.`);
    const bytes = zip(filesOf(folder));
    const path = `packages/${id}-${manifest.version}.yvx`;
    written.set(path, bytes);
    versions.push({
      version: manifest.version,
      publishedAt: version.publishedAt,
      engines: manifest.engines,
      package: path,
      sha256: sha256(bytes),
      size: bytes.length,
    });
    latest = { manifest, folder };
  }
  const { manifest, folder } = latest;
  const docs = {};
  for (const [key, file] of [
    ["readme", "README.md"],
    ["changelog", "CHANGELOG.md"],
  ])
    if (existsSync(join(folder, file))) {
      docs[key] = `docs/${entry.id}/${file}`;
      written.set(docs[key], readFileSync(join(folder, file)));
    }
  let icon;
  if (entry.icon) {
    icon = `icons/${entry.id}.png`;
    written.set(icon, png(ICONS[entry.icon]));
  }
  const contributes = manifest.contributes ?? {};
  extensions.push({
    id: entry.id,
    publisher: manifest.publisher,
    name: manifest.name,
    displayName: manifest.displayName ?? manifest.name,
    publisherDisplayName: entry.publisherDisplayName,
    description: manifest.description ?? "",
    categories: entry.categories,
    tags: entry.tags ?? [],
    ...(icon ? { icon } : {}),
    ...docs,
    ...(entry.repository ? { repository: entry.repository } : {}),
    ...(entry.homepage ? { homepage: entry.homepage } : {}),
    ...(manifest.license ? { license: manifest.license } : {}),
    contributes: {
      commands: (contributes.commands ?? []).map((c) => ({
        command: c.command,
        title: c.category ? `${c.category}: ${c.title}` : c.title,
      })),
      settings: Object.entries(contributes.configuration?.properties ?? {}).map(([id, s]) => ({
        id,
        description: s.description ?? "",
      })),
    },
    extensionKind: manifest.main ? "code" : "declarative",
    activationEvents: manifest.activationEvents ?? [],
    versions: versions.reverse(),
  });
}
const content = {
  schema: catalog.schema,
  name: catalog.name,
  categories: catalog.categories,
  recommended: catalog.recommended,
  extensions,
};
// --- The signed index (EXT-20) ----------------------------------------------------------------
// What Yavin pins for its own registry (src-tauri/src/registry_anchors.json): the index must be
// signed as that registry, with a key pinned for it and active.
const pinned = JSON.parse(readFileSync(anchorsFile, "utf8")).registries.find(
  (r) => r.id === "yavin-official",
);
const REGISTRY_ID = pinned.id;
const KEY_ID = "yavin-registry-2026-10-19";
const pinnedKey = pinned.keys.find((k) => k.keyId === KEY_ID);
if (!pinnedKey || pinnedKey.status !== "active" || pinnedKey.algorithm !== "ed25519") {
  console.error(
    `The signing key ${KEY_ID} is not pinned as an active Ed25519 key for ${REGISTRY_ID}.`,
  );
  process.exit(1);
}
const DOMAIN = Buffer.from("Yavin.RegistryIndex.v1\0", "utf8");
const VALID_DAYS = 365;
const FRESHNESS = ["registryId", "sequence", "issuedAt", "expiresAt"];
const contentOf = (index) =>
  JSON.stringify(Object.fromEntries(Object.entries(index).filter(([k]) => !FRESHNESS.includes(k))));
const indexFile = join(out, "index.json");
const signatureFile = join(out, "index.json.sig");
const previous = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : null;
if (
  !renew &&
  previous &&
  existsSync(signatureFile) &&
  previous.registryId === REGISTRY_ID &&
  contentOf(previous) === contentOf(content)
) {
  // The same content: the published index and its signature, as they are.
  written.set("index.json", readFileSync(indexFile));
  written.set("index.json.sig", readFileSync(signatureFile));
} else {
  const day = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const { schema, ...rest } = content;
  const signedIndex = {
    schema,
    registryId: REGISTRY_ID,
    sequence: (previous?.sequence ?? 0) + 1,
    issuedAt: day(now),
    expiresAt: day(new Date(now.getTime() + VALID_DAYS * 86_400_000)),
    ...rest,
  };
  const bytes = Buffer.from(`${JSON.stringify(signedIndex, null, 2)}\n`);
  written.set("index.json", bytes);
  if (!check) {
    const keyFile =
      process.env.YAVIN_REGISTRY_SIGNING_KEY ??
      join(homedir(), ".yavin-registry", "signing-key.pem");
    if (!existsSync(keyFile)) {
      console.error(
        `The registry changed, so its index must be signed again: no signing key at ${keyFile} (set YAVIN_REGISTRY_SIGNING_KEY).`,
      );
      process.exit(1);
    }
    const signature = sign(
      null,
      Buffer.concat([DOMAIN, bytes]),
      createPrivateKey(readFileSync(keyFile)),
    );
    // The signature must verify under the key Yavin pins, over the very bytes written.
    if (
      !verify(null, Buffer.concat([DOMAIN, bytes]), createPublicKey(pinnedKey.publicKey), signature)
    ) {
      console.error(
        `The signing key does not match the pinned key ${KEY_ID}: nothing was written.`,
      );
      process.exit(1);
    }
    written.set(
      "index.json.sig",
      Buffer.from(
        JSON.stringify({
          schema: 1,
          registryId: REGISTRY_ID,
          keyId: KEY_ID,
          algorithm: "ed25519",
          signature: signature.toString("base64"),
        }),
      ),
    );
  }
}

// A published version is immutable: the same version with other bytes would install different
// code under a checksum users already trust. Change the content, change the version.
const publishedFile = join(out, "index.json");
if (existsSync(publishedFile)) {
  const published = JSON.parse(readFileSync(publishedFile, "utf8"));
  const changed = [];
  for (const before of published.extensions ?? [])
    for (const old of before.versions ?? []) {
      const now = extensions
        .find((e) => e.id === before.id)
        ?.versions.find((v) => v.version === old.version);
      if (now && now.sha256 !== old.sha256) changed.push(`${before.id} ${old.version}`);
    }
  if (changed.length) {
    console.error(
      `Published versions would change content: ${changed.join(", ")}. Give the changed package a new version.`,
    );
    process.exit(1);
  }
}

if (check) {
  const stale = [...written].filter(([path, bytes]) => {
    const file = join(out, path);
    return !existsSync(file) || !readFileSync(file).equals(bytes);
  });
  if (stale.length) {
    console.error(
      `The registry is out of date: ${stale.map(([p]) => p).join(", ")}. Run node scripts/build-registry.mjs.`,
    );
    process.exit(1);
  }
  // Its expiry, ahead of time: an index past it installs no code.
  const index = JSON.parse(readFileSync(indexFile, "utf8"));
  const warnDays = Number(process.env.YAVIN_REGISTRY_WARN_DAYS ?? 90);
  // Whole days, as Yavin counts them: the index is valid through its expiry day.
  const left =
    Date.parse(`${index.expiresAt}T00:00:00Z`) / 86_400_000 - Math.floor(Date.now() / 86_400_000);
  if (!(left >= warnDays)) {
    console.error(
      `The registry index (sequence ${index.sequence}) expires on ${index.expiresAt}, in ${left} day(s) -- less than ${warnDays}: renew it (node scripts/build-registry.mjs --renew, with the signing key), publish it, then verify it (node scripts/verify-registry.mjs).`,
    );
    process.exit(1);
  }
  console.log(
    `The registry is up to date (${written.size} files); its index expires on ${index.expiresAt}, in ${left} days.`,
  );
} else {
  for (const folder of ["packages", "docs", "icons"])
    rmSync(join(out, folder), { recursive: true, force: true });
  for (const [path, bytes] of written) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), bytes);
  }
  const total = [...written.values()].reduce((sum, b) => sum + b.length, 0);
  console.log(
    `Wrote the registry: ${extensions.length} extensions, ${written.size} files, ${total} bytes.`,
  );
  for (const e of extensions)
    for (const v of e.versions)
      console.log(`  ${e.id} ${v.version}  ${v.size} bytes  sha256 ${v.sha256}`);
}
