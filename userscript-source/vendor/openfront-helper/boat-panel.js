// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/boat-panel.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Boat list panel: two tabs — boats YOU sent, and boats INCOMING to your
// current territory (team/ally/enemy). Hovering a row focuses that boat so the
// shared map overlay draws its route + a strong highlight; this works even when
// the boat-prediction overlay toggle is off (the panel keeps the loop alive).
//
// Reads `boatPredictionTransports` (populated by syncBoatPrediction while the
// overlay is active) as the single source of truth, and reuses the overlay's
// relation/colour classification. ETA is computed live from the game's
// motionPlans, the same data the game uses to advance the ship.

  const BOAT_PANEL_UPDATE_MS = 400;
  const BOAT_PANEL_POS_KEY = "openfrontHelperBoatPanelPos";
  let boatPanelActiveTab = "sent"; // "sent" | "incoming"
  let boatPanelUpdateTimer = null;
  const boatPanelRowCache = new Map(); // domUnitId -> { row, dot, name, eta }
  let boatPanelTabButtons = null; // { sent, incoming }

  function ensureBoatPanelStyles() {
    if (document.getElementById(BOAT_PANEL_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = BOAT_PANEL_STYLE_ID;
    style.textContent = `
      #${BOAT_PANEL_ID} {
        position: fixed;
        right: 14px;
        top: 560px;
        z-index: 9000;
        display: none;
        flex-direction: column;
        width: min(260px, calc(100vw - 28px));
        max-height: min(52vh, 460px);
        overflow: hidden;
        border: 1px solid rgba(148, 163, 184, 0.34);
        border-radius: 8px;
        background: rgba(12, 18, 20, 0.95);
        color: #e2e8f0;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 11px;
        font-weight: 700;
        box-shadow: 0 10px 26px rgba(0, 0, 0, 0.4), 0 0 16px rgba(148, 163, 184, 0.1);
        pointer-events: auto;
      }
      #${BOAT_PANEL_ID}[data-visible="true"] { display: flex; }

      #${BOAT_PANEL_ID} .ofh-boatp-header {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 6px 8px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        cursor: grab;
        touch-action: none;
      }
      #${BOAT_PANEL_ID} .ofh-boatp-header:active { cursor: grabbing; }
      #${BOAT_PANEL_ID} .ofh-boatp-title {
        margin: 0;
        flex: 1;
        color: rgba(226, 232, 240, 0.85);
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }

      #${BOAT_PANEL_ID} .ofh-boatp-tabs {
        display: flex;
        gap: 4px;
        padding: 7px 8px 4px;
      }
      #${BOAT_PANEL_ID} .ofh-boatp-tab {
        flex: 1;
        padding: 5px 6px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 7px;
        background: rgba(8, 22, 24, 0.6);
        color: rgba(226, 232, 240, 0.7);
        font-size: 11px;
        font-weight: 700;
        text-align: center;
        cursor: pointer;
        transition: 0.15s;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${BOAT_PANEL_ID} .ofh-boatp-tab:hover { border-color: rgba(148, 163, 184, 0.34); }
      #${BOAT_PANEL_ID} .ofh-boatp-tab.on {
        background: rgba(148, 163, 184, 0.26);
        border-color: rgba(148, 163, 184, 0.5);
        color: #f8fafc;
      }

      #${BOAT_PANEL_ID} .ofh-boatp-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 4px 6px 8px;
      }
      #${BOAT_PANEL_ID} .ofh-boat-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 7px;
        border-radius: 7px;
        cursor: pointer;
      }
      #${BOAT_PANEL_ID} .ofh-boat-row:hover { background: rgba(148, 163, 184, 0.18); }
      #${BOAT_PANEL_ID} .ofh-boat-dot {
        flex: none;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        box-shadow: 0 0 4px currentColor;
      }
      #${BOAT_PANEL_ID} .ofh-boat-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        font-weight: 600;
        color: #eef2f0;
      }
      #${BOAT_PANEL_ID} .ofh-boat-eta {
        flex: none;
        font-size: 11px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: #cbd5e1;
      }
      #${BOAT_PANEL_ID} .ofh-boatp-empty {
        padding: 14px 10px;
        text-align: center;
        font-size: 11px;
        color: rgba(226, 232, 240, 0.5);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function setBoatPanelActiveTab(tab) {
    if (!boatPanelTabButtons) {
      return;
    }
    boatPanelActiveTab = tab === "incoming" ? "incoming" : "sent";
    boatPanelTabButtons.sent.classList.toggle("on", boatPanelActiveTab === "sent");
    boatPanelTabButtons.incoming.classList.toggle("on", boatPanelActiveTab === "incoming");
    updateBoatPanel();
  }

  function ensureBoatPanel() {
    ensureBoatPanelStyles();
    let panel = document.getElementById(BOAT_PANEL_ID);
    if (panel) {
      return panel;
    }

    panel = document.createElement("div");
    panel.id = BOAT_PANEL_ID;
    panel.setAttribute("aria-hidden", "true");

    const header = document.createElement("div");
    header.className = "ofh-boatp-header";
    const title = document.createElement("h2");
    title.className = "ofh-boatp-title";
    title.textContent = tr("Boats");
    header.appendChild(title);

    const tabs = document.createElement("div");
    tabs.className = "ofh-boatp-tabs";
    const sentTab = document.createElement("div");
    sentTab.className = "ofh-boatp-tab";
    sentTab.addEventListener("click", () => setBoatPanelActiveTab("sent"));
    const incomingTab = document.createElement("div");
    incomingTab.className = "ofh-boatp-tab";
    incomingTab.addEventListener("click", () => setBoatPanelActiveTab("incoming"));
    tabs.append(sentTab, incomingTab);
    boatPanelTabButtons = { sent: sentTab, incoming: incomingTab };

    const body = document.createElement("div");
    body.className = "ofh-boatp-body";

    panel.append(header, tabs, body);
    (document.body || document.documentElement).appendChild(panel);
    // Draggable by the header, with the position persisted to localStorage
    // (shared helper from gold-per-minute.js).
    makeGoldStatPanelDraggable(panel, header, BOAT_PANEL_POS_KEY);
    applyStoredGoldStatPanelPosition(panel, BOAT_PANEL_POS_KEY);

    setBoatPanelActiveTab(boatPanelActiveTab);
    return panel;
  }

  // computeBoatEtaMs / formatBoatEta live in boat-prediction.js (shared scope)
  // so the hover label and this panel format ETA identically.

  function getBoatPanelRow(transport) {
    let entry = boatPanelRowCache.get(transport.domUnitId);
    if (!entry) {
      const row = document.createElement("div");
      row.className = "ofh-boat-row";
      const dot = document.createElement("span");
      dot.className = "ofh-boat-dot";
      const name = document.createElement("span");
      name.className = "ofh-boat-name";
      const eta = document.createElement("span");
      eta.className = "ofh-boat-eta";
      row.append(dot, name, eta);

      const focusId = transport.domUnitId;
      row.addEventListener("mouseenter", () => {
        boatPanelFocusedId = focusId;
      });
      row.addEventListener("mouseleave", () => {
        if (boatPanelFocusedId === focusId) {
          boatPanelFocusedId = null;
        }
      });

      entry = { row, dot, name, eta, unit: transport.unit };
      // Click a row → pan the camera to that boat's current position. entry.unit
      // is refreshed each render so a stale scan ref isn't used.
      row.addEventListener("click", () => {
        if (entry.unit) {
          focusIncomingBoat(entry.unit);
        }
      });
      boatPanelRowCache.set(transport.domUnitId, entry);
    }
    return entry;
  }

  function renderBoatPanelRows(bodyEl, game, transports) {
    const seen = new Set();

    for (const transport of transports) {
      seen.add(transport.domUnitId);
      const entry = getBoatPanelRow(transport);
      entry.unit = transport.unit; // refresh ref for click-to-focus
      // currentColor drives the dot's glow (box-shadow); set both.
      entry.dot.style.color = transport.color;
      entry.dot.style.background = transport.color;
      entry.name.textContent = transport.ownerName || "—";
      entry.eta.textContent = formatBoatEta(computeBoatEtaMs(game, transport));
      // appendChild on an existing node moves it — keeps list order without
      // recreating rows, so hover state + focus survive each refresh.
      bodyEl.appendChild(entry.row);
    }

    for (const [domUnitId, entry] of boatPanelRowCache) {
      if (!seen.has(domUnitId)) {
        if (boatPanelFocusedId === domUnitId) {
          // The hovered boat vanished (landed / tab switch): drop the focus so
          // its route doesn't stay stuck on the map.
          boatPanelFocusedId = null;
        }
        entry.row.remove();
        boatPanelRowCache.delete(domUnitId);
      }
    }

    let empty = bodyEl.querySelector(".ofh-boatp-empty");
    if (!transports.length) {
      if (!empty) {
        empty = document.createElement("div");
        empty.className = "ofh-boatp-empty";
        bodyEl.appendChild(empty);
      }
      empty.textContent = tr("No boats");
    } else if (empty) {
      empty.remove();
    }
  }

  function clearBoatPanelRows() {
    for (const [, entry] of boatPanelRowCache) {
      entry.row.remove();
    }
    boatPanelRowCache.clear();
  }

  function updateBoatPanel() {
    const panel = document.getElementById(BOAT_PANEL_ID);
    if (!panel) {
      return;
    }
    const context = getOpenFrontGameContext();
    const game = context?.game || null;

    // Partition the scanned transports first — visibility depends on the counts.
    const sent = [];
    const incoming = [];
    if (game) {
      for (const transport of boatPredictionTransports) {
        try {
          if (!transport.unit?.isActive?.()) {
            continue; // unit ref can go stale between 1s scans
          }
        } catch (_error) {
          continue;
        }
        if (transport.relation === "self") {
          sent.push(transport);
        } else if (transport.targetsMyTerritory) {
          incoming.push(transport);
        }
      }
    }

    // Show only in a match AND only when there is at least one boat to list.
    const shouldShow =
      boatPanelOpen && Boolean(game) && (sent.length > 0 || incoming.length > 0);
    panel.dataset.visible = shouldShow ? "true" : "false";
    if (!shouldShow) {
      boatPanelFocusedId = null;
      clearBoatPanelRows();
      return;
    }

    const bodyEl = panel.querySelector(".ofh-boatp-body");
    if (!bodyEl) {
      return;
    }

    if (boatPanelTabButtons) {
      boatPanelTabButtons.sent.textContent = `${tr("Sent")} (${sent.length})`;
      boatPanelTabButtons.incoming.textContent = `${tr("Incoming")} (${incoming.length})`;
    }

    renderBoatPanelRows(bodyEl, game, boatPanelActiveTab === "sent" ? sent : incoming);
  }

  function setBoatPanelEnabled(enabled) {
    boatPanelOpen = Boolean(enabled);

    if (boatPanelOpen) {
      ensureBoatPanel();
      if (boatPanelUpdateTimer === null) {
        boatPanelUpdateTimer = window.setInterval(updateBoatPanel, BOAT_PANEL_UPDATE_MS);
      }
      // Kick the shared overlay loop so the panel can draw focused routes even
      // when the prediction overlay toggle is off.
      refreshBoatOverlayActivity();
      // updateBoatPanel decides actual visibility (only shows once in a match).
      updateBoatPanel();
    } else {
      const panel = document.getElementById(BOAT_PANEL_ID);
      if (panel) {
        panel.dataset.visible = "false";
      }
      if (boatPanelUpdateTimer !== null) {
        clearInterval(boatPanelUpdateTimer);
        boatPanelUpdateTimer = null;
      }
      // Don't leave a focused boat highlighted on the map after closing.
      boatPanelFocusedId = null;
      clearBoatPanelRows();
      // Tear the overlay down only if no other consumer still needs it.
      refreshBoatOverlayActivity();
    }
  }

  // ── Incoming-boat warning ────────────────────────────────────────────────
  // A new transport aimed at MY territory raises a center-screen alert, in the
  // same spirit as the Missile Silo warning. Detection runs on the overlay scan
  // (see maybeWarnNewIncomingBoats, called from syncBoatPrediction).
  const BOAT_ALERT_MS = 9000;
  let boatIncomingSeen = new Set(); // ids treated as "already known"
  let boatIncomingWarnInit = false; // seeded yet? (first pass primes, no alert)
  const boatAlertTimers = new Map(); // boatId -> dismiss timer

  function ensureBoatAlertStyles() {
    if (document.getElementById(BOAT_ALERT_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = BOAT_ALERT_STYLE_ID;
    style.textContent = `
      #${BOAT_ALERT_CONTAINER_ID} {
        position: fixed;
        top: 17%;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9000;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        width: max-content;
        max-width: min(520px, calc(100vw - 24px));
        pointer-events: none;
      }
      #${BOAT_ALERT_CONTAINER_ID} .ofh-boat-alert {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 13px;
        padding: 12px 16px;
        border: 2px solid var(--boat-accent, rgba(248, 113, 113, 0.95));
        border-radius: 12px;
        background: linear-gradient(180deg, rgba(12, 26, 28, 0.96), rgba(6, 16, 18, 0.96));
        color: #ecfdf5;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 0 26px var(--boat-accent, rgba(248, 113, 113, 0.45));
        animation:
          ofh-boat-alert-in 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2),
          ofh-boat-alert-glow 1.2s ease-in-out infinite;
      }
      @keyframes ofh-boat-alert-in {
        from { opacity: 0; transform: translateY(-14px) scale(0.94); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes ofh-boat-alert-glow {
        0%, 100% { box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 0 18px var(--boat-accent, rgba(248, 113, 113, 0.3)); }
        50% { box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 0 36px var(--boat-accent, rgba(248, 113, 113, 0.8)); }
      }
      #${BOAT_ALERT_CONTAINER_ID} .ofh-boat-alert-icon {
        flex: 0 0 auto;
        font-size: 28px;
        line-height: 1;
        animation: ofh-boat-alert-bob 0.9s ease-in-out infinite;
      }
      @keyframes ofh-boat-alert-bob {
        0%, 100% { transform: translateY(-2px) rotate(-6deg); }
        50% { transform: translateY(2px) rotate(6deg); }
      }
      #${BOAT_ALERT_CONTAINER_ID} .ofh-boat-alert-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      #${BOAT_ALERT_CONTAINER_ID} .ofh-boat-alert-title {
        font-size: 11px; font-weight: 800; letter-spacing: 0.08em;
        text-transform: uppercase; color: var(--boat-accent, #fca5a5);
      }
      #${BOAT_ALERT_CONTAINER_ID} .ofh-boat-alert-msg { font-size: 15px; font-weight: 800; line-height: 1.2; }
      #${BOAT_ALERT_CONTAINER_ID} .ofh-boat-alert-who { color: var(--boat-accent, #fecaca); }
      #${BOAT_ALERT_CONTAINER_ID} .ofh-boat-alert-actions { display: flex; align-items: center; gap: 6px; margin-left: 4px; }
      #${BOAT_ALERT_CONTAINER_ID} .ofh-boat-alert-btn {
        cursor: pointer;
        border: 1px solid rgba(153, 246, 228, 0.4);
        border-radius: 7px;
        background: rgba(20, 184, 166, 0.18);
        color: #ccfbf1;
        font: 700 12px/1 "Aptos", "Segoe UI", sans-serif;
        padding: 6px 9px;
        white-space: nowrap;
      }
      #${BOAT_ALERT_CONTAINER_ID} .ofh-boat-alert-btn:hover { background: rgba(20, 184, 166, 0.32); }
      #${BOAT_ALERT_CONTAINER_ID} .ofh-boat-alert-close { padding: 6px 8px; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureBoatAlertContainer() {
    ensureBoatAlertStyles();
    let container = document.getElementById(BOAT_ALERT_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = BOAT_ALERT_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function dismissIncomingBoatAlert(boatId) {
    const timer = boatAlertTimers.get(boatId);
    if (timer != null) {
      clearTimeout(timer);
      boatAlertTimers.delete(boatId);
    }
    const container = document.getElementById(BOAT_ALERT_CONTAINER_ID);
    if (container) {
      for (const el of Array.from(container.children)) {
        if (el.dataset && el.dataset.boatId === boatId) {
          el.remove();
        }
      }
    }
  }

  function clearAllIncomingBoatAlerts() {
    for (const timer of boatAlertTimers.values()) {
      clearTimeout(timer);
    }
    boatAlertTimers.clear();
    const container = document.getElementById(BOAT_ALERT_CONTAINER_ID);
    if (container) {
      container.replaceChildren();
    }
  }

  // Pan the camera to a boat via the game's own events-display HUD (same hook the
  // game uses for "go to unit"). Best-effort; silently no-ops if unavailable.
  function focusIncomingBoat(unit) {
    try {
      const eventsDisplay = document.querySelector("events-display");
      if (unit && eventsDisplay && typeof eventsDisplay.emitGoToUnitEvent === "function") {
        eventsDisplay.emitGoToUnitEvent(unit);
      }
    } catch (_error) {
      // ignore
    }
  }

  function showIncomingBoatAlert(transport) {
    const container = ensureBoatAlertContainer();
    dismissIncomingBoatAlert(transport.domUnitId); // re-arm if somehow present

    const alert = document.createElement("div");
    alert.className = "ofh-boat-alert";
    alert.dataset.boatId = transport.domUnitId;
    alert.style.setProperty("--boat-accent", transport.color);

    const icon = document.createElement("div");
    icon.className = "ofh-boat-alert-icon";
    icon.textContent = "🚤";

    const body = document.createElement("div");
    body.className = "ofh-boat-alert-body";
    const title = document.createElement("span");
    title.className = "ofh-boat-alert-title";
    title.textContent = tr("⚠ Incoming boat");
    const msg = document.createElement("span");
    msg.className = "ofh-boat-alert-msg";
    const who = document.createElement("span");
    who.className = "ofh-boat-alert-who";
    who.textContent = transport.ownerName || "—";
    msg.append(who, document.createTextNode(" " + tr("is landing in your territory!")));
    body.append(title, msg);

    const actions = document.createElement("div");
    actions.className = "ofh-boat-alert-actions";
    const focusBtn = document.createElement("button");
    focusBtn.type = "button";
    focusBtn.className = "ofh-boat-alert-btn";
    focusBtn.textContent = "🎯 " + tr("Focus");
    focusBtn.addEventListener("click", () => focusIncomingBoat(transport.unit));
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "ofh-boat-alert-btn ofh-boat-alert-close";
    closeBtn.textContent = "✕";
    closeBtn.title = tr("Close");
    closeBtn.addEventListener("click", () => dismissIncomingBoatAlert(transport.domUnitId));
    actions.append(focusBtn, closeBtn);

    alert.append(icon, body, actions);
    container.appendChild(alert);

    const timer = setTimeout(() => dismissIncomingBoatAlert(transport.domUnitId), BOAT_ALERT_MS);
    boatAlertTimers.set(transport.domUnitId, timer);
  }

  // Called once per scan (~1s) from syncBoatPrediction. First pass after enabling
  // primes the "seen" set without alerting, so boats already incoming at that
  // moment don't all fire at once.
  function maybeWarnNewIncomingBoats(transports) {
    if (!boatWarnIncoming) {
      return;
    }
    const current = new Set();
    for (const transport of transports) {
      if (transport.relation === "self" || !transport.targetsMyTerritory) {
        continue;
      }
      try {
        if (!transport.unit?.isActive?.()) {
          continue;
        }
      } catch (_error) {
        continue;
      }
      current.add(transport.domUnitId);
      if (boatIncomingWarnInit && !boatIncomingSeen.has(transport.domUnitId)) {
        showIncomingBoatAlert(transport);
      }
    }
    boatIncomingSeen = current; // also prunes ids that are gone
    boatIncomingWarnInit = true;
  }

  // Re-prime detection without alerting (called when the game context is lost,
  // i.e. between matches in the same session, so a new match seeds cleanly).
  function resetIncomingBoatWarningBaseline() {
    boatIncomingSeen = new Set();
    boatIncomingWarnInit = false;
  }

  function setBoatIncomingWarningEnabled(enabled) {
    const next = Boolean(enabled);
    const changed = next !== boatWarnIncoming;
    boatWarnIncoming = next;
    if (changed) {
      // Re-prime detection on any real toggle: on enable the next scan seeds
      // silently; on disable drop open alerts.
      boatIncomingSeen = new Set();
      boatIncomingWarnInit = false;
      if (!next) {
        clearAllIncomingBoatAlerts();
      }
    }
    // The warning keeps the scan loop alive by itself (see isBoatOverlayActive).
    refreshBoatOverlayActivity();
  }
