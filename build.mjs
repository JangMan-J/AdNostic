#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { loadCatalogue, toDnrRules, toMainTables } from "./catalogue.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function copyRecursive(srcDir, dstDir, skipNames = new Set()) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(s, d, skipNames);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function collectFiles(dir, baseDir = dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    if (entry.name === "_metadata" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, baseDir, out);
    } else {
      const rel = path.relative(baseDir, full).split(path.sep).join("/");
      out.push({ full, rel });
    }
  }
  return out;
}

// Pure Node.js OS-agnostic PKZIP builder (creates standard .zip and .xpi archives)
function createZipArchive(sourceDir, outArchive) {
  const files = collectFiles(sourceDir);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { full, rel } of files) {
    const nameBuf = Buffer.from(rel, "utf8");
    const rawData = fs.readFileSync(full);
    const compressed = zlib.deflateRawSync(rawData, { level: 9 });
    const useDeflate = compressed.length < rawData.length;
    const body = useDeflate ? compressed : rawData;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(rawData);

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHdr.writeUInt16LE(method, 8);
    localHdr.writeUInt16LE(0, 10);
    localHdr.writeUInt16LE(0x21, 12);
    localHdr.writeUInt32LE(crc, 14);
    localHdr.writeUInt32LE(body.length, 18);
    localHdr.writeUInt32LE(rawData.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);

    localParts.push(localHdr, nameBuf, body);

    const centralHdr = Buffer.alloc(46);
    centralHdr.writeUInt32LE(0x02014b50, 0);
    centralHdr.writeUInt16LE(20, 4);
    centralHdr.writeUInt16LE(20, 6);
    centralHdr.writeUInt16LE(0x0800, 8);
    centralHdr.writeUInt16LE(method, 10);
    centralHdr.writeUInt16LE(0, 12);
    centralHdr.writeUInt16LE(0x21, 14);
    centralHdr.writeUInt32LE(crc, 16);
    centralHdr.writeUInt32LE(body.length, 20);
    centralHdr.writeUInt32LE(rawData.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt16LE(0, 30);
    centralHdr.writeUInt16LE(0, 32);
    centralHdr.writeUInt16LE(0, 34);
    centralHdr.writeUInt16LE(0, 36);
    centralHdr.writeUInt32LE(0, 38);
    centralHdr.writeUInt32LE(offset, 42);

    centralParts.push(centralHdr, nameBuf);
    offset += localHdr.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(outArchive, Buffer.concat([...localParts, centralBuf, eocd]));
}

// 1. Check the committed icons (made from tools/AdNostic.svg by tools/make-icons.sh)
const iconsDir = path.join(SRC, "icons");
for (const sz of [16, 32, 48, 128]) {
  if (!fs.existsSync(path.join(iconsDir, `icon${sz}.png`))) throw new Error(`missing src/icons/icon${sz}.png (run tools/make-icons.sh)`);
}

// 2. Syntax-check JS & JSON files
for (const jsFile of ["inject-main.js", "content-isolated.js", "background.js", "popup.js"]) {
  execFileSync(process.execPath, ["--check", path.join(SRC, jsFile)], { stdio: "inherit" });
}

// 3. Build Chrome / Brave / Edge / Chromium MV3 target
fs.mkdirSync(DIST, { recursive: true });
const chromeDir = path.join(DIST, "chrome");
const firefoxDir = path.join(DIST, "firefox");

const baseManifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.base.json"), "utf8"));
const skip = new Set(["manifest.base.json", "catalogue.json", "site-rules.json"]);

// start from empty output folders so nothing stale from an earlier build is packaged
fs.rmSync(chromeDir, { recursive: true, force: true });
fs.rmSync(firefoxDir, { recursive: true, force: true });
copyRecursive(SRC, chromeDir, skip);
const chromeManifest = {
  ...baseManifest,
  background: {
    service_worker: "background.js"
  }
};
fs.writeFileSync(
  path.join(chromeDir, "manifest.json"),
  JSON.stringify(chromeManifest, null, 2) + "\n"
);

// 4. Build Firefox MV3 target
copyRecursive(SRC, firefoxDir, skip);
const firefoxManifest = {
  ...baseManifest,
  permissions: [...baseManifest.permissions],
  background: {
    scripts: ["background.js"]
  },
  browser_specific_settings: {
    gecko: {
      id: "adnostic@janglabs.io",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] }
    },
    gecko_android: {
      strict_min_version: "142.0"
    }
  }
};
fs.writeFileSync(
  path.join(firefoxDir, "manifest.json"),
  JSON.stringify(firefoxManifest, null, 2) + "\n"
);


