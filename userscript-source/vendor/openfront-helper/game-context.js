// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/selective-trade-policy.js (lines 1-89, 178-186, 488-579)
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: everything except OpenFront game-context discovery: all embargo / selective-trade-policy logic, the report*/refresh* functions (postToExtension) and the custom/solo/cheats game checks were dropped; rememberOpenFrontGameContext no longer syncs embargo patches.

// OpenFront context discovery and selective trade policy.

  function isObject(value) {
    return value !== null && typeof value === "object";
  }

  function isUsableOpenFrontGameContext(game, transform) {
    return Boolean(
      game?.playerViews &&
        transform?.worldToScreenCoordinates,
    );
  }

  function rememberOpenFrontGameContext(game, transform) {
    if (!isUsableOpenFrontGameContext(game, transform)) {
      return null;
    }

    lastOpenFrontGameContext = { game, transform };
    return lastOpenFrontGameContext;
  }

  function findOpenFrontGameContextInDom() {
    const gameSources = [];
    const transformSources = [];

    for (const element of document.querySelectorAll("*")) {
      if (element?.game) {
        gameSources.push(element.game);
      }
      if (element?.g) {
        gameSources.push(element.g);
      }
      if (element?.transformHandler) {
        transformSources.push(element.transformHandler);
      }
      if (element?.transform) {
        transformSources.push(element.transform);
      }
    }

    for (const game of gameSources) {
      for (const transform of transformSources) {
        const context = rememberOpenFrontGameContext(game, transform);
        if (context) {
          return context;
        }
      }
    }

    return null;
  }

  function isTeamGame(game) {
    const mode = String(game?.config?.().gameMode ?? game?.config?.().gameMode?.() ?? "")
      .trim()
      .toLowerCase();
    if (mode === "team") {
      return true;
    }
    if (mode === "free for all" || mode === "ffa") {
      return false;
    }

    const players = Array.from(game?.playerViews?.() || []).filter((player) =>
      player?.isAlive?.(),
    );
    return players.some((player) => {
      const team = getPlayerTeamName(player);
      return team && team !== "Bot";
    });
  }

  function getGameConfig(game) {
    try {
      const value = game?.config;
      const config = typeof value === "function" ? value.call(game) : value;
      return isObject(config) ? config : null;
    } catch (_error) {
      return null;
    }
  }


  function isHumanPlayer(player) {
    try {
      const playerType = player?.type?.() ?? player?.data?.playerType;
      return playerType === "HUMAN";
    } catch (_error) {
      return false;
    }
  }


  // Strategy: short-circuit on the cached context. Game/transform references
  // are stable across the lifetime of a single match. Force a periodic full
  // re-discovery so we still notice when a game ends and a new one starts.
  const _OPEN_FRONT_CONTEXT_REFRESH_MS = 1000;
  let _lastOpenFrontContextDiscoveryAt = 0;

  function _discoverOpenFrontGameContext() {
    const playerInfoOverlay = document.querySelector("player-info-overlay");
    const playerPanel = document.querySelector("player-panel");
    const emojiTable = document.querySelector("emoji-table");
    const buildMenu = document.querySelector("build-menu");
    const gameLeftSidebar = document.querySelector("game-left-sidebar");
    const gameRightSidebar = document.querySelector("game-right-sidebar");
    const leaderBoard = document.querySelector("leader-board");
    const teamStats = document.querySelector("team-stats");
    const spawnTimer = document.querySelector("spawn-timer");
    const unitDisplay = document.querySelector("unit-display");
    const controlPanel = document.querySelector("control-panel");

    const gameSources = [
      playerInfoOverlay?.game,
      playerPanel?.g,
      emojiTable?.game,
      leaderBoard?.game,
      teamStats?.game,
      gameLeftSidebar?.game,
      gameRightSidebar?.game,
      buildMenu?.game,
      spawnTimer?.game,
      unitDisplay?.game,
      controlPanel?.game,
    ];
    const transformSources = [
      playerInfoOverlay?.transform,
      emojiTable?.transformHandler,
      buildMenu?.transformHandler,
      spawnTimer?.transformHandler,
      unitDisplay?.transformHandler,
      controlPanel?.transformHandler,
    ];

    for (const game of gameSources) {
      for (const transform of transformSources) {
        const context = rememberOpenFrontGameContext(game, transform);
        if (context) {
          return context;
        }
      }
    }

    const discoveredContext = findOpenFrontGameContextInDom();
    if (discoveredContext) {
      return discoveredContext;
    }

    return null;
  }

  function getOpenFrontGameContext() {
    // Fast path: re-use the cached context as long as it still looks usable
    // and the periodic refresh interval has not elapsed.
    const now = performance.now();
    if (
      now - _lastOpenFrontContextDiscoveryAt < _OPEN_FRONT_CONTEXT_REFRESH_MS &&
      isUsableOpenFrontGameContext(
        lastOpenFrontGameContext?.game,
        lastOpenFrontGameContext?.transform,
      )
    ) {
      return lastOpenFrontGameContext;
    }

    _lastOpenFrontContextDiscoveryAt = now;
    const discovered = _discoverOpenFrontGameContext();
    if (discovered) {
      return discovered;
    }

    // Last resort: even if discovery failed this round, keep the previously
    // cached context if its functions still exist. Prevents a single failed
    // DOM scan from breaking helpers mid-game.
    if (
      isUsableOpenFrontGameContext(
        lastOpenFrontGameContext?.game,
        lastOpenFrontGameContext?.transform,
      )
    ) {
      return lastOpenFrontGameContext;
    }

    return null;
  }
