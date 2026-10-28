// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/team-build-stats.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Draggable, position-persisting team build-stats panel.
//
// Lists, per team, how many of each structure type exist (City / Port /
// Factory / Defense Post / SAM Launcher / Missile Silo) and raises a warning
// the first time a team's Missile Silo count crosses 0 -> >=1 (their first
// silo = nuke capability).
//
// OpenFront runs the full simulation on every client (server only relays
// intents), so there is NO unit-hiding fog of war: every team's structures
// appear in game.units() the instant they are placed — including while still
// under construction. Counts are therefore stable, so the 0->1 alert cannot
// spuriously re-fire from a unit blinking in/out of view; the only re-fire
// path is a genuine destroy-then-rebuild, which is intended.
//
// IMPORTANT (shared lexical scope): every page-bridge classic script shares ONE
// global scope. Top-level identifiers MUST be unique across the bundle — do NOT
// redeclare names from sibling modules (e.g. `UNIT` in auto-bot/core.js). All
// top-level names here are prefixed TEAM_BUILD_/teamBuild and the structure
// type strings are inlined literals (canonical src/core/game/Game.ts UnitType).

  const TEAM_BUILD_PANEL_ID = "openfront-helper-team-build-stats";
  const TEAM_BUILD_STYLE_ID = "openfront-helper-team-build-stats-styles";
  const TEAM_BUILD_POS_KEY = "openfront-helper-team-build-stats-pos";
  const TEAM_BUILD_ALERT_CONTAINER_ID = "openfront-helper-team-build-alert";
  const TEAM_BUILD_SILO_TYPE = "Missile Silo";
  // In-panel warning chip stays lit for this long after a team's first silo.
  const TEAM_BUILD_WARN_MS = 9000;
  // The big center-screen urgent alert auto-dismisses after this long.
  const TEAM_BUILD_ALERT_MS = 15000;

  // Columns, in display order. `type` is the canonical UnitType string the
  // client GameView indexes units by; `emoji` is the glyph shown when no icon
  // resolves.
  const TEAM_BUILD_STRUCTURES = [
    { type: "City", emoji: "🏙️", label: "City" },
    { type: "Port", emoji: "⚓", label: "Port" },
    { type: "Factory", emoji: "🏭", label: "Factory" },
    { type: "Defense Post", emoji: "🛡️", label: "Defense Post" },
    { type: "SAM Launcher", emoji: "🛰️", label: "SAM Launcher" },
    { type: "Missile Silo", emoji: "🚀", label: "Missile Silo" },
  ];

  // Economy columns appended after the structure columns (merged-in team
  // gold-per-minute, plus owned territory and max troop capacity).
  const TEAM_BUILD_STAT_COLUMNS = [
    { key: "gpm", glyph: "💰", label: "Gold per minute" },
    { key: "owned", glyph: "🗺️", label: "Owned (% of map)" },
    { key: "maxTroops", glyph: "⚔️", label: "Max troops" },
  ];

  function formatTeamBuildCount(value) {
    const v = Number(value) || 0;
    if (v >= 1_000_000) {
      return `${(v / 1_000_000).toFixed(1)}M`;
    }
    if (v >= 1_000) {
      return `${(v / 1_000).toFixed(1)}K`;
    }
    return String(Math.round(v));
  }

  // Compact GPM for the narrow column — no "/min" suffix (the 💰 header implies
  // it); keeps the sign for net-negative income.
  function formatTeamBuildGpm(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "—";
    }
    const sign = value < 0 ? "-" : "";
    const v = Math.abs(value);
    if (v >= 1_000_000) {
      return `${sign}${(v / 1_000_000).toFixed(1)}M`;
    }
    if (v >= 1_000) {
      return `${sign}${(v / 1_000).toFixed(1)}K`;
    }
    return `${sign}${Math.round(v)}`;
  }

  // Owned territory as a % of the conquerable map — matching the game's own
  // team-stats: denominator = land tiles MINUS fallout (nuked) tiles.
  function formatTeamBuildOwned(ownedTiles, game) {
    let total = 0;
    try {
      total =
        (Number(game?.numLandTiles?.()) || 0) -
        (Number(game?.numTilesWithFallout?.()) || 0);
    } catch (_error) {
      total = 0;
    }
    if (total <= 0) {
      return "—";
    }
    const pct = ((Number(ownedTiles) || 0) / total) * 100;
    return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
  }

  function teamBuildIconUrl(structure) {
    // Resolve the unit icon from the game's live asset manifest (set by the
    // shell via window.__OFH_gameIconUrl). Empty string → emoji fallback.
    return (
      (typeof window.__OFH_gameIconUrl === "function" &&
        window.__OFH_gameIconUrl(structure.type)) ||
      ""
    );
  }

  // A column-header glyph: the game SVG icon when available (falling back to the
  // emoji on load error), otherwise the emoji directly.
  function makeTeamBuildHeadGlyph(structure) {
    const url = teamBuildIconUrl(structure);
    if (!url) {
      const span = document.createElement("span");
      span.textContent = structure.emoji;
      return span;
    }
    const img = document.createElement("img");
    img.className = "openfront-helper-tbs-icon";
    img.src = url;
    img.alt = structure.label;
    img.draggable = false;
    img.addEventListener(
      "error",
      () => {
        const span = document.createElement("span");
        span.textContent = structure.emoji;
        img.replaceWith(span);
      },
      { once: true },
    );
    return img;
  }

  let teamBuildStatsEnabled = false;
  // Click-to-sort state. null key = default (silo desc, then total desc). dir: 1
  // = descending, -1 = ascending. Clicking a header sets its key; clicking the
  // active header again flips the direction.
  let teamBuildSortKey = null;
  let teamBuildSortDir = 1;
  // team name -> last seen visible silo count (for 0 -> >=1 edge detection).
  const teamBuildPrevSiloCounts = new Map();
  // team name -> warning expiry timestamp (ms).
  const teamBuildSiloWarnings = new Map();
  // team name -> auto-dismiss timeout id for its big center-screen alert.
  const teamBuildAlertTimers = new Map();
  // Pre-existing silos at enable time must NOT fire a warning; seed first.
  let teamBuildSeeded = false;
  // Identity of the game we seeded against; a new game resets all state.
  let teamBuildGameRef = null;
  let teamBuildRenderSignature = "";

  function ensureTeamBuildStatsStyles() {
    if (document.getElementById(TEAM_BUILD_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = TEAM_BUILD_STYLE_ID;
    style.textContent = `
      #${TEAM_BUILD_PANEL_ID} {
        position: fixed;
        top: var(--team-build-top, 96px);
        left: var(--team-build-left, 12px);
        z-index: 9000;
        display: none;
        width: max-content;
        max-width: min(440px, calc(100vw - 16px));
        min-width: 200px;
        min-height: 100px;
        padding: 6px 7px 7px;
        border: 1px solid rgba(148, 163, 184, 0.34);
        border-radius: 8px;
        background: rgba(12, 18, 20, 0.92);
        color: #e2e8f0;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.1;
        box-shadow:
          0 10px 26px rgba(0, 0, 0, 0.4),
          0 0 16px rgba(148, 163, 184, 0.1);
        pointer-events: auto;
        user-select: none;
        resize: both;
        overflow: auto;
      }

      #${TEAM_BUILD_PANEL_ID}[data-visible="true"] {
        display: block;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 5px;
        cursor: grab;
        touch-action: none;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-header:active {
        cursor: grabbing;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-title {
        color: rgba(226, 232, 240, 0.82);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        white-space: nowrap;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-drag {
        color: rgba(148, 163, 184, 0.55);
        font-size: 11px;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-warn {
        display: none;
        margin-bottom: 5px;
        padding: 4px 6px;
        border: 1px solid rgba(248, 113, 113, 0.7);
        border-radius: 6px;
        background: rgba(69, 10, 10, 0.85);
        color: #fecaca;
        font-size: 10.5px;
        font-weight: 800;
        white-space: normal;
        animation: openfront-helper-tbs-pulse 1.05s ease-in-out infinite;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-warn[data-active="true"] {
        display: block;
      }

      @keyframes openfront-helper-tbs-pulse {
        0%, 100% {
          border-color: rgba(248, 113, 113, 0.7);
          box-shadow: 0 0 0 rgba(248, 113, 113, 0);
        }
        50% {
          border-color: rgba(248, 113, 113, 1);
          box-shadow: 0 0 10px rgba(248, 113, 113, 0.55);
        }
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-grid {
        display: grid;
        grid-template-columns: minmax(46px, 1fr) 34px repeat(${TEAM_BUILD_STRUCTURES.length}, 26px) repeat(${TEAM_BUILD_STAT_COLUMNS.length}, 46px);
        gap: 2px 4px;
        align-items: center;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-cell {
        text-align: center;
        font-variant-numeric: tabular-nums;
      }

      /* Economy columns: a touch wider, right-aligned, with a divider before
         them so they read apart from the structure counts. */
      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-stat {
        text-align: right;
        padding-left: 3px;
        font-size: 10px;
        white-space: nowrap;
      }
      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-stat-first {
        border-left: 1px solid rgba(148, 163, 184, 0.22);
        padding-left: 5px;
      }

      /* Click-to-sort headers. */
      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-sortable {
        cursor: pointer;
      }
      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-sortable:hover {
        color: #ffffff;
        filter: brightness(1.25);
      }
      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-sorted {
        color: #ffffff;
      }
      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-sort-arrow {
        margin-left: 1px;
        font-size: 8px;
        opacity: 0.95;
        vertical-align: middle;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-head {
        display: flex;
        align-items: center;
        justify-content: center;
        padding-bottom: 3px;
        color: rgba(203, 213, 225, 0.85);
        font-size: 11px;
        line-height: 1;
        border-bottom: 1px solid rgba(148, 163, 184, 0.22);
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-icon {
        width: 14px;
        height: 14px;
        object-fit: contain;
        /* Game icons ship as black-fill SVGs; invert to white for the dark panel. */
        filter: brightness(0) invert(1);
        opacity: 0.92;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-head.openfront-helper-tbs-silo {
        color: #fca5a5;
      }

      /* Tint the silo column's icon red to match its warning emphasis. */
      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-head.openfront-helper-tbs-silo .openfront-helper-tbs-icon {
        filter: brightness(0) saturate(100%) invert(67%) sepia(38%) saturate(1352%) hue-rotate(305deg) brightness(101%) contrast(98%);
        opacity: 1;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-total {
        color: #fcd34d;
        font-weight: 800;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-name {
        overflow: hidden;
        padding-right: 2px;
        color: var(--team-accent-color, #cbd5e1);
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
        border-left: 3px solid var(--team-accent-color, rgba(148, 163, 184, 0.6));
        padding-left: 5px;
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-value {
        color: rgba(226, 232, 240, 0.92);
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-value.openfront-helper-tbs-zero {
        color: rgba(148, 163, 184, 0.4);
      }

      #${TEAM_BUILD_PANEL_ID} .openfront-helper-tbs-value.openfront-helper-tbs-silo-has {
        color: #fca5a5;
        font-weight: 800;
        text-shadow: 0 0 6px rgba(248, 113, 113, 0.45);
      }

      /* ── Big center-screen urgent silo alert ─────────────────────────── */
      #${TEAM_BUILD_ALERT_CONTAINER_ID} {
        position: fixed;
        top: 22%;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9000;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        width: max-content;
        max-width: min(560px, calc(100vw - 24px));
        /* Container is pass-through; each alert card re-enables its own events. */
        pointer-events: none;
      }

      #${TEAM_BUILD_ALERT_CONTAINER_ID} .openfront-helper-tbs-alert {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 14px 18px;
        border: 2px solid rgba(248, 113, 113, 0.95);
        border-radius: 12px;
        background: linear-gradient(180deg, rgba(60, 9, 9, 0.96), rgba(30, 6, 6, 0.96));
        color: #fee2e2;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        box-shadow:
          0 18px 50px rgba(0, 0, 0, 0.55),
          0 0 30px rgba(248, 113, 113, 0.5);
        animation:
          openfront-helper-tbs-alert-in 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2),
          openfront-helper-tbs-alert-glow 1.15s ease-in-out infinite;
      }

      @keyframes openfront-helper-tbs-alert-in {
        from { opacity: 0; transform: translateY(-14px) scale(0.94); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes openfront-helper-tbs-alert-glow {
        0%, 100% { box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 0 22px rgba(248, 113, 113, 0.35); }
        50% { box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 0 40px rgba(248, 113, 113, 0.85); }
      }

      #${TEAM_BUILD_ALERT_CONTAINER_ID} .openfront-helper-tbs-alert-icon {
        flex: 0 0 auto;
        width: 38px;
        height: 38px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 30px;
        line-height: 1;
        animation: openfront-helper-tbs-alert-shake 0.9s ease-in-out infinite;
      }

      @keyframes openfront-helper-tbs-alert-shake {
        0%, 100% { transform: rotate(-9deg); }
        50% { transform: rotate(9deg); }
      }

      #${TEAM_BUILD_ALERT_CONTAINER_ID} .openfront-helper-tbs-alert-body {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      #${TEAM_BUILD_ALERT_CONTAINER_ID} .openfront-helper-tbs-alert-title {
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #fca5a5;
      }

      #${TEAM_BUILD_ALERT_CONTAINER_ID} .openfront-helper-tbs-alert-msg {
        font-size: 16px;
        font-weight: 800;
        line-height: 1.2;
      }

      #${TEAM_BUILD_ALERT_CONTAINER_ID} .openfront-helper-tbs-alert-team {
        color: var(--team-accent-color, #fee2e2);
        text-shadow: 0 0 8px rgba(0, 0, 0, 0.6);
      }

      #${TEAM_BUILD_ALERT_CONTAINER_ID} .openfront-helper-tbs-alert-actions {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: 6px;
      }

      #${TEAM_BUILD_ALERT_CONTAINER_ID} .openfront-helper-tbs-alert-focus {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 8px 13px;
        border: 1px solid rgba(248, 250, 252, 0.5);
        border-radius: 8px;
        background: rgba(248, 113, 113, 0.92);
        color: #450a0a;
        font-size: 13px;
        font-weight: 800;
        cursor: pointer;
        white-space: nowrap;
      }

      #${TEAM_BUILD_ALERT_CONTAINER_ID} .openfront-helper-tbs-alert-focus:hover {
        background: #fecaca;
      }

      #${TEAM_BUILD_ALERT_CONTAINER_ID} .openfront-helper-tbs-alert-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border: 1px solid rgba(248, 250, 252, 0.25);
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.5);
        color: #fecaca;
        font-size: 14px;
        font-weight: 800;
        cursor: pointer;
      }

      #${TEAM_BUILD_ALERT_CONTAINER_ID} .openfront-helper-tbs-alert-close:hover {
        background: rgba(248, 113, 113, 0.3);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureTeamBuildAlertContainer() {
    ensureTeamBuildStatsStyles();
    let container = document.getElementById(TEAM_BUILD_ALERT_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = TEAM_BUILD_ALERT_CONTAINER_ID;
      container.setAttribute("aria-live", "assertive");
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  // Pan the game camera to the silo. Preferred path: the events-display HUD
  // component's public emitGoToUnitEvent(unit) (uses the game's own eventBus,
  // no constructor juggling). Falls back to focusing the silo's owner.
  function focusTeamBuildSilo(siloUnit, ownerSmallId) {
    const eventsDisplay = document.querySelector("events-display");
    try {
      if (siloUnit && eventsDisplay && typeof eventsDisplay.emitGoToUnitEvent === "function") {
        eventsDisplay.emitGoToUnitEvent(siloUnit);
        return true;
      }
    } catch (_error) {
      // Fall through to the owner-focus fallback.
    }
    try {
      const target =
        document.querySelector("actionable-events") ||
        eventsDisplay ||
        document.querySelector("events-display");
      if (
        target &&
        typeof target.emitGoToPlayerEvent === "function" &&
        Number.isFinite(Number(ownerSmallId))
      ) {
        target.emitGoToPlayerEvent(Number(ownerSmallId));
        return true;
      }
    } catch (_error) {
      // Nothing else to try.
    }
    return false;
  }

  function dismissTeamBuildSiloAlert(team) {
    const timer = teamBuildAlertTimers.get(team);
    if (timer != null) {
      clearTimeout(timer);
      teamBuildAlertTimers.delete(team);
    }
    const container = document.getElementById(TEAM_BUILD_ALERT_CONTAINER_ID);
    if (container) {
      // Match by dataset in JS rather than a CSS attribute selector so arbitrary
      // team names (quotes, spaces) need no escaping.
      for (const el of Array.from(container.children)) {
        if (el.dataset && el.dataset.team === team) {
          el.remove();
        }
      }
    }
  }

  function clearAllTeamBuildSiloAlerts() {
    for (const timer of teamBuildAlertTimers.values()) {
      clearTimeout(timer);
    }
    teamBuildAlertTimers.clear();
    const container = document.getElementById(TEAM_BUILD_ALERT_CONTAINER_ID);
    if (container) {
      container.replaceChildren();
    }
  }

  function showTeamBuildSiloAlert(team, color, siloUnit, ownerSmallId) {
    const container = ensureTeamBuildAlertContainer();
    // One alert per team at a time — replace any existing one (re-arms timer).
    dismissTeamBuildSiloAlert(team);

    const alert = document.createElement("div");
    alert.className = "openfront-helper-tbs-alert";
    alert.dataset.team = team;
    alert.style.setProperty("--team-accent-color", color);

    const icon = document.createElement("div");
    icon.className = "openfront-helper-tbs-alert-icon";
    icon.textContent = "🚨";

    const body = document.createElement("div");
    body.className = "openfront-helper-tbs-alert-body";
    const title = document.createElement("span");
    title.className = "openfront-helper-tbs-alert-title";
    title.textContent = tr("⚠ Missile Silo warning");
    const msg = document.createElement("span");
    msg.className = "openfront-helper-tbs-alert-msg";
    const teamSpan = document.createElement("span");
    teamSpan.className = "openfront-helper-tbs-alert-team";
    teamSpan.textContent = team;
    msg.append(
      teamSpan,
      document.createTextNode(" " + tr("just built its first Missile Silo!")),
    );
    body.append(title, msg);

    const actions = document.createElement("div");
    actions.className = "openfront-helper-tbs-alert-actions";
    const focusBtn = document.createElement("button");
    focusBtn.type = "button";
    focusBtn.className = "openfront-helper-tbs-alert-focus";
    focusBtn.textContent = "🎯 " + tr("Focus");
    focusBtn.title = tr("Move camera to the silo");
    focusBtn.addEventListener("click", () => {
      focusTeamBuildSilo(siloUnit, ownerSmallId);
    });
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "openfront-helper-tbs-alert-close";
    closeBtn.textContent = "✕";
    closeBtn.title = tr("Close");
    closeBtn.addEventListener("click", () => {
      dismissTeamBuildSiloAlert(team);
    });
    actions.append(focusBtn, closeBtn);

    alert.append(icon, body, actions);
    container.appendChild(alert);

    const timer = setTimeout(() => {
      dismissTeamBuildSiloAlert(team);
    }, TEAM_BUILD_ALERT_MS);
    teamBuildAlertTimers.set(team, timer);
  }

  function ensureTeamBuildStatsPanel() {
    ensureTeamBuildStatsStyles();

    let panel = document.getElementById(TEAM_BUILD_PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = TEAM_BUILD_PANEL_ID;
      panel.setAttribute("aria-hidden", "true");

      const header = document.createElement("div");
      header.className = "openfront-helper-tbs-header";
      const title = document.createElement("span");
      title.className = "openfront-helper-tbs-title";
      title.textContent = "⚒ " + tr("Team build");
      const grip = document.createElement("span");
      grip.className = "openfront-helper-tbs-drag";
      grip.textContent = "⠿";
      header.append(title, grip);

      const warn = document.createElement("div");
      warn.className = "openfront-helper-tbs-warn";

      const grid = document.createElement("div");
      grid.className = "openfront-helper-tbs-grid";

      panel.append(header, warn, grid);
      (document.body || document.documentElement).appendChild(panel);

      makeTeamBuildStatsDraggable(panel, header);
      applyStoredTeamBuildStatsPosition(panel);
      applyStoredTeamBuildStatsSize(panel);
      if (window.ResizeObserver) {
        new ResizeObserver(() => saveTeamBuildStatsSize(panel)).observe(panel);
      }
    }
    return panel;
  }

  function applyStoredTeamBuildStatsSize(panel) {
    try {
      var s = JSON.parse(window.localStorage.getItem(TEAM_BUILD_POS_KEY + ":size") || "null");
      if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) {
        panel.style.width = s.w + "px";
        panel.style.height = s.h + "px";
      }
    } catch (_e) {}
  }
  function saveTeamBuildStatsSize(panel) {
    var w = parseInt(panel.style.width, 10);
    var h = parseInt(panel.style.height, 10);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    try {
      window.localStorage.setItem(TEAM_BUILD_POS_KEY + ":size", JSON.stringify({ w: w, h: h }));
    } catch (_e) {}
  }

  function applyStoredTeamBuildStatsPosition(panel) {
    let pos = null;
    try {
      pos = JSON.parse(window.localStorage.getItem(TEAM_BUILD_POS_KEY) || "null");
    } catch (_error) {
      pos = null;
    }
    if (!pos || !Number.isFinite(pos.left) || !Number.isFinite(pos.top)) {
      return;
    }
    panel.style.setProperty(
      "--team-build-left",
      `${Math.max(0, Math.min(pos.left, window.innerWidth - 60))}px`,
    );
    panel.style.setProperty(
      "--team-build-top",
      `${Math.max(0, Math.min(pos.top, window.innerHeight - 30))}px`,
    );
  }

  function makeTeamBuildStatsDraggable(panel, handle) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;

    function onMove(event) {
      if (!dragging) {
        return;
      }
      const left = Math.max(
        0,
        Math.min(originLeft + (event.clientX - startX), window.innerWidth - 60),
      );
      const top = Math.max(
        0,
        Math.min(originTop + (event.clientY - startY), window.innerHeight - 30),
      );
      panel.style.setProperty("--team-build-left", `${left}px`);
      panel.style.setProperty("--team-build-top", `${top}px`);
    }

    function onUp() {
      if (!dragging) {
        return;
      }
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        window.localStorage.setItem(
          TEAM_BUILD_POS_KEY,
          JSON.stringify({
            left: parseInt(panel.style.getPropertyValue("--team-build-left"), 10),
            top: parseInt(panel.style.getPropertyValue("--team-build-top"), 10),
          }),
        );
      } catch (_error) {
        // Best-effort — the panel stays where dragged for this session regardless.
      }
    }

    handle.addEventListener("pointerdown", (event) => {
      dragging = true;
      const rect = panel.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      startX = event.clientX;
      startY = event.clientY;
      panel.style.setProperty("--team-build-left", `${originLeft}px`);
      panel.style.setProperty("--team-build-top", `${originTop}px`);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      event.preventDefault();
    });
  }

  // Build one row per real team: {team, color, counts:{<type>:n}, total, silo}.
  // Mirrors team-gold-per-minute's filtering: skip players with no team and the
  // literal "Bot" faction. Counts cover every team (no fog hides units). The
  // displayed counts are the SUM OF LEVELS excluding under-construction units
  // (matching the game's stats), while `silo` is a building count that DOES
  // include under-construction silos so the alert can fire as early as possible.
  function getTeamBuildRows(game) {
    const structureTypes = TEAM_BUILD_STRUCTURES.map((s) => s.type);
    let units = [];
    try {
      units = game.units(...structureTypes) || [];
    } catch (_error) {
      units = [];
    }

    // smallID -> team name, resolved once from the cached player views so we do
    // not call unit.owner() (a map lookup) more than necessary. aliveTeams is
    // every team with at least one living player — used to seed empty rows so
    // the panel shows all teams from the very start of the game (at 0), rather
    // than waiting for the first structure to be built.
    const teamBySmallId = new Map();
    const aliveTeams = new Set();
    // Per-team economy aggregates, accumulated in this same player loop so the
    // GPM tracker key (fallbackIndex) matches gold-per-minute.js exactly.
    const teamStatAcc = new Map(); // team -> {owned, maxTroops, gpmTotal, gpmTracked}
    const players = getCachedPlayerViews(game);
    let config = null;
    try {
      config = game.config?.();
    } catch (_error) {
      config = null;
    }
    let index = 0;
    for (const player of players) {
      const team = getPlayerTeamName(player);
      const smallId = getPlayerSmallId(player, index);
      if (team && team !== "Bot") {
        teamBySmallId.set(smallId, team);
        let alive = false;
        try {
          alive = Boolean(player?.isAlive?.());
        } catch (_error) {
          alive = false;
        }
        if (alive) {
          aliveTeams.add(team);
          let acc = teamStatAcc.get(team);
          if (!acc) {
            acc = { owned: 0, maxTroops: 0, gpmTotal: 0, gpmTracked: 0 };
            teamStatAcc.set(team, acc);
          }
          try {
            acc.owned += Number(player.numTilesOwned?.()) || 0;
          } catch (_error) {
            // ignore
          }
          try {
            // Troops are stored at 10x and shown /10 in-game (renderTroops).
            if (config?.maxTroops) {
              acc.maxTroops += (Number(config.maxTroops(player)) || 0) / 10;
            }
          } catch (_error) {
            // ignore
          }
          // getGoldPerMinuteForPlayer is provided by gold-per-minute.js (shared
          // scope); needs the sampler running — updateTeamBuildStatsPanel pumps it.
          const gpm = getGoldPerMinuteForPlayer(player, index);
          if (Number.isFinite(gpm)) {
            acc.gpmTotal += gpm;
            acc.gpmTracked += 1;
          }
        }
      }
      index += 1;
    }

    const teams = new Map();
    function ensureTeamEntry(team) {
      let entry = teams.get(team);
      if (!entry) {
        entry = {
          team,
          total: 0,
          silo: 0,
          siloUnit: null,
          siloOwnerSmallId: NaN,
          counts: {},
          owned: 0,
          maxTroops: 0,
          gpm: null,
        };
        for (const s of TEAM_BUILD_STRUCTURES) {
          entry.counts[s.type] = 0;
        }
        teams.set(team, entry);
      }
      return entry;
    }

    // Seed every living team up front (all counts 0) so the panel is populated
    // immediately on game start; structure counts then fill in as they appear.
    for (const team of aliveTeams) {
      ensureTeamEntry(team);
    }

    for (const unit of units) {
      let smallId = NaN;
      try {
        smallId = Number(unit.owner?.()?.smallID?.());
      } catch (_error) {
        continue;
      }
      const team = teamBySmallId.get(smallId);
      if (!team) {
        continue;
      }
      let type = null;
      try {
        type = unit.type?.();
      } catch (_error) {
        type = null;
      }
      const entry = ensureTeamEntry(team);
      if (type == null || !(type in entry.counts)) {
        continue;
      }
      // Structures are upgradable, so the game reports counts as the SUM OF
      // LEVELS excluding units still under construction (PlayerView.totalUnitLevels).
      // A team with 3 silos upgraded to total level 7 shows "7" — matching the
      // game's own UnitDisplay / team-stats panels, not the raw building count.
      let underConstruction = false;
      try {
        underConstruction = Boolean(unit.isUnderConstruction?.());
      } catch (_error) {
        underConstruction = false;
      }
      if (!underConstruction) {
        let level = 1;
        try {
          const lv = Number(unit.level?.());
          if (Number.isFinite(lv) && lv > 0) {
            level = lv;
          }
        } catch (_error) {
          level = 1;
        }
        entry.counts[type] += level;
        entry.total += level;
      }
      if (type === TEAM_BUILD_SILO_TYPE) {
        // The silo ALERT deliberately stays building-based and includes ones
        // still under construction, so a team is flagged the moment it STARTS a
        // silo — earliest possible warning, independent of the level-based
        // display count above.
        entry.silo += 1;
        // Remember one silo unit (+ owner) so the alert's Focus button can pan
        // the camera straight to it. Prefer a finished silo over one still under
        // construction, but keep any silo as a fallback.
        if (!entry.siloUnit || (!underConstruction && entry.siloUnderConstruction)) {
          entry.siloUnit = unit;
          entry.siloOwnerSmallId = smallId;
          entry.siloUnderConstruction = underConstruction;
        }
      }
    }

    // Fold the economy aggregates into each team entry (gpm = null when no
    // player has 2+ samples yet → renders as "tracking").
    for (const entry of teams.values()) {
      const acc = teamStatAcc.get(entry.team);
      if (acc) {
        entry.owned = acc.owned;
        entry.maxTroops = acc.maxTroops;
        entry.gpm = acc.gpmTracked > 0 ? acc.gpmTotal : null;
      }
    }

    return sortTeamBuildRows(Array.from(teams.values()));
  }

  function teamBuildRowSortValue(row, key) {
    switch (key) {
      case "total":
        return row.total;
      case "gpm":
        return Number.isFinite(row.gpm) ? row.gpm : -Infinity;
      case "owned":
        return row.owned;
      case "maxTroops":
        return row.maxTroops;
      default:
        return (row.counts && row.counts[key]) || 0; // a structure type
    }
  }

  function sortTeamBuildRows(rows) {
    if (!teamBuildSortKey) {
      // Default: most silos first, then most structures.
      return rows.sort((a, b) => b.silo - a.silo || b.total - a.total);
    }
    const key = teamBuildSortKey;
    const dir = teamBuildSortDir;
    return rows.sort((a, b) => {
      const av = teamBuildRowSortValue(a, key);
      const bv = teamBuildRowSortValue(b, key);
      if (av !== bv) {
        return dir === 1 ? bv - av : av - bv;
      }
      // Stable tie-break: more structures first, then team name.
      if (b.total !== a.total) {
        return b.total - a.total;
      }
      return String(a.team).localeCompare(String(b.team));
    });
  }

  function setTeamBuildSort(key) {
    if (teamBuildSortKey === key) {
      teamBuildSortDir = teamBuildSortDir === 1 ? -1 : 1;
    } else {
      teamBuildSortKey = key;
      teamBuildSortDir = 1;
    }
    updateTeamBuildStatsPanel();
  }

  function attachTeamBuildSort(headEl, key) {
    headEl.classList.add("openfront-helper-tbs-sortable");
    headEl.addEventListener("click", () => setTeamBuildSort(key));
    if (teamBuildSortKey === key) {
      headEl.classList.add("openfront-helper-tbs-sorted");
      const arrow = document.createElement("span");
      arrow.className = "openfront-helper-tbs-sort-arrow";
      arrow.textContent = teamBuildSortDir === 1 ? "▾" : "▴";
      headEl.appendChild(arrow);
    }
  }

  function getMyTeamName(game) {
    try {
      const myPlayer = game?.myPlayer?.();
      return getPlayerTeamName(myPlayer);
    } catch (_error) {
      return null;
    }
  }

  // Detect each team's first visible silo (0 -> >=1). Returns nothing; mutates
  // teamBuildSiloWarnings. Own team is tracked (to keep prev counts correct) but
  // never warned — you already know your own builds.
  function updateTeamBuildSiloWarnings(rows, myTeam, now, game) {
    const liveTeams = new Set();
    for (const row of rows) {
      liveTeams.add(row.team);
      const prev = teamBuildPrevSiloCounts.get(row.team) ?? 0;
      if (teamBuildSeeded && prev === 0 && row.silo > 0 && row.team !== myTeam) {
        teamBuildSiloWarnings.set(row.team, now + TEAM_BUILD_WARN_MS);
        // Fire the big center-screen alert with a Focus button on this team's
        // FIRST silo (0 -> >=1). Own team is excluded above — you build it.
        showTeamBuildSiloAlert(
          row.team,
          getTeamColor(row.team, game),
          row.siloUnit,
          row.siloOwnerSmallId,
        );
      }
      teamBuildPrevSiloCounts.set(row.team, row.silo);
    }

    // Drop teams that vanished (e.g. eliminated) so a re-used name can re-warn.
    for (const team of Array.from(teamBuildPrevSiloCounts.keys())) {
      if (!liveTeams.has(team)) {
        teamBuildPrevSiloCounts.delete(team);
      }
    }
    for (const [team, expiry] of Array.from(teamBuildSiloWarnings.entries())) {
      if (expiry <= now) {
        teamBuildSiloWarnings.delete(team);
      }
    }
  }

  function renderTeamBuildGrid(grid, rows, game) {
    const children = [];

    const corner = document.createElement("span");
    corner.className = "openfront-helper-tbs-cell openfront-helper-tbs-head";
    corner.textContent = "";
    children.push(corner);
    const totalHead = document.createElement("span");
    totalHead.className =
      "openfront-helper-tbs-cell openfront-helper-tbs-head openfront-helper-tbs-total";
    totalHead.textContent = "Σ";
    totalHead.title = tr("Total structures");
    attachTeamBuildSort(totalHead, "total");
    children.push(totalHead);
    for (const s of TEAM_BUILD_STRUCTURES) {
      const head = document.createElement("span");
      head.className = "openfront-helper-tbs-cell openfront-helper-tbs-head";
      if (s.type === TEAM_BUILD_SILO_TYPE) {
        head.classList.add("openfront-helper-tbs-silo");
      }
      head.append(makeTeamBuildHeadGlyph(s));
      head.title = s.label;
      attachTeamBuildSort(head, s.type);
      children.push(head);
    }
    // Economy columns (merged-in team gold-per-minute + territory + max troops).
    TEAM_BUILD_STAT_COLUMNS.forEach((stat, statIndex) => {
      const head = document.createElement("span");
      head.className =
        "openfront-helper-tbs-cell openfront-helper-tbs-head openfront-helper-tbs-stat";
      if (statIndex === 0) {
        head.classList.add("openfront-helper-tbs-stat-first");
      }
      head.textContent = stat.glyph;
      head.title = tr(stat.label);
      attachTeamBuildSort(head, stat.key);
      children.push(head);
    });

    for (const row of rows) {
      const color = getTeamColor(row.team, game);
      const name = document.createElement("span");
      name.className = "openfront-helper-tbs-cell openfront-helper-tbs-name";
      name.style.setProperty("--team-accent-color", color);
      name.textContent = row.team;
      name.title = `${row.team} · ${row.total} công trình`;
      children.push(name);

      const totalCell = document.createElement("span");
      totalCell.className =
        "openfront-helper-tbs-cell openfront-helper-tbs-value openfront-helper-tbs-total";
      totalCell.textContent = String(row.total);
      children.push(totalCell);

      for (const s of TEAM_BUILD_STRUCTURES) {
        const count = row.counts[s.type] || 0;
        const cell = document.createElement("span");
        cell.className = "openfront-helper-tbs-cell openfront-helper-tbs-value";
        if (count === 0) {
          cell.classList.add("openfront-helper-tbs-zero");
        } else if (s.type === TEAM_BUILD_SILO_TYPE) {
          cell.classList.add("openfront-helper-tbs-silo-has");
        }
        cell.textContent = String(count);
        children.push(cell);
      }

      const gpmCell = document.createElement("span");
      gpmCell.className =
        "openfront-helper-tbs-cell openfront-helper-tbs-value openfront-helper-tbs-stat openfront-helper-tbs-stat-first";
      gpmCell.textContent = formatTeamBuildGpm(row.gpm);
      children.push(gpmCell);

      const ownedCell = document.createElement("span");
      ownedCell.className =
        "openfront-helper-tbs-cell openfront-helper-tbs-value openfront-helper-tbs-stat";
      ownedCell.textContent = formatTeamBuildOwned(row.owned, game);
      children.push(ownedCell);

      const troopsCell = document.createElement("span");
      troopsCell.className =
        "openfront-helper-tbs-cell openfront-helper-tbs-value openfront-helper-tbs-stat";
      troopsCell.textContent = formatTeamBuildCount(row.maxTroops);
      children.push(troopsCell);
    }

    grid.replaceChildren(...children);
  }

  function hideTeamBuildStatsPanel(panel) {
    if (panel.dataset.visible !== "false") {
      panel.dataset.visible = "false";
      panel.setAttribute("aria-hidden", "true");
    }
    teamBuildRenderSignature = "";
  }

  function updateTeamBuildStatsPanel() {
    const panel = ensureTeamBuildStatsPanel();
    if (!teamBuildStatsEnabled) {
      hideTeamBuildStatsPanel(panel);
      return;
    }

    const context =
      typeof getOpenFrontGameContext === "function"
        ? getOpenFrontGameContext()
        : null;
    const game = context?.game;
    if (!game) {
      hideTeamBuildStatsPanel(panel);
      return;
    }

    // Keep the gold-per-minute sampler warm so the merged GPM column has data
    // even when the standalone GPM helpers are off. (gold-per-minute.js, shared
    // scope; getTeamBuildRows below reads the resulting trackers.)
    if (typeof sampleGoldPerMinuteIfDue === "function") {
      sampleGoldPerMinuteIfDue();
    }

    // A fresh game invalidates all warning/seed state.
    if (game !== teamBuildGameRef) {
      teamBuildGameRef = game;
      teamBuildPrevSiloCounts.clear();
      teamBuildSiloWarnings.clear();
      clearAllTeamBuildSiloAlerts();
      teamBuildSeeded = false;
    }

    const rows = getTeamBuildRows(game);
    if (rows.length === 0) {
      hideTeamBuildStatsPanel(panel);
      return;
    }

    const now = Date.now();
    const myTeam = getMyTeamName(game);

    if (!teamBuildSeeded) {
      // First render against this game: record existing silos WITHOUT warning.
      for (const row of rows) {
        teamBuildPrevSiloCounts.set(row.team, row.silo);
      }
      teamBuildSeeded = true;
    } else {
      updateTeamBuildSiloWarnings(rows, myTeam, now, game);
    }

    const warnTeams = rows
      .filter((row) => teamBuildSiloWarnings.has(row.team))
      .map((row) => row.team);

    const signature =
      `sort:${teamBuildSortKey || ""}:${teamBuildSortDir};` +
      rows
        .map((row) => {
          const counts = TEAM_BUILD_STRUCTURES.map(
            (s) => row.counts[s.type] || 0,
          ).join(",");
          const gpm = row.gpm == null ? "" : Math.round(row.gpm);
          return `${row.team}|${getTeamColor(row.team, game)}|${counts}|${gpm}|${row.owned}|${row.maxTroops}`;
        })
        .join(";") + `#warn:${warnTeams.join(",")}`;

    if (teamBuildRenderSignature !== signature) {
      teamBuildRenderSignature = signature;

      const grid = panel.querySelector(".openfront-helper-tbs-grid");
      if (grid) {
        renderTeamBuildGrid(grid, rows, game);
      }

      const warn = panel.querySelector(".openfront-helper-tbs-warn");
      if (warn) {
        if (warnTeams.length > 0) {
          warn.textContent = tr("⚠ First silo: {teams}", { teams: warnTeams.join(", ") });
          warn.dataset.active = "true";
        } else {
          warn.dataset.active = "false";
          warn.textContent = "";
        }
      }
    }

    if (panel.dataset.visible !== "true") {
      panel.dataset.visible = "true";
      panel.setAttribute("aria-hidden", "false");
    }
  }

  function setTeamBuildStatsEnabled(enabled) {
    teamBuildStatsEnabled = Boolean(enabled);
    if (!teamBuildStatsEnabled) {
      unregisterHelperTickListener(updateTeamBuildStatsPanel);
      teamBuildPrevSiloCounts.clear();
      teamBuildSiloWarnings.clear();
      clearAllTeamBuildSiloAlerts();
      teamBuildSeeded = false;
      teamBuildGameRef = null;
      teamBuildRenderSignature = "";
      const panel = document.getElementById(TEAM_BUILD_PANEL_ID);
      if (panel) {
        panel.dataset.visible = "false";
        panel.setAttribute("aria-hidden", "true");
      }
      return;
    }

    registerHelperTickListener(updateTeamBuildStatsPanel);
  }
