// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/shared-utils.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Shared player, team, overlay, and formatting helpers used across bridge features.

function normalizeEconomyHeatmapIntensity(value) {
  const intensity = Number(value);
  if (!Number.isFinite(intensity)) {
    return 1;
  }
  return Math.max(0, Math.min(2, Math.round(intensity)));
}

function escapeCssIdentifier(value) {
  if (globalThis.CSS?.escape) {
    return CSS.escape(value);
  }

  return value.replace(/["\\]/g, "\\$&");
}

function getPlayerSmallId(player, fallbackIndex = 0) {
  try {
    return Number(player?.smallID?.() ?? player?.data?.smallID ?? fallbackIndex);
  } catch (_error) {
    return Number(fallbackIndex);
  }
}

function getPlayerDisplayName(player) {
  try {
    return String(
      player?.displayName?.() ??
        player?.name?.() ??
        player?.data?.displayName ??
        player?.data?.name ??
        "Unknown",
    );
  } catch (_error) {
    return "Unknown";
  }
}

function getPlayerRelationToMyPlayer(game, player) {
  let myPlayer = null;
  try {
    myPlayer = game?.myPlayer?.();
    if (!player?.isPlayer?.() || !myPlayer?.isPlayer?.()) {
      return null;
    }
  } catch (_error) {
    return null;
  }

  const playerId = getPlayerSmallId(player, NaN);
  const myPlayerId = getPlayerSmallId(myPlayer, NaN);
  if (Number.isFinite(playerId) && playerId === myPlayerId) {
    return "self";
  }

  try {
    if (player.isFriendly?.(myPlayer) || myPlayer.isFriendly?.(player)) {
      return "ally";
    }
  } catch (_error) {
    return "enemy";
  }

  return "enemy";
}

function getPlayerTeamName(player) {
  try {
    const team = player?.team?.();
    return team == null ? null : String(team);
  } catch (_error) {
    return null;
  }
}

// Color resolution for teams and individual players.
//
// v0.32 moved the game's theme out of core into a client-side ThemeProvider that
// page scope cannot reach — game.config().theme() no longer exists, so the old
// path silently fell through to a stale palette (and for 8+ teams, where the
// game names teams "Team 1".."Team N", that palette has no entry → every team
// collapsed to one fallback color). The live, per-player resolved color IS still
// readable: PlayerView.territoryColor() returns a colord color we can .toHex().
//   • getPlayerColor(player) → that player's exact in-game color (reflects team
//     shade, cosmetics, and colorblind mode), falling back to the team palette.
//   • getTeamColor(team)     → the color of a representative living member of the
//     team (lowest smallID, for stability), so every team is distinct — including
//     8+-team "Team N" — falling back to the palette, then a deterministic color.
// Every path degrades safely if territoryColor() is unavailable on a given build.

function _playerTerritoryHex(player) {
  try {
    const hex = player?.territoryColor?.()?.toHex?.();
    if (typeof hex === "string" && /^#[0-9a-fA-F]{3,8}$/.test(hex)) {
      return hex;
    }
  } catch (_error) {
    // PlayerView.territoryColor() unavailable on this build → palette fallback.
  }
  return null;
}

// team name -> color of its representative (lowest-smallID alive member),
// rebuilt once per (game, tick). Lowest smallID (not iteration-order-first)
// keeps a team's swatch stable when a member dies, avoiding render churn.
let _teamRepColorGame = null;
let _teamRepColorTick = -1;
const _teamRepColors = new Map();
const _teamRepSmallIds = new Map();

function _ensureTeamRepColors(game) {
  let tick = Number.NaN;
  try {
    tick = Number(game?.ticks?.());
  } catch (_error) {
    tick = Number.NaN;
  }
  if (
    game === _teamRepColorGame &&
    Number.isFinite(tick) &&
    tick === _teamRepColorTick
  ) {
    return _teamRepColors;
  }
  _teamRepColorGame = game;
  _teamRepColorTick = Number.isFinite(tick) ? tick : -1;
  _teamRepColors.clear();
  _teamRepSmallIds.clear();
  for (const player of getCachedPlayerViews(game)) {
    let alive = false;
    try {
      alive = Boolean(player?.isAlive?.());
    } catch (_error) {
      alive = false;
    }
    if (!alive) {
      continue;
    }
    const team = getPlayerTeamName(player);
    if (!team || team === "Bot") {
      continue;
    }
    const smallId = getPlayerSmallId(player, Number.MAX_SAFE_INTEGER);
    const prevId = _teamRepSmallIds.get(team);
    if (prevId !== undefined && prevId <= smallId) {
      continue;
    }
    const hex = _playerTerritoryHex(player);
    if (hex) {
      _teamRepColors.set(team, hex);
      _teamRepSmallIds.set(team, smallId);
    }
  }
  return _teamRepColors;
}

// Exact in-game color for one player. Returns null (rather than a palette
// guess) for a teamless player when no live color is readable, so callers can
// keep their "no accent" behavior for FFA players on builds without
// territoryColor() — only team players fall back to the shared team color.
function getPlayerColor(player, game = null) {
  const hex = _playerTerritoryHex(player);
  if (hex) {
    return hex;
  }
  const team = getPlayerTeamName(player);
  return team ? getTeamColor(team, game) : null;
}

// Per-game cache for the palette/generated fallback path (rep colors are cached
// separately, per tick). Avoids re-running the lower-case index lookup per row.
let _cachedTeamColorGame = null;
const _cachedTeamColors = new Map();
let _teamColorsLowerCaseIndex = null;

function _getTeamColorsLowerCaseIndex() {
  if (_teamColorsLowerCaseIndex !== null) {
    return _teamColorsLowerCaseIndex;
  }
  _teamColorsLowerCaseIndex = new Map();
  for (const [name, color] of Object.entries(TEAM_COLORS)) {
    _teamColorsLowerCaseIndex.set(name.toLowerCase(), color);
  }
  return _teamColorsLowerCaseIndex;
}

// HSL (h:0-360, s/l:0-100) -> #rrggbb. Standalone so the generated team colors
// below don't depend on any other module's color helpers.
function _hslToHex(h, s, l) {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const toHex = (v) => {
    const n = Math.round((v + m) * 255);
    return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Deterministic distinct color for a team name not in TEAM_COLORS (the game's
// unnamed "Team 1".."Team N" for 8+ teams), so the 8th+ teams never collapse to
// one color even when no live member color is readable. For the "Team N" form we
// spread hues by the golden angle keyed on N, which keeps even adjacent teams
// well separated; any other name falls back to a stable FNV-1a hue.
function _generateTeamColor(name) {
  const str = String(name ?? "");
  const numbered = /(\d+)\s*$/.exec(str);
  if (numbered) {
    const n = Number(numbered[1]);
    return _hslToHex(Math.floor((n * 137.508) % 360), 68, 60);
  }
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h = (h ^ str.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  const hue = h % 360;
  const sat = 62 + ((h >>> 9) % 18); // 62..79%
  const light = 56 + ((h >>> 17) % 12); // 56..67%
  return _hslToHex(hue, sat, light);
}

function _computeTeamColor(team) {
  const teamKey = String(team ?? "");
  const directMatch = _getTeamColorsLowerCaseIndex().get(teamKey.trim().toLowerCase());
  if (directMatch) {
    return directMatch;
  }
  if (!teamKey) {
    return "#4ade80";
  }
  return _generateTeamColor(teamKey);
}

function getTeamColor(team, game = null) {
  // Primary: the live color of a representative living team member — correct for
  // any team count and tracks colorblind mode. Must run BEFORE the per-game
  // palette cache so an early-game palette color can't shadow it once players
  // spawn and their real colors become readable.
  if (game) {
    const rep = _ensureTeamRepColors(game).get(String(team ?? ""));
    if (rep) {
      return rep;
    }
  }
  // Fallback: palette match, else a deterministic generated color.
  if (game !== _cachedTeamColorGame) {
    _cachedTeamColorGame = game;
    _cachedTeamColors.clear();
  }
  const cacheKey = String(team ?? "");
  const cached = _cachedTeamColors.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const color = _computeTeamColor(team);
  _cachedTeamColors.set(cacheKey, color);
  return color;
}

function getTeamColorBackground(team, game = null) {
  const color = getTeamColor(team, game);
  return `${color}2b`;
}

function isNationBotPlayer(player) {
  try {
    const playerType = player?.type?.() ?? player?.data?.playerType;
    return playerType === "NATION";
  } catch (_error) {
    return false;
  }
}

function getPlayerMarkerId(player, fallbackIndex) {
  try {
    return String(
      player?.id?.() ??
        player?.smallID?.() ??
        player?.data?.id ??
        player?.displayName?.() ??
        fallbackIndex,
    );
  } catch (_error) {
    return String(fallbackIndex);
  }
}

function getPlayerGoldNumber(player) {
  try {
    const gold = player?.gold?.();
    if (typeof gold === "bigint") {
      return Number(gold);
    }
    return Number(gold);
  } catch (_error) {
    return NaN;
  }
}

let _cachedInfoOverlayEl = null;

function getHoveredPlayerInfoOverlay() {
  if (!_cachedInfoOverlayEl?.isConnected) {
    _cachedInfoOverlayEl = document.querySelector("player-info-overlay") ?? null;
  }
  const overlay = _cachedInfoOverlayEl;
  if (!overlay?.player) {
    return null;
  }

  const visible = overlay._isInfoVisible ?? overlay.isInfoVisible;
  if (visible === false) {
    return null;
  }

  return overlay;
}

function getPlayerInfoPanelRect(overlay) {
  const panel =
    overlay.querySelector('[class*="bg-gray-800"]') ??
    overlay.querySelector('[class*="backdrop-blur"]') ??
    overlay;
  const rect = panel.getBoundingClientRect?.();
  if (rect && (rect.width > 0 || rect.height > 0)) {
    return rect;
  }

  return null;
}

function normalizeTradeName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findPlayerByTradeName(players, name) {
  const normalizedName = normalizeTradeName(name);
  if (!normalizedName) {
    return null;
  }

  return (
    players.find(
      (player) => normalizeTradeName(getPlayerDisplayName(player)) === normalizedName,
    ) ?? players.find((player) => normalizeTradeName(player?.name?.()) === normalizedName) ?? null
  );
}

// Shared per-tick cache for game.playerViews(). Avoids spawning a new
// Array.from(...) snapshot on every helper render across multiple features.
let _cachedPlayerViewsGame = null;
let _cachedPlayerViewsTick = -1;
let _cachedPlayerViewsArray = [];

function getCachedPlayerViews(game) {
  if (!game) {
    return [];
  }

  let currentTick = Number.NaN;
  try {
    currentTick = Number(game.ticks?.());
  } catch (_error) {
    currentTick = Number.NaN;
  }

  if (
    game === _cachedPlayerViewsGame &&
    Number.isFinite(currentTick) &&
    currentTick === _cachedPlayerViewsTick &&
    _cachedPlayerViewsArray.length > 0
  ) {
    return _cachedPlayerViewsArray;
  }

  _cachedPlayerViewsGame = game;
  _cachedPlayerViewsTick = Number.isFinite(currentTick) ? currentTick : -1;
  try {
    _cachedPlayerViewsArray = Array.from(game.playerViews?.() || []);
  } catch (_error) {
    _cachedPlayerViewsArray = [];
  }
  return _cachedPlayerViewsArray;
}

// FNV-1a-ish 32-bit numeric hash. Used to replace JSON.stringify-based
// render-signature comparison in trade-balances.
function mixHashNumber(hash, value) {
  let h = hash >>> 0;
  let n = value | 0;
  if (n < 0) {
    n = (n + 0x100000000) >>> 0;
  }
  h = (h ^ (n & 0xff)) >>> 0;
  h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  h = (h ^ ((n >>> 8) & 0xff)) >>> 0;
  h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  h = (h ^ ((n >>> 16) & 0xff)) >>> 0;
  h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  h = (h ^ ((n >>> 24) & 0xff)) >>> 0;
  h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  return h;
}

function mixHashString(hash, value) {
  const str = String(value ?? "");
  let h = hash >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h ^ str.charCodeAt(i)) >>> 0;
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}
