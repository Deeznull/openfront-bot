// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/estate-panel.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Estates panel: lists each separate parcel of land you own — a "parcel" is a
// connected component of your owned tiles (orthogonally adjacent via the game's
// neighbours). A lone tile (e.g. a boat landing isolated in the wild) counts as
// its own parcel. Click a column to sort, click a row to pan the camera there.
//
// Seeds come from player.borderTiles() (async worker call); the flood-fill that
// counts each component is client-side & synchronous (game.neighbors / ownerID).
// Recomputed on a throttle while the panel is open, never per frame.

  const ESTATE_PANEL_ID = "openfront-helper-estate-panel";
  const ESTATE_PANEL_STYLE_ID = "openfront-helper-estate-panel-styles";
  const ESTATE_PANEL_POS_KEY = "openfrontHelperEstatePanelPos";
  const ESTATE_COMPUTE_MS = 2500;

  let estatePanelOpen = false;
  let estateSortDir = 1; // 1 = most tiles first, -1 = fewest first
  let estateData = []; // [{ key, tiles, cx, cy }]
  let estateComputing = false;
  let estateIntervalId = null;
  const estateRowCache = new Map(); // key -> { row, cells:{rank,tiles} }

  function ensureEstatePanelStyles() {
    if (document.getElementById(ESTATE_PANEL_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = ESTATE_PANEL_STYLE_ID;
    style.textContent = `
      #${ESTATE_PANEL_ID} {
        position: fixed;
        right: 14px;
        top: 770px;
        z-index: 9000;
        display: none;
        flex-direction: column;
        width: 178px;
        height: 240px;
        min-width: 140px;
        min-height: 110px;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        resize: both;
        overflow: hidden;
        border: 1px solid rgba(148, 163, 184, 0.34);
        border-radius: 8px;
        background: rgba(12, 18, 20, 0.95);
        color: #e2e8f0;
        font: 700 11px/1.15 "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        box-shadow: 0 10px 26px rgba(0, 0, 0, 0.4), 0 0 16px rgba(148, 163, 184, 0.1);
        pointer-events: auto;
      }
      #${ESTATE_PANEL_ID}[data-visible="true"] { display: flex; }

      #${ESTATE_PANEL_ID} .est-header {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        cursor: grab;
        touch-action: none;
      }
      #${ESTATE_PANEL_ID} .est-header:active { cursor: grabbing; }
      #${ESTATE_PANEL_ID} .est-title {
        flex: 1;
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        color: rgba(226, 232, 240, 0.85);
      }
      #${ESTATE_PANEL_ID} .est-count {
        font-size: 10px;
        font-weight: 900;
        color: rgba(148, 163, 184, 0.85);
      }

      #${ESTATE_PANEL_ID} .est-table {
        flex: 1;
        min-height: 0;
        overflow: auto;
        display: grid;
        grid-template-columns: 40px minmax(0, 1fr);
        align-content: start;
        grid-auto-rows: 26px;
      }
      #${ESTATE_PANEL_ID} .est-row { display: contents; }
      #${ESTATE_PANEL_ID} .est-cell {
        padding: 0 8px;
        line-height: 25px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
        border-bottom: 1px solid rgba(148, 163, 184, 0.08);
      }
      #${ESTATE_PANEL_ID} .est-rank { color: rgba(148, 163, 184, 0.72); }
      #${ESTATE_PANEL_ID} .est-tiles { text-align: right; }
      #${ESTATE_PANEL_ID} .est-head {
        position: sticky;
        top: 0;
        z-index: 1;
        background: rgba(16, 22, 24, 0.98);
        color: rgba(226, 232, 240, 0.72);
        font-size: 10px;
        text-transform: uppercase;
        border-bottom: 1px solid rgba(148, 163, 184, 0.22);
      }
      #${ESTATE_PANEL_ID} .est-head.est-sortable { cursor: pointer; }
      #${ESTATE_PANEL_ID} .est-head.est-sortable:hover { color: #fff; }
      #${ESTATE_PANEL_ID} .est-sort-arrow { font-size: 8px; margin-left: 2px; }
      #${ESTATE_PANEL_ID} .est-row .est-cell { cursor: pointer; }
      #${ESTATE_PANEL_ID} .est-row:hover .est-cell { background: rgba(148, 163, 184, 0.18); }
      #${ESTATE_PANEL_ID} .est-empty {
        grid-column: 1 / -1;
        padding: 12px;
        text-align: center;
        color: rgba(226, 232, 240, 0.55);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureEstatePanel() {
    ensureEstatePanelStyles();
    let panel = document.getElementById(ESTATE_PANEL_ID);
    if (panel) {
      return panel;
    }
    panel = document.createElement("div");
    panel.id = ESTATE_PANEL_ID;

    const header = document.createElement("div");
    header.className = "est-header";
    const title = document.createElement("span");
    title.className = "est-title";
    title.textContent = tr("Estates");
    const count = document.createElement("span");
    count.className = "est-count";
    header.append(title, count);

    const table = document.createElement("div");
    table.className = "est-table";
    // Sticky header row: # + Tiles (Tiles sortable).
    const hRank = document.createElement("span");
    hRank.className = "est-cell est-head est-rank";
    hRank.textContent = "#";
    const hTiles = document.createElement("span");
    hTiles.className = "est-cell est-head est-tiles est-sortable";
    hTiles.title = tr("Tiles");
    hTiles.addEventListener("click", () => {
      estateSortDir = estateSortDir === 1 ? -1 : 1;
      renderEstatePanel();
    });
    table.append(hRank, hTiles);

    panel.append(header, table);
    (document.body || document.documentElement).appendChild(panel);
    makeGoldStatPanelDraggable(panel, header, ESTATE_PANEL_POS_KEY);
    applyStoredGoldStatPanelPosition(panel, ESTATE_PANEL_POS_KEY);
    return panel;
  }

  function getEstateRow(table, estate) {
    let entry = estateRowCache.get(estate.key);
    if (!entry) {
      const rowEl = document.createElement("div");
      rowEl.className = "est-row";
      const rank = document.createElement("span");
      rank.className = "est-cell est-rank";
      const tiles = document.createElement("span");
      tiles.className = "est-cell est-tiles";
      rowEl.append(rank, tiles);
      entry = { row: rowEl, cells: { rank, tiles }, cx: estate.cx, cy: estate.cy };
      // Click → pan the camera to this parcel's centre.
      rowEl.addEventListener("click", () => {
        try {
          const transform = getOpenFrontGameContext()?.transform;
          if (transform && typeof transform.onGoToPosition === "function") {
            transform.onGoToPosition({ x: entry.cx, y: entry.cy });
          }
        } catch (_error) {
          // ignore
        }
      });
      estateRowCache.set(estate.key, entry);
      table.appendChild(rowEl);
    }
    return entry;
  }

  function renderEstatePanel() {
    const panel = document.getElementById(ESTATE_PANEL_ID);
    if (!panel) {
      return;
    }
    const inGame = Boolean(getOpenFrontGameContext()?.game);
    const shouldShow = estatePanelOpen && inGame && estateData.length > 0;
    panel.dataset.visible = shouldShow ? "true" : "false";
    if (!shouldShow) {
      return;
    }

    const table = panel.querySelector(".est-table");
    if (!table) {
      return;
    }

    // Sort a copy; default = most tiles first.
    const sorted = estateData
      .slice()
      .sort((a, b) => (estateSortDir === 1 ? b.tiles - a.tiles : a.tiles - b.tiles));

    // Header sort arrow.
    const hTiles = table.querySelector(".est-head.est-tiles");
    if (hTiles) {
      hTiles.textContent = tr("Tiles");
      const arrow = document.createElement("span");
      arrow.className = "est-sort-arrow";
      arrow.textContent = estateSortDir === 1 ? "▾" : "▴";
      hTiles.appendChild(arrow);
    }

    const count = panel.querySelector(".est-count");
    if (count) {
      count.textContent = String(sorted.length);
    }

    const seen = new Set();
    for (let i = 0; i < sorted.length; i += 1) {
      const estate = sorted[i];
      seen.add(estate.key);
      const entry = getEstateRow(table, estate);
      entry.cx = estate.cx; // refresh centre for click-to-focus
      entry.cy = estate.cy;
      entry.cells.rank.textContent = String(i + 1);
      entry.cells.tiles.textContent = String(estate.tiles);
      table.appendChild(entry.row); // move into sorted order (after header)
    }
    for (const [key, entry] of estateRowCache) {
      if (!seen.has(key)) {
        entry.row.remove();
        estateRowCache.delete(key);
      }
    }
  }

  // Flood-fill the player's owned tiles into connected components. Seeds are the
  // border tiles (every component has a border); each owned tile is visited once.
  function computeEstateComponents(game, borderTiles, mySmallId) {
    const visited = new Set();
    const components = [];
    for (const seed of borderTiles) {
      if (visited.has(seed)) {
        continue;
      }
      visited.add(seed);
      const stack = [seed];
      let size = 0;
      let sumX = 0;
      let sumY = 0;
      let minRef = seed;
      while (stack.length) {
        const t = stack.pop();
        size += 1;
        sumX += game.x(t);
        sumY += game.y(t);
        if (t < minRef) {
          minRef = t;
        }
        for (const n of game.neighbors(t)) {
          if (visited.has(n)) {
            continue;
          }
          let owner = NaN;
          try {
            owner = Number(game.ownerID(n));
          } catch (_error) {
            continue;
          }
          if (owner === mySmallId) {
            visited.add(n);
            stack.push(n);
          }
        }
      }
      components.push({
        key: String(minRef), // smallest tile ref = stable id while unchanged
        tiles: size,
        cx: sumX / size,
        cy: sumY / size,
      });
    }
    return components;
  }

  async function refreshEstates() {
    if (!estatePanelOpen || estateComputing) {
      return;
    }
    const context = getOpenFrontGameContext();
    const game = context?.game;
    if (!game) {
      estateData = [];
      renderEstatePanel();
      return;
    }
    let me = null;
    try {
      me = game.myPlayer?.();
    } catch (_error) {
      me = null;
    }
    if (!me?.isPlayer?.()) {
      estateData = [];
      renderEstatePanel();
      return;
    }

    estateComputing = true;
    try {
      const mySmallId = Number(me.smallID());
      const result = await me.borderTiles();
      const borderTiles = result?.borderTiles;
      if (!borderTiles || !estatePanelOpen) {
        return;
      }
      estateData = computeEstateComponents(game, borderTiles, mySmallId);
      renderEstatePanel();
    } catch (_error) {
      // Worker call failed this round; keep the last data.
    } finally {
      estateComputing = false;
    }
  }

  function setEstatePanelEnabled(enabled) {
    estatePanelOpen = Boolean(enabled);
    if (estatePanelOpen) {
      ensureEstatePanel();
      if (estateIntervalId === null) {
        estateIntervalId = window.setInterval(refreshEstates, ESTATE_COMPUTE_MS);
      }
      refreshEstates();
    } else {
      if (estateIntervalId !== null) {
        clearInterval(estateIntervalId);
        estateIntervalId = null;
      }
      estateData = [];
      for (const [, entry] of estateRowCache) {
        entry.row.remove();
      }
      estateRowCache.clear();
      const panel = document.getElementById(ESTATE_PANEL_ID);
      if (panel) {
        panel.dataset.visible = "false";
      }
    }
  }
