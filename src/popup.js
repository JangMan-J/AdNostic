(() => {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  const globalToggle = document.getElementById("globalToggle");
  const statusDot = document.getElementById("statusDot");
  const currentHostEl = document.getElementById("currentHost");
  const totalCountEl = document.getElementById("totalCount");
  const baitCountEl = document.getElementById("baitCount");
  const probeCountEl = document.getElementById("probeCount");
  const sdkCountEl = document.getElementById("sdkCount");
  const overlayCountEl = document.getElementById("overlayCount");
  const hostToggleBtn = document.getElementById("hostToggleBtn");

  let activeTab = null;
  let activeHost = "";

  function render(state) {
    const globalEnabled = state.globalEnabled !== false;
    const pausedHosts = Array.isArray(state.pausedHosts) ? state.pausedHosts : [];
    const hostPaused = activeHost && pausedHosts.includes(activeHost);
    const active = globalEnabled && !hostPaused;

    globalToggle.checked = globalEnabled;
    statusDot.classList.toggle("paused", !active);

    const s = state.stats || {};
    const overlays = (s.overlaysRemoved || 0) + (s.dnrBlocked || 0);
    const total = (s.baitSpoofs || 0) + (s.probeIntercepts || 0) + (s.sdkStubs || 0) + overlays;

    totalCountEl.textContent = String(total);
    baitCountEl.textContent = String(s.baitSpoofs || 0);
    probeCountEl.textContent = String(s.probeIntercepts || 0);
    sdkCountEl.textContent = String(s.sdkStubs || 0);
    overlayCountEl.textContent = String(overlays);

    if (!activeHost) {
      hostToggleBtn.disabled = true;
      hostToggleBtn.textContent = "Unavailable on internal page";
    } else {
      hostToggleBtn.disabled = false;
      hostToggleBtn.textContent = hostPaused
        ? `Resume on ${activeHost}`
        : `Pause on ${activeHost}`;
    }
  }

  async function refresh() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs && tabs[0] ? tabs[0] : null;
    if (activeTab && activeTab.url && /^https?:/i.test(activeTab.url)) {
      activeHost = new URL(activeTab.url).hostname.toLowerCase();
      currentHostEl.textContent = activeHost;
    } else {
      activeHost = "";
      currentHostEl.textContent = "Browser page";
    }

    const state = await api.runtime.sendMessage({
      type: "AUB_GET_STATE",
      tabId: activeTab ? activeTab.id : -1
    });
    render(state || {});
  }

  globalToggle.addEventListener("change", async () => {
    await api.runtime.sendMessage({
      type: "AUB_SET_GLOBAL",
      globalEnabled: globalToggle.checked,
      tabId: activeTab ? activeTab.id : -1
    });
    if (activeTab?.id) api.tabs.reload(activeTab.id);
    await refresh();
  });

  hostToggleBtn.addEventListener("click", async () => {
    if (!activeHost) return;
    await api.runtime.sendMessage({
      type: "AUB_TOGGLE_HOST",
      host: activeHost,
      tabId: activeTab ? activeTab.id : -1
    });
    if (activeTab?.id) api.tabs.reload(activeTab.id);
    await refresh();
  });

  refresh().catch(() => {});
})();
