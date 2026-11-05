// Ad-network catalogue: the single place that knows which hosts and URL shapes the extension acts on.
//
// Interface (everything else is private):
//   loadCatalogue(path)   -> validated catalogue object (throws on a malformed entry)
//   toDnrRules(cat)       -> declarativeNetRequest rules (both browsers load these)
//   toMainTables(cat)     -> regex sources the page-side script compiles at startup
//
// Roles, per host:   block  = the network layer refuses the request (DNR)
//                    defuse = if the request fails, the page-side script reports a successful one
// They are independent on purpose: hosts the user's own blocker already handles are defuse-only,
// video-creative hosts are block-only, and the ad-provider hosts are both.
import fs from "node:fs";
import nodePath from "node:path";

const RESOURCE_TYPES = new Set(["script", "xmlhttprequest", "sub_frame", "image", "media", "other", "stylesheet", "font", "ping"]);
const MANIFEST_KINDS = ["vmap", "vast", "jsonAd"];

function fail(msg) {
  throw new Error("catalogue: " + msg);
}

function checkTypes(types, where) {
  if (!Array.isArray(types) || types.length === 0) fail(`${where}: block must be a non-empty array of resource types`);
  for (const t of types) if (!RESOURCE_TYPES.has(t)) fail(`${where}: unknown resource type "${t}"`);
}

function checkRegex(src, where) {
  try {
    new RegExp(src, "i");
  } catch (e) {
    fail(`${where}: invalid regex (${e.message})`);
  }
}

const SITE_OPS = new Set(["aopr", "aopw", "set", "cookie"]);
const SITE_VALUES = new Set(["false", "true", "null", "undefined", "noopFunc", "trueFunc", "falseFunc", "emptyStr", "emptyArr", "emptyObj"]);
const SITE_PROP = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

// Host-scoped scriptlets imported from the filter lists (tools/import-site-rules.mjs). Validated strictly:
// the generated table is compiled into page-world code, so nothing unexpected may pass through.
function loadSiteRules(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const rules = doc.rules;
  for (const g of doc.generic || []) {
    if (!["adnet", "detect"].includes(g.kind)) fail(`generic rule: unknown kind "${g.kind}"`);
    if (!["aopr", "aopw", "set"].includes(g.op)) fail(`generic rule ${g.prop}: unknown op "${g.op}"`);
    if (!SITE_PROP.test(g.prop)) fail(`generic rule: bad property "${g.prop}"`);
    if (g.op === "set" && !SITE_VALUES.has(g.value) && !/^\d{1,6}$/.test(g.value)) fail(`generic rule ${g.prop}: bad value`);
  }
  for (const r of rules) {
    if (!r.hosts?.length) fail("site rule without hosts");
    for (const h of r.hosts) if (!/^[a-z0-9][a-z0-9.\-]*(\.\*)?$/.test(h)) fail(`site rule: bad host "${h}"`);
    for (const a of r.actions) {
      if (!SITE_OPS.has(a.op)) fail(`site rule ${r.hosts[0]}: unknown op "${a.op}"`);
      if (a.op === "cookie") {
        if (!/^[\w.\-]+$/.test(a.name) || !/^[\w.\-]*$/.test(a.value)) fail(`site rule ${r.hosts[0]}: bad cookie`);
      } else if (!SITE_PROP.test(a.prop)) fail(`site rule ${r.hosts[0]}: bad property "${a.prop}"`);
      if (a.op === "set" && !SITE_VALUES.has(a.value) && !/^\d{1,6}$/.test(a.value)) fail(`site rule ${r.hosts[0]}: bad value "${a.value}"`);
    }
  }
  return { rules, generic: doc.generic || [] };
}

// "tube8.*" -> any TLD; every host also matches its subdomains
export function siteHostRegex(hosts) {
  const alt = hosts.map((h) => (h.endsWith(".*") ? h.slice(0, -2).replace(/\./g, "\\.") + "\\.[a-z.]+" : h.replace(/\./g, "\\.")));
  return `(?:^|\\.)(?:${alt.join("|")})$`;
}

export function loadCatalogue(path) {
  const cat = JSON.parse(fs.readFileSync(path, "utf8"));
  if (cat.version !== 1) fail("unsupported version " + cat.version);
  const seen = new Set();
  for (const h of cat.hosts) {
    if (!/^[a-z0-9][a-z0-9.\-]*$/.test(h.host)) fail(`bad host "${h.host}"`);
    if (seen.has(h.host)) fail(`duplicate host "${h.host}"`);
    seen.add(h.host);
    if (!h.block && !h.defuse) fail(`${h.host}: needs a role (block and/or defuse)`);
    if (h.block) checkTypes(h.block, h.host);
  }
  for (const p of cat.hostPatterns) checkRegex(p.regex, "hostPattern " + p.regex);
  for (const p of cat.paths) {
    if (!p.urlFilter) fail("path entry without urlFilter");
    checkTypes(p.block, p.urlFilter);
  }
  const site = loadSiteRules(nodePath.join(nodePath.dirname(path), "site-rules.json"));
  cat.siteRules = site.rules;
  cat.genericRules = site.generic;
  checkRegex(cat.adultNetworkRe, "adultNetworkRe");
  checkRegex(cat.probePathRe, "probePathRe");
  for (const k of MANIFEST_KINDS) {
    if (!cat.manifests?.[k]) fail(`manifests.${k} missing`);
    checkRegex(cat.manifests[k], "manifests." + k);
  }
  return cat;
}

export function toDnrRules(cat) {
  const filters = [
    ...cat.hosts.filter((h) => h.block).map((h) => ({ urlFilter: `||${h.host}^`, types: h.block })),
    ...cat.paths.map((p) => ({ urlFilter: p.urlFilter, types: p.block }))
  ];
  return filters.map((f, i) => ({
    id: i + 1,
    priority: 10,
    action: { type: "block" },
    condition: { urlFilter: f.urlFilter, resourceTypes: [...f.types] }
  }));
}

export function toMainTables(cat) {
  const esc = (h) => h.replace(/\./g, "\\.");
  const alts = [
    ...cat.hosts.filter((h) => h.defuse).map((h) => esc(h.host)),
    ...cat.hostPatterns.filter((p) => p.defuse).map((p) => p.regex)
  ];
  return {
    defuseHostRe: `(?:^|\\.)(?:${alts.join("|")})$`,
    probePathRe: cat.probePathRe,
    manifests: { ...cat.manifests },
    siteRules: cat.siteRules.map((r) => ({ hostRe: siteHostRegex(r.hosts), actions: r.actions })),
    genericRules: cat.genericRules.map((g) => ({ kind: g.kind, op: g.op, prop: g.prop, value: g.value })),
    adultNetworkRe: cat.adultNetworkRe
  };
}

