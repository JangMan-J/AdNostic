(() => {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const EVENT_TELEMETRY = "__aub_telemetry_9e4b1c";
  const EVENT_CONTROL = "__aub_control_9e4b1c";

  let isPaused = false;

  const localStats = {
    baitSpoofs: 0,
    probeIntercepts: 0,
    sdkStubs: 0,
    overlaysRemoved: 0,
    scrollUnlocks: 0,
    neutralizedSelectors: []
  };

  localStats.hooks = {};
  function hook(name, n = 1) {
    localStats.hooks[name] = (localStats.hooks[name] || 0) + n;
  }

  function sendStatsDelta(delta) {
    try {
      api.runtime.sendMessage({
        type: "AUB_RECORD_STATS",
        host: location.hostname,
        delta
      }).catch?.(() => {});
    } catch (_) {}
  }

  document.addEventListener(
    EVENT_TELEMETRY,
    (ev) => {
      if (isPaused || !ev || !ev.detail) return;
      const d = ev.detail;
      const delta = {
        baitSpoofs: Number(d.baitSpoofs) || 0,
        probeIntercepts: Number(d.probeIntercepts) || 0,
        sdkStubs: Number(d.sdkStubs) || 0,
        overlaysRemoved: 0
      };
      localStats.baitSpoofs += delta.baitSpoofs;
      localStats.probeIntercepts += delta.probeIntercepts;
      localStats.sdkStubs += delta.sdkStubs;
      if (d.sub && typeof d.sub === "object") {
        for (const [k, v] of Object.entries(d.sub)) hook(k, Number(v) || 0);
      }
      if (delta.baitSpoofs || delta.probeIntercepts || delta.sdkStubs) {
        sendStatsDelta(delta);
      }
    },
    true
  );

  function setMainWorldPaused(pausedVal) {
    isPaused = Boolean(pausedVal);
    try {
      document.dispatchEvent(
        new CustomEvent(EVENT_CONTROL, {
          detail: { paused: isPaused },
          bubbles: false,
          cancelable: false
        })
      );
    } catch (_) {}
  }

  // Known walls are hidden only where they are known to exist (host-scoped), or, for the generic
  // third-party ones that can appear anywhere, only when the element behaves like an actual wall
  // (overlay positioning + anti-adblock wording). A bare element with a known id on an arbitrary
  // site is left untouched, so a page cannot use a planted decoy to detect the extension.
  const HOST_SCOPED_WALLS = [
    { sel: "#ab_banner, #adblock_message", host: /(^|\.)redtube\./i },
    { sel: "#adblock_tooltip, #adblock_1", host: /(^|\.)(pornhub|youporn|you-porn|youporngay|redtube|tube8|extremetube)\./i },
    { sel: "#adBlockAlertWrap", host: /(^|\.)tube8\./i },
    { sel: ".dad-vlac-notice", host: /(^|\.)(xnxx|xnxx-cams)\./i },
    { sel: "aside[data-role$='ab-message']", host: /(^|\.)(xhamster\d*|xh[a-z0-9]{2,}|stripchat)\./i },
    { sel: "#ablock-notify", host: /(^|\.)thegay\./i },
    { sel: "#ad_blocker_note", host: /(^|\.)(archangelvideo|analviolation|pornforce|analized)\./i },
    { sel: "#abmessage", host: /(^|\.)(proporn|tubeon|drtuber|iceporn|nuvid)\./i },
    { sel: ".adblock.tac", host: /(^|\.)ashemaletube\./i },
    { sel: "div[id^='js-adblock']", host: /(^|\.)eurogirlsescort\./i }
  ];
  const GENERIC_WALL_SELECTOR = [
    ".fc-ab-root", "#babasbmsgx", "[id^='babasbmsg']", "#detectadblock", "#adblock-modal", "#adblock_modal",
    "#adblock-overlay", "#anti-adblock", "#anti_adblock", ".anti-adblock-modal", ".adblock-modal-overlay", ".admiral-adblock"
  ].join(",");

  // Real walls cover a meaningful part of the viewport; a small planted element does not qualify.
  function coversEnough(el) {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    return r.width * r.height >= 0.2 * vw * vh;
  }

  function looksLikeWall(el) {
    const text = (el.innerText || el.textContent || "").trim();
    if (!ANTI_ADBLOCK_TEXT_RE.test(text) || AGE_GATE_EXCLUSION_RE.test(text)) return false;
    const cs = window.getComputedStyle(el);
    const z = parseInt(cs.zIndex, 10);
    const overlay =
      cs.position === "fixed" || cs.position === "sticky" ||
      (cs.position === "absolute" && !Number.isNaN(z) && z >= 50) ||
      el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true";
    return overlay && coversEnough(el);
  }

  function hideKnownWalls() {
    let any = false;
    const host = location.hostname;
    for (const w of HOST_SCOPED_WALLS) {
      if (!w.host.test(host)) continue;
      for (const el of document.querySelectorAll(w.sel)) {
        if (!neutralizedNodes.has(el) && hideOverlayNode(el)) any = true;
      }
    }
    for (const el of document.querySelectorAll(GENERIC_WALL_SELECTOR)) {
      if (!neutralizedNodes.has(el) && looksLikeWall(el) && hideOverlayNode(el)) any = true;
    }
    return any;
  }

  function hideKnownFast() {
    if (isPaused || !document.body) return;
    if (hideKnownWalls()) {
      hideSiblingBackdrops();
      unlockPageScrollAndBlur();
    }
  }

  const ANTI_ADBLOCK_TEXT_RE =
    /\b(?:disable\s+(?:your\s+)?ad\s*block(?:er|ing)?|turn\s+off\s+(?:your\s+)?ad\s*block(?:er|ing)?|ad\s*block(?:er)?\s+(?:is\s+)?(?:detected|enabled|active)|we\s*(?:'ve|\s+have)?\s+(?:detected|noticed)\s+(?:that\s+you\s+(?:are\s+using|have)\s+)?an?\s+ad\s*block(?:er)?|whitelist\s+(?:us|this\s+(?:site|website))|allow\s+ads\s+(?:on\s+this\s+site|to\s+continue)|please\s+unblock\s+ads|ad-?blocker\s+wall|it\s+looks\s+like\s+you(?:'re|\s+are)\s+using\s+an?\s+ad\s*block)\b/i;

  const AGE_GATE_EXCLUSION_RE =
    /\b(?:18\s+years\s+of\s+age|at\s+least\s+18|older\s+than\s+18|age\s+verification|are\s+you\s+18|i\s+am\s+18\s*\+|parental\s+control|restricted\s+to\s+adults)\b/i;

  const neutralizedNodes = new WeakSet();

  function describeNode(el) {
    const tag = (el.tagName || "div").toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
    return `${tag}${id}${cls}`;
  }

  function protectsMainContent(el) {
    if (!el || el === document.documentElement || el === document.body) return true;
    const tag = el.tagName;
    if (tag === "MAIN" || tag === "ARTICLE" || tag === "VIDEO") return true;
    if (el.querySelector && el.querySelector("video, main, article")) return true;
    const textLen = (el.textContent || "").length;
    if (textLen > 2500) return true;
    if (el.querySelectorAll && el.querySelectorAll("a[href]").length > 20) return true;
    return false;
  }

  function unlockPageScrollAndBlur() {
    let unlocked = false;
    for (const root of [document.documentElement, document.body]) {
      if (!root) continue;
      const cs = window.getComputedStyle(root);
      if (
        cs.overflow === "hidden" ||
        cs.overflowY === "hidden" ||
        cs.position === "fixed" ||
        cs.pointerEvents === "none"
      ) {
        root.style.setProperty("overflow", "auto", "important");
        root.style.setProperty("overflow-y", "auto", "important");
        if (cs.position === "fixed") {
          root.style.setProperty("position", "static", "important");
        }
        root.style.setProperty("pointer-events", "auto", "important");
        root.style.setProperty("user-select", "auto", "important");
        unlocked = true;
      }
      if (root.classList) {
        for (const cls of Array.from(root.classList)) {
          if (/^(?:modal-open|no-scroll|noscroll|ab-lock|fc-ab-lock|sp-message-open)$/i.test(cls)) {
            root.classList.remove(cls);
            unlocked = true;
          }
        }
      }
    }

    // Strip anti-adblock blur/pointer locks on top-level content wrappers
    if (document.body) {
      for (const child of Array.from(document.body.children)) {
        if (neutralizedNodes.has(child)) continue;
        const cs = window.getComputedStyle(child);
        if (cs.filter && cs.filter.includes("blur")) {
          child.style.setProperty("filter", "none", "important");
          unlocked = true;
        }
        if (cs.webkitFilter && cs.webkitFilter.includes("blur")) {
          child.style.setProperty("-webkit-filter", "none", "important");
          unlocked = true;
        }
        if (cs.pointerEvents === "none" && protectsMainContent(child)) {
          child.style.setProperty("pointer-events", "auto", "important");
          unlocked = true;
        }
      }
    }

    if (unlocked) {
      hook("dom.scrollUnlock");
      localStats.scrollUnlocks += 1;
    }
  }

  function hideOverlayNode(el) {
    if (!el || neutralizedNodes.has(el) || protectsMainContent(el)) return false;
    neutralizedNodes.add(el);
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("opacity", "0", "important");
    el.style.setProperty("pointer-events", "none", "important");

    localStats.overlaysRemoved += 1;
    hook("dom.wallHide");
    const desc = describeNode(el);
    if (localStats.neutralizedSelectors.length < 15) {
      localStats.neutralizedSelectors.push(desc);
    }
    sendStatsDelta({
      baitSpoofs: 0,
      probeIntercepts: 0,
      sdkStubs: 0,
      overlaysRemoved: 1
    });
    return true;
  }

  function hideSiblingBackdrops() {
    if (!document.body) return;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    for (const child of Array.from(document.body.children)) {
      if (neutralizedNodes.has(child) || protectsMainContent(child)) continue;
      if (child.tagName === "SCRIPT" || child.tagName === "STYLE" || child.tagName === "LINK") {
        continue;
      }
      const txt = (child.textContent || "").trim();
      if (txt.length > 0) continue;
      const cs = window.getComputedStyle(child);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (cs.position !== "fixed" && cs.position !== "absolute") continue;
      const rect = child.getBoundingClientRect();
      if (rect.width >= vw * 0.8 && rect.height >= vh * 0.8) {
        const z = parseInt(cs.zIndex, 10);
        if (!Number.isNaN(z) && z >= 100) {
          neutralizedNodes.add(child);
          child.style.setProperty("display", "none", "important");
          child.style.setProperty("pointer-events", "none", "important");
        }
      }
    }
  }

  function scanForAntiAdblockOverlays() {
    if (isPaused || !document.body) return;
    let neutralizedAny = false;

    // 1. Check known anti-adblock root selectors
    if (hideKnownWalls()) neutralizedAny = true;

    // 2. Check fixed/sticky/dialog overlays with explicit anti-adblock text
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const candidates = new Set([
      ...Array.from(document.body.children),
      ...Array.from(
        document.querySelectorAll(
          "[role='dialog'], [aria-modal='true'], dialog[open], [class*='modal'], [class*='overlay'], [id*='modal'], [id*='overlay'], [class*='adblock'], [id*='adblock']"
        )
      )
    ]);

    for (const el of candidates) {
      if (!el || el.nodeType !== 1 || neutralizedNodes.has(el)) continue;
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || protectsMainContent(el)) continue;

      const text = (el.innerText || el.textContent || "").trim();
      if (!text || text.length < 15 || text.length > 2200) continue;
      if (AGE_GATE_EXCLUSION_RE.test(text)) continue;
      if (!ANTI_ADBLOCK_TEXT_RE.test(text)) continue;

      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;

      // Walk up if this is an inner dialog box inside a full-screen modal wrapper
      let target = el;
      if (
        el.parentElement &&
        el.parentElement !== document.body &&
        !protectsMainContent(el.parentElement)
      ) {
        const pcs = window.getComputedStyle(el.parentElement);
        if (pcs.position === "fixed" || pcs.position === "sticky") {
          const pText = (el.parentElement.innerText || "").trim();
          if (!AGE_GATE_EXCLUSION_RE.test(pText) && pText.length <= 2400) {
            target = el.parentElement;
          }
        }
      }

      const tcs = window.getComputedStyle(target);
      const z = parseInt(tcs.zIndex, 10);
      const rect = target.getBoundingClientRect();
      const isOverlayGeometry =
        tcs.position === "fixed" ||
        tcs.position === "sticky" ||
        (tcs.position === "absolute" && (!Number.isNaN(z) && z >= 50)) ||
        target.getAttribute("role") === "dialog" ||
        target.getAttribute("aria-modal") === "true" ||
        (rect.width >= vw * 0.35 && rect.height >= vh * 0.2 && !Number.isNaN(z) && z >= 20);

      if (isOverlayGeometry && coversEnough(target) && hideOverlayNode(target)) {
        neutralizedAny = true;
      }
    }

    if (neutralizedAny) {
      hideSiblingBackdrops();
      unlockPageScrollAndBlur();
    }

    suppressInPlayerVideoAds();
  }

  const EXPLICIT_AD_VIDEO_URL_RE =
    /(?:ht-cdn\.trafficjunky\.net\/|\/pre_videos\/|psid=ed_tj|\/movie\/preroll\/|\/preroll\/.*\.(?:mp4|webm))/i;

  // Aylo first-party house ads: ordinary MSE <video>s injected into a wrapper whose class is
  // <8-14 random letters><Date.now() in ms>, outside the real player. Match on that structure.
  const EPOCH_CLASS_RE = /^[a-z]{6,16}(\d{13})$/;
  const MAIN_PLAYER_SEL =
    ".mgp_videoWrapper, .playerFlvContainer, #player, [id^='playerDiv'], .mainPlayerDiv, #xplayer, .xplayer, .vjs-tech, #EPvideo";

  function findEpochAdContainer(v) {
    if (v.closest && v.closest(MAIN_PLAYER_SEL)) return null;
    if (Number.isFinite(v.duration) && v.duration > 90) return null;
    let e = v.parentElement;
    for (let i = 0; i < 4 && e && e !== document.body; i++, e = e.parentElement) {
      for (const c of e.classList || []) {
        const m = EPOCH_CLASS_RE.exec(c);
        if (m && Math.abs(Date.now() - Number(m[1])) < 6 * 3600 * 1000) return e;
      }
    }
    return null;
  }

  function killEpochAdVideos() {
    for (const v of document.querySelectorAll("video")) {
      const box = findEpochAdContainer(v);
      if (!box) continue;
      if (neutralizedNodes.has(v)) {
        // site may try to resume it; keep it stopped
        if (!v.paused) {
          try { v.pause(); } catch (_) {}
        }
        continue;
      }
      neutralizedNodes.add(v);
      try {
        v.muted = true;
        v.autoplay = false;
        v.pause();
        v.dispatchEvent(new Event("ended"));
        v.removeAttribute("src");
        v.load();
      } catch (_) {}
      for (let n = box, k = 0; n && n !== document.body && k < 3; n = n.parentElement, k++) {
        if (n.querySelector && n.querySelector(MAIN_PLAYER_SEL)) break;
        n.style.setProperty("display", "none", "important");
      }
      localStats.overlaysRemoved += 1;
      hook("video.epochHouseAd");
      sendStatsDelta({ baitSpoofs: 0, probeIntercepts: 0, sdkStubs: 0, overlaysRemoved: 1 });
    }
  }

  // Same randomized-container signature without a <video>: right-rail / banner house-ad slots.
  function epochClassOf(el) {
    for (const cl of el.classList || []) {
      const m = EPOCH_CLASS_RE.exec(cl);
      if (m && Math.abs(Date.now() - Number(m[1])) < 6 * 3600 * 1000) return true;
    }
    return false;
  }

  function hideEpochSlot(el) {
    if (neutralizedNodes.has(el) || !epochClassOf(el)) return false;
    if (el.closest && el.closest(MAIN_PLAYER_SEL)) return false;
    if (el.querySelector && el.querySelector(MAIN_PLAYER_SEL + ", main, article, form, input, textarea")) return false;
    if ((el.textContent || "").length > 1500) return false;
    neutralizedNodes.add(el);
    for (const v of el.querySelectorAll ? el.querySelectorAll("video") : []) {
      try { v.pause(); v.removeAttribute("src"); v.load(); } catch (_) {}
    }
    el.style.setProperty("display", "none", "important");
    localStats.overlaysRemoved += 1;
    hook("dom.epochSlot");
    sendStatsDelta({ baitSpoofs: 0, probeIntercepts: 0, sdkStubs: 0, overlaysRemoved: 1 });
    return true;
  }

  function sweepEpochSlots(root, cap = 300) {
    if (isPaused || !root || root.nodeType !== 1) return;
    hideEpochSlot(root);
    if (!root.querySelectorAll) return;
    let n = 0;
    for (const el of root.querySelectorAll("div[class], section[class], aside[class], a[class]")) {
      if (++n > cap) break;
      hideEpochSlot(el);
    }
  }

  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "attributes") hideEpochSlot(m.target); // class applied after insertion
      else for (const n of m.addedNodes) sweepEpochSlots(n);
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
  });

  // Second pass for lazy / visibility-triggered units: whole-document sweeps after load and shortly
  // after the user scrolls. Fixed delays (no randomization below these values), so a unit that
  // initializes late is never skipped.
  const fullSweep = () => {
    sweepEpochSlots(document.body, 5000);
    killEpochAdVideos();
  };
  window.addEventListener("load", () => {
    for (const ms of [1200, 3500, 7000]) setTimeout(fullSweep, ms);
  });
  let scrollQueued = false;
  window.addEventListener("scroll", () => {
    if (scrollQueued) return;
    scrollQueued = true;
    setTimeout(() => {
      scrollQueued = false;
      fullSweep();
    }, 800);
  }, { passive: true });

  // event-driven instead of polling: media events are captured at document level
  for (const evName of ["play", "loadedmetadata"]) {
    document.addEventListener(evName, () => {
      if (!isPaused && document.body) killEpochAdVideos();
    }, true);
  }

  function suppressInPlayerVideoAds() {
    if (isPaused || !document.body) return;
    killEpochAdVideos();

    // 1. Hide dedicated video-ad overlay wrappers (never touching primary player containers)
    for (const adWrap of document.querySelectorAll(
      ".ima-ad-container, .exo-video-ad, .adsbytrafficjunky, .preroll-blocker, #preroll_ads"
    )) {
      if (!neutralizedNodes.has(adWrap) && !protectsMainContent(adWrap)) {
        neutralizedNodes.add(adWrap);
        adWrap.style.setProperty("display", "none", "important");
        adWrap.style.setProperty("pointer-events", "none", "important");
      }
    }

    // 2. Click explicit player "Skip Ad" buttons when enabled
    for (const skipBtn of document.querySelectorAll(
      ".vjs-skip-ad, .jw-skip, .mgp_skipAd, .fp-vast-skip, [class*='skipAd'], [id*='skip_ad']"
    )) {
      const txt = (skipBtn.innerText || skipBtn.textContent || "").trim();
      if (!txt || /skip/i.test(txt)) {
        try {
          skipBtn.click();
        } catch (_) {}
      }
    }

    // 3. Fast-forward <video> ONLY when src is an explicit ad-CDN asset or inside an active ad container
    for (const v of document.querySelectorAll("video")) {
      const src = v.currentSrc || v.src || "";
      const inAdMode = Boolean(
        v.closest && v.closest(".ima-ad-container, .vjs-ad-playing, .jw-flag-ads")
      );
      if ((src && EXPLICIT_AD_VIDEO_URL_RE.test(src)) || inAdMode) {
        try {
          v.muted = true;
          if (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.1) {
            v.currentTime = v.duration;
          } else {
            v.playbackRate = 16.0;
          }
          v.dispatchEvent(new Event("ended"));
        } catch (_) {}
      }
    }
  }

  // Initialize state from storage
  async function init() {
    let scanTimer = null;
    const scheduleScan = () => {
      if (isPaused || scanTimer) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        scanForAntiAdblockOverlays();
      }, 80);
    };

    const observer = new MutationObserver(() => {
      hideKnownFast();
      scheduleScan();
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "open", "hidden"]
      });
    }

    window.addEventListener("DOMContentLoaded", () => {
      if (!isPaused) {
        scanForAntiAdblockOverlays();
      }
    });

    window.addEventListener("load", () => {
      if (!isPaused) {
        scanForAntiAdblockOverlays();
        setTimeout(scanForAntiAdblockOverlays, 600);
        setTimeout(scanForAntiAdblockOverlays, 1800);
      }
    });

    // Optimistically inject base CSS at document_start; remove if site turns out paused

    try {
      const data = await api.storage.local.get(["globalEnabled", "pausedHosts"]);
      const globalEnabled = data.globalEnabled !== false;
      const pausedHosts = Array.isArray(data.pausedHosts) ? data.pausedHosts : [];
      const host = location.hostname;
      const shouldPause = !globalEnabled || (host && pausedHosts.includes(host));
      setMainWorldPaused(shouldPause);
    } catch (_) {
      setMainWorldPaused(false);
    }

    if (!isPaused && document.readyState !== "loading") {
      scanForAntiAdblockOverlays();
    }
  }

  api.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    api.storage.local.get(["globalEnabled", "pausedHosts"]).then((data) => {
      const globalEnabled = data.globalEnabled !== false;
      const pausedHosts = Array.isArray(data.pausedHosts) ? data.pausedHosts : [];
      setMainWorldPaused(!globalEnabled || pausedHosts.includes(location.hostname));
    }).catch(() => {});
  });

  api.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "AUB_GET_FRAME_STATS") {
      scanForAntiAdblockOverlays();
      sendResponse({
        paused: isPaused,
        host: location.hostname,
        stats: { ...localStats }
      });
      return false;
    }
    return false;
  });

  init();
})();
