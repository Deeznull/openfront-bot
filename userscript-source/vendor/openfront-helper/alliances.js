// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/alliances.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Alliance marker overlay and ally-duration display.

  function ensureAllyMarkerStyles() {
    if (document.getElementById(ALLY_MARKER_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = ALLY_MARKER_STYLE_ID;
    style.textContent = `
      #${ALLY_MARKER_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 9000;
        pointer-events: none;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-lines {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        overflow: visible;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-line {
        stroke: rgba(34, 197, 94, 0.58);
        stroke-width: 2.5;
        stroke-linecap: round;
        filter: drop-shadow(0 0 5px rgba(34, 197, 94, 0.72));
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot {
        position: fixed;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        width: max-content;
        margin: -7.5px 0 0 -50px;
        color: #dcfce7;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        font-size: 10px;
        font-weight: 900;
        line-height: 1;
        text-align: center;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.92);
        transform: translate(var(--ally-x), var(--ally-y));
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot::before {
        content: "";
        width: 15px;
        height: 15px;
        border-radius: 50%;
        background: rgba(34, 197, 94, 0.72);
        box-shadow:
          0 0 0 2px rgba(20, 83, 45, 0.38),
          0 0 13px rgba(34, 197, 94, 0.78);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-time {
        display: grid;
        gap: 2px;
        min-width: 100px;
        padding: 4px 6px;
        border: 1px solid rgba(134, 239, 172, 0.34);
        border-radius: 8px;
        background: rgba(5, 46, 22, 0.78);
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-time span {
        white-space: nowrap;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-label {
        color: rgba(220, 252, 231, 0.82);
        font-size: 9px;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-line.openfront-helper-ally-warning {
        stroke: rgba(249, 115, 22, 0.68);
        filter: drop-shadow(0 0 5px rgba(249, 115, 22, 0.76));
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-warning {
        color: #ffedd5;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-warning::before {
        background: rgba(249, 115, 22, 0.76);
        box-shadow:
          0 0 0 2px rgba(154, 52, 18, 0.4),
          0 0 13px rgba(249, 115, 22, 0.82);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-warning .openfront-helper-ally-time {
        border-color: rgba(253, 186, 116, 0.42);
        background: rgba(67, 20, 7, 0.82);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-warning .openfront-helper-ally-label {
        color: rgba(255, 237, 213, 0.84);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-line.openfront-helper-ally-critical {
        stroke: rgba(239, 68, 68, 0.72);
        filter: drop-shadow(0 0 5px rgba(239, 68, 68, 0.82));
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-critical {
        color: #fee2e2;
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-critical::before {
        background: rgba(239, 68, 68, 0.82);
        box-shadow:
          0 0 0 2px rgba(127, 29, 29, 0.44),
          0 0 13px rgba(239, 68, 68, 0.86);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-critical .openfront-helper-ally-time {
        border-color: rgba(252, 165, 165, 0.46);
        background: rgba(69, 10, 10, 0.84);
      }

      #${ALLY_MARKER_CONTAINER_ID} .openfront-helper-ally-dot.openfront-helper-ally-critical .openfront-helper-ally-label {
        color: rgba(254, 226, 226, 0.86);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureAllyMarkerContainer() {
    ensureAllyMarkerStyles();

    let container = document.getElementById(ALLY_MARKER_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = ALLY_MARKER_CONTAINER_ID;
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function ensureAllyLineSvg(container) {
    let svg = container.querySelector(".openfront-helper-ally-lines");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("openfront-helper-ally-lines");
      svg.setAttribute("aria-hidden", "true");
      container.prepend(svg);
    }
    return svg;
  }

  function isAlliedPlayer(player, otherPlayer) {
    try {
      return player !== otherPlayer && Boolean(player?.isAlliedWith?.(otherPlayer));
    } catch (_error) {
      return false;
    }
  }

  function getAllianceView(player, otherPlayer) {
    try {
      return Array.from(player?.alliances?.() || []).find(
        (alliance) => alliance?.other === otherPlayer?.id?.(),
      );
    } catch (_error) {
      return null;
    }
  }

  function formatAllianceDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
  }

  function getAllianceUrgencyClass(totalSeconds) {
    if (!Number.isFinite(totalSeconds)) {
      return "";
    }
    if (totalSeconds < 30) {
      return "openfront-helper-ally-critical";
    }
    if (totalSeconds <= 60) {
      return "openfront-helper-ally-warning";
    }
    return "";
  }

  function getAllianceTimingText(game, alliance) {
    const currentTick = Number(game?.ticks?.());
    const expiresAt = Number(alliance?.expiresAt);
    if (
      !Number.isFinite(currentTick) ||
      !Number.isFinite(expiresAt)
    ) {
      return {
        remaining: "unknown left",
        urgencyClass: "",
      };
    }

    const remainingSeconds = (expiresAt - currentTick) / 10;
    return {
      remaining: `${formatAllianceDuration(remainingSeconds)} left`,
      urgencyClass: getAllianceUrgencyClass(remainingSeconds),
    };
  }

  function syncAllyMarkers() {
    if (!allyMarkersEnabled) {
      document.getElementById(ALLY_MARKER_CONTAINER_ID)?.remove();
      allyMarkerAnimationFrame = null;
      return;
    }

    const container = ensureAllyMarkerContainer();
    const lineSvg = ensureAllyLineSvg(container);
    const overlay = getHoveredPlayerInfoOverlay();
    const transform = overlay?.transform;
    if (!overlay?.game || !transform) {
      container.replaceChildren();
      allyMarkerAnimationFrame = requestAnimationFrame(syncAllyMarkers);
      return;
    }

    const hoveredNameLocation = overlay.player?.nameLocation?.();
    if (!hoveredNameLocation) {
      lineSvg.replaceChildren();
      container.replaceChildren(lineSvg);
      allyMarkerAnimationFrame = requestAnimationFrame(syncAllyMarkers);
      return;
    }

    const hoveredScreenPos =
      transform.worldToScreenCoordinates(hoveredNameLocation);
    if (
      !Number.isFinite(hoveredScreenPos?.x) ||
      !Number.isFinite(hoveredScreenPos?.y)
    ) {
      lineSvg.replaceChildren();
      container.replaceChildren(lineSvg);
      allyMarkerAnimationFrame = requestAnimationFrame(syncAllyMarkers);
      return;
    }

    const activeIds = new Set();
    const players = Array.from(overlay.game.playerViews?.() || []);

    for (let index = 0; index < players.length; index++) {
      const player = players[index];
      if (!player?.isAlive?.() || !isAlliedPlayer(overlay.player, player)) {
        continue;
      }

      const nameLocation = player.nameLocation?.();
      if (!nameLocation) {
        continue;
      }

      const screenPos = transform.worldToScreenCoordinates(nameLocation);
      if (
        !Number.isFinite(screenPos?.x) ||
        !Number.isFinite(screenPos?.y) ||
        screenPos.x < -30 ||
        screenPos.y < -30 ||
        screenPos.x > window.innerWidth + 30 ||
        screenPos.y > window.innerHeight + 30
      ) {
        continue;
      }

      const markerId = getPlayerMarkerId(player, index);
      activeIds.add(markerId);

      let line = lineSvg.querySelector(
        `.openfront-helper-ally-line[data-ally-id="${escapeCssIdentifier(markerId)}"]`,
      );
      if (!line) {
        line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.classList.add("openfront-helper-ally-line");
        line.dataset.allyId = markerId;
        lineSvg.appendChild(line);
      }
      line.setAttribute("x1", String(hoveredScreenPos.x));
      line.setAttribute("y1", String(hoveredScreenPos.y));
      line.setAttribute("x2", String(screenPos.x));
      line.setAttribute("y2", String(screenPos.y));

      let marker = container.querySelector(
        `.openfront-helper-ally-dot[data-ally-id="${escapeCssIdentifier(markerId)}"]`,
      );
      if (!marker) {
        marker = document.createElement("div");
        marker.className = "openfront-helper-ally-dot";
        marker.dataset.allyId = markerId;
        marker.innerHTML = `
          <span class="openfront-helper-ally-time">
            <span class="openfront-helper-ally-label">Alliance</span>
            <span class="openfront-helper-ally-remaining"></span>
          </span>
        `;
        container.appendChild(marker);
      }

      const alliance = getAllianceView(overlay.player, player);
      const timing = getAllianceTimingText(overlay.game, alliance);
      marker.classList.remove(
        "openfront-helper-ally-warning",
        "openfront-helper-ally-critical",
      );
      line.classList.remove(
        "openfront-helper-ally-warning",
        "openfront-helper-ally-critical",
      );
      if (timing.urgencyClass) {
        marker.classList.add(timing.urgencyClass);
        line.classList.add(timing.urgencyClass);
      }
      const remaining = marker.querySelector(".openfront-helper-ally-remaining");
      if (remaining) {
        remaining.textContent = timing.remaining;
      }

      marker.style.setProperty("--ally-x", `${screenPos.x}px`);
      marker.style.setProperty("--ally-y", `${screenPos.y}px`);
    }

    for (const marker of container.querySelectorAll(".openfront-helper-ally-dot")) {
      if (!activeIds.has(marker.dataset.allyId || "")) {
        marker.remove();
      }
    }
    for (const line of lineSvg.querySelectorAll(".openfront-helper-ally-line")) {
      if (!activeIds.has(line.dataset.allyId || "")) {
        line.remove();
      }
    }

    allyMarkerAnimationFrame = requestAnimationFrame(syncAllyMarkers);
  }

  function setAllyMarkersEnabled(enabled) {
    allyMarkersEnabled = Boolean(enabled);
    if (!allyMarkersEnabled) {
      if (allyMarkerAnimationFrame !== null) {
        cancelAnimationFrame(allyMarkerAnimationFrame);
      }
      allyMarkerAnimationFrame = null;
      document.getElementById(ALLY_MARKER_CONTAINER_ID)?.remove();
      return;
    }

    if (allyMarkerAnimationFrame === null) {
      syncAllyMarkers();
    }
  }
