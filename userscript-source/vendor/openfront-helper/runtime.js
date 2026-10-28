// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/runtime.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: PAGE_SOURCE/EXTENSION_SOURCE, postToExtension and the load-time public-lobbies-update listener; the auto-renew localStorage read (now false); trade/heatmap-only helpers (canStationTradeWith, getHeatmapTypePriority, addEconomicSource and its index).

// Shared page-context runtime, constants, and low-level helpers.

const BOT_MARKER_CONTAINER_ID = "openfront-helper-bot-marker-layer";
const BOT_MARKER_STYLE_ID = "openfront-helper-bot-marker-styles";
const ALLY_MARKER_CONTAINER_ID = "openfront-helper-ally-marker-layer";
const ALLY_MARKER_STYLE_ID = "openfront-helper-ally-marker-styles";
const ALLIANCE_REQUEST_PANEL_ID = "openfront-helper-alliance-request-panel";
const ALLIANCE_REQUEST_PANEL_STYLE_ID =
  "openfront-helper-alliance-request-panel-styles";
const ALLIANCE_FOCUS_FLASH_CONTAINER_ID =
  "openfront-helper-alliance-focus-flash-layer";
const ALLIANCE_FOCUS_FLASH_STYLE_ID =
  "openfront-helper-alliance-focus-flash-styles";
const ALLIANCE_FOCUS_FLASH_CANVAS_CLASS =
  "openfront-helper-alliance-focus-flash-canvas";
const ECONOMY_HEATMAP_CONTAINER_ID = "openfront-helper-economy-heatmap-layer";
const ECONOMY_HEATMAP_STYLE_ID = "openfront-helper-economy-heatmap-styles";
const ECONOMY_HEATMAP_CANVAS_CLASS = "openfront-helper-economy-heatmap-canvas";
const EXPORT_PARTNER_HEATMAP_CONTAINER_ID =
  "openfront-helper-export-partner-heatmap-layer";
const EXPORT_PARTNER_HEATMAP_STYLE_ID =
  "openfront-helper-export-partner-heatmap-styles";
const EXPORT_PARTNER_HEATMAP_CANVAS_CLASS =
  "openfront-helper-export-partner-heatmap-canvas";
const HELPER_STATS_CONTAINER_ID = "openfront-helper-stats-container";
const HELPER_STATS_STYLE_ID = "openfront-helper-stats-container-styles";
const GOLD_PER_MINUTE_BADGE_ID = "openfront-helper-gpm-badge";
const GOLD_PER_MINUTE_STYLE_ID = "openfront-helper-gpm-styles";
const TEAM_GOLD_PER_MINUTE_BADGE_ID = "openfront-helper-team-gpm-badge";
const TEAM_GOLD_PER_MINUTE_STYLE_ID = "openfront-helper-team-gpm-styles";
const TOP_GOLD_PER_MINUTE_BADGE_ID = "openfront-helper-top-gpm-badge";
const TOP_GOLD_PER_MINUTE_STYLE_ID = "openfront-helper-top-gpm-styles";
// localStorage keys for user-dragged positions of the gold readouts.
const HELPER_STATS_POS_KEY = "openfront-helper-stats-container-pos";
const TOP_GOLD_PER_MINUTE_POS_KEY = "openfront-helper-top-gpm-pos";
const TRADE_BALANCE_BADGE_ID = "openfront-helper-trade-balance-badge";
const TRADE_BALANCE_STYLE_ID = "openfront-helper-trade-balance-styles";
const NUKE_LANDING_CONTAINER_ID = "openfront-helper-nuke-landing-layer";
const NUKE_LANDING_STYLE_ID = "openfront-helper-nuke-landing-styles";
const BOAT_LANDING_CONTAINER_ID = "openfront-helper-boat-landing-layer";
const BOAT_LANDING_STYLE_ID = "openfront-helper-boat-landing-styles";
const BOAT_PANEL_ID = "openfront-helper-boat-panel";
const BOAT_PANEL_STYLE_ID = "openfront-helper-boat-panel-styles";
const BOAT_ALERT_CONTAINER_ID = "openfront-helper-boat-alert-layer";
const BOAT_ALERT_STYLE_ID = "openfront-helper-boat-alert-styles";
const NUKE_SUGGESTION_CONTAINER_ID = "openfront-helper-nuke-suggestion-layer";
const NUKE_SUGGESTION_STYLE_ID = "openfront-helper-nuke-suggestion-styles";
const NUKE_SUGGESTION_REFRESH_MS = 1800;
const GOLD_PER_MINUTE_SAMPLE_MS = 1000;
const GOLD_PER_MINUTE_RENDER_MS = 250;
const GOLD_PER_MINUTE_WINDOW_MS = 60000;
// Heatmap layers must keep pace with the game canvas while panning, otherwise
// the helper layer visibly lags behind. Capped at ~60 Hz (matches the typical
// rAF cadence); per-frame work is throttled by the cached data path instead.
const ECONOMY_HEATMAP_DRAW_MS = 16;
const EXPORT_PARTNER_HEATMAP_DRAW_MS = 16;
const EXPORT_PARTNER_HEATMAP_SOURCE_CACHE_MS = 500;
const ECONOMY_HEATMAP_DATA_REFRESH_MS = 1000;
const TRADE_BALANCE_RENDER_MS = 250;
const ECONOMY_HEATMAP_VIEWPORT_PADDING = 120;
const ECONOMY_HEATMAP_REVENUE_WINDOW_MS = 180000;
const HEATMAP_REFERENCE_ZOOM = 1.8;
// Team base colors, kept in sync with the game's default theme palette
// (src/client/render/gl/default-theme.json `teamColors` as of v0.32.3). Used as
// a fallback when the live per-player color is unreachable (see getTeamColor /
// getPlayerColor in shared-utils.js). For 8+ teams the game names teams
// "Team 1".."Team N" — not in this map — so getTeamColor derives those from a
// living member's color, or generates a distinct deterministic one.
const TEAM_COLORS = {
  Red: "#eb3333",
  Blue: "#2962ff",
  Teal: "#2bd4bd",
  Purple: "#9234ea",
  Yellow: "#e7b008",
  Orange: "#f97415",
  Green: "#41be52",
  Bot: "#d1cdc7",
  Humans: "#2962ff",
  Nations: "#eb3333",
};

