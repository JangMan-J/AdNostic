(() => {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const tabStats = new Map();
  globalThis.__aubGetTabStats = (tabId) => tabStats.get(tabId) || null;

  function emptyStats(host = "") {
    return {
      host,
      baitSpoofs: 0,
      probeIntercepts: 0,
      sdkStubs: 0,
      overlaysRemoved: 0,
      dnrBlocked: 0
    };
  }

  function totalHits(s) {
    if (!s) return 0;
    return (
      (s.baitSpoofs || 0) +
      (s.probeIntercepts || 0) +
      (s.sdkStubs || 0) +
      (s.overlaysRemoved || 0) +
      (s.dnrBlocked || 0)
    );
  }

  async function updateBadge(tabId) {
    if (typeof tabId !== "number" || tabId < 0) return;
    try {
      const { globalEnabled = true, pausedHosts = [] } = await api.storage.local.get([
        "globalEnabled",
        "pausedHosts"
      ]);
      const stats = tabStats.get(tabId);
      const isPaused = !globalEnabled || (stats?.host && pausedHosts.includes(stats.host));
      if (isPaused) {
        await api.action.setBadgeText({ tabId, text: "OFF" });
        await api.action.setBadgeBackgroundColor({ tabId, color: "#6b7280" });
        return;
      }
      const count = totalHits(stats);
      await api.action.setBadgeText({
        tabId,
        text: count > 0 ? (count > 99 ? "99+" : String(count)) : ""
      });
      if (count > 0) {
        await api.action.setBadgeBackgroundColor({ tabId, color: "#10b981" });
      }
    } catch (_) {}
  }

  async function syncDnrState() {
    try {
      const { globalEnabled = true, pausedHosts = [] } = await api.storage.local.get([
        "globalEnabled",
        "pausedHosts"
      ]);

      await api.declarativeNetRequest.updateEnabledRulesets(
        globalEnabled
          ? { enableRulesetIds: ["ruleset_anti_adblock"], disableRulesetIds: [] }
          : { enableRulesetIds: [], disableRulesetIds: ["ruleset_anti_adblock"] }
      );

      const existing = await api.declarativeNetRequest.getDynamicRules();
      const removeRuleIds = existing.map((r) => r.id);
      const addRules = (Array.isArray(pausedHosts) ? pausedHosts : [])
        .filter(Boolean)
        .map((host, idx) => ({
          id: 10000 + idx,
          priority: 1000,
          action: { type: "allowAllRequests" },
          condition: {
            requestDomains: [host],
            resourceTypes: ["main_frame", "sub_frame"]
          }
        }));

      await api.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules
      });
    } catch (_) {}
  }

  api.runtime.onInstalled.addListener(async () => {
    const cur = await api.storage.local.get(["globalEnabled", "pausedHosts"]);
    if (typeof cur.globalEnabled !== "boolean") {
      await api.storage.local.set({ globalEnabled: true });
    }
    if (!Array.isArray(cur.pausedHosts)) {
      await api.storage.local.set({ pausedHosts: [] });
    }
    await syncDnrState();
  });

  if (api.declarativeNetRequest?.onRuleMatchedDebug) {
    api.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
      const tabId = info?.request?.tabId;
      if (typeof tabId === "number" && tabId >= 0) {
        const cur = tabStats.get(tabId) || emptyStats();
        cur.dnrBlocked += 1;
        tabStats.set(tabId, cur);
        updateBadge(tabId);
      }
    });
  }

  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "loading" && changeInfo.url) {
      try {
        const host = new URL(changeInfo.url).hostname;
        tabStats.set(tabId, emptyStats(host));
        updateBadge(tabId);
      } catch (_) {}
    } else if (changeInfo.status === "complete" && tab?.url) {
      updateBadge(tabId);
    }
  });

  api.tabs.onRemoved.addListener((tabId) => {
    tabStats.delete(tabId);
  });

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;

    if (msg.type === "AUB_RECORD_STATS") {
      const tabId = sender?.tab?.id;
      if (typeof tabId === "number" && tabId >= 0) {
        const cur = tabStats.get(tabId) || emptyStats(msg.host || "");
        if (msg.host && !cur.host) cur.host = msg.host;
        const d = msg.delta || {};
        cur.baitSpoofs += Number(d.baitSpoofs) || 0;
        cur.probeIntercepts += Number(d.probeIntercepts) || 0;
        cur.sdkStubs += Number(d.sdkStubs) || 0;
        cur.overlaysRemoved += Number(d.overlaysRemoved) || 0;
        tabStats.set(tabId, cur);
        updateBadge(tabId);
      }
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "AUB_GET_STATE") {
      (async () => {
        const { globalEnabled = true, pausedHosts = [] } = await api.storage.local.get([
          "globalEnabled",
          "pausedHosts"
        ]);
        const tabId = msg.tabId;
        const stats = typeof tabId === "number" ? tabStats.get(tabId) || emptyStats() : emptyStats();
        sendResponse({
          globalEnabled,
          pausedHosts,
          stats,
          total: totalHits(stats)
        });
      })();
      return true;
    }

    if (msg.type === "AUB_SET_GLOBAL") {
      (async () => {
        const globalEnabled = Boolean(msg.globalEnabled);
        await api.storage.local.set({ globalEnabled });
        await syncDnrState();
        if (typeof msg.tabId === "number") await updateBadge(msg.tabId);
        sendResponse({ ok: true, globalEnabled });
      })();
      return true;
    }

    if (msg.type === "AUB_TOGGLE_HOST") {
      (async () => {
        const host = String(msg.host || "").trim().toLowerCase();
        const { pausedHosts = [] } = await api.storage.local.get(["pausedHosts"]);
        const set = new Set(Array.isArray(pausedHosts) ? pausedHosts : []);
        if (host) {
          if (set.has(host)) set.delete(host);
          else set.add(host);
        }
        const updated = Array.from(set);
        await api.storage.local.set({ pausedHosts: updated });
        await syncDnrState();
        if (typeof msg.tabId === "number") await updateBadge(msg.tabId);
        sendResponse({ ok: true, pausedHosts: updated, paused: set.has(host) });
      })();
      return true;
    }

    return false;
  });
})();
