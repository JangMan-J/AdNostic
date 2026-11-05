# AdNostic: store listing copy

## Name
AdNostic

## Summary (hard limit 250 characters)
Blocks intrusive ads, pop-unders, and adversarial scripts. Specifically targets blocking ads containing explicit content, as well as disabling embedded scripts intended to circumvent user settings and preferences. Collects no data.

## Description (supports limited Markdown; no hard limit, keep it scannable)
**Blocks intrusive ads, pop-unders, and adversarial scripts.**

Specifically targets blocking ads containing explicit content, as well as disabling embedded scripts intended to circumvent your settings and preferences.

- **Stops explicit ads and pop-unders** before they reach the page
- **Disables scripts** that detect your ad blocker and try to override your choices
- **Removes lockout overlays** and restores scrolling
- **Works on its own** or beside the ad blocker you already use

**Private by design:** it runs entirely in your browser, makes no network requests of its own and needs no account. **Collects no data.**

_It does not remove every ad and is not a replacement for a full ad blocker._

## Categories
- AMO: Privacy & Security

## Privacy answers
- Collects or transmits user data: No.
- Remote code: No. All code is in the package; rule tables are packaged JSON.
- Accounts: None.
- Firefox manifest declares `data_collection_permissions: { required: ["none"] }`.

## Single purpose
"Block intrusive ads and ads containing explicit content, suppress unauthorized pop-unders, and disable scripts that circumvent the user's ad-blocking settings and preferences. Collects no data."

## Permission justifications
- `host_permissions <all_urls>` and content scripts: "Intrusive ad networks and the scripts that circumvent ad blocking can appear on any site and in any frame, and must be answered before the page's own scripts run. The set of sites cannot be listed in advance."
- `declarativeNetRequestWithHostAccess`: "Blocks requests to a fixed list of ad-network and detector hosts bundled in the extension, and stops blocking on sites the user pauses."
- `storage`: "Two local settings: the global on/off switch and the list of sites the user paused. Never leaves the device."

## Screenshot
`store/screenshot.png`