let botMarkersEnabled = false;
let botMarkerAnimationFrame = null;
let allyMarkersEnabled = false;
let allyMarkerAnimationFrame = null;
let allianceRequestsPanelEnabled = false;
let allianceRequestsPanelAnimationFrame = null;
let allianceFocusFlashAnimationFrame = null;
let goldPerMinuteEnabled = false;
let goldPerMinuteInterval = null;
let goldPerMinuteAnimationFrame = null;
let lastGoldPerMinuteSampleAt = 0;
let lastGoldPerMinuteRenderAt = 0;
let goldPerMinuteRenderSignature = "";
let lastProcessedIncomingGoldTransferTick = null;
let teamGoldPerMinuteEnabled = false;
let teamGoldPerMinuteAnimationFrame = null;
let lastTeamGoldPerMinuteRenderAt = 0;
let teamGoldPerMinuteRenderSignature = "";
let topGoldPerMinuteEnabled = false;
let topGoldPerMinuteAnimationFrame = null;
let lastTopGoldPerMinuteRenderAt = 0;
let topGoldPerMinuteRenderSignature = "";
let tradeBalancesEnabled = false;
let tradeBalanceAnimationFrame = null;
let lastProcessedTradeBalanceTick = null;
let lastTradeBalanceRenderAt = 0;
let tradeBalanceRenderSignature = "";
let nukePredictionEnabled = false;
// Sub-toggle of nuke prediction: the flight-path (trajectory) line. Default on.
let nukeTrajectoryEnabled = true;
let nukeLandingAnimationFrame = null;
let boatPredictionEnabled = false;
let boatPredictionAlwaysOwnRoutes = false;
let boatPredictionAlwaysTeamRoutes = false;
let boatPredictionAlwaysAllyRoutes = false;
let boatPredictionAlwaysEnemyRoutes = false;
let boatLandingAnimationFrame = null;
// Boat list panel: open state + the boat id the user is hovering in the list.
// The map overlay reads these so a focused boat draws its route/highlight even
// when the prediction overlay itself is off.
let boatPanelOpen = false;
let boatPanelFocusedId = null;
// Incoming-boat warning: when on, a new transport that targets my territory
// raises a center-screen alert (like the Missile Silo warning). Keeps the scan
// loop alive on its own so it works without the overlay or panel.
let boatWarnIncoming = false;
let nukeSuggestionsEnabled = false;
let nukeSuggestionAnimationFrame = null;
let autoNukeEnabled = false;
let autoNukePatchTimeout = null;
let lastNukeSuggestionComputedAt = 0;
let lastNukeSuggestionSignature = "";
let lastNukeSuggestionSignatureCheckAt = 0;
let currentNukeSuggestionResults = [];
let nukeSuggestionTileComputeKey = null;
let economyHeatmapEnabled = false;
let economyHeatmapAnimationFrame = null;
let lastEconomyHeatmapDrawAt = 0;
let lastEconomyHeatmapDataAt = 0;
let economyHeatmapDataGame = null;
let economyHeatmapSources = [];
let economyHeatmapIntensity = 1;
let exportPartnerHeatmapEnabled = false;
let exportPartnerHeatmapAnimationFrame = null;
let lastExportPartnerHeatmapDrawAt = 0;
let exportPartnerHeatmapSourceCacheGame = null;
let exportPartnerHeatmapSourceCachePlayerId = null;
let exportPartnerHeatmapSourceCacheAt = 0;
let exportPartnerHeatmapSourceCache = [];
let selectiveTradePolicyEnabled = false;
let selectiveTradePolicyNeedsEmbargoSync = false;
let selectiveTradePolicyMyPlayerId = null;
let lastSelectiveTradePolicyRequestAt = null;
let lastReportedSelectiveTradePolicyAvailability = null;
let lastReportedCheatsAvailability = null;
let lastOpenFrontGameContext = null;

