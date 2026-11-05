(() => {
  "use strict";

  // Natives we call at runtime are captured at document_start, before any page script can hook them.
  const _setTimeout = setTimeout, _CustomEvent = CustomEvent, _Event = Event, _ProgressEvent = ProgressEvent;
  const _dispatch = EventTarget.prototype.dispatchEvent, _URL = URL, _Response = Response, _DOMParser = DOMParser;

  const EVENT_TELEMETRY = "__aub_telemetry_9e4b1c";
  const EVENT_CONTROL = "__aub_control_9e4b1c";

  let paused = false;

  const origToString = Function.prototype.toString;
  const nativeStrings = new WeakMap();

  // Wrap a native with a Proxy over the original: name, length, missing prototype, non-constructibility
  // and descriptor shape stay identical to the real native; toString is answered by the patched toString.
  function markNative(wrapped, original, fallbackName) {
    if (typeof original !== "function") {
      nativeStrings.set(wrapped, `function ${fallbackName || ""}() { [native code] }`);
      return wrapped;
    }
    const proxy = new Proxy(original, {
      apply(_target, thisArg, args) {
        return Reflect.apply(wrapped, thisArg, args);
      }
    });
    try {
      nativeStrings.set(proxy, Reflect.apply(origToString, original, []));
    } catch (_) {
      nativeStrings.set(proxy, `function ${fallbackName || ""}() { [native code] }`);
    }
    return proxy;
  }

  const patchedToString = function toString() {
    if (nativeStrings.has(this)) {
      return nativeStrings.get(this);
    }
    return Reflect.apply(origToString, this, arguments);
  };
  const toStringProxy = markNative(patchedToString, origToString, "toString");
  try {
    Object.defineProperty(Function.prototype, "toString", {
      value: toStringProxy,
      writable: true,
      configurable: true
    });
  } catch (_) {}

  let lastReportTs = 0;
  const pendingCounts = {
    baitSpoofs: 0,
    probeIntercepts: 0,
    sdkStubs: 0
  };
  let flushScheduled = false;

  const pendingSub = {};
  function recordHit(kind, sub) {
    if (paused) return;
    pendingCounts[kind] = (pendingCounts[kind] || 0) + 1;
    if (sub) pendingSub[sub] = (pendingSub[sub] || 0) + 1;
    if (kind === "baitSpoofs") engageGeneric("detect");
    const now = Date.now();
    if (!flushScheduled && now - lastReportTs > 150) {
      flushScheduled = true;
      _setTimeout(() => {
        flushScheduled = false;
        lastReportTs = Date.now();
        const snapshot = { ...pendingCounts, sub: { ...pendingSub } };
        for (const k of Object.keys(pendingSub)) delete pendingSub[k];
        pendingCounts.baitSpoofs = 0;
        pendingCounts.probeIntercepts = 0;
        pendingCounts.sdkStubs = 0;
        try {
          Reflect.apply(_dispatch, document, [
            new _CustomEvent(EVENT_TELEMETRY, { detail: snapshot, bubbles: false, cancelable: false })
          ]);
        } catch (_) {}
      }, 1000);
    }
  }

  document.addEventListener(
    EVENT_CONTROL,
    (e) => {
      if (e && e.detail && typeof e.detail.paused === "boolean") {
        paused = e.detail.paused;
      }
    },
    true
  );

  // --- Layer 1: Bait Element Identification & Geometry / Style Spoofing ---

  const IGNORED_TAGS = new Set([
    "HTML",
    "BODY",
    "HEAD",
    "MAIN",
    "HEADER",
    "FOOTER",
    "NAV",
    "ARTICLE",
    "VIDEO",
    "AUDIO",
    "CANVAS",
    "SCRIPT",
    "STYLE",
    "LINK",
    "META",
    "FORM"
  ]);

  const BAIT_TOKEN_RE =
    /(?:^|[\s_-])(?:adsbox|ad-banner|ad_banner|adbanner|pub_300x250|pub_300x250m|pub_728x90|text-ad|textad|text_ad|text_ads|text-ads|text-ad-links|ad-text|ad-placement|ad-placeholder|adbadge|bannerad|banner-ad|banner_ad|afs_ads|adsbygoogle|adblock-test|adblock_test|ad-tester|adtester|ad-check|adcheck|ad-detect|adb-bait|ad-bait|bait-ad|sponsor-ad|sponsored-ad|doubleclick|dfp-ad|gpt-ad|exo-native-widget|exoclick-ad|tj-banner|trafficjunky|juicyads)(?:$|[\s_-])/i;

  const BAIT_ID_RE =
    /^(?:adsbox|ad-banner|ad_banner|adbanner|ad-tester|adtester|adblock-test|adblock_test|adb-bait|ad-bait|bait|carbonads|ad_position_box|exo_slider|tj_ad)$/i;

  function getClassString(el) {
    const cn = el.className;
    if (typeof cn === "string") return cn;
    if (el.getAttribute) return el.getAttribute("class") || "";
    return "";
  }

  function isBaitElement(el) {
    if (paused || !el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (!tag || IGNORED_TAGS.has(tag)) return false;

    const cls = getClassString(el);
    const id = el.id || "";

    let matched = false;
    if (cls && BAIT_TOKEN_RE.test(cls)) matched = true;
    else if (id && (BAIT_ID_RE.test(id) || BAIT_TOKEN_RE.test(id))) matched = true;
    else if (tag === "INS" && cls.includes("adsbygoogle")) matched = true;

    if (!matched) return false;

    // Bait probes are empty or tiny leaf containers, never rich content trees
    if (el.childElementCount > 3) return false;
    if (
      el.childElementCount > 0 &&
      el.querySelector &&
      el.querySelector("video, main, article, form, nav, iframe[src*='player']")
    ) {
      return false;
    }
    const txt = el.textContent || "";
    if (txt.length > 120) return false;

    return true;
  }

  function findDescriptor(proto, prop) {
    let cur = proto;
    while (cur) {
      const desc = Object.getOwnPropertyDescriptor(cur, prop);
      if (desc) return { owner: cur, desc };
      cur = Object.getPrototypeOf(cur);
    }
    return null;
  }

  function patchNumericGetter(startProto, prop, fakeValue) {
    const found = findDescriptor(startProto, prop);
    if (!found || typeof found.desc.get !== "function") return;
    const origGet = found.desc.get;
    const wrappedGet = markNative(function () {
      const real = Reflect.apply(origGet, this, []);
      if (real === 0 && isBaitElement(this)) {
        recordHit("baitSpoofs", "geom.offsetSize");
        return fakeValue;
      }
      return real;
    }, origGet, `get ${prop}`);
    try {
      Object.defineProperty(found.owner, prop, {
        ...found.desc,
        get: wrappedGet
      });
    } catch (_) {}
  }

  patchNumericGetter(HTMLElement.prototype, "offsetHeight", 250);
  patchNumericGetter(HTMLElement.prototype, "offsetWidth", 300);
  patchNumericGetter(Element.prototype, "clientHeight", 250);
  patchNumericGetter(Element.prototype, "clientWidth", 300);

  const offsetParentInfo = findDescriptor(HTMLElement.prototype, "offsetParent");
  if (offsetParentInfo && typeof offsetParentInfo.desc.get === "function") {
    const origOffsetParent = offsetParentInfo.desc.get;
    const wrappedOffsetParent = markNative(function () {
      const real = Reflect.apply(origOffsetParent, this, []);
      if (real === null && isBaitElement(this)) {
        recordHit("baitSpoofs", "geom.offsetParent");
        return document.body || document.documentElement;
      }
      return real;
    }, origOffsetParent, "get offsetParent");
    try {
      Object.defineProperty(offsetParentInfo.owner, "offsetParent", {
        ...offsetParentInfo.desc,
        get: wrappedOffsetParent
      });
    } catch (_) {}
  }

  const origGetBCR = Element.prototype.getBoundingClientRect;
  if (typeof origGetBCR === "function") {
    const wrappedGetBCR = markNative(function getBoundingClientRect() {
      const rect = Reflect.apply(origGetBCR, this, arguments);
      if (rect && rect.height === 0 && rect.width === 0 && isBaitElement(this)) {
        recordHit("baitSpoofs", "geom.getBCR");
        if (typeof DOMRect === "function") {
          return new DOMRect(0, 0, 300, 250);
        }
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          width: 300,
          height: 250,
          right: 300,
          bottom: 250,
          toJSON() {
            return this;
          }
        };
      }
      return rect;
    }, origGetBCR, "getBoundingClientRect");
    try {
      Element.prototype.getBoundingClientRect = wrappedGetBCR;
    } catch (_) {}
  }

  const origGetClientRects = Element.prototype.getClientRects;
  if (typeof origGetClientRects === "function") {
    const wrappedGetClientRects = markNative(function getClientRects() {
      const rects = Reflect.apply(origGetClientRects, this, arguments);
      if (rects && rects.length === 0 && isBaitElement(this)) {
        recordHit("baitSpoofs", "geom.getClientRects");
        const fakeRect =
          typeof DOMRect === "function"
            ? new DOMRect(0, 0, 300, 250)
            : { x: 0, y: 0, top: 0, left: 0, width: 300, height: 250, right: 300, bottom: 250 };
        const list = [fakeRect];
        list.item = (i) => list[i] || null;
        return list;
      }
      return rects;
    }, origGetClientRects, "getClientRects");
    try {
      Element.prototype.getClientRects = wrappedGetClientRects;
    } catch (_) {}
  }

  const origGetComputedStyle = window.getComputedStyle;
  if (typeof origGetComputedStyle === "function") {
    const SPOOF_STYLE_MAP = {
      display: (v) => (v === "none" ? "block" : v),
      visibility: (v) => (v === "hidden" || v === "collapse" ? "visible" : v),
      opacity: (v) => (v === "0" ? "1" : v),
      height: (v) => (v === "0px" || v === "auto" ? "250px" : v),
      width: (v) => (v === "0px" || v === "auto" ? "300px" : v)
    };

    const wrappedGCS = markNative(function getComputedStyle(el, pseudo) {
      const style = Reflect.apply(origGetComputedStyle, window, arguments);
      if (paused || pseudo || !style || !isBaitElement(el)) {
        return style;
      }
      const realDisplay = Reflect.apply(style.getPropertyValue, style, ["display"]);
      const realVis = Reflect.apply(style.getPropertyValue, style, ["visibility"]);
      const realOpacity = Reflect.apply(style.getPropertyValue, style, ["opacity"]);
      const realHeight = Reflect.apply(style.getPropertyValue, style, ["height"]);

      if (
        realDisplay !== "none" &&
        realVis !== "hidden" &&
        realOpacity !== "0" &&
        realHeight !== "0px"
      ) {
        return style;
      }

      recordHit("baitSpoofs", "style.getComputedStyle");

      const proxiedGetProp = markNative(
        function getPropertyValue(propName) {
          const raw = Reflect.apply(style.getPropertyValue, style, [propName]);
          const key = String(propName || "").toLowerCase();
          return SPOOF_STYLE_MAP[key] ? SPOOF_STYLE_MAP[key](raw) : raw;
        },
        style.getPropertyValue,
        "getPropertyValue"
      );

      return new Proxy(style, {
        get(target, prop) {
          if (prop === "getPropertyValue") return proxiedGetProp;
          const val = Reflect.get(target, prop, target);
          if (typeof prop === "string" && SPOOF_STYLE_MAP[prop]) {
            return SPOOF_STYLE_MAP[prop](val);
          }
          if (typeof val === "function") {
            return val.bind(target);
          }
          return val;
        }
      });
    }, origGetComputedStyle, "getComputedStyle");

    try {
      window.getComputedStyle = wrappedGCS;
    } catch (_) {}
  }

  const origGetAttribute = Element.prototype.getAttribute;
  if (typeof origGetAttribute === "function") {
    Element.prototype.getAttribute = markNative(function getAttribute(name) {
      if (!paused && typeof name === "string" && name.toLowerCase() === "abp") {
        const real = Reflect.apply(origGetAttribute, this, arguments);
        if (real !== null) {
          recordHit("baitSpoofs", "attr.abp");
          return null;
        }
        return null;
      }
      return Reflect.apply(origGetAttribute, this, arguments);
    }, origGetAttribute, "getAttribute");
  }

  // --- Layer 2: Ad-Probe Network & Resource Error Defusing ---

  // Hosts and URL shapes come from catalogue.json (generated into this file by build.mjs).
  const AUB_TABLES = /*@CATALOGUE_MAIN@*/ null;
  const AD_PROBE_HOST_RE = new RegExp(AUB_TABLES.defuseHostRe, "i");
  const AD_PROBE_PATH_RE = new RegExp(AUB_TABLES.probePathRe, "i");

  function isAdProbeUrl(rawUrl) {
    if (paused || !rawUrl || typeof rawUrl !== "string") return false;
    if (
      rawUrl.startsWith("data:") ||
      rawUrl.startsWith("blob:") ||
      rawUrl.startsWith("moz-extension:") ||
      rawUrl.startsWith("chrome-extension:")
    ) {
      return false;
    }
    try {
      const u = new _URL(rawUrl, window.location.href);
      if (AD_PROBE_HOST_RE.test(u.hostname)) return true;
      if (AD_PROBE_PATH_RE.test(u.pathname + u.search)) return true;
    } catch (_) {
      if (AD_PROBE_PATH_RE.test(rawUrl)) return true;
    }
    return false;
  }

  const ADULT_NET_RE = new RegExp(AUB_TABLES.adultNetworkRe, "i");
  function fulfillAdProbeSideEffects(rawUrl) {
    if (!rawUrl) return;
    if (ADULT_NET_RE.test(rawUrl)) engageGeneric("adnet");
    if (/adsbygoogle/i.test(rawUrl)) {
      if (!window.adsbygoogle || typeof window.adsbygoogle !== "object") {
        window.adsbygoogle = [];
      }
      window.adsbygoogle.loaded = true;
      if (typeof window.adsbygoogle.push !== "function") {
        window.adsbygoogle.push = function () {
          return 1;
        };
      }
      window.google_ad_status = 1;
    }
    if (/(?:fuck|block|sniff)adblock|adblock-?detector/i.test(rawUrl)) {
      installDetectorStubs();
      engageGeneric("detect");
    }
    if (/fundingchoices|googlefc/i.test(rawUrl) && !window.googlefc) {
      window.googlefc = { callbackQueue: [], controlledMessagingFunction: () => {}, showRevocationMessage: () => {} };
    }
    if (/ad-provider|exoclick|magsrv|pemsrv|exdynsrv|realsrv/i.test(rawUrl)) {
      window.exoNoExternalUI38djdkjDDJsio96 = true;
      if (!window.AdProvider) window.AdProvider = { push() {} };
    }
    if (/juicyads|adsbyjuicy|jads\.co/i.test(rawUrl) && !window.adsbyjuicy) {
      window.adsbyjuicy = { push() {} };
    }
    window.canRunAds = true;
    window.canShowAds = true;
    window.isAdBlockActive = false;
  }

  const GIF_1X1 = new Uint8Array([
    71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33,
    249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59
  ]);

  const EMPTY_VAST_XML = '<?xml version="1.0" encoding="UTF-8"?><VAST version="3.0"></VAST>';
  const EMPTY_VMAP_XML =
    '<?xml version="1.0" encoding="UTF-8"?><vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0"></vmap:VMAP>';

  const VMAP_URL_RE = new RegExp(AUB_TABLES.manifests.vmap, "i");
  const VAST_URL_RE = new RegExp(AUB_TABLES.manifests.vast, "i");
  const JSON_VIDEO_AD_URL_RE = new RegExp(AUB_TABLES.manifests.jsonAd, "i");

  function classifyVideoAdManifestUrl(rawUrl) {
    if (paused || !rawUrl || typeof rawUrl !== "string") return null;
    if (
      rawUrl.startsWith("data:") ||
      rawUrl.startsWith("blob:") ||
      rawUrl.startsWith("moz-extension:") ||
      rawUrl.startsWith("chrome-extension:")
    ) {
      return null;
    }
    if (VMAP_URL_RE.test(rawUrl)) return "vmap";
    if (VAST_URL_RE.test(rawUrl)) return "vast";
    if (JSON_VIDEO_AD_URL_RE.test(rawUrl)) return "json_ad";
    return null;
  }

  function makeVideoAdStubPayload(kind) {
    if (kind === "vmap") {
      return { body: EMPTY_VMAP_XML, contentType: "application/xml; charset=utf-8", isXml: true };
    }
    if (kind === "vast") {
      return { body: EMPTY_VAST_XML, contentType: "application/xml; charset=utf-8", isXml: true };
    }
    return { body: "{}", contentType: "application/json; charset=utf-8", isXml: false, isJson: true };
  }

  function makeSyntheticResponse(rawUrl) {
    fulfillAdProbeSideEffects(rawUrl);
    const vKind = classifyVideoAdManifestUrl(rawUrl);
    if (vKind) {
      const p = makeVideoAdStubPayload(vKind);
      return new _Response(p.body, {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": p.contentType }
      });
    }
    const isImg = /\.(?:gif|png|jpe?g|webp)(?:[?#]|$)/i.test(rawUrl);
    if (isImg) {
      return new _Response(GIF_1X1, {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "image/gif" }
      });
    }
    return new _Response("window.canRunAds=true;window.isAdBlockActive=false;", {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/javascript; charset=utf-8" }
    });
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    const wrappedFetch = markNative(function fetch(input, init) {
      const urlStr =
        typeof input === "string"
          ? input
          : input && typeof input.url === "string"
          ? input.url
          : String(input || "");
      const proactiveVideoKind = classifyVideoAdManifestUrl(urlStr);
      if (proactiveVideoKind) {
        recordHit("probeIntercepts", "net.fetchManifestStub");
        const p = makeVideoAdStubPayload(proactiveVideoKind);
        return Promise.resolve(
          new _Response(p.body, {
            status: 200,
            statusText: "OK",
            headers: { "Content-Type": p.contentType }
          })
        );
      }
      if (!isAdProbeUrl(urlStr)) {
        return Reflect.apply(origFetch, this, arguments);
      }
      return Reflect.apply(origFetch, this, arguments).then(
        (res) => res,
        () => {
          recordHit("probeIntercepts", "net.fetchFailFallback");
          return makeSyntheticResponse(urlStr);
        }
      );
    }, origFetch, "fetch");
    try {
      window.fetch = wrappedFetch;
    } catch (_) {}
  }

  const origAddEL = EventTarget.prototype.addEventListener;

  // XMLHttpRequest probe & VAST/preroll manifest interception
  const xhrMeta = new WeakMap();
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  const origXhrGetRespHeader = XMLHttpRequest.prototype.getResponseHeader;
  const xhrSpoof = new WeakMap();
  for (const prop of ["readyState", "status", "statusText", "response", "responseText", "responseXML"]) {
    const found = findDescriptor(XMLHttpRequest.prototype, prop);
    if (!found || typeof found.desc.get !== "function") continue;
    const origGet = found.desc.get;
    try {
      Object.defineProperty(found.owner, prop, {
        ...found.desc,
        get: markNative(function () {
          const st = xhrSpoof.get(this);
          return st ? st[prop] : Reflect.apply(origGet, this, []);
        }, origGet, "get " + prop)
      });
    } catch (_) {}
  }

  if (typeof origXhrGetRespHeader === "function") {
    XMLHttpRequest.prototype.getResponseHeader = markNative(function getResponseHeader(name) {
      const meta = xhrMeta.get(this);
      if (meta && meta.spoofed && meta.contentType && String(name || "").toLowerCase() === "content-type") {
        return meta.contentType;
      }
      return Reflect.apply(origXhrGetRespHeader, this, arguments);
    }, origXhrGetRespHeader, "getResponseHeader");
  }

  function spoofXhrSuccess(xhr, meta) {
    if (!meta || meta.spoofed || paused) return false;
    meta.spoofed = true;
    recordHit("probeIntercepts", "net.xhrSpoof");
    fulfillAdProbeSideEffects(meta.url);

    let body = "window.canRunAds=true;window.isAdBlockActive=false;";
    let contentType = "application/javascript; charset=utf-8";
    let xmlDoc = null;
    let parsedJson = null;

    if (meta.proactiveKind) {
      const p = makeVideoAdStubPayload(meta.proactiveKind);
      body = p.body;
      contentType = p.contentType;
      if (p.isXml && typeof DOMParser === "function") {
        try {
          xmlDoc = new _DOMParser().parseFromString(body, "text/xml");
        } catch (_) {}
      }
      if (p.isJson) {
        parsedJson = {};
      }
    }
    meta.contentType = contentType;

    const respType = xhr.responseType || "";
    const respVal =
      respType === "json"
        ? parsedJson || {}
        : respType === "document" && xmlDoc
        ? xmlDoc
        : body;

    const st = {
      readyState: 1,
      status: 200,
      statusText: "OK",
      response: respVal,
      responseText: body,
      responseXML: xmlDoc
    };
    xhrSpoof.set(xhr, st);
    const fire = (type, progress) => {
      try {
        Reflect.apply(_dispatch, xhr, [
          progress ? new _ProgressEvent(type, { loaded: body.length, total: body.length }) : new _Event(type)
        ]);
      } catch (_) {}
    };
    // A real completed request walks 2 (headers) -> 3 (loading) -> 4 (done), then load / loadend.
    _setTimeout(() => {
      st.readyState = 2;
      fire("readystatechange");
      _setTimeout(() => {
        st.readyState = 3;
        fire("readystatechange");
        fire("progress", true);
        _setTimeout(() => {
          st.readyState = 4;
          fire("readystatechange");
          fire("load", true);
          fire("loadend", true);
        }, 0);
      }, 0);
    }, 0);
    return true;
  }

  if (typeof XMLHttpRequestEventTarget !== "undefined") {
    const xhrOnErr = findDescriptor(XMLHttpRequestEventTarget.prototype, "onerror");
    if (xhrOnErr && typeof xhrOnErr.desc.set === "function") {
      const origSet = xhrOnErr.desc.set;
      const origGet = xhrOnErr.desc.get;
      const fnMap = new WeakMap();
      try {
        Object.defineProperty(xhrOnErr.owner, "onerror", {
          configurable: true,
          enumerable: xhrOnErr.desc.enumerable,
          get: markNative(function () {
            return fnMap.has(this) ? fnMap.get(this) : Reflect.apply(origGet, this, []);
          }, origGet, "get onerror"),
          set: markNative(function (fn) {
            fnMap.set(this, fn);
            if (typeof fn !== "function") {
              return Reflect.apply(origSet, this, [fn]);
            }
            const self = this;
            return Reflect.apply(origSet, this, [
              function (ev) {
                const meta = xhrMeta.get(self);
                if (meta && !paused) {
                  if (ev) {
                    ev.stopImmediatePropagation();
                    ev.preventDefault();
                  }
                  spoofXhrSuccess(self, meta);
                  return;
                }
                return Reflect.apply(fn, this, arguments);
              }
            ]);
          }, origSet, "set onerror")
        });
      } catch (_) {}
    }
  }

  if (typeof origXhrOpen === "function" && typeof origXhrSend === "function") {
    XMLHttpRequest.prototype.open = markNative(function open(method, url) {
      const urlStr = typeof url === "string" ? url : String(url || "");
      const proactiveKind = classifyVideoAdManifestUrl(urlStr);
      if (proactiveKind) {
        xhrMeta.set(this, { url: urlStr, spoofed: false, proactiveKind });
      } else if (isAdProbeUrl(urlStr)) {
        xhrMeta.set(this, { url: urlStr, spoofed: false, proactiveKind: null });
      } else {
        xhrMeta.delete(this);
      }
      return Reflect.apply(origXhrOpen, this, arguments);
    }, origXhrOpen, "open");

    XMLHttpRequest.prototype.send = markNative(function send() {
      const meta = xhrMeta.get(this);
      if (meta && !paused) {
        if (meta.proactiveKind) {
          spoofXhrSuccess(this, meta);
          return;
        }
        const xhr = this;
        origAddEL.call(
          xhr,
          "error",
          (ev) => {
            if (paused) return;
            ev.stopImmediatePropagation();
            ev.preventDefault();
            spoofXhrSuccess(xhr, meta);
          },
          true
        );
      }
      return Reflect.apply(origXhrSend, this, arguments);
    }, origXhrSend, "send");
  }

  // Dynamic & inline <script> / <img> resource error -> load defuser
  const handledProbeEls = new WeakSet();

  function getProbeElementUrl(el) {
    if (!el || el.nodeType !== 1) return "";
    const tag = el.tagName;
    if (tag !== "SCRIPT" && tag !== "IMG" && tag !== "IFRAME") return "";
    return el.src || (el.getAttribute && el.getAttribute("src")) || "";
  }

  function handleProbeElementError(el, ev) {
    const src = getProbeElementUrl(el);
    if (!src || !isAdProbeUrl(src)) return false;
    if (ev) {
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
    if (!handledProbeEls.has(el)) {
      handledProbeEls.add(el);
      recordHit("probeIntercepts", "net.elementErrorDefuse");
      fulfillAdProbeSideEffects(src);
      _setTimeout(() => {
        try {
          if (el.tagName === "IMG") {
            try {
              Object.defineProperty(el, "complete", { value: true, configurable: true });
              Object.defineProperty(el, "naturalWidth", { value: 1, configurable: true });
              Object.defineProperty(el, "naturalHeight", { value: 1, configurable: true });
            } catch (_) {}
          }
          Reflect.apply(_dispatch, el, [new _Event("load")]);
        } catch (_) {}
      }, 0);
    }
    return true;
  }

  // Capture-phase window listener intercepts all attached <script>/<img>/<iframe> load errors
  window.addEventListener(
    "error",
    (ev) => {
      if (paused || !ev || !ev.target || ev.target === window) return;
      handleProbeElementError(ev.target, ev);
    },
    true
  );

  // Also wrap detached element onerror + addEventListener('error', ...) for detached new Image() probes
  function wrapElementOnError(proto) {
    const found = findDescriptor(proto, "onerror");
    if (!found || typeof found.desc.set !== "function") return;
    const origSet = found.desc.set;
    const origGet = found.desc.get;
    const handlerMap = new WeakMap();
    try {
      Object.defineProperty(found.owner, "onerror", {
        configurable: true,
        enumerable: found.desc.enumerable,
        get: markNative(function () {
          return handlerMap.has(this)
            ? handlerMap.get(this)
            : Reflect.apply(origGet, this, []);
        }, origGet, "get onerror"),
        set: markNative(function (fn) {
          handlerMap.set(this, fn);
          if (typeof fn !== "function") {
            return Reflect.apply(origSet, this, [fn]);
          }
          const el = this;
          const wrapped = function (ev) {
            if (handleProbeElementError(el, ev)) return;
            return Reflect.apply(fn, this, arguments);
          };
          return Reflect.apply(origSet, this, [wrapped]);
        }, origSet, "set onerror")
      });
    } catch (_) {}
  }

  wrapElementOnError(HTMLElement.prototype);
  if (typeof GlobalEventHandlers !== "undefined") {
    wrapElementOnError(GlobalEventHandlers.prototype);
  }

  if (typeof origAddEL === "function") {
    const listenerWrappers = new WeakMap();
    EventTarget.prototype.addEventListener = markNative(function addEventListener(
      type,
      listener,
      options
    ) {
      if (type === "error" && listener && this instanceof XMLHttpRequest) {
        const xhr = this;
        let mapForXhr = listenerWrappers.get(xhr);
        if (!mapForXhr) {
          mapForXhr = new WeakMap();
          listenerWrappers.set(xhr, mapForXhr);
        }
        let wrapped = mapForXhr.get(listener);
        if (!wrapped) {
          wrapped = function (ev) {
            const meta = xhrMeta.get(xhr);
            if (meta && !paused) {
              if (ev) {
                ev.stopImmediatePropagation();
                ev.preventDefault();
              }
              spoofXhrSuccess(xhr, meta);
              return;
            }
            if (typeof listener === "function") {
              return Reflect.apply(listener, this, arguments);
            }
            if (listener && typeof listener.handleEvent === "function") {
              return listener.handleEvent(ev);
            }
          };
          mapForXhr.set(listener, wrapped);
        }
        return Reflect.apply(origAddEL, this, [type, wrapped, options]);
      }
      if (
        type === "error" &&
        listener &&
        (this instanceof HTMLImageElement ||
          this instanceof HTMLScriptElement ||
          this instanceof HTMLIFrameElement)
      ) {
        const el = this;
        let mapForEl = listenerWrappers.get(el);
        if (!mapForEl) {
          mapForEl = new WeakMap();
          listenerWrappers.set(el, mapForEl);
        }
        let wrapped = mapForEl.get(listener);
        if (!wrapped) {
          wrapped = function (ev) {
            if (handleProbeElementError(el, ev)) return;
            if (typeof listener === "function") {
              return Reflect.apply(listener, this, arguments);
            }
            if (listener && typeof listener.handleEvent === "function") {
              return listener.handleEvent(ev);
            }
          };
          mapForEl.set(listener, wrapped);
        }
        return Reflect.apply(origAddEL, this, [type, wrapped, options]);
      }
      return Reflect.apply(origAddEL, this, arguments);
    }, origAddEL, "addEventListener");
  }

  // --- Layer 3: Anti-Adblock & Adult/Streaming Ad SDK Global Stubs ---

  class DefusedAdBlockDetector {
    constructor() {
      this._notDetectedCbs = [];
      this._options = { debug: false };
      const self = this;
      this.options = {
        set(opts) {
          if (opts && typeof opts === "object") Object.assign(self._options, opts);
          return self.options;
        },
        get(key) {
          return self._options[key];
        }
      };
    }
    setOption(options, value) {
      if (typeof options === "string") {
        this._options[options] = value;
      } else if (options && typeof options === "object") {
        Object.assign(this._options, options);
      }
      return this;
    }
    check() {
      recordHit("sdkStubs", "sdk.detectorCheck");
      this.emitEvent(false);
      return true;
    }
    emitEvent(detected) {
      if (!detected) {
        const cbs = this._notDetectedCbs.slice();
        for (const fn of cbs) {
          try {
            fn();
          } catch (_) {}
        }
      }
      return this;
    }
    clearEvent() {
      this._notDetectedCbs.length = 0;
    }
    on(detected, fn) {
      recordHit("sdkStubs", "sdk.detectorOn");
      if (!detected && typeof fn === "function") {
        this._notDetectedCbs.push(fn);
        try {
          fn();
        } catch (_) {}
      }
      return this;
    }
    onDetected() {
      recordHit("sdkStubs", "sdk.detectorOnDetected");
      return this;
    }
    onNotDetected(fn) {
      return this.on(false, fn);
    }
  }

  const sharedDetector = new DefusedAdBlockDetector();

  // Detector-library and ad-script decoys are installed only at the moment a matching request is
  // defused (the moment the real script's own definition would have appeared). Nothing is defined on a
  // clean page, so `'FuckAdBlock' in window` and similar checks look exactly like an unmodified browser.
  function defineDecoy(name, value, ignoreWrites) {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: false,
        get() {
          return value;
        },
        set(v) {
          if (ignoreWrites) {
            recordHit("sdkStubs", "sdk.globalSetterIgnored");
          } else {
            value = v;
          }
        }
      });
    } catch (_) {}
  }

  let detectorStubsInstalled = false;
  function installDetectorStubs() {
    if (detectorStubsInstalled) return;
    detectorStubsInstalled = true;
    for (const n of ["FuckAdBlock", "BlockAdBlock", "SniffAdBlock"]) defineDecoy(n, DefusedAdBlockDetector, true);
    for (const n of ["fuckAdBlock", "blockAdBlock", "sniffAdBlock"]) defineDecoy(n, sharedDetector, true);
  }

  // --- Layer 4: Host-Scoped Scriptlet Primitives (aopr / aopw / set-constant / cookie) ---

  // Host-scoped scriptlets imported from the uAssets / AdGuard filter lists (src/site-rules.json, generated by
  // tools/import-site-rules.mjs). Properties may be dotted chains; a missing parent is trapped until it is assigned.
  const CONSTANTS = {
    false: () => false, true: () => true, null: () => null, undefined: () => undefined,
    noopFunc: () => function () {}, trueFunc: () => function () { return true; }, falseFunc: () => function () { return false; },
    emptyStr: () => "", emptyArr: () => [], emptyObj: () => ({})
  };
  const constantOf = (token) => (token in CONSTANTS ? CONSTANTS[token]() : Number(token));

  function defineLeaf(owner, prop, op, token) {
    const rid = Math.random().toString(36).slice(2, 9);
    try {
      if (op === "aopr") {
        Object.defineProperty(owner, prop, {
          configurable: true,
          get() {
            if (paused) return undefined;
            recordHit("sdkStubs", "scriptlet.aopr");
            throw new ReferenceError(`Aborted read of ${prop} [${rid}]`);
          },
          set() {}
        });
      } else if (op === "aopw") {
        let cur = owner[prop];
        Object.defineProperty(owner, prop, {
          configurable: true,
          get() { return cur; },
          set(v) {
            if (paused) { cur = v; return; }
            recordHit("sdkStubs", "scriptlet.aopw");
            throw new ReferenceError(`Aborted write of ${prop} [${rid}]`);
          }
        });
      } else {
        const value = constantOf(token);
        Object.defineProperty(owner, prop, {
          configurable: true,
          get() { return value; },
          set() { recordHit("sdkStubs", "scriptlet.setConstant"); }
        });
      }
    } catch (_) {}
  }

  function trapChain(owner, chain, op, token) {
    const [head, ...rest] = chain;
    if (rest.length === 0) return defineLeaf(owner, head, op, token);
    const descend = (obj) => {
      if (obj && (typeof obj === "object" || typeof obj === "function")) trapChain(obj, rest, op, token);
    };
    const existing = owner[head];
    if (existing !== undefined && existing !== null) return descend(existing);
    let held;
    try {
      Object.defineProperty(owner, head, {
        configurable: true,
        enumerable: true,
        get() { return held; },
        set(v) { held = v; descend(v); }
      });
    } catch (_) {}
  }

  // Keys of every trap installed on this page, host-scoped or dynamic, so nothing is trapped twice.
  const engaged = new Set();

  // True when something real already lives at the property chain (or a trap of ours does). A dynamic rule never
  // overrides it: that is what keeps engaging rules on unknown sites collision-safe.
  function isOccupied(chain) {
    let cur = window;
    for (const part of chain) {
      let v;
      try { v = cur[part]; } catch (_) { return true; }   // a throwing getter is somebody's trap
      if (v === undefined) return false;
      cur = v;
    }
    return true;
  }

  // Low-collision subset of the imported rules, engaged only when the page shows the behaviour that makes them
  // relevant: "adnet" after an adult ad-network request was defused, "detect" after the page measured a bait
  // element that a blocker had hidden. Nothing is defined on a page that never does either.
  function engageGeneric(kind) {
    if (paused || !AUB_TABLES) return;
    for (const g of AUB_TABLES.genericRules) {
      if (g.kind !== kind) continue;
      const key = g.op + ":" + g.prop;
      if (engaged.has(key)) continue;
      engaged.add(key);
      const chain = g.prop.split(".");
      if (isOccupied(chain)) continue;
      trapChain(window, chain, g.op, g.value);
      recordHit("sdkStubs", "generic." + kind);
    }
  }

  function runSiteAction(act) {
    if (act.op !== "cookie") engaged.add(act.op + ":" + act.prop);
    if (act.op === "cookie") {
      try {
        if (!document.cookie.includes(act.name + "=")) {
          document.cookie = `${act.name}=${act.value}; path=/; SameSite=Lax`;
          recordHit("sdkStubs", "host.cookie");
        }
      } catch (_) {}
      return;
    }
    trapChain(window, act.prop.split("."), act.op, act.value);
  }

  // Video player configuration traps (strip pre-roll / VAST config before player boots)
  function trapObjectGlobal(prop, sanitizer) {
    let current = window[prop];
    if (current && typeof current === "object") {
      try {
        sanitizer(current);
      } catch (_) {}
    }
    try {
      Object.defineProperty(window, prop, {
        configurable: true,
        enumerable: true,
        get() {
          return current;
        },
        set(val) {
          if (!paused && val && typeof val === "object") {
            try {
              sanitizer(val);
            } catch (_) {}
          }
          current = val;
        }
      });
    } catch (_) {}
  }

  // Aylo (Pornhub/YouPorn/RedTube/Tube8) promo flags, per AdGuard set-constant rules
  const ayloHost = (window.location && window.location.hostname) || "";
  if (/(?:^|\.)(?:pornhub|youporn|redtube|tube8)\.[a-z.]+$/i.test(ayloHost)) {
    const promoKey = /pornhub/i.test(ayloHost) ? "holiday_promo_prem" : "holiday_promo";
    trapObjectGlobal("page_params", (obj) => {
      try {
        obj[promoKey] = true;
        recordHit("sdkStubs", "host.ayloPageParams");
      } catch (_) {}
    });
  }

  // xHamster / Hammy Media player pre-roll config
  const XH_HOST_RE =
    /(?:^|\.)(?:xhamster\d*|xhday\d*|xhspot|xhtotal|xhtree|xhwide\d*|xhofficial|xhbig|xhvid|xhdate|xhlease|xhaccess|xhopen|xhchannel|xhplanet\d*|xhmoon\d*|xhadult\d*|xhbranch\d*|xhwebsite\d*|megaxh|openxh\d*|seexh|valuexh|fullxh|interxh|galleryxh|colourxh|myxh|xhdesi)\.[a-z.]+$/i;
  if (XH_HOST_RE.test(ayloHost)) trapObjectGlobal("initials", (obj) => {
    if ("prerollAllowed" in obj) {
      obj.prerollAllowed = false;
      recordHit("sdkStubs", "host.xhamsterInitials");
    }
    if ("prerollConfig" in obj && obj.prerollConfig) {
      obj.prerollConfig = null;
    }
    if (obj.xplayerSettings && typeof obj.xplayerSettings === "object") {
      obj.xplayerSettings.preroll = null;
      obj.xplayerSettings.vast = null;
    }
  });

  // WGCZ (xVideos / XNXX) html5player video-ad & detector state
  if (/(?:^|\.)(?:xvideos\d*|xnxx\d*|xvideos-cams|xnxx-cams)\.[a-z.]+$/i.test(ayloHost)) trapObjectGlobal("html5player", (obj) => {
    obj.disableVideoAds = true;
    obj.has_adblocker = false;
    obj.adblocker_detected = false;
    obj.need_doubleclick_ad = false;
  });

  // Aylo / TrafficJunky pre-roll preload hook. (TJ_ADS_TAKEOVER used to be pinned to false here; removed: its
  // effect was never shown to matter, and the site's own call to TJ_ADS_TAKEOVER.preloadAds() then threw a
  // TypeError that the site's error reporting could see.)
  if (/(?:^|\.)(?:pornhub|youporn|redtube|tube8)\.[a-z.]+$/i.test(ayloHost)) {
    defineLeaf(window, "tjPreloadAds", "set", "noopFunc");
  }

  const curHost = (window.location && window.location.hostname) || "";
  if (curHost) {
    for (const rule of AUB_TABLES.siteRules) {
      if (new RegExp(rule.hostRe, "i").test(curHost)) {
        for (const act of rule.actions) runSiteAction(act);
      }
    }
  }
})();
