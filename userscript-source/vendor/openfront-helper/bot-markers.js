// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/bot-markers.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing. ofbot change: allied/teammate nations get a green dot.

// Bot marker overlay for nation AI players.

  function ensureBotMarkerStyles() {
    if (document.getElementById(BOT_MARKER_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = BOT_MARKER_STYLE_ID;
    style.textContent = `
      #${BOT_MARKER_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 9000;
        pointer-events: none;
      }

      #${BOT_MARKER_CONTAINER_ID} .openfront-helper-bot-dot {
        position: fixed;
        width: 13px;
        height: 13px;
        margin: -6.5px 0 0 -6.5px;
        border-radius: 50%;
        background: rgba(239, 68, 68, 0.68);
        box-shadow:
          0 0 0 2px rgba(127, 29, 29, 0.34),
          0 0 10px rgba(239, 68, 68, 0.72);
        transform: translate(var(--bot-x), var(--bot-y));
      }

      #${BOT_MARKER_CONTAINER_ID} .openfront-helper-bot-dot.openfront-helper-bot-ally {
        background: rgba(34, 197, 94, 0.68);
        box-shadow:
          0 0 0 2px rgba(20, 83, 45, 0.34),
          0 0 10px rgba(34, 197, 94, 0.72);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureBotMarkerContainer() {
    ensureBotMarkerStyles();

    let container = document.getElementById(BOT_MARKER_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = BOT_MARKER_CONTAINER_ID;
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  // DOM-element cache keyed by player marker id. Eliminates the O(N) per-marker
  // container.querySelector and the O(N) container.querySelectorAll sweep that
  // ran every frame. With 40 bots this was ~1600 DOM lookups per frame at 60Hz.
  const botMarkerEntries = new Map();
  // Cached active-bot list. Refreshed on a slower cadence than per-frame; the
  // expensive proxy calls (playerViews, isAlive, isNationBot, nameLocation,
  // getPlayerMarkerId) only run during a scan.
  let botMarkerScanCache = [];
  let lastBotMarkerScanAt = 0;
  const BOT_MARKER_SCAN_MS = 500;

  function collectBotMarkerScan(game) {
    const players = getCachedPlayerViews(game);
    const result = [];
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (!isNationBotPlayer(player) || !player?.isAlive?.()) {
        continue;
      }
      const markerId = getPlayerMarkerId(player, index);
      const ally = getPlayerRelationToMyPlayer(game, player) === "ally";
      result.push({ player, markerId, ally });
    }
    return result;
  }

  function pruneBotMarkerCache() {
    const activeIds = new Set();
    for (const entry of botMarkerScanCache) {
      activeIds.add(entry.markerId);
    }
    for (const [markerId, entry] of botMarkerEntries) {
      if (!activeIds.has(markerId)) {
        entry.marker.remove();
        botMarkerEntries.delete(markerId);
      }
    }
  }

  function ensureBotMarkerEntry(container, markerId) {
    let entry = botMarkerEntries.get(markerId);
    if (entry) {
      return entry;
    }
    const marker = document.createElement("div");
    marker.className = "openfront-helper-bot-dot";
    marker.dataset.botId = markerId;
    container.appendChild(marker);
    entry = { marker, x: NaN, y: NaN, hidden: false, ally: false };
    botMarkerEntries.set(markerId, entry);
    return entry;
  }

  function hideBotMarkerEntry(entry) {
    if (!entry.hidden) {
      entry.marker.hidden = true;
      entry.hidden = true;
    }
  }

  function syncBotMarkers() {
    if (!botMarkersEnabled) {
      document.getElementById(BOT_MARKER_CONTAINER_ID)?.remove();
      botMarkerEntries.clear();
      botMarkerScanCache = [];
      lastBotMarkerScanAt = 0;
      botMarkerAnimationFrame = null;
      return;
    }

    const context = getOpenFrontGameContext();
    const container = ensureBotMarkerContainer();
    if (!context) {
      if (botMarkerEntries.size > 0) {
        for (const entry of botMarkerEntries.values()) {
          entry.marker.remove();
        }
        botMarkerEntries.clear();
      }
      botMarkerScanCache = [];
      lastBotMarkerScanAt = 0;
      botMarkerAnimationFrame = requestAnimationFrame(syncBotMarkers);
      return;
    }

    const now = performance.now();
    if (now - lastBotMarkerScanAt >= BOT_MARKER_SCAN_MS) {
      botMarkerScanCache = collectBotMarkerScan(context.game);
      pruneBotMarkerCache();
      lastBotMarkerScanAt = now;
    }

    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;

    for (let i = 0; i < botMarkerScanCache.length; i += 1) {
      const { player, markerId, ally } = botMarkerScanCache[i];
      const nameLocation = player.nameLocation?.();
      if (!nameLocation) {
        const existing = botMarkerEntries.get(markerId);
        if (existing) {
          hideBotMarkerEntry(existing);
        }
        continue;
      }

      const screenPos = context.transform.worldToScreenCoordinates(nameLocation);
      if (
        !Number.isFinite(screenPos?.x) ||
        !Number.isFinite(screenPos?.y) ||
        screenPos.x < -30 ||
        screenPos.y < -30 ||
        screenPos.x > innerWidth + 30 ||
        screenPos.y > innerHeight + 30
      ) {
        const existing = botMarkerEntries.get(markerId);
        if (existing) {
          hideBotMarkerEntry(existing);
        }
        continue;
      }

      const entry = ensureBotMarkerEntry(container, markerId);
      if (entry.hidden) {
        entry.marker.hidden = false;
        entry.hidden = false;
      }
      if (entry.ally !== ally) {
        entry.marker.classList.toggle("openfront-helper-bot-ally", ally);
        entry.ally = ally;
      }
      if (entry.x !== screenPos.x) {
        entry.marker.style.setProperty("--bot-x", `${screenPos.x}px`);
        entry.x = screenPos.x;
      }
      if (entry.y !== screenPos.y) {
        entry.marker.style.setProperty("--bot-y", `${screenPos.y}px`);
        entry.y = screenPos.y;
      }
    }

    botMarkerAnimationFrame = requestAnimationFrame(syncBotMarkers);
  }

  function setBotMarkersEnabled(enabled) {
    botMarkersEnabled = Boolean(enabled);
    if (!botMarkersEnabled) {
      if (botMarkerAnimationFrame !== null) {
        cancelAnimationFrame(botMarkerAnimationFrame);
      }
      botMarkerAnimationFrame = null;
      botMarkerEntries.clear();
      botMarkerScanCache = [];
      lastBotMarkerScanAt = 0;
      document.getElementById(BOT_MARKER_CONTAINER_ID)?.remove();
      return;
    }

    if (botMarkerAnimationFrame === null) {
      syncBotMarkers();
    }
  }
