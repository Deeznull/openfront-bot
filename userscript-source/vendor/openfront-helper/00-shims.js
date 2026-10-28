// ofbot shims for the vendored openfront-helper modules (not upstream code).
// tr(): upstream i18n lookup replaced by an English pass-through with {name}
// placeholder substitution. getTradeEventGoldAmount(): copied from upstream
// engine/ingame/trade-balances.js (that module itself is not ported), used by
// gold-per-minute.js.
function tr(k,p){let s=k;if(p)for(const n in p)s=s.split("{"+n+"}").join(String(p[n]));return s;}

function getTradeEventGoldAmount(value) {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return Number(value);
}

// ---- Shims for the acting features (auto-donate, sos-defense) ----
// They send nothing over the WebSocket. Every intent goes through the bot's own
// play-aid path (page.ts publishes it as window.__ofbotHelper.api): the game's
// EventBus and Transport encode and send it, and it shares the bot's rate
// limiter (5/s, 130/min in multiplayer). Without that API they send nothing.
function _ofbotHelperSend(intent) {
  try {
    const api = window.__ofbotHelper && window.__ofbotHelper.api;
    return !!(api && typeof api.send === "function" && api.send(intent));
  } catch (_e) {
    return false;
  }
}

// Upstream ws-hook.js sendGamePacket(obj); here obj is an intent in the bot's
// shape ({ type: "donate_troops", recipient, troops } etc.).
function sendGamePacket(obj) {
  return _ofbotHelperSend(obj);
}

// Upstream signal-scheduler.js enqueueSignal(kind, recipient, args), as
// sos-defense.js calls it: ("emoji", player, [player, emojiId]) and
// ("target", player, [playerId]). Sent at once; sos-defense already spaces
// them past the game's per-recipient cooldowns.
function enqueueSignal(kind, recipient, args) {
  try {
    if (kind === "emoji") {
      const to = args && args[0];
      const id = to && typeof to.id === "function" ? to.id() : null;
      if (id == null || !(args[1] >= 0)) return false;
      return _ofbotHelperSend({ type: "emoji", recipient: id, emoji: args[1] });
    }
    if (kind === "target") {
      const target = args && args[0];
      if (target == null) return false;
      return _ofbotHelperSend({ type: "targetPlayer", target: target });
    }
  } catch (_e) {}
  return false;
}

// The game's emoji table (OpenFrontIO packages/engine-api/src/Schemas.ts
// emojiTable, flattened); an emoji intent carries the index. Upstream's
// auto-bot/emojiBehavior.js has the same lookup.
const _OFBOT_EMOJI_TABLE = [
  "😀", "😊", "🥰", "😇", "😎",
  "😞", "🥺", "😭", "😱", "😡",
  "😈", "🤡", "🥱", "🫡", "🖕",
  "👋", "👏", "✋", "🙏", "💪",
  "👍", "👎", "🫴", "🤌", "🤦‍♂️",
  "🤝", "🆘", "🕊️", "🏳️", "⏳",
  "🔥", "💥", "💀", "☢️", "⚠️",
  "↖️", "⬆️", "↗️", "👑", "🥇",
  "⬅️", "🎯", "➡️", "🥈", "🥉",
  "↙️", "⬇️", "↘️", "❤️", "💔",
  "💰", "⚓", "⛵", "🏡", "🛡️",
  "🏭", "🚂", "❓", "🐔", "🐀",
];
const emojiId = (e) => _OFBOT_EMOJI_TABLE.indexOf(e);

// Upstream reads auto-donate settings from its Quick Panel settings cache. Here
// it holds fixed defaults (the upstream fallbacks, documented in README.md);
// the auto-donate toggle sets the two *Enabled flags. Optional override: a JSON
// object in localStorage "ofbot-helper-settings" with any of these keys, read
// each time the feature is switched on.
const _OFBOT_HELPER_SETTING_DEFAULTS = {
  autoDonateEnabled: false,
  autoDonateKeepPct: 40, // donate troops only above 40% of max troops
  autoDonatePercentage: 25, // send 25% of current troops
  autoDonateTargets: "", // comma-separated names; empty = friendly players
  autoDonateGoldEnabled: false,
  autoDonateGoldThreshold: 5000000, // donate gold only above 5M
  autoDonateGoldPercentage: 25, // send 25% of current gold
  autoDonateGoldTargets: "", // comma-separated names; empty = friendly players
};
const _quickPanelSettingsCache = Object.assign({}, _OFBOT_HELPER_SETTING_DEFAULTS);

function _ofbotLoadHelperSettings() {
  Object.assign(_quickPanelSettingsCache, _OFBOT_HELPER_SETTING_DEFAULTS);
  try {
    const raw = localStorage.getItem("ofbot-helper-settings");
    const o = raw ? JSON.parse(raw) : null;
    if (o && typeof o === "object") {
      for (const k in _OFBOT_HELPER_SETTING_DEFAULTS) {
        if (k.endsWith("Enabled") || !(k in o)) continue;
        if (typeof o[k] === typeof _OFBOT_HELPER_SETTING_DEFAULTS[k]) _quickPanelSettingsCache[k] = o[k];
      }
    }
  } catch (_e) {}
}
