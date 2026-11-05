// One-shot import: reads the real uAssets and AdGuard filter lists and writes src/site-rules.json.
// Only host-scoped scriptlets on adult-site domains, and only the kinds the extension already implements:
//   aopr / aopw / set-constant / set-cookie. Everything else (popup, timer, listener scriptlets) is skipped.
// The output is committed; the release does not depend on the lists or on re-running this.
//   node tools/import-site-rules.mjs <uassets-filters.txt> <adguard-antiadblock.txt>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [uPath, aPath] = process.argv.slice(2);
if (!uPath || !aPath) { console.error("usage: node tools/import-site-rules.mjs <uassets-filters.txt> <adguard-antiadblock.txt>"); process.exit(2); }

const ADULT = /porn|xxx|hentai|sex|nude|fuck|milf|erotic|brazzers|xvideo|xnxx|xhamst|xh[a-z0-9]{3,}\.|redtube|youporn|tube8|rule34|spankbang|eporner|chaturbate|stripchat|tnaflix|beeg|drtuber|nuvid|youjizz|keezmovies|extremetube|tubegalore|motherless|fapello|ashemale|camwhores|camporn|camvideos|hotmovies|javhd|gay|pussy|boob|tits|anal/i;
const VALUES = new Set(["false", "true", "null", "undefined", "noopFunc", "trueFunc", "falseFunc", "emptyStr", "emptyArr", "emptyObj"]);
const PROP = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const DOMAIN = /^[a-z0-9][a-z0-9.\-]*(\.\*)?$/;

