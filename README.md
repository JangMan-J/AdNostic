# AdNostic (Chrome & Firefox WebExtension)

OS-agnostic Manifest V3 browser extension for **Chrome / Brave / Edge / Chromium** and **Firefox (140+)**.

Blocks intrusive ads, pop-unders, and adversarial scripts. Specifically targets blocking ads containing explicit content, as well as disabling embedded scripts intended to circumvent user settings and preferences. Collects no data.

## Packaged Extension Files

- **Chrome / Brave / Edge / Chromium**: `dist/adnostic-chrome.zip` (unpacked folder: `dist/chrome/`)
- **Firefox**: `dist/adnostic-firefox.xpi` (unpacked folder: `dist/firefox/`)

Both packages are pure WebExtensions (HTML/CSS/JS + JSON + PNG) with zero OS-specific dependencies and run on Windows, macOS, Linux, and Firefox for Android.

## Installation (Any OS)

### Chrome / Brave / Edge / Chromium
1. Unzip `dist/adnostic-chrome.zip` (or select `dist/chrome/` directly).
2. Open `chrome://extensions` (or `brave://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the extracted `chrome` folder (on Chrome 130+, you can also drag `dist/adnostic-chrome.zip` onto `chrome://extensions` with Developer mode enabled).

### Firefox
- **Temporary load (any release Firefox)**: Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and select `dist/adnostic-firefox.xpi`.
- **Permanent load (Firefox Developer Edition / Nightly / ESR)**: Set `xpinstall.signatures.required` to `false` in `about:config`, then open `about:addons` → gear icon → **Install Add-on From File…** → select `dist/adnostic-firefox.xpi`.

## How It Works

1. **Stealth `MAIN`-World Scriptlet Engine (`src/inject-main.js`, `document_start`)**
   - Preserves `Function.prototype.toString` (`[native code]`) on all wrapped DOM/Web APIs to defeat anti-tamper checks.
   - Spoofs bait DOM element geometry (`offsetHeight`, `offsetWidth`, `clientHeight`, `clientWidth`, `offsetParent`, `getBoundingClientRect`, `getClientRects`), `getComputedStyle`, and `abp` body attributes when hidden by cosmetic adblock rules.
   - Converts blocked ad-probe `<script>`, `<img>`, and `<iframe>` `error` events into synthetic `load` events (both DOM capture phase and detached `new Image()` prototype handlers) across Google Ads, ExoClick (`magsrv`, `exdynsrv`, `pemsrv`, `realsrv`), TrafficJunky, JuicyAds, PopAds, AdScore, and generic `/ads.js` probes.
   - Intercepts rejected `fetch()` and `XMLHttpRequest` ad-probe requests and resolves synthetic `200 OK` responses.
   - Stubs detector globals (`FuckAdBlock`, `BlockAdBlock`, `SniffAdBlock`, `canRunAds`, `adsbygoogle.loaded`, ExoClick fallback suppressor `exoNoExternalUI38djdkjDDJsio96`, `googlefc`) and host-scoped `aopr`/`aopw`/`set-constant`/cookie rules.
2. **Surgical DOM Wall & Scroll-Lock Neutralizer (`src/content-isolated.js`)**
   - Hides known anti-adblock overlays (for example Google Funding Choices `.fc-ab-root` and BlockAdBlock `#babasbmsgx`, plus a small set of site-specific overlay selectors) and unclassed modal lockouts matching anti-adblock wording.
   - Explicitly preserves 18+ age-verification gates and `<video>` players, while stripping anti-adblock `blur()` filters and `overflow: hidden` scroll locks.
3. **Network layer (`src/background.js`; rules generated from `src/catalogue.json` into `rules/anti-adblock-dnr.json`)**
   - Chrome and Firefox: a `declarativeNetRequest` ruleset blocks a fixed list of ad-network and detector hosts, plus dynamic per-host pause rules.

## Build from Source

```bash
node build.mjs
```

Needs only Node.js (developed with Node 26; no packages to install). Output: `dist/chrome/`, `dist/firefox/`, `dist/adnostic-chrome.zip`, `dist/adnostic-firefox.xpi`, and `build-info.json` with the archive hashes. The default seed is committed, so the same source always gives the same files; set `AUB_SEED=<text>` to cut a release with different internal names.

`src/icons/` comes from `tools/AdNostic.svg` (`tools/make-icons.sh`, needs `rsvg-convert`); `src/site-rules.json` was generated once by `tools/import-site-rules.mjs`. Neither is needed to build.

## License

MIT, see `LICENSE`.
