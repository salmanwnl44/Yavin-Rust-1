// Verifies the DEPLOYED Yavin registry index against the trust Yavin pins (EXT-24): what users
// download, not the files in the repository.
//
//   node scripts/verify-registry.mjs [--base URL] [--anchors FILE] [--local DIR|none] [--warn-days N]
//   node scripts/verify-registry.mjs --files DIR     a candidate, before it is published
//
// Fetches index.json and index.json.sig from the registry's base (default: the official one in
// src-tauri/src/registry_anchors.json) and fails (exit 1), saying why, if:
//   - either is missing, or the signature file is not exactly what Yavin reads;
//   - the signature does not verify -- Ed25519 over Yavin's domain prefix and the exact bytes
//     served -- under a key pinned for that very registry, active and within its notAfter;
//   - the index names another registry, is malformed, is below the floor this release pins
//     (minSequence), has expired, or expires within the warning lead time (default 90 days);
//   - (with --local, default the repository's registry/) the deployed bytes are not the
//     repository's: the publication did not happen, or something else is being served.
// The Rust verifier in the application is the one that decides installs; this is the monitor.
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const DOMAIN = Buffer.from("Yavin.RegistryIndex.v1\0", "utf8");
const DAY = 86_400_000;
// Whole days since 1970, as Yavin compares them: a date is valid through that day itself.
const dayOf = (text) =>
  /^\d{4}-\d{2}-\d{2}$/.test(text ?? "") ? Date.parse(`${text}T00:00:00Z`) / DAY : NaN;

/**
 * What is wrong with a deployed index (\`index\`, \`signature\`: their bytes, or null if not
 * served), against \`anchors\` for the registry at \`base\`, on \`today\` (ms), warning \`warnDays\`
 * ahead; \`local\`: the repository's index bytes, if they should match. Returns the problems (empty:
 * fine) and what was found.
 */
export function check({ anchors, base, index, signature, today: now, warnDays, local = null }) {
  const today = Math.floor(now / DAY);
  const problems = [];
  const found = {};
  const anchor = anchors.registries.find((r) => r.base === base);
  if (!anchor) return { problems: [`no registry is pinned at ${base}`], found };
  if (!index) problems.push("index.json is not served");
  if (!signature) problems.push("index.json.sig is not served");
  if (!index || !signature) return { problems, found };
  let sig;
  try {
    sig = JSON.parse(signature.toString("utf8"));
  } catch {
    return { problems: ["index.json.sig is not JSON"], found };
  }
  const fields = ["schema", "registryId", "keyId", "algorithm", "signature"];
  if (Object.keys(sig).sort().join() !== [...fields].sort().join() || sig.schema !== 1)
    problems.push(`index.json.sig must hold exactly ${fields.join(", ")} (schema 1)`);
  found.keyId = sig.keyId;
  if (sig.registryId !== anchor.id)
    problems.push(`the signature names registry ${sig.registryId}, not ${anchor.id}`);
  if (sig.algorithm !== "ed25519") problems.push(`algorithm ${sig.algorithm} is not ed25519`);
  const key = anchor.keys.find((k) => k.keyId === sig.keyId);
  if (!key) problems.push(`key ${sig.keyId} is not pinned for ${anchor.id}`);
  else {
    if (key.status !== "active") problems.push(`key ${sig.keyId} is ${key.status}`);
    if (key.notAfter && today > dayOf(key.notAfter))
      problems.push(`key ${sig.keyId} is past its notAfter (${key.notAfter})`);
    const raw = Buffer.from(sig.signature ?? "", "base64");
    const ok =
      raw.length === 64 &&
      verify(null, Buffer.concat([DOMAIN, index]), createPublicKey(key.publicKey), raw);
    if (!ok)
      problems.push(
        "the signature does not verify over the bytes served (changed after signing, or another key)",
      );
  }
  let value;
  try {
    value = JSON.parse(index.toString("utf8"));
  } catch {
    problems.push("index.json is not JSON");
    return { problems, found };
  }
  Object.assign(found, {
    registryId: value.registryId,
    sequence: value.sequence,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
  const issued = dayOf(value.issuedAt);
  const expires = dayOf(value.expiresAt);
  if (
    value.schema !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !(issued <= expires)
  )
    problems.push("index.json is malformed (schema, sequence or dates)");
  if (value.registryId !== anchor.id)
    problems.push(`index.json names registry ${value.registryId}, not ${anchor.id}`);
  if (Number.isSafeInteger(value.sequence) && value.sequence < anchor.minSequence)
    problems.push(
      `sequence ${value.sequence} is below the floor this release pins (${anchor.minSequence}): Yavin refuses it`,
    );
  if (today > expires) problems.push(`the index expired on ${value.expiresAt}`);
  else {
    found.daysLeft = expires - today;
    if (found.daysLeft < warnDays)
      problems.push(
        `the index expires on ${value.expiresAt}, in ${found.daysLeft} day(s) -- less than ${warnDays}: renew it`,
      );
  }
  if (local && !local.equals(index))
    problems.push(
      "the deployed index is not the repository's registry/index.json (not published, or something else is served)",
    );
  return { problems, found };
}

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: "error" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 ? process.argv[at + 1] : undefined;
  };
  const anchors = JSON.parse(
    readFileSync(arg("anchors") ?? join(app, "src-tauri", "src", "registry_anchors.json"), "utf8"),
  );
  const base = arg("base") ?? anchors.registries.find((r) => r.id === "yavin-official").base;
  // --files DIR: a candidate not yet published (a renewal to review), checked offline as the
  // registry at \`base\` would serve it.
  const files = arg("files");
  const localDir = arg("local") ?? (arg("base") || files ? null : join(app, "registry"));
  const warnDays = Number(arg("warn-days") ?? process.env.YAVIN_REGISTRY_WARN_DAYS ?? 90);
  const readOrNull = (path) => {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  };
  const [index, signature] = files
    ? [readOrNull(join(files, "index.json")), readOrNull(join(files, "index.json.sig"))]
    : await Promise.all([fetchBytes(`${base}index.json`), fetchBytes(`${base}index.json.sig`)]);
  const local = localDir && localDir !== "none" ? readFileSync(join(localDir, "index.json")) : null;
  const { problems, found } = check({
    anchors,
    base,
    index,
    signature,
    today: Date.now(),
    warnDays,
    local,
  });
  console.log(`registry ${base}: ${JSON.stringify(found)}`);
  if (problems.length) {
    for (const problem of problems) console.error(`registry: ${problem}`);
    process.exit(1);
  }
  console.log(
    `verified: signed with ${found.keyId}, sequence ${found.sequence}, expires ${found.expiresAt} (${found.daysLeft} days)${local ? ", identical to the repository" : ""}.`,
  );
}