const normValue = (v) => {
  v = v.trim().replace(/^['"]|['"]$/g, "");
  if (v === "") return "emptyStr";
  if (VALUES.has(v)) return v;
  if (/^\d{1,6}$/.test(v)) return v;
  return null;
};
const normProp = (p) => {
  p = p.trim().replace(/^window\./, "");
  return PROP.test(p) ? p : null;
};

const byDomain = new Map();
const stats = { lines: 0, adultScriptlets: 0, kept: 0, skippedKind: {}, skippedValue: 0, skippedProp: 0 };
function add(domains, action) {
  for (const d of domains) {
    const list = byDomain.get(d) || [];
    if (!list.some((a) => JSON.stringify(a) === JSON.stringify(action))) list.push(action);
    byDomain.set(d, list);
  }
}
function domainsOf(raw) {
  return raw.split(",").map((d) => d.trim().toLowerCase()).filter((d) => d && !d.startsWith("~") && DOMAIN.test(d) && ADULT.test(d));
}
function handle(domains, kind, args) {
  stats.adultScriptlets++;
  if (kind === "aopr" || kind === "aopw") {
    const prop = normProp(args[0] || "");
    if (!prop) return void stats.skippedProp++;
    stats.kept++; return add(domains, { op: kind, prop });
  }
  if (kind === "set") {
    const prop = normProp(args[0] || ""), value = normValue(args[1] ?? "");
    if (!prop) return void stats.skippedProp++;
    if (value === null) return void stats.skippedValue++;
    stats.kept++; return add(domains, { op: "set", prop, value });
  }
  if (kind === "cookie") {
    const [name, value] = [(args[0] || "").trim(), (args[1] || "").trim()];
    if (!/^[\w.\-]+$/.test(name) || !/^[\w.\-]*$/.test(value)) return void stats.skippedValue++;
    stats.kept++; return add(domains, { op: "cookie", name, value });
  }
  stats.skippedKind[kind] = (stats.skippedKind[kind] || 0) + 1;
}

for (const raw of [...fs.readFileSync(uPath, "utf8").split("\n"), ...fs.readFileSync(aPath, "utf8").split("\n")]) {
  const line = raw.trim();
  stats.lines++;
  if (!line || line[0] === "!" || line[0] === "[") continue;
  let m = /^([^#]+)##\+js\((.*)\)$/.exec(line);            // uBlock Origin
  if (m) {
    const domains = domainsOf(m[1]);
    if (!domains.length) continue;
    const parts = m[2].split(",").map((s) => s.trim());
    const kind = { aopr: "aopr", "abort-on-property-read": "aopr", aopw: "aopw", "abort-on-property-write": "aopw", set: "set", "set-constant": "set", "set-cookie": "cookie", "set-cookie-reload": "cookie" }[parts[0]] || parts[0];
    handle(domains, kind, parts.slice(1));
    continue;
  }
  m = /^([^#]+)#%#\/\/scriptlet\((.*)\)$/.exec(line);       // AdGuard
  if (m) {
    const domains = domainsOf(m[1]);
    if (!domains.length) continue;
    const parts = m[2].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
    const kind = { "abort-on-property-read": "aopr", "abort-on-property-write": "aopw", "set-constant": "set", "set-cookie": "cookie", "set-cookie-reload": "cookie" }[parts[0]] || parts[0];
    handle(domains, kind, parts.slice(1));
  }
}

// group domains that share exactly the same action list
const groups = new Map();
for (const [domain, actions] of byDomain) {
  const key = JSON.stringify(actions);
  groups.set(key, [...(groups.get(key) || []), domain]);
}
const rules = [...groups.entries()]
  .map(([k, hosts]) => ({ hosts: hosts.sort(), actions: JSON.parse(k) }))
  .sort((a, b) => b.hosts.length - a.hosts.length || a.hosts[0].localeCompare(b.hosts[0]));

// ---- Generic subset: rules that may be engaged dynamically on hosts that are NOT in the table ----
// Engaging a rule on an unknown site is only safe when the property name is specific enough to the ad / detector
// tooling that a legitimate page is very unlikely to own it. Selection is evidence-based, from the lists themselves:
//   adnet  : abort-on-read of a vendor-shaped name carried by >= 3 unrelated sites (engaged when an adult ad network
//            request is defused on the page)
//   detect : a name that says "adblock" in so many words (engaged when the page measures a bait element that a blocker hid);
//            abort rules always, constants only when >= 2 sites agree on one value (polarity is site-specific)
const registrable = (h) => {
  const p = h.replace(/\.\*$/, "").split(".");
  const twoLevel = ["co", "com", "org", "net"].includes(p[p.length - 2]) && p[p.length - 1].length === 2;
  return p.slice(twoLevel ? -3 : -2).join(".");
};
const BUILTIN_HEADS = new Set(["window", "document", "console", "String", "Object", "Array", "JSON", "Math", "navigator", "location", "Function", "Promise", "Reflect", "Proxy", "Number", "Date", "RegExp", "Element", "Node", "EventTarget", "XMLHttpRequest", "history", "screen", "localStorage", "sessionStorage", "performance", "crypto"]);
const BUILTIN_NAMES = new Set(["open", "close", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "btoa", "atob", "alert", "confirm", "prompt", "eval", "fetch", "setTimeout", "setInterval", "name", "parent", "top", "self", "frames", "focus", "blur", "print", "stop"]);
// Reviewed by hand: names that pass the statistics but are too generic (or are already used as our own decoys).
const REVIEWED_EXCLUDE = new Set(["loadTool", "page_params", "page_params.holiday_promo", "initials", "exoNoExternalUI38djdkjDDJsio96"]);
const ADBLOCK_NAME = /ad[-_]?block|adsblocked|aadetector/i;
const vendorShaped = (head) => /[a-z][A-Z]|\d/.test(head);

const evidence = new Map(); // "op|prop" -> { domains:Set, values:Set }
for (const [domain, actions] of byDomain) {
  for (const a of actions) {
    if (a.op === "cookie") continue;
    const k = a.op + "|" + a.prop;
    const e = evidence.get(k) || { op: a.op, prop: a.prop, domains: new Set(), values: new Set() };
    e.domains.add(registrable(domain));
    if (a.op === "set") e.values.add(a.value);
    evidence.set(k, e);
  }
}
const generic = [];
for (const e of evidence.values()) {
  const head = e.prop.split(".")[0];
  if (BUILTIN_HEADS.has(head) || BUILTIN_NAMES.has(e.prop) || REVIEWED_EXCLUDE.has(e.prop) || REVIEWED_EXCLUDE.has(head)) continue;
  const n = e.domains.size;
  if (ADBLOCK_NAME.test(e.prop)) {
    if (e.op === "aopr" || e.op === "aopw") generic.push({ kind: "detect", op: e.op, prop: e.prop, domains: n });
    else if (e.op === "set" && n >= 2 && e.values.size === 1) generic.push({ kind: "detect", op: "set", prop: e.prop, value: [...e.values][0], domains: n });
  } else if (e.op === "aopr" && n >= 3 && vendorShaped(head)) {
    generic.push({ kind: "adnet", op: "aopr", prop: e.prop, domains: n });
  }
}
generic.sort((a, b) => a.kind.localeCompare(b.kind) || b.domains - a.domains || a.prop.localeCompare(b.prop));

fs.writeFileSync(path.join(root, "src", "site-rules.json"), JSON.stringify({ version: 1, rules, generic }) + "\n");
console.log("generic (dynamically engaged) rules:");
for (const g of generic) console.log(`  ${g.kind.padEnd(6)} ${g.op.padEnd(4)} ${g.prop}${g.value !== undefined ? " = " + g.value : ""}   (${g.domains} site${g.domains > 1 ? "s" : ""})`);
console.log(JSON.stringify({ ...stats, domains: byDomain.size, groups: rules.length }, null, 1));