// Game-time alert: one-shot center-screen notice at a configurable match time.
const GAME_TIME_ALERT_CONTAINER_ID = "openfront-helper-game-time-alert-layer";
const GAME_TIME_ALERT_STYLE_ID = "openfront-helper-game-time-alert-styles";
let gameTimeAlertEnabled = false;
let gameTimeAlertThresholdSec = 300;
let gameTimeAlertInterval = null;
let gameTimeAlertFired = false;
let gameTimeAlertLastGame = null;

// Master gate for all per-player on-map overlays (troop/threat/money). Defaults
// on so overlays enabled via settings show before the first sync arrives.
let playerMapOverlaysEnabled = true;
// Per-player on-map overlay (troop counts) — first layer on the shared scheduler.
let mapTroopCountsEnabled = false;
// Per-player threat marks (☢ nuke-capable, weak/danger dots) on the same layer.
let threatIndicatorsEnabled = false;
// Per-player gold readout on the same layer.
let mapMoneyEnabled = false;
// Attack-highlight overlay (who is attacking you) — its own scheduler layer.
let attackHighlightEnabled = false;
// Advisor panel (manual-play HUD): economy state, expansion advice, top threats.
const ADVISOR_PANEL_ID = "openfront-helper-advisor-panel";
const ADVISOR_PANEL_STYLE_ID = "openfront-helper-advisor-panel-styles";
const ADVISOR_PANEL_POS_KEY = "openfront-helper-advisor-panel-pos";
let advisorPanelEnabled = false;

// Quick Panel — compact tabbed floating control panel for fast settings + WS actions.
const QUICK_PANEL_ID = "openfront-helper-quick-panel";
const QUICK_PANEL_STYLE_ID = "openfront-helper-quick-panel-styles";
const QUICK_PANEL_POS_KEY = "openfront-helper-quick-panel-pos";
let quickPanelEnabled = false;

// Retaliation HUD: semi-auto nuke counter-attack confirmation card.
const RETALIATION_CONTAINER_ID = "openfront-helper-retaliation-layer";
const RETALIATION_STYLE_ID = "openfront-helper-retaliation-styles";
let retaliationEnabled = false;
let retaliationInterval = null;

// Hide ads: CSS injection.
const HIDE_ADS_STYLE_ID = "openfront-helper-hide-ads-style";
// Attack-ratio hotkey: Shift+1..0 set attack ratio 10%..100%.
let attackRatioHotkeyEnabled = false;
// Right-click conquest menu: one-click attack + alliance policy.
const RIGHT_CLICK_MENU_ID = "openfront-helper-right-click-menu";
const RIGHT_CLICK_STYLE_ID = "openfront-helper-right-click-styles";
let rightClickMenuEnabled = false;

