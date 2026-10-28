// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/game-time-alert.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Game-time alert: a one-shot, center-screen notice when the match reaches a
// configurable elapsed time. Info-toned (this is a reminder, not a danger
// warning). Standalone — it runs on its own 1s interval and needs neither the
// map overlay layer nor the shared scheduler. Follows the same center-alert
// visual language as the Missile Silo / incoming-boat warnings.

  function ensureGameTimeAlertStyles() {
    if (document.getElementById(GAME_TIME_ALERT_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = GAME_TIME_ALERT_STYLE_ID;
    style.textContent = `
      #${GAME_TIME_ALERT_CONTAINER_ID} {
        position: fixed;
        top: 18%;
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

      #${GAME_TIME_ALERT_CONTAINER_ID} .openfront-helper-gta-alert {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border: 2px solid rgba(96, 165, 250, 0.9);
        border-radius: 12px;
        background: linear-gradient(180deg, rgba(8, 47, 73, 0.96), rgba(2, 20, 40, 0.96));
        color: var(--oh-panel-text, #e2e8f0);
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        box-shadow:
          0 18px 50px rgba(0, 0, 0, 0.55),
          0 0 26px rgba(96, 165, 250, 0.45);
        animation:
          openfront-helper-gta-in 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2),
          openfront-helper-gta-glow 1.6s ease-in-out infinite;
      }

      @keyframes openfront-helper-gta-in {
        from { opacity: 0; transform: translateY(-14px) scale(0.94); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes openfront-helper-gta-glow {
        0%, 100% { box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 0 20px rgba(96, 165, 250, 0.3); }
        50% { box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 0 38px rgba(96, 165, 250, 0.7); }
      }

      #${GAME_TIME_ALERT_CONTAINER_ID} .openfront-helper-gta-icon {
        flex: 0 0 auto;
        font-size: 26px;
        line-height: 1;
      }

      #${GAME_TIME_ALERT_CONTAINER_ID} .openfront-helper-gta-body {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      #${GAME_TIME_ALERT_CONTAINER_ID} .openfront-helper-gta-title {
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--oh-accent, #60a5fa);
      }

      #${GAME_TIME_ALERT_CONTAINER_ID} .openfront-helper-gta-msg {
        font-size: 15px;
        font-weight: 800;
        line-height: 1.2;
      }

      #${GAME_TIME_ALERT_CONTAINER_ID} .openfront-helper-gta-close {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        margin-left: 4px;
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.5);
        color: var(--oh-panel-text, #e2e8f0);
        font-size: 13px;
        font-weight: 800;
        cursor: pointer;
      }

      #${GAME_TIME_ALERT_CONTAINER_ID} .openfront-helper-gta-close:hover {
        background: rgba(96, 165, 250, 0.28);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureGameTimeAlertContainer() {
    ensureGameTimeAlertStyles();
    let container = document.getElementById(GAME_TIME_ALERT_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = GAME_TIME_ALERT_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function formatGameTimeAlertClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${String(rem).padStart(2, "0")}s`;
  }

  function showGameTimeAlertCard(elapsedSeconds) {
    const container = ensureGameTimeAlertContainer();
    const card = document.createElement("div");
    card.className = "openfront-helper-gta-alert";

    const icon = document.createElement("div");
    icon.className = "openfront-helper-gta-icon";
    icon.textContent = "⏱️";

    const body = document.createElement("div");
    body.className = "openfront-helper-gta-body";
    const title = document.createElement("div");
    title.className = "openfront-helper-gta-title";
    title.textContent = tr("Game-time alert");
    const msg = document.createElement("div");
    msg.className = "openfront-helper-gta-msg";
    msg.textContent = tr("Match time reached {time}", {
      time: formatGameTimeAlertClock(elapsedSeconds),
    });
    body.appendChild(title);
    body.appendChild(msg);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "openfront-helper-gta-close";
    close.textContent = "✕";
    close.title = tr("Close");
    close.setAttribute("aria-label", tr("Close"));

    let removed = false;
    const autoCloseId = window.setTimeout(() => {
      if (removed) return;
      removed = true;
      card.remove();
    }, 12000);
    close.addEventListener("click", () => {
      if (removed) return;
      removed = true;
      window.clearTimeout(autoCloseId);
      card.remove();
    });

    card.appendChild(icon);
    card.appendChild(body);
    card.appendChild(close);
    container.appendChild(card);
  }

  function checkGameTimeAlert() {
    if (!gameTimeAlertEnabled) {
      return;
    }
    let game = null;
    try {
      game = getOpenFrontGameContext()?.game || null;
    } catch (_error) {
      game = null;
    }
    if (!game || typeof game.ticks !== "function") {
      return;
    }
    // A new match hands out a fresh game instance (and ticks restart near 0),
    // so re-arm the one-shot latch whenever the instance changes.
    if (game !== gameTimeAlertLastGame) {
      gameTimeAlertLastGame = game;
      gameTimeAlertFired = false;
    }
    let ticks = 0;
    try {
      ticks = Number(game.ticks()) || 0;
    } catch (_error) {
      return;
    }
    const elapsedSeconds = ticks / 10; // OpenFront advances 10 ticks per second.
    if (elapsedSeconds < gameTimeAlertThresholdSec) {
      gameTimeAlertFired = false; // still before the threshold (covers restarts)
      return;
    }
    if (gameTimeAlertFired) {
      return;
    }
    gameTimeAlertFired = true;
    showGameTimeAlertCard(elapsedSeconds);
  }

  function setGameTimeAlertEnabled(enabled, thresholdSec) {
    gameTimeAlertEnabled = Boolean(enabled);
    const parsed = Number(thresholdSec);
    if (Number.isFinite(parsed) && parsed > 0) {
      gameTimeAlertThresholdSec = Math.max(30, Math.min(3600, Math.round(parsed)));
    }
    if (!gameTimeAlertEnabled) {
      if (gameTimeAlertInterval !== null) {
        window.clearInterval(gameTimeAlertInterval);
        gameTimeAlertInterval = null;
      }
      gameTimeAlertFired = false;
      gameTimeAlertLastGame = null;
      document.getElementById(GAME_TIME_ALERT_CONTAINER_ID)?.remove();
      return;
    }
    if (gameTimeAlertInterval === null) {
      gameTimeAlertInterval = window.setInterval(checkGameTimeAlert, 1000);
    }
  }
