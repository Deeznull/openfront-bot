// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/advisor-panel.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Advisor panel — a draggable slate-glass HUD (matches the project's in-game panel
// system) summarizing YOUR situation for manual play: troop-economy state, growth
// & safe-to-spend, expansion recommendation, and the top enemy threats. Consumes
// advisor-intel.js; updates on the shared 250ms helper tick (registerHelperTickListener),
// so it adds no rAF loop of its own. Decoupled from the auto-bot.

  function ensureAdvisorPanelStyles() {
    if (document.getElementById(ADVISOR_PANEL_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = ADVISOR_PANEL_STYLE_ID;
    style.textContent = `
      #${ADVISOR_PANEL_ID} {
        position: fixed;
        top: 120px; left: 12px;
        z-index: 9000;
        width: 220px;
        display: none;
        border: 1px solid rgba(148, 163, 184, 0.34);
        border-radius: 8px;
        background: rgba(12, 18, 20, 0.92);
        color: #e2e8f0;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 11px; font-weight: 700; line-height: 1.15;
        box-shadow: 0 10px 26px rgba(0,0,0,0.4), 0 0 16px rgba(148,163,184,0.1);
        pointer-events: auto; user-select: none;
      }
      #${ADVISOR_PANEL_ID}[data-visible="true"] { display: block; }
      #${ADVISOR_PANEL_ID} .ofh-adv-header {
        display: flex; align-items: center; gap: 6px;
        padding: 6px 8px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        cursor: grab; touch-action: none;
      }
      #${ADVISOR_PANEL_ID} .ofh-adv-header:active { cursor: grabbing; }
      #${ADVISOR_PANEL_ID} .ofh-adv-title {
        flex: 1; font-size: 10px; font-weight: 900; text-transform: uppercase;
        letter-spacing: 0.4px; color: rgba(226, 232, 240, 0.85);
      }
      #${ADVISOR_PANEL_ID} .ofh-adv-grip { color: rgba(148,163,184,0.55); }
      #${ADVISOR_PANEL_ID} .ofh-adv-x {
        display: inline-flex; align-items: center; justify-content: center;
        width: 20px; height: 20px; border: 1px solid rgba(148,163,184,0.25);
        border-radius: 6px; background: rgba(15,23,42,0.5); color: #e2e8f0;
        font-size: 12px; font-weight: 800; cursor: pointer;
      }
      #${ADVISOR_PANEL_ID} .ofh-adv-x:hover { background: rgba(148,163,184,0.24); }
      #${ADVISOR_PANEL_ID} .ofh-adv-body { padding: 7px 8px 8px; display: flex; flex-direction: column; gap: 7px; }
      #${ADVISOR_PANEL_ID} .ofh-adv-eco-state {
        display: inline-block; padding: 2px 6px; border-radius: 6px;
        font-size: 10px; font-weight: 900; letter-spacing: 0.4px;
      }
      #${ADVISOR_PANEL_ID} .ofh-adv-line { color: rgba(226,232,240,0.85); font-variant-numeric: tabular-nums; }
      #${ADVISOR_PANEL_ID} .ofh-adv-sub { color: rgba(148,163,184,0.85); font-size: 10px; font-variant-numeric: tabular-nums; }
      #${ADVISOR_PANEL_ID} .ofh-adv-sec-title {
        font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.4px;
        color: rgba(226,232,240,0.72); border-top: 1px solid rgba(148,163,184,0.14); padding-top: 6px;
      }
      #${ADVISOR_PANEL_ID} .ofh-adv-threat {
        display: flex; align-items: center; gap: 6px; padding: 2px 0;
      }
      #${ADVISOR_PANEL_ID} .ofh-adv-lvl {
        flex: 0 0 auto; padding: 1px 5px; border-radius: 999px; font-size: 9px; font-weight: 900;
      }
      #${ADVISOR_PANEL_ID} .ofh-adv-name {
        flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e2e8f0;
      }
      #${ADVISOR_PANEL_ID} .ofh-adv-empty { color: rgba(148,163,184,0.72); font-size: 10px; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureAdvisorPanel() {
    ensureAdvisorPanelStyles();
    let panel = document.getElementById(ADVISOR_PANEL_ID);
    if (panel) {
      return panel;
    }
    panel = document.createElement("div");
    panel.id = ADVISOR_PANEL_ID;
    const header = document.createElement("div");
    header.className = "ofh-adv-header";
    const title = document.createElement("div");
    title.className = "ofh-adv-title";
    title.textContent = `⚑ ${tr("Advisor")}`;
    const grip = document.createElement("div");
    grip.className = "ofh-adv-grip";
    grip.textContent = "⠿";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ofh-adv-x";
    close.textContent = "✕";
    close.title = tr("Close");
    close.addEventListener("click", () => { _qpSync("showAdvisorPanel", false); setAdvisorPanelEnabled(false); });
    header.appendChild(grip);
    header.appendChild(title);
    header.appendChild(close);
    const body = document.createElement("div");
    body.className = "ofh-adv-body";
    body.id = `${ADVISOR_PANEL_ID}-body`;
    panel.appendChild(header);
    panel.appendChild(body);
    (document.body || document.documentElement).appendChild(panel);
    if (typeof makeGoldStatPanelDraggable === "function") {
      makeGoldStatPanelDraggable(panel, header, ADVISOR_PANEL_POS_KEY);
      applyStoredGoldStatPanelPosition(panel, ADVISOR_PANEL_POS_KEY);
    }
    return panel;
  }

  function advEcoStateStyle(state) {
    switch (state) {
      case "CRITICAL":
        return { bg: "rgba(127,29,29,0.55)", fg: "#fca5a5", label: tr("critical") };
      case "RECOVER":
        return { bg: "rgba(146,64,14,0.5)", fg: "#fde68a", label: tr("recover") };
      case "GROWTH_PEAK":
      case "READY":
        return { bg: "rgba(20,83,45,0.5)", fg: "#86efac", label: tr("growing") };
      default: // PUSH / CAP_WASTE
        return { bg: "rgba(30,58,138,0.5)", fg: "#93c5fd", label: tr("spend now") };
    }
  }

  function advExpansionLabel(state) {
    if (state === "CRITICAL") return tr("recover");
    if (state === "PUSH" || state === "CAP_WASTE") return tr("aggressive");
    return tr("normal");
  }

  function advThreatLevelStyle(level) {
    switch (level) {
      case "Critical":
        return { bg: "rgba(127,29,29,0.7)", fg: "#fecaca" };
      case "Dangerous":
        return { bg: "rgba(146,64,14,0.7)", fg: "#fed7aa" };
      default:
        return { bg: "rgba(148,163,184,0.28)", fg: "#e2e8f0" };
    }
  }

  function advTroopsShort(rawTroops) {
    const v = Math.max(0, Math.floor((Number(rawTroops) || 0) / 10));
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return String(v);
  }

  function renderAdvisorPanel() {
    if (!advisorPanelEnabled) {
      return;
    }
    const panel = document.getElementById(ADVISOR_PANEL_ID);
    if (!panel) {
      return;
    }
    let context = null;
    try {
      context = getOpenFrontGameContext();
    } catch (_error) {
      context = null;
    }
    const body = document.getElementById(`${ADVISOR_PANEL_ID}-body`);
    if (!context || !context.game || !body) {
      panel.dataset.visible = "false";
      return;
    }
    const game = context.game;
    const me = game.myPlayer ? game.myPlayer() : null;
    if (!me) {
      panel.dataset.visible = "false";
      return;
    }
    panel.dataset.visible = "true";

    const eco = advEvaluateSelfEconomy(game, me);
    const parts = [];
    if (eco) {
      const st = advEcoStateStyle(eco.state);
      const pct = Math.round(eco.currentRatio * 100);
      parts.push(
        `<div><span class="ofh-adv-eco-state" style="background:${st.bg};color:${st.fg}">${st.label}</span></div>`,
      );
      parts.push(
        `<div class="ofh-adv-line">${tr("Troops")} ${advTroopsShort(eco.currentTroops)}/${advTroopsShort(eco.maxTroops)} (${pct}%)</div>`,
      );
      parts.push(
        `<div class="ofh-adv-sub">${tr("Growth")} ${Math.round(eco.growthEfficiency * 100)}% · ${tr("Spend")} ${advTroopsShort(eco.safeSpendableTroops)}</div>`,
      );
      if (eco.timeToPushSec != null) {
        parts.push(`<div class="ofh-adv-sub">${tr("Push in")} ${eco.timeToPushSec}s</div>`);
      }
      parts.push(
        `<div class="ofh-adv-sub">${tr("Expansion")}: ${advExpansionLabel(eco.state)}</div>`,
      );
    } else {
      parts.push(`<div class="ofh-adv-empty">${tr("Waiting for game…")}</div>`);
    }

    // Top threats.
    parts.push(`<div class="ofh-adv-sec-title">${tr("Threats")}</div>`);
    let threats = [];
    try {
      const players = getCachedPlayerViews(game);
      const nukeBuilders = advNukeBuilderIds(game);
      for (let i = 0; i < players.length; i += 1) {
        const p = players[i];
        if (!p || !p.isAlive || !p.isAlive()) continue;
        let rel = "enemy";
        try {
          rel = getPlayerRelationToMyPlayer(game, p) || "enemy";
        } catch (_e) {
          rel = "enemy";
        }
        if (rel === "self" || rel === "ally" || rel === "team") continue;
        const t = advEvaluateThreat(game, me, p, nukeBuilders);
        if (t.level === "Weak") continue;
        let name = "?";
        try {
          name = getPlayerDisplayName ? getPlayerDisplayName(p) : p.name && p.name();
        } catch (_e) {
          name = "?";
        }
        threats.push({ name, threat: t });
      }
      threats.sort((a, b) => b.threat.score - a.threat.score);
      threats = threats.slice(0, 6);
    } catch (_error) {
      threats = [];
    }
    if (threats.length === 0) {
      parts.push(`<div class="ofh-adv-empty">${tr("No notable threats")}</div>`);
    } else {
      for (let i = 0; i < threats.length; i += 1) {
        const th = threats[i];
        const ls = advThreatLevelStyle(th.threat.level);
        const nuke = th.threat.nukeCapable || th.threat.buildingNuke ? " ☢" : "";
        const safeName = String(th.name).replace(/[<>&]/g, "");
        parts.push(
          `<div class="ofh-adv-threat"><span class="ofh-adv-lvl" style="background:${ls.bg};color:${ls.fg}">${tr(th.threat.level)}</span><span class="ofh-adv-name">${safeName}${nuke}</span></div>`,
        );
      }
    }

    body.innerHTML = parts.join("");
  }

  function setAdvisorPanelEnabled(enabled) {
    advisorPanelEnabled = Boolean(enabled);
    if (!advisorPanelEnabled) {
      if (typeof unregisterHelperTickListener === "function") {
        unregisterHelperTickListener(renderAdvisorPanel);
      }
      document.getElementById(ADVISOR_PANEL_ID)?.remove();
      return;
    }
    ensureAdvisorPanel();
    if (typeof registerHelperTickListener === "function") {
      registerHelperTickListener(renderAdvisorPanel);
    }
  }
