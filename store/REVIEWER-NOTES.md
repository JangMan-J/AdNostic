# AdNostic: notes for store reviewers

## Building from source
- `node build.mjs` produces `dist/chrome/`, `dist/firefox/` and the two archives. It uses only Node.js built-in modules; there is nothing to install. (Developed with Node 26; not run on other versions.)
- The default seed is committed (`adnostic-1.0.0`), so the same source always produces the same files. `build-info.json` records the seed and archive hashes. Compare extracted files, not archive bytes.
- The shipped code is **not minified or obfuscated**. `build.mjs` copies `src/` and applies three mechanical steps, all visible in the script:
  1. writes `rules/anti-adblock-dnr.json` from `src/catalogue.json` (ad-network hosts and URL patterns);
  2. replaces one placeholder (`/*@CATALOGUE_MAIN@*/ null`) in `inject-main.js` with a JSON table generated from `src/catalogue.json` and `src/site-rules.json`;
  3. renames two internal event-name constants and orders the DNR rule ids from the seed.
- `src/icons/*.png` were rasterized from `tools/AdNostic.svg` by `tools/make-icons.sh`.

## What it does
- DNR static rules block a fixed list of ad-network and detector hosts and URL patterns; dynamic `allowAllRequests` rules implement the user's per-site pause.
- A page-world content script (`inject-main.js`, `document_start`, all frames) disables scripts that circumvent the user's ad blocking: it makes hidden bait elements report normal sizes, turns failed ad-probe requests into successes, and aborts specific ad and pop-under loader scripts. `src/site-rules.json` holds the per-site rules for sites that serve ads containing explicit content (host names, property names and constant values only; generated once with `tools/import-site-rules.mjs` from public filter lists, which are not needed to build). On other sites the same kind of rule engages only after the page runs an ad-network request or a detector.
- An isolated-world script (`content-isolated.js`) hides "disable your ad blocker" overlays, unlocks scrolling, and hides ad slots and ad videos that a site injects under randomly generated class names.
- It excludes `google.com`, `youtube.com`, `mozilla.org`, `mozilla.com` and `firefox.com`.
- Wrapped page APIs are proxied so a page cannot tell the extension is present. That is deliberate, to defeat anti-adblock detection. It hides nothing from the user or from reviewers.

## Things you may see
- Pages whose pop-under scripts are aborted may log a `ReferenceError` in the console. That is the intended effect.
- Nothing is transmitted. No `fetch`, XHR, WebSocket or beacon is made by extension code. There is no `eval`, `new Function` or remote script. `new RegExp(...)` is built only from tables inside the package.
- Four listed sites get one page cookie (`site-rules.json`, `op: "cookie"`).

## How to try it
Load the unpacked folder or archive and open a page with an anti-adblock overlay, or any page that requests a `blockadblock`/`fuckadblock` script. The toolbar popup shows a per-tab count and a pause switch for the current site.

