// Builds Yavin's extension registry (IDE-09) -- `registry/index.json`, `registry/packages/`,
// `registry/docs/`, `registry/icons/` -- from `registry/catalog.json` and the extensions' source
// folders. Packages are deterministic (sorted entries, fixed timestamps), so the same sources
// always give the same SHA-256. Served as static files over HTTPS (the repository's raw files),
// the registry is what `YavinRegistryProvider` reads.
//
//   node scripts/build-registry.mjs           write the registry
//   node scripts/build-registry.mjs --check   fail if the written registry is out of date
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, deflateSync } from "node:zlib";
// Yavin's own manifest validator: a package the installer would refuse is never published.
import { readManifest } from "../src/services/extensions/manifest.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "registry");
const check = process.argv.includes("--check");
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
const index = {
  schema: catalog.schema,
  name: catalog.name,
  categories: catalog.categories,
  recommended: catalog.recommended,
  extensions,
};
written.set("index.json", Buffer.from(`${JSON.stringify(index, null, 2)}\n`));

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
  console.log(`The registry is up to date (${written.size} files).`);
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