// 4a. Generate everything that comes from the ad-network catalogue (rule list + page-side / Firefox tables).
const CAT = loadCatalogue(path.join(SRC, "catalogue.json"));
function applyCatalogue(dir) {
  fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "rules", "anti-adblock-dnr.json"), JSON.stringify(toDnrRules(CAT), null, 2) + "\n");
  const sub = (file, token, tables) => {
    const f = path.join(dir, file);
    const code = fs.readFileSync(f, "utf8");
    const needle = `/*@${token}@*/ null`;
    if (code.split(needle).length !== 2) throw new Error(`${file}: expected exactly one ${needle}`);
    fs.writeFileSync(f, code.replace(needle, () => JSON.stringify(tables)));
  };
  sub("inject-main.js", "CATALOGUE_MAIN", toMainTables(CAT));
}
applyCatalogue(chromeDir);
applyCatalogue(firefoxDir);

// 4b. Per-release naming. The two relay event names between the page-world and isolated-world scripts, and the
// order and ids of the DNR rules, are derived from a seed so that two releases do not share the same constants
// (it keeps the names from colliding with anything a page might define). It does not obfuscate logic: the
// output stays plain, readable source. The default seed is committed, so the same source always produces the
// same files; override with AUB_SEED=<text> to cut a release with different names.
const SEED = process.env.AUB_SEED || "adnostic-1.0.0";
const h = (label) => crypto.createHash("sha256").update(SEED + ":" + label).digest();
const tok = (label) => "_" + h(label).toString("hex").slice(0, 14);
const NAME_MAP = {
  "__aub_telemetry_9e4b1c": tok("telemetry"),
  "__aub_control_9e4b1c": tok("control")
};
function mutateTarget(dir) {
  for (const f of collectFiles(dir)) {
    if (f.rel.endsWith(".js")) {
      let code = fs.readFileSync(f.full, "utf8");
      for (const [from, to] of Object.entries(NAME_MAP)) code = code.split(from).join(to);
      fs.writeFileSync(f.full, code);
    }
  }
  const rp = path.join(dir, "rules", "anti-adblock-dnr.json");
  const rules = JSON.parse(fs.readFileSync(rp, "utf8"));
  // seeded shuffle, then seeded unique ids below the dynamic-rule range (10000+)
  const order = rules.map((r, i) => [h("order" + i).readUInt32BE(0), r]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const used = new Set();
  order.forEach((r, i) => {
    let id = (h("id" + i).readUInt32BE(0) % 8999) + 1;
    while (used.has(id)) id = (id % 8999) + 1;
    used.add(id);
    r.id = id;
  });
  fs.writeFileSync(rp, JSON.stringify(order, null, 2) + "\n");
}
mutateTarget(chromeDir);
mutateTarget(firefoxDir);

// 5. Package OS-agnostic WebExtension archives (.zip for Chrome/Chromium, .xpi for Firefox)
const chromeZip = path.join(DIST, "adnostic-chrome.zip");
const firefoxXpi = path.join(DIST, "adnostic-firefox.xpi");
createZipArchive(chromeDir, chromeZip);
createZipArchive(firefoxDir, firefoxXpi);

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
fs.writeFileSync(
  path.join(ROOT, "build-info.json"),
  JSON.stringify({ seed: SEED, names: NAME_MAP, chromeZipSha256: sha(chromeZip), firefoxXpiSha256: sha(firefoxXpi) }, null, 2) + "\n"
);
console.log("seed:", SEED);
console.log("Built OS-agnostic WebExtension targets:");
console.log(" -", chromeDir);
console.log(" -", firefoxDir);
console.log(" -", chromeZip);
console.log(" -", firefoxXpi);