// Round logger: timeline JSON + combat outcome tracking.
let roundLoggerEnabled = false;
// Network logger: hook fetch/XHR metadata.
let networkLoggerEnabled = false;

// Build timer overlay: construction countdown + missile cooldown above silos/SAMs.
let buildTimerEnabled = false;
// Enemy-intent early warning: WebSocket hook to detect incoming attacks/boats.
let enemyIntentEnabled = false;
// Spawn heatmap overlay: colored grid showing spawn quality.
let spawnHeatmapEnabled = false;
let spawnMarkersEnabled = false;
// Anti-AFK: Web Worker keep-alive for background tabs.
let antiAfkEnabled = false;

const goldTrackers = new Map();
const incomingGoldTransfers = new Map();
const tradeBalanceTrackers = new Map();
const exportPartnerSourceTrackers = new Map();
const economyRevenueSourceTrackers = new Map();
const factoryPortSpendTrackers = new Map();
const factoryPortUnitTrackers = new Map();
const trainTradeTrackers = new Map();
const tradeShipSourceTrackers = new Map();
const autoNukeOriginalRootSubMenus = new Map();
const autoNukeOriginalAttackSubMenus = new Map();
const selectiveTradePolicyAllowedPartnerIds = new Set();
const originalPlayerHasEmbargoMethods = new WeakMap();
const allianceRequestsPanelEvents = [];
const capturedAllianceRequestEvents = new WeakSet();
let allianceRequestsPanelRenderSignature = "";
// Auto-renew: when on, the alliance requests panel auto-confirms renewal
// prompts (RENEW_ALLIANCE / type 24) so expiring alliances are re-sent without
// a manual click. Persisted in localStorage; the position is saved per drag.
const ALLIANCE_REQUEST_PANEL_POS_KEY =
  "openfront-helper-alliance-request-panel-pos";
const ALLIANCE_REQUEST_PANEL_AUTORENEW_KEY =
  "openfront-helper-alliance-request-autorenew";
let allianceRequestsAutoRenewEnabled = false; // ofbot: localStorage read removed (alliance-requests panel not ported)
const autoRenewedAllianceEvents = new WeakSet();
function toFiniteNumber(value, fallback = 0) {
  const numberValue = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function getUnitLevel(unit) {
  return Math.max(1, toFiniteNumber(unit?.level?.(), 1));
}

// ---------- Consolidated helper update scheduler ----------
// Replaces 4 self-recursive requestAnimationFrame loops (gold-per-minute,
// team-gpm, top-gpm, trade-balance). Each helper registers a callback that
// runs at HELPER_TICK_INTERVAL_MS instead of waking the main thread every
// 16 ms only to throttle itself back to 250 ms.
const HELPER_TICK_INTERVAL_MS = 250;
const _helperTickListeners = new Set();
let _helperTickIntervalId = null;

function _runHelperTick() {
  for (const listener of _helperTickListeners) {
    try {
      listener();
    } catch (error) {
      console.error("OpenFront helper tick listener failed:", error);
    }
  }
}

function _ensureHelperTickRunning() {
  if (_helperTickIntervalId !== null) {
    return;
  }
  _helperTickIntervalId = window.setInterval(_runHelperTick, HELPER_TICK_INTERVAL_MS);
}

function registerHelperTickListener(fn) {
  if (typeof fn !== "function") {
    return;
  }
  _helperTickListeners.add(fn);
  _ensureHelperTickRunning();
  try {
    fn();
  } catch (error) {
    console.error("OpenFront helper tick listener (initial) failed:", error);
  }
}

function unregisterHelperTickListener(fn) {
  _helperTickListeners.delete(fn);
  if (_helperTickListeners.size === 0 && _helperTickIntervalId !== null) {
    window.clearInterval(_helperTickIntervalId);
    _helperTickIntervalId = null;
  }
}

// Sync a panel's visibility state back to the Quick Panel. Panel setters call
// this so the Quick Panel toggle reflects the actual state when a panel is
// closed via its own X button (not just the QP toggle).
function _qpSync(settingKey, enabled) {
  try {
    window.dispatchEvent(new CustomEvent("ofh-quick-panel-setting", {
      detail: { key: settingKey, value: !!enabled }
    }));
  } catch (e) {}
}
