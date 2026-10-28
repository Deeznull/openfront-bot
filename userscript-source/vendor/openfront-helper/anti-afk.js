// Adapted from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/anti-afk.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Changed: nothing runs at load (upstream overrode window.setInterval and started
// a Worker on load). The setInterval-to-Worker hub is gone: the bot's page.ts
// already runs every window.setInterval on a worker clock while the tab is
// hidden. The 15 s keep-alive no longer sends a hand-built JSON ping over the
// WebSocket (the game's wire format is binary zbin since v0.35, and the server
// kicks a client whose message it can't decode); it calls the game's own 5 s
// ping callback instead, which encodes and sends the ping through the game's
// Transport and checks the socket itself. Off restores window.setInterval.

// Anti-AFK: keeps the server from marking the player as disconnected (no ping
// for 30 s) when the browser tab sits in the background.

let _antiAfkPrevSetInterval = null; // window.setInterval before our wrapper
let _antiAfkWrapper = null;
let _antiAfkKeepAliveInterval = null;
let _antiAfkPingFn = null; // the game's Transport ping callback, once seen
let _antiAfkPingLastRun = 0;

const ANTI_AFK_KEEPALIVE_MS = 15000;
const ANTI_AFK_PING_STALE_MS = 12000;

// Transport.startPing: setInterval(() => { ... sendMsg({ type: "ping", sentAt }) }, 5000)
function _antiAfkIsGamePing(fn, ms) {
  if (Number(ms) !== 5000 || typeof fn !== "function") return false;
  try {
    const src = String(fn);
    return /["']?type["']?\s*:\s*["']ping["']/.test(src) && src.indexOf("sentAt") !== -1;
  } catch (_e) {
    return false;
  }
}

function _antiAfkInstallWrapper() {
  if (_antiAfkWrapper) return;
  const prev = window.setInterval;
  _antiAfkPrevSetInterval = prev;
  _antiAfkWrapper = function (fn, ms, ...args) {
    // Pass-through: same arguments, same id. Only the game's ping callback is
    // wrapped, to note when it last ran and to keep a handle on it.
    if (antiAfkEnabled && _antiAfkIsGamePing(fn, ms)) {
      const orig = fn;
      const wrapped = function (...a) {
        _antiAfkPingLastRun = performance.now();
        return orig.apply(this, a);
      };
      _antiAfkPingFn = wrapped;
      _antiAfkPingLastRun = performance.now();
      return prev.call(window, wrapped, ms, ...args);
    }
    return prev.call(window, fn, ms, ...args);
  };
  window.setInterval = _antiAfkWrapper;
}

function _antiAfkRemoveWrapper() {
  // Restore only if nobody wrapped setInterval on top of ours since; otherwise
  // leave ours in place, where it is a plain pass-through while disabled.
  if (_antiAfkWrapper && window.setInterval === _antiAfkWrapper) {
    window.setInterval = _antiAfkPrevSetInterval;
    _antiAfkWrapper = null;
    _antiAfkPrevSetInterval = null;
  }
}

// ---- Extra keep-alive ping when tab is hidden ----

function _sendKeepAlivePing() {
  if (!antiAfkEnabled || !_antiAfkPingFn) return;
  if (performance.now() - _antiAfkPingLastRun < ANTI_AFK_PING_STALE_MS) return;
  try {
    _antiAfkPingFn();
    console.log("[AntiAFK] keep-alive ping sent");
  } catch (_e) {
    _antiAfkPingFn = null; // that game is gone
  }
}

function _startKeepAlive() {
  if (_antiAfkKeepAliveInterval !== null) return;
  _antiAfkKeepAliveInterval = window.setInterval(function () {
    if (document.hidden) {
      _sendKeepAlivePing();
    }
  }, ANTI_AFK_KEEPALIVE_MS);
}

function _stopKeepAlive() {
  if (_antiAfkKeepAliveInterval !== null) {
    window.clearInterval(_antiAfkKeepAliveInterval);
    _antiAfkKeepAliveInterval = null;
  }
}

// ---- Feature toggle ----

function setAntiAfkEnabled(enabled) {
  antiAfkEnabled = !!enabled;
  if (antiAfkEnabled) {
    _antiAfkInstallWrapper();
    _startKeepAlive();
  } else {
    _stopKeepAlive();
    _antiAfkRemoveWrapper();
    _antiAfkPingFn = null;
  }
}
