/**
 * Page side of the OpenFront bot userscript.
 *
 * - Wraps `window.Worker` (document-start) so it sees the game's engine
 *   worker: the `init` and `turn` messages the page sends it are copied to a
 *   shadow engine (shadow.ts), and the state hashes it sends back are
 *   compared with the shadow's to prove the two games are identical. The
 *   worker's per-tick updates are forwarded too: on engines without snapshots
 *   a hash mismatch switches the shadow to mirror mode (mirror.ts), where it
 *   follows the real game instead of the bot stopping.
 * - Intents the shadow's bot produces are sent through the game's own UI
 *   event bus (the Transport's handlers), i.e. exactly like clicks.
 * - Plays in any game mode where we have our own player (not replays/spectating).
 */
import { GameUpdateType } from "ofenums";
import { type FeedEntry, feedEntry, feedTransfers, findHashes } from "./feed";
import { FARM_TWEAKS } from "./farm-params";
import { FfaClaims, holdLock, JOIN_WAIT_MS, joinable, LockClaims, SKIP_MS } from "./ffa-claim";
import { type GameRec, recAll, recExport, recFinish, recNew, recSave } from "./rec";
import { type Aid, type AidApi, allAids, setAid } from "./aids";

declare function __ofbotShadowMain(): void;
declare const __OFBOT_VERSION__: string;

type Intent = { type: string; [k: string]: any };

const W = window as any;
const RealWorker: typeof Worker = W.Worker;
const HASH = GameUpdateType.Hash as number;

// ---------------------------------------------------------------- settings

interface Settings {
  autoStart: boolean;
  emojis: boolean;
  team: boolean;
  share: boolean;
  farm: boolean; // also turbo: Max speed, next turn as soon as the last is done
  farmGames: number;
  farmPublic: boolean; // farm: public FFA games once the day's XP solo games are used
  farmSolo?: boolean; // false: the farm skips solo games (no panel option; headless recorder)
  min: boolean; // panel collapsed to its header
  opts: boolean; // options (checkboxes) folded away
  aids?: Record<string, boolean>; // play aids on/off by key (src/aids)
  aidsOpen?: boolean; // play aids list unfolded
  v?: number; // settings format: 3 = no separate turbo option (farm has it)
  x: number;
  y: number;
}
const SETTINGS_KEY = "ofbot.settings.v1";
// x < 0: default spot at the top right, under the game's timer bar.
const settings: Settings = { autoStart: false, emojis: false, team: true, share: true, farm: false, farmGames: 0, farmPublic: true, min: false, opts: false, x: -1, y: 130 };
try {
  const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  // Before 0.6.2 turbo was its own option; farm includes it now.
  delete stored.turbo;
  Object.assign(settings, stored, { v: 3 });
} catch {
  /* private window / blocked storage: defaults */
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------- game context

interface ShadowHandle {
  post(msg: any, transfer?: Transferable[]): void;
  stop(): void;
}

interface GameCtx {
  realWorker: Worker;
  realPost: (msg: any, transfer?: any) => void;
  gameType: string;
  farm: boolean; // Easy solo: the farm profile (FARM_TWEAKS) plays it
  allowed: boolean;
  reason: string;
  clientID: string | undefined;
  init: any; // cloned init message (kept for a page-thread fallback restart)
  turns: any[];
  shadow: ShadowHandle | null;
  shadowReady: boolean;
  onPage: boolean;
  myID: string | null;
  realHashes: Map<number, number>;
  shadowHashes: Map<number, number>;
  syncedTick: number;
  realTick: number; // last hash tick of the real game
  shadowTick: number; // last tick the shadow (and so the bot) has played
  shadowSeenAt: number; // wall time the shadow last advanced
  resyncing: boolean;
  snapId: string | null;
  canSnapshot: boolean;
  desyncTimes: number[];
  real: FeedEntry[]; // real updates kept only for a restart before ready
  mirror: boolean;
  lost: boolean;
  sync: any;
  lastHashOk: number;
  queue: { i: Intent; at: number; key: string }[];
  sent: number;
  dropped: number;
  stats: any;
  bus: any;
  handlers: Record<string, (e: any) => void> | null;
  rec: GameRec | null;
}

let ctx: GameCtx | null = null;
let botOn = false; // user's Start/Stop choice (applies to the current/next game)
let lastMsg = "";
let snapCounter = 0;

function note(msg: string) {
  lastMsg = msg;
  console.info("[ofbot]", msg);
  render();
}

// ------------------------------------------------------------- solo turbo (farm)
// Solo games (and replays) run on a local server that checks every 5 ms
// whether the engine finished the last turn and, at Max speed, hands out the
// next one. Browsers stretch that timer to >= 4 ms, and to once a second in a
// background tab. Farm (turbo) runs the same check right after each engine message
// (a MessageChannel task, which background tabs don't throttle), so at Max
// the next turn starts as soon as the last one is done. The check itself
// still decides: at the other speeds nothing changes. Multiplayer servers
// pace turns themselves, so it has no effect there.
let turnPoll: (() => void) | null = null;
let turnPollId: unknown = null;
let turnsPosted = 0;
let kickAt = 0;
const realSetInterval = W.setInterval.bind(W);
const realClearInterval = W.clearInterval.bind(W);

// Background tabs (0.6.3.1): a hidden tab's timers run at most once a second,
// and once a minute after ~5 minutes, so a solo game's turns (the 5 ms check)
// and the bot's sends (pump) all but stop. While the tab is hidden a worker
// clock (worker timers and their messages are not throttled) runs every
// interval made through window.setInterval at its own pace instead; the real
// timers stand down meanwhile. A held Web Lock keeps the tab from being frozen.
// The game's picture (requestAnimationFrame) still pauses until the tab is back.
type Tick = { fn: (...a: any[]) => unknown; ms: number; args: any[]; last: number };
const ticks = new Map<unknown, Tick>();
let clock: Worker | null = null;
let unlock: (() => void) | null = null;
function clockTick() {
  const now = performance.now();
  for (const t of ticks.values()) {
    if (now - t.last < t.ms) continue;
    t.last = now;
    try {
      t.fn(...t.args);
    } catch (e) {
      console.warn("[ofbot] background tick failed", e);
    }
  }
}
function setClock() {
  if (!document.hidden) {
    clock?.terminate();
    clock = null;
    unlock?.();
    unlock = null;
    return;
  }
  if (!clock) {
    try {
      const url = URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),4)"], { type: "text/javascript" }));
      clock = new RealWorker(url);
      clock.onmessage = clockTick;
    } catch {
      clock = null; // no workers: the throttled real timers carry on
    }
  }
  const locks = (navigator as any).locks;
  if (!unlock && locks?.request) {
    locks.request("ofbot-awake", () => new Promise<void>((res) => (unlock = res))).catch(() => {});
  }
}
document.addEventListener("visibilitychange", setClock);

W.setInterval = (fn: any, ms?: number, ...args: any[]) => {
  if (typeof fn !== "function") return realSetInterval(fn, ms, ...args);
  let run = fn;
  const isTurnPoll = ms === 5 && /replaySpeedMultiplier|turnIntervalMs/.test(String(fn));
  if (isTurnPoll) {
    // The local server's turn check: no new turn while the bot's shadow lags.
    run = function (this: any, ...a: any[]) {
      if (shadowLagging()) return;
      return fn.apply(this, a);
    };
  }
  const t: Tick = { fn: run, ms: Math.max(4, Number(ms) || 0), args, last: performance.now() };
  const id = realSetInterval(
    function (this: any, ...a: any[]) {
      if (clock) return; // hidden: the worker clock runs it
      t.last = performance.now();
      return run.apply(this, a);
    },
    ms,
    ...args,
  );
  ticks.set(id, t);
  if (isTurnPoll) {
    turnPoll = run;
    turnPollId = id;
  }
  return id;
};
W.clearInterval = (id?: any) => {
  if (id !== undefined && id === turnPollId) turnPoll = turnPollId = null;
  ticks.delete(id);
  return realClearInterval(id);
};
const realClearTimeout = W.clearTimeout.bind(W);
W.clearTimeout = (id?: any) => {
  // clearTimeout also stops an interval
  if (ticks.delete(id) && id === turnPollId) turnPoll = turnPollId = null;
  return realClearTimeout(id);
};
const kick = new MessageChannel();
kick.port1.onmessage = () => {
  if (!turnPoll || !settings.farm) return;
  const before = turnsPosted;
  try {
    turnPoll();
  } catch {
    turnPoll = null; // the game changed: leave its own timer alone
    return;
  }
  // The check wants a new millisecond; retry briefly instead of waiting 4 ms.
  if (turnsPosted === before && Date.now() - kickAt < 2) kick.port2.postMessage(0);
};
// Solo pacing (live 2026-10-17: an Easy farm game at Max speed ran 16 game
// minutes ahead of the shadow, so the bot played a stale game, banked 290M
// gold and lost). The local server hands out no new turn while the real game
// is more than SHADOW_MAX_LAG ticks ahead of the shadow; the game waits for
// the bot instead of leaving it behind. Multiplayer servers pace themselves.
const SHADOW_MAX_LAG = 60; // ticks (6 s of game time)
const SHADOW_STALL_MS = 15_000;
function shadowLagging(): boolean {
  const c = ctx;
  if (!c || !botOn || !c.allowed || c.gameType !== "Singleplayer") return false;
  if (!c.shadowReady || c.mirror || c.lost || c.resyncing || c.realTick < 0) return false;
  // A shadow that stopped advancing (crashed worker) must not freeze the game.
  if (Date.now() - c.shadowSeenAt > SHADOW_STALL_MS) return false;
  return c.realTick - c.shadowTick > SHADOW_MAX_LAG;
}

function kickTurn() {
  if (!turnPoll || !settings.farm) return;
  kickAt = Date.now();
  kick.port2.postMessage(0);
}

// ------------------------------------------------------------ worker hook

class HookedWorker extends RealWorker {
  constructor(url: string | URL, opts?: WorkerOptions) {
    super(url, opts);
    try {
      hook(this);
    } catch (e) {
      console.warn("[ofbot] hook failed", e);
    }
  }
}
W.Worker = HookedWorker;

// -------------------------------------------------------- multi-tab lock
// The game's MultiTabDetector keeps a "multi-tab-lock" item in localStorage
// and slaps a 10s penalty on the tab whenever it sees another owner's lock.
// We don't want it: delete the key whenever present and hide it from the
// detector so getItem never returns a foreign lock and writes are dropped.
try {
  const LOCK_KEY = "multi-tab-lock";
  const ls = window.localStorage;
  const proto = Object.getPrototypeOf(ls) as Storage;
  const get = proto.getItem.bind(ls);
  const set = proto.setItem.bind(ls);
  const rem = proto.removeItem.bind(ls);
  rem(LOCK_KEY);
  ls.getItem = (k: string) => (k === LOCK_KEY ? null : get(k));
  ls.setItem = (k: string, v: string) => { if (k !== LOCK_KEY) set(k, v); };
  ls.removeItem = (k: string) => rem(k);
  // Stray lock written before we loaded, or by another tab, gets cleared too.
  setInterval(() => { if (get(LOCK_KEY) !== null) rem(LOCK_KEY); }, 500);
} catch (e) {
  console.warn("[ofbot] multi-tab-lock neutralize failed", e);
}

function hook(w: Worker) {
  const realPost = RealWorker.prototype.postMessage.bind(w) as (m: any, t?: any) => void;
  const realTerminate = RealWorker.prototype.terminate.bind(w);
  (w as any).postMessage = (msg: any, transfer?: any) => {
    try {
      if (msg && typeof msg === "object") {
        if (msg.type === "turn") turnsPosted++;
        if (msg.type === "init" && msg.gameStartInfo) {
          // Clone before the real post detaches the transferred map buffers.
          onInit(w, realPost, structuredClone({ ...msg, id: undefined }));
        } else if (ctx?.realWorker === w) {
          if (msg.type === "turn") onTurn(structuredClone(msg.turn));
          else if (msg.type === "run_turns" || msg.type === "connect") {
            disposeCtx("replay / spectator engine — bot off");
          }
        }
      }
    } catch (e) {
      console.warn("[ofbot] mirror failed", e);
    }
    return realPost(msg, transfer);
  };
  (w as any).terminate = () => {
    if (ctx?.realWorker === w) disposeCtx("game closed");
    return realTerminate();
  };
  w.addEventListener("message", (e: MessageEvent) => {
    if (ctx?.realWorker === w) onRealMessage(e.data);
    kickTurn();
  });
}

function disposeCtx(reason: string) {
  if (!ctx) return;
  if (ctx.rec) recFinish(ctx.rec);
  ctx.shadow?.stop();
  ctx = null;
  note(reason);
}

function onInit(w: Worker, realPost: GameCtx["realPost"], init: any) {
  disposeCtx("new game");
  const gameType = String(init.gameStartInfo?.config?.gameType ?? "?");
  const clientID: string | undefined = init.clientID ?? undefined;
  let allowed = clientID !== undefined;
  let reason = "";
  if (clientID === undefined) {
    reason = "spectating / replay — nothing to play";
  }
  if (!allowed) init = null; // don't keep the map for a game we won't play
  ctx = {
    realWorker: w,
    realPost,
    gameType,
    farm: gameType === "Singleplayer" && String(init?.gameStartInfo?.config?.difficulty ?? "") === "Easy",
    allowed,
    reason,
    clientID,
    init,
    turns: [],
    shadow: null,
    shadowReady: false,
    onPage: false,
    myID: null,
    realHashes: new Map(),
    shadowHashes: new Map(),
    syncedTick: -1,
    realTick: -1,
    shadowTick: -1,
    shadowSeenAt: 0,
    resyncing: false,
    snapId: null,
    canSnapshot: false,
    desyncTimes: [],
    real: [],
    mirror: false,
    lost: false,
    sync: null,
    lastHashOk: Date.now(),
    queue: [],
    sent: 0,
    dropped: 0,
    stats: null,
    bus: null,
    handlers: null,
    rec: allowed ? recNew(init, __OFBOT_VERSION__) : null,
  };
  if (!allowed) {
    note(reason);
    return;
  }
  if (settings.autoStart || (settings.farm && (gameType === "Singleplayer" || (gameType === "Public" && settings.farmPublic))))
    botOn = true;
  startShadow(ctx, false);
  note(`${gameType} game detected — starting shadow engine`);
}

function startShadow(c: GameCtx, onPage: boolean) {
  c.onPage = onPage;
  c.shadowReady = false;
  const onMsg = (m: any) => {
    if (ctx === c) onShadowMessage(c, m);
  };
  if (!onPage) {
    try {
      const src = `(${__ofbotShadowMain.toString()})()`;
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const sw = new RealWorker(url);
      sw.onmessage = (e) => onMsg(e.data);
      sw.onerror = (e) => {
        console.warn("[ofbot] shadow worker error", e);
        if (ctx === c && !c.shadowReady) {
          sw.terminate();
          startShadow(c, true);
        }
      };
      c.shadow = {
        post: (m, t) => sw.postMessage(m, t ?? []),
        stop: () => {
          sw.terminate();
          URL.revokeObjectURL(url);
        },
      };
    } catch (e) {
      console.warn("[ofbot] shadow worker blocked, running on page", e);
      return startShadow(c, true);
    }
  } else {
    if (!W.__ofbotCreateShadow) __ofbotShadowMain();
    const handle = W.__ofbotCreateShadow(onMsg, true);
    let stopped = false;
    c.shadow = {
      post: (m) => setTimeout(() => !stopped && handle(m), 0),
      stop: () => {
        stopped = true;
      },
    };
  }
  c.shadow.post({
    t: "init",
    gameStartInfo: c.init.gameStartInfo,
    clientID: c.clientID,
    mapSource: mapSourceFor(c.init),
    snapshot: c.init.snapshot,
  });
  for (const turn of c.turns) c.shadow.post({ t: "turn", turn });
  if (c.real.length) c.shadow.post({ t: "real", list: c.real });
}

/**
 * Older engines put the map files in the init message. Newer ones (the live site,
 * v0.34) send only `cdnBase` and the worker fetches the map itself; the shadow
 * does the same, with the page's asset manifest for the hashed file names.
 */
function mapSourceFor(init: any): any {
  if (init.map) return { files: structuredClone(init.map) };
  const boot = W.BOOTSTRAP_CONFIG ?? {};
  const cdn: string = init.cdnBase || boot.cdnBase || "";
  const base = new URL(cdn || "/", location.href).href;
  const manifest: Record<string, string> = {};
  for (const [k, v] of Object.entries(boot.assetManifest ?? {})) {
    if (k.startsWith("maps/") && typeof v === "string") manifest[k] = v;
  }
  return { assets: { base, manifest } };
}

function onTurn(turn: any) {
  const c = ctx;
  if (!c || !c.allowed || !c.shadow) return;
  if (!c.shadowReady) c.turns.push(turn); // kept only for a restart before ready
  c.shadow.post({ t: "turn", turn });
}

function onRealMessage(data: any) {
  const c = ctx;
  if (!c || !c.allowed || !data) return;
  // game_update_batch in v0.34; any message carrying engine updates in shape.
  const gus: any[] | null = Array.isArray(data.gameUpdates)
    ? data.gameUpdates
    : data.gameUpdate?.updates
      ? [data.gameUpdate]
      : null;
  if (gus) {
    const list: FeedEntry[] = [];
    for (const gu of gus) {
      for (const h of findHashes(gu, HASH)) {
        c.realTick = Math.max(c.realTick, h.tick);
        c.realHashes.set(h.tick, h.hash);
        compare(c, h.tick);
      }
      const e = feedEntry(gu);
      if (e) list.push(e);
    }
    if (list.length && c.shadow) {
      if (c.shadowReady) c.shadow.post({ t: "real", list }, feedTransfers(list));
      else {
        c.real.push(...list);
        c.shadow.post({ t: "real", list });
      }
    }
  } else if (data.type === "snapshot_result" && data.id && data.id === c.snapId) {
    c.snapId = null;
    if (!data.snapshot) {
      note("resync failed (no snapshot) — bot paused");
      setBot(false);
      return;
    }
    c.shadowHashes.clear();
    c.shadow?.post({ t: "resync", snapshot: data.snapshot }, [data.snapshot.buffer]);
  }
}

function compare(c: GameCtx, tick: number) {
  const a = c.realHashes.get(tick);
  const b = c.shadowHashes.get(tick);
  if (a === undefined || b === undefined || c.resyncing || c.mirror) return;
  c.realHashes.delete(tick);
  c.shadowHashes.delete(tick);
  if (a === b) {
    c.syncedTick = Math.max(c.syncedTick, tick);
    c.lastHashOk = Date.now();
    for (const m of [c.realHashes, c.shadowHashes]) {
      for (const t of m.keys()) if (t < tick - 600) m.delete(t);
    }
    return;
  }
  desync(c, tick);
}

function desync(c: GameCtx, tick: number) {
  const now = Date.now();
  c.desyncTimes = c.desyncTimes.filter((t) => now - t < 180_000);
  c.desyncTimes.push(now);
  c.queue.length = 0;
  if (!c.canSnapshot) {
    // No snapshot to resync from: keep playing, with the shadow following the
    // real game's own updates. Hashes can't confirm sync any more.
    c.mirror = true;
    c.shadow?.post({ t: "mirror", on: true });
    note(`shadow diverged from the game at tick ${tick} (newer game version?) — mirror mode: following the game's updates`);
    return;
  }
  if (c.desyncTimes.length > 4) {
    note(
      `shadow keeps diverging (tick ${tick}) — the script's engine doesn't match this site's version. ` +
        "Rebuild the userscript from the site's game code. Bot stopped.",
    );
    setBot(false);
    c.resyncing = true; // stop comparing
    return;
  }
  c.resyncing = true;
  c.snapId = `ofbot-snap-${++snapCounter}`;
  note(`desync at tick ${tick} — resyncing from the game's snapshot`);
  c.realPost({ type: "snapshot", id: c.snapId });
}

function onShadowMessage(c: GameCtx, m: any) {
  switch (m.t) {
    case "ready":
      c.shadowReady = true;
      c.myID = m.myID;
      c.canSnapshot = !!m.canSnapshot;
      // The shadow holds its own map copy and turn buffer now; free ours.
      c.turns.length = 0;
      c.real.length = 0;
      c.init.map = null;
      if (m.resync) {
        c.resyncing = false;
        note(`resynced at tick ${m.tick}`);
      } else {
        note(`shadow engine ready${c.onPage ? " (page thread)" : ""}`);
      }
      pushEnable();
      break;
    case "hash":
      if (m.tick > c.shadowTick) { c.shadowTick = m.tick; c.shadowSeenAt = Date.now(); }
      c.shadowHashes.set(m.tick, m.hash);
      compare(c, m.tick);
      break;
    case "intents":
      if (!botOn || c.resyncing || c.lost) return;
      for (const i of m.intents as Intent[]) enqueue(c, i);
      // Solo: send now, not at the next 100 ms pump (Max speed runs many ticks per pump).
      if (c.gameType === "Singleplayer") pump();
      break;
    case "state":
      if (Number.isFinite(m.tick) && m.tick > c.shadowTick) { c.shadowTick = m.tick; c.shadowSeenAt = Date.now(); }
      c.stats = m;
      render();
      break;
    case "sync":
      c.sync = m;
      break;
    case "rec":
      if (!c.rec) break;
      c.rec.cps.push(m.cp);
      c.rec.botOn ||= botOn;
      if (m.cp.died) c.rec.died = m.cp.tick;
      if (m.cp.died || c.rec.cps.length % 10 === 1) recSave(c.rec);
      break;
    case "diverged":
      // Ownership differs while no hash has matched for a while (hashes
      // missing or unreadable in this version): same as a hash mismatch.
      if (!c.mirror && Date.now() - c.lastHashOk > 30_000) desync(c, m.tick);
      break;
    case "lost":
      c.lost = true;
      c.queue.length = 0;
      note(`game version changed too much — rebuild needed (${m.msg}). Bot stopped.`);
      setBot(false);
      break;
    case "log":
      note(m.msg);
      break;
    case "error":
      console.warn("[ofbot]", m.msg);
      lastMsg = m.msg.split("\n")[0];
      render();
      break;
  }
}

// ---------------------------------------------------------- intent sending

/** Transport handler name and the UI event object it expects. */
const pid = (id: string) => ({ id: () => id });
const ROUTES: Record<string, [string, (i: Intent) => any]> = {
  attack: ["onSendAttackIntent", (i) => ({ targetID: i.targetID, troops: i.troops })],
  boat: ["onSendBoatAttackIntent", (i) => ({ troops: i.troops, dst: i.dst })],
  cancel_attack: ["onCancelAttackIntentEvent", (i) => ({ attackID: i.attackID })],
  cancel_boat: ["onCancelBoatIntentEvent", (i) => ({ unitID: i.unitID })],
  build_unit: [
    "onBuildUnitIntent",
    (i) => ({ unit: i.unit, tile: i.tile, rocketDirectionUp: i.rocketDirectionUp, amount: i.amount }),
  ],
  upgrade_structure: [
    "onSendUpgradeStructureIntent",
    (i) => ({ unitType: i.unit, unitId: i.unitId, amount: i.amount }),
  ],
  move_warship: ["onMoveWarshipEvent", (i) => ({ unitIds: i.unitIds, tile: i.tile })],
  targetPlayer: ["onSendTargetPlayerIntent", (i) => ({ targetID: i.target })],
  spawn: ["onSendSpawnIntentEvent", (i) => ({ tile: i.tile })],
  allianceRequest: ["onSendAllianceRequest", (i) => ({ recipient: pid(i.recipient) })],
  allianceExtension: ["onSendAllianceExtensionIntent", (i) => ({ recipient: pid(i.recipient) })],
  allianceReject: ["onAllianceRejectUIEvent", (i) => ({ requestor: pid(i.requestor) })],
  breakAlliance: ["onBreakAllianceRequestUIEvent", (i) => ({ recipient: pid(i.recipient) })],
  embargo: ["onSendEmbargoIntent", (i) => ({ target: pid(i.targetID), action: i.action })],
  emoji: [
    "onSendEmojiIntent",
    (i) => ({ recipient: i.recipient === "AllPlayers" ? "AllPlayers" : pid(i.recipient), emoji: i.emoji }),
  ],
  quick_chat: [
    "onSendQuickChatIntent",
    (i) => ({ recipient: pid(i.recipient), quickChatKey: i.quickChatKey, target: i.target }),
  ],
  donate_troops: ["onSendDonateTroopIntent", (i) => ({ recipient: pid(i.recipient), troops: i.troops })],
  donate_gold: ["onSendDonateGoldIntent", (i) => ({ recipient: pid(i.recipient), gold: i.gold })],
};

/** Finds the game's EventBus via any HUD element holding it. */
function findBus(): any {
  const seen = new Set<any>();
  const stack: (Document | ShadowRoot)[] = [document];
  while (stack.length) {
    const root = stack.pop()!;
    for (const el of Array.from(root.querySelectorAll("*")) as any[]) {
      const bus = el.eventBus;
      if (bus && !seen.has(bus) && bus.listeners instanceof Map) {
        seen.add(bus);
        const h = handlersOf(bus);
        if (h.onSendAttackIntent) return bus;
      }
      if (el.shadowRoot) stack.push(el.shadowRoot);
    }
  }
  return null;
}

function handlersOf(bus: any): Record<string, (e: any) => void> {
  const out: Record<string, (e: any) => void> = {};
  for (const [, arr] of bus.listeners as Map<unknown, ((e: any) => void)[]>) {
    for (const h of arr) {
      const m = /\.(on[A-Za-z0-9_]+)\s*\(/.exec(String(h));
      if (m && !out[m[1]]) out[m[1]] = h;
    }
  }
  return out;
}

function enqueue(c: GameCtx, i: Intent) {
  const key = JSON.stringify(i);
  if (c.queue.some((q) => q.key === key)) return;
  // A spawn replaces any spawn still waiting.
  if (i.type === "spawn") c.queue = c.queue.filter((q) => q.i.type !== "spawn");
  c.queue.push({ i, at: performance.now(), key });
}

// Token buckets. Multiplayer games go through the real server, which allows 10
// intents/s and 150/min per client — stay well under both.
const bucket = { sec: 0, secAt: 0, min: [] as number[] };
function canSend(c: GameCtx): boolean {
  // Solo: the local server has no intent limit, so neither do we (owner
  // 2026-10-15: "cant it perform orders much faster"). A 10/s cap at Max
  // speed queued intents for hundreds of ticks until they went stale.
  if (c.gameType === "Singleplayer") return true;
  const now = performance.now();
  if (now - bucket.secAt >= 1000) {
    bucket.sec = 0;
    bucket.secAt = now;
  }
  bucket.min = bucket.min.filter((t) => now - t < 60_000);
  return bucket.sec < 5 && bucket.min.length < 130;
}

// Send order (user live report 2026-10-14: 115 of 495 intents dropped, chat
// competing with attacks): troop moves and builds first, then diplomacy, chat
// last. Chat only goes out while the minute bucket has room left for moves.
function prio(t: string): number {
  if (t === "emoji" || t === "quick_chat") return 2;
  if (t === "allianceRequest" || t === "allianceExtension" || t === "allianceReject" ||
      t === "breakAlliance" || t === "embargo") return 1;
  return 0;
}

function pump() {
  const c = ctx;
  if (!c || !c.allowed || !botOn || c.resyncing || c.lost) return;
  const now = performance.now();
  // Decisions go stale: drop what couldn't be sent within 2.5 s.
  // Dropped troop moves go back to the shadow, so its in-flight sum (the
  // troops it holds back for sends on their way) frees them at once.
  const gone: Intent[] = [];
  c.queue = c.queue.filter((q) => now - q.at < 2500 || (gone.push(q.i), false));
  c.dropped += gone.length;
  while (c.queue.length && canSend(c)) {
    if (!c.handlers || !c.bus) {
      c.bus = findBus();
      c.handlers = c.bus ? handlersOf(c.bus) : null;
      if (!c.handlers) break; // HUD not up yet; retry next pump
    }
    let k = 0;
    for (let j = 1; j < c.queue.length; j++) if (prio(c.queue[j].i.type) < prio(c.queue[k].i.type)) k = j;
    if (prio(c.queue[k].i.type) === 2 && c.gameType !== "Singleplayer" && bucket.min.length >= 100) {
      // Chat waits (and goes stale) rather than eat the moves' minute budget.
      break;
    }
    const { i } = c.queue.splice(k, 1)[0];
    const route = ROUTES[i.type];
    const handler = route && c.handlers[route[0]];
    if (!handler) {
      c.dropped++;
      gone.push(i);
      continue;
    }
    try {
      handler(route[1](i));
      c.sent++;
      if (c.gameType !== "Singleplayer") {
        bucket.sec++;
        bucket.min.push(now);
      }
    } catch (e) {
      console.warn("[ofbot] send failed", i, e);
      c.dropped++;
      gone.push(i);
      c.bus = c.handlers = null; // rediscover (new game / new bus)
      break;
    }
  }
  const moves = gone.filter((i) => i.type === "attack" || i.type === "boat");
  if (moves.length && c.shadow) c.shadow.post({ t: "dropped", intents: moves });
}

// Play aids' intents (a hotkey macro the player pressed): sent with the bot
// on or off, ahead of the bot's queue, through the same rate limiter.
let aidQueue: { i: Intent; at: number }[] = [];
function pumpAids() {
  const c = ctx;
  if (!c || !c.allowed) {
    aidQueue = [];
    return;
  }
  const now = performance.now();
  aidQueue = aidQueue.filter((q) => now - q.at < 3000);
  while (aidQueue.length && canSend(c)) {
    if (!c.handlers || !c.bus) {
      c.bus = findBus();
      c.handlers = c.bus ? handlersOf(c.bus) : null;
      if (!c.handlers) return;
    }
    const { i } = aidQueue.shift()!;
    const route = ROUTES[i.type];
    const handler = route && c.handlers[route[0]];
    if (!handler) continue;
    try {
      handler(route[1](i));
      if (c.gameType !== "Singleplayer") {
        bucket.sec++;
        bucket.min.push(now);
      }
    } catch (e) {
      console.warn("[ofbot] aid send failed", i, e);
      c.bus = c.handlers = null;
      return;
    }
  }
}
setInterval(() => {
  pumpAids();
  pump();
}, 100);

const aidApi: AidApi = {
  send(i) {
    if (!ctx?.allowed) return false;
    aidQueue.push({ i, at: performance.now() });
    pumpAids();
    return true;
  },
  note: (m) => note(m),
};
// The vendored helper's acting features (auto-donate, auto-defend) send
// through this same path; they never write to the WebSocket themselves.
if (W.__ofbotHelper) W.__ofbotHelper.api = aidApi;

// ------------------------------------------------------------------ control

function pushEnable() {
  const c = ctx;
  if (!c?.shadow || !c.allowed) return;
  // Two profiles (owner 2026-10-15): Easy solo games get FARM_TWEAKS over the
  // general one; every other game sends {} (the shadow re-creates the bot only
  // when the params change).
  c.shadow.post({ t: "enable", on: botOn, emojis: settings.emojis, team: settings.team, share: settings.share,
    params: c.farm ? FARM_TWEAKS : {} });
}

function setBot(on: boolean) {
  botOn = on;
  if (!on && ctx) ctx.queue.length = 0;
  pushEnable();
  render();
}

// ----------------------------------------------------------------------- UI

// ------------------------------------------------------------- turbo farm
// Farm: on the homepage start an Easy solo game (the player's other solo
// settings stay), let the bot play it at Max speed with turbo, and after the
// game ends go back home and start the next one. Unchecking stops the loop.
const FARM_WAIT_MS = 10_000; // after the end: let the game record upload
const FARM_MAX_MS = 90 * 60_000; // a game that never ends is left after this
const FARM_MAX_TICKS = 50 * 600; // owner 2026-10-17: leave a solo game after 50 game minutes
let farmGameAt = 0;
let farmEndAt = 0;
let farmDeadTitle: string | null = null;
let farmDeadAt = 0;
let farmStartAt = 0;

// Solo XP (public progression config, read live 2026-10-15): only the first
// singleplayerGamesPerDay (5) eligible solo games of a UTC day pay XP, and
// Caps come only from level-ups. Past that the farm waits for the next day.
let soloDaily: { day: string; games: number } | null = null;
let soloPerDay = 5;
let soloCapNoted = false;
document.addEventListener("userMeResponse", (e: any) => {
  const d = e?.detail?.player?.progress?.daily;
  if (d && typeof d.day === "string" && Number.isFinite(Number(d.singleplayerGames))) {
    soloDaily = { day: d.day, games: Number(d.singleplayerGames) };
    render();
  }
});
void fetch(`https://api.${location.hostname.replace(/^www\./, "")}/public/progression/config`)
  .then((r) => r.json())
  .then((c) => {
    const n = Number(c?.xp?.singleplayerGamesPerDay);
    if (n > 0) soloPerDay = n;
  })
  .catch(() => {
    /* keep 5 */
  });

/** Today's XP-paying solo games, or null while unknown (signed out). */
function soloToday(): number | null {
  if (!soloDaily) return null;
  return soloDaily.day === new Date().toISOString().slice(0, 10) ? soloDaily.games : 0;
}

function farmOnHome(): boolean {
  const p = location.pathname;
  return !ctx && (p === "/" || p === "" || p === "/index.html") && !/join|replay/i.test(location.hash + location.search);
}

async function farmStart() {
  const el = document.querySelector("single-player-modal") as any;
  if (!el || typeof el.startGame !== "function") return;
  note("Farm: starting an Easy solo game…");
  try {
    el.resetOptions?.();
    await el.loadNationCount?.();
    if (typeof el.handleDifficultySelection === "function") el.handleDifficultySelection("Easy");
    else el.selectedDifficulty = "Easy";
    await el.startGame();
  } catch (e) {
    note(`Farm: couldn't start a solo game (${String(e)})`);
  }
}

/** The game's "speed up" key, as the player has bound it (default "."). */
function speedUpKey(): { code: string; shift: boolean } | null {
  let v = "Period";
  try {
    const b = JSON.parse(localStorage.getItem("settings.keybinds") ?? "{}")?.gameSpeedUp;
    const s = typeof b === "string" ? b : typeof b?.value === "string" ? b.value : null;
    if (s === "Null") return null;
    if (s) v = s;
  } catch {
    /* defaults */
  }
  const parts = v.split("+");
  return { code: parts[parts.length - 1], shift: parts.slice(0, -1).some((x) => /shift/i.test(x)) };
}

function farmSpeedUp() {
  const k = speedUpKey();
  if (!k) return;
  // The game reacts on keyup; Max is the top speed, so extra presses do nothing.
  dispatchEvent(new KeyboardEvent("keyup", { code: k.code, shiftKey: k.shift, bubbles: true }));
}

function farmLeave() {
  lockClaims?.drop();
  claims.drop();
  // Other bot tabs count games in the same saved settings: add ours to the
  // stored count, and don't write this tab's older copy of the rest back.
  let stored: any = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") ?? {};
  } catch {
    /* storage off */
  }
  settings.farmGames = Math.max(settings.farmGames, Number(stored.farmGames) || 0) + 1;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, ...stored, farmGames: settings.farmGames }));
  } catch {
    /* ignore */
  }
  note(`Farm: game ${settings.farmGames} done — next one`);
  // A full load of the homepage, not the win modal's in-page exit: after a
  // death that exit left the game HUD drawn over the homepage and the next
  // start never fired (live 2026-10-15).
  location.assign(`${location.origin}/`);
}

function farmTick() {
  if (!settings.farm) {
    farmStartAt = 0;
    return;
  }
  const now = Date.now();
  if (farmOnHome()) {
    farmAwayAt = 0;
    const today = soloToday();
    if (settings.farmSolo === false || (today !== null && today >= soloPerDay)) {
      farmStartAt = 0;
      if (settings.farmPublic) {
        farmJoinPublic(now);
        return;
      }
      if (!soloCapNoted) note(`Farm: today's ${soloPerDay} XP solo games are done — waiting for 00:00 UTC`);
      soloCapNoted = true;
      return;
    }
    soloCapNoted = false;
    // Several bot tabs on one account: one plays the day's solo games, the
    // others play public FFA games meanwhile (or wait, without public games).
    const turn = soloTurn(now);
    if (!turn) {
      if (turn === false && settings.farmPublic) farmJoinPublic(now);
      return;
    }
    // A few seconds on the homepage first: time to uncheck Farm, and for the
    // page to finish loading its components.
    if (!farmStartAt) farmStartAt = now + 5000;
    if (now >= farmStartAt) {
      farmStartAt = now + 20_000; // retry if this start doesn't lead to a game
      void farmStart();
    }
    return;
  }
  farmStartAt = 0;
  const c = ctx;
  if (!c) {
    farmGameAt = 0;
    // Off the homepage with no game (a lobby that closed, a stray page):
    // back home after a while. A lobby wait is left alone.
    const sel = document.querySelector("game-mode-selector") as any;
    if (sel?.inLobby) farmAwayAt = 0;
    else if (!farmAwayAt) farmAwayAt = now;
    else if (now - farmAwayAt > FARM_AWAY_MS) {
      farmAwayAt = 0;
      location.assign(`${location.origin}/`);
    }
    return;
  }
  farmAwayAt = 0;
  if (c.allowed && c.gameType === "Public" && settings.farmPublic) return farmPublicTick(c, now);
  if (!c.allowed || c.gameType !== "Singleplayer") return;
  if (farmGameAt === 0) farmGameAt = now;
  if (c.shadowReady) farmSpeedUp();
  const wm = document.querySelector("win-modal") as any;
  if (farmEndAt === 0) {
    if (wm?.isVisible) {
      const alive = !!c.stats?.alive;
      const title = String(wm._title ?? "");
      if (alive) farmEndAt = now + FARM_WAIT_MS;
      // Died: the modal comes up again with a new title when the game ends.
      // At Max speed that's usually soon; don't wait more than 5 minutes.
      else if (farmDeadTitle === null) {
        farmDeadTitle = title;
        farmDeadAt = now;
      } else if (title !== farmDeadTitle) farmEndAt = now + FARM_WAIT_MS;
    }
    if (farmDeadTitle !== null && now - farmDeadAt > 5 * 60_000) farmEndAt = now;
    if (now - farmGameAt > FARM_MAX_MS) farmEndAt = now;
    if (c.realTick >= FARM_MAX_TICKS) {
      note("Farm: 50 game minutes passed — leaving for a new game");
      farmEndAt = now;
    }
  } else if (now >= farmEndAt) {
    farmEndAt = farmGameAt = 0;
    farmDeadTitle = null;
    farmLeave();
  }
}
setInterval(farmTick, 1000);

// Game record: the first win-modal sight (our death or the game's end).
setInterval(() => {
  const r = ctx?.rec;
  if (!r || r.end) return;
  const wm = document.querySelector("win-modal") as any;
  if (!wm?.isVisible) return;
  r.end = { tick: ctx!.realTick, title: String(wm._title ?? ""), alive: r.died === null };
  recSave(r);
  render();
}, 1000);
addEventListener("pagehide", () => {
  if (ctx?.rec) recFinish(ctx.rec);
});

// Public FFA (owner 2026-10-15: "best xp per second"). XP per game is
// (50 played + 17 per game minute alive, up to 30 + placement + win) at 1x,
// four times the solo rate and with no daily game limit, but in real time:
// about 20 XP a minute against 30-45 for a held Max-speed solo game. So the
// farm plays the day's XP solo games first and public games after. Time XP
// counts alive time (the record keeps killedAt; the config's minAliveTicks),
// and leaving after death forfeits nothing (only leaving alive does), so a
// dead bot goes straight to the next lobby; alive, it plays the game out.
const FARM_AWAY_MS = 5 * 60_000;
const FARM_PUBLIC_MAX_MS = 3 * 60 * 60_000;
let farmAwayAt = 0;
let farmJoinAt = 0;

// Each bot tab on one account joins a different FFA game (ffa-claim.ts):
// a Web Lock per game, or claims in localStorage where there are no locks.
const locks = (navigator as any).locks;
const lockClaims = locks?.request ? new LockClaims(locks) : null;
const claims = new FfaClaims(localStorage, Math.random().toString(36).slice(2));
let claimWaitNoted = false;
// Keep a localStorage claim alive while in the lobby or the game (a lock
// lasts as long as the tab by itself).
setInterval(() => {
  if (lockClaims) return;
  if (farmOnHome() && !(document.querySelector("game-mode-selector") as any)?.inLobby) return;
  claims.keepAlive(Date.now());
}, 10_000);
addEventListener("pagehide", () => claims.drop());

// One tab at a time plays the solo games: the one holding this lock.
const SOLO_LOCK = "ofbot-solo";
let soloLock: "no" | "asking" | "held" = "no";
let soloAskAt = 0;
/** Whether this tab may play solo games now (null: still asking). */
function soloTurn(now: number): boolean | null {
  if (!lockClaims || soloLock === "held") return true;
  if (soloLock === "asking") return null;
  if (now < soloAskAt) return false;
  soloLock = "asking";
  void holdLock(locks, SOLO_LOCK).then((release) => {
    soloLock = release ? "held" : "no";
    soloAskAt = Date.now() + 10_000;
  });
  return null;
}

// A join that hasn't led into its lobby yet, and lobbies whose join failed.
let joinPending: { id: string; at: number } | null = null;
const joinSkip = new Map<string, number>();

// Lobbies the server refused, shared with the other bot tabs so none of them
// tries the same dead lobby next.
let skipChannel: BroadcastChannel | null = null;
try {
  skipChannel = new BroadcastChannel("ofbot-ffa-skip");
  skipChannel.onmessage = (e) => {
    if (typeof e.data?.skip === "string") joinSkip.set(e.data.skip, Date.now() + SKIP_MS);
  };
} catch {
  /* no BroadcastChannel: each tab finds out by itself */
}

// The server refused the join (it started just before we got in, or filled):
// skip that lobby and pick another at once instead of waiting out JOIN_WAIT_MS.
document.addEventListener("leave-lobby", (e: Event) => {
  const d = (e as CustomEvent).detail;
  if (!settings.farmPublic || (d?.cause !== "game-started" && d?.cause !== "full-lobby")) return;
  const id = String(d.lobby ?? joinPending?.id ?? "");
  if (id) {
    joinSkip.set(id, Date.now() + SKIP_MS);
    try {
      skipChannel?.postMessage({ skip: id });
    } catch {
      /* closed */
    }
  }
  note(`Farm: lobby ${id} ${d.cause === "full-lobby" ? "filled up" : "started"} before we got in — trying another one`);
  joinPending = null;
  lockClaims?.drop();
  claims.drop();
  farmJoinAt = Date.now() + 1000;
});

function farmJoinPublic(now: number) {
  const sel = document.querySelector("game-mode-selector") as any;
  if (!sel) return;
  if (sel.inLobby) {
    joinPending = null;
    return;
  }
  if (joinPending) {
    if (now - joinPending.at < JOIN_WAIT_MS) return;
    note(`Farm: joining lobby ${joinPending.id} didn't work — trying another one`);
    joinSkip.set(joinPending.id, now + SKIP_MS);
    joinPending = null;
    // The claim stays until the next one replaces it: this join may still
    // land, and another tab must not join the same lobby meanwhile.
    if (sel.showTrustRequired) sel.showTrustRequired = false;
    farmJoinAt = 0;
  }
  if (now < farmJoinAt) return;
  const all = sel.lobbies?.games?.ffa;
  if (!Array.isArray(all) || typeof sel.validateAndJoin !== "function") return;
  const offset = Number(sel.serverTimeOffset);
  const lobbies = joinable(all, !!sel.viewerTrusted, joinSkip, now, Date.now() + (Number.isFinite(offset) ? offset : 0));
  const pick = async () => {
    const lobby = lockClaims ? await lockClaims.claim(lobbies) : claims.claim(lobbies, Date.now());
    if (!lobby) {
      if (!claimWaitNoted) note("Farm: every open FFA lobby is taken by another bot tab — waiting for the next one");
      claimWaitNoted = true;
      farmJoinAt = Date.now() + 3000;
      return;
    }
    claimWaitNoted = false;
    joinPending = { id: String(lobby.gameID), at: Date.now() };
    note(`Farm: joining public FFA lobby ${lobby.gameID}`);
    try {
      sel.validateAndJoin(lobby);
    } catch (e) {
      note(`Farm: couldn't join a public lobby (${String(e)})`);
    }
  };
  farmJoinAt = now + 30_000; // no second pick while one is pending
  void pick().catch(() => (farmJoinAt = 0));
}

function farmPublicTick(c: GameCtx, now: number) {
  if (farmGameAt === 0) farmGameAt = now;
  const wm = document.querySelector("win-modal") as any;
  // The modal comes up on our death and at the game's end: either way
  // there is no more XP to earn here.
  if (farmEndAt === 0 && (wm?.isVisible || now - farmGameAt > FARM_PUBLIC_MAX_MS)) farmEndAt = now + FARM_WAIT_MS;
  if (farmEndAt !== 0 && now >= farmEndAt) {
    farmEndAt = farmGameAt = 0;
    farmLeave();
  }
}


let ui: {
  host: HTMLElement;
  status: HTMLElement;
  stats: HTMLElement;
  msg: HTMLElement;
  btn: HTMLButtonElement;
  auto: HTMLInputElement;
  emo: HTMLInputElement;
  team: HTMLInputElement;
  share: HTMLInputElement;
  farm: HTMLInputElement;
  pub: HTMLInputElement;
} | null = null;

function buildUI() {
  if (ui || !document.body) return;
  const host = document.createElement("div");
  host.id = "ofbot-panel";
  host.style.cssText = "position:fixed;z-index:2147483646;";
  placePanel(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
<style>
  .p{font:12px/1.35 system-ui,sans-serif;color:#e8eef5;background:rgba(17,24,39,.92);
     border:1px solid #374151;border-radius:8px;width:230px;box-shadow:0 4px 16px rgba(0,0,0,.4)}
  .h{display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:move;border-bottom:1px solid #374151;font-weight:600}
  .h span{flex:1}
  .b{padding:6px 8px;display:grid;gap:5px}
  button{font:600 13px system-ui;border:0;border-radius:6px;padding:7px;cursor:pointer;color:#fff;background:#16a34a}
  button.on{background:#dc2626}
  button:disabled{background:#4b5563;cursor:default}
  label{display:flex;gap:6px;align-items:center;color:#cbd5e1}
  .s{color:#93c5fd}.m{color:#9ca3af;word-break:break-word;max-height:48px;overflow:hidden}
  .x{cursor:pointer;color:#9ca3af;font-weight:400}
  .of{cursor:pointer;color:#9ca3af;user-select:none}.o{display:grid;gap:5px}
</style>
<div class="p">
  <div class="h"><span>OpenFront Bot</span><small class="x" title="Collapse">–</small></div>
  <div class="b">
    <div class="s"></div>
    <div class="t"></div>
    <button></button>
    <div class="of" title="Show/hide the options"></div>
    <div class="o">
    <label><input type="checkbox" class="auto"> Auto-start in each game</label>
    <label><input type="checkbox" class="emo"> Bot may send emojis</label>
    <label><input type="checkbox" class="team"> Team up with other script bots</label>
    <label><input type="checkbox" class="share"> Send/receive troops &amp; gold with them</label>
    <label title="Starts Easy solo games one after another, played by the bot at Max speed with turbo. Uncheck to stop."><input type="checkbox" class="farm"> Farm: Easy solo games on repeat</label>
    <label title="Farm: once the day's XP-paying solo games are used, join public FFA games (the bot plays; next lobby after it dies or the game ends)"><input type="checkbox" class="pub"> …then public FFA games</label>
    <div class="of ex" title="Download a log of the games played in this browser (map, size, place, checkpoints), to study them with their replays"></div>
    </div>
    <div class="of af" style="font-weight:700" title="Optional helpers for your own play; they work with the bot on or off"></div>
    <div class="o ad"></div>
    <div class="m"></div>
  </div>
</div>`;
  // On <html>, not <body>: the game's UI framework may re-render body.
  document.documentElement.appendChild(host);
  const q = <T extends Element>(s: string) => root.querySelector(s) as unknown as T;
  ui = {
    host,
    status: q(".s"),
    stats: q(".t"),
    msg: q(".m"),
    btn: q("button"),
    auto: q(".auto"),
    emo: q(".emo"),
    team: q(".team"),
    share: q(".share"),
    farm: q(".farm"),
    pub: q(".pub"),
  };
  ui.team.checked = settings.team;
  ui.share.checked = settings.share;
  ui.team.onchange = () => {
    settings.team = ui!.team.checked;
    saveSettings();
    pushEnable();
  };
  ui.share.onchange = () => {
    settings.share = ui!.share.checked;
    saveSettings();
    pushEnable();
  };
  ui.farm.checked = settings.farm;
  ui.farm.onchange = () => {
    settings.farm = ui!.farm.checked;
    saveSettings();
    note(settings.farm ? "Farm on: Easy solo games on repeat" : "Farm off");
  };
  ui.pub.checked = settings.farmPublic;
  ui.pub.onchange = () => {
    settings.farmPublic = ui!.pub.checked;
    saveSettings();
  };
  const ex = q<HTMLElement>(".ex");
  ex.textContent = "Export game log";
  ex.onclick = () => recExport();
  ex.onpointerenter = () => (ex.textContent = `Export game log (${recAll().length} games)`);
  ui.auto.checked = settings.autoStart;
  ui.emo.checked = settings.emojis;
  ui.btn.onclick = () => setBot(!botOn);
  ui.auto.onchange = () => {
    settings.autoStart = ui!.auto.checked;
    saveSettings();
  };
  ui.emo.onchange = () => {
    settings.emojis = ui!.emo.checked;
    saveSettings();
    pushEnable();
  };
  // Collapse the whole body from the header (–/+), or fold away only the
  // options; both states survive reloads.
  const body = q<HTMLElement>(".b");
  const x = q<HTMLElement>(".x");
  const opts = q<HTMLElement>(".o");
  const fold = q<HTMLElement>(".of");
  const showFolds = () => {
    body.style.display = settings.min ? "none" : "";
    x.textContent = settings.min ? "+" : "–";
    x.title = settings.min ? "Expand" : "Collapse";
    opts.style.display = settings.opts ? "none" : "";
    fold.textContent = settings.opts ? "Options ▸" : "Options ▾";
  };
  showFolds();
  buildAids(q<HTMLElement>(".af"), q<HTMLElement>(".ad"));
  x.onclick = () => {
    settings.min = !settings.min;
    saveSettings();
    showFolds();
  };
  fold.onclick = () => {
    settings.opts = !settings.opts;
    saveSettings();
    showFolds();
  };
  // Drag by the header.
  const header = q<HTMLElement>(".h");
  header.onpointerdown = (e) => {
    if ((e.target as HTMLElement).classList.contains("x")) return;
    const r = host.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      settings.x = Math.max(0, Math.min(innerWidth - 60, ev.clientX - sx));
      settings.y = Math.max(0, Math.min(innerHeight - 30, ev.clientY - sy));
      host.style.left = `${settings.x}px`;
      host.style.top = `${settings.y}px`;
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      saveSettings();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  // Keep the panel from passing clicks/keys to the game canvas.
  for (const ev of ["pointerdown", "mousedown", "click", "wheel", "contextmenu"]) {
    host.addEventListener(ev, (e) => e.stopPropagation());
  }
  render();
}

/** The "Play aids" fold: one checkbox per aid, each started when ticked. */
function buildAids(fold: HTMLElement, list: HTMLElement) {
  const aids: Aid[] = allAids();
  settings.aids ??= {};
  const show = () => {
    list.style.display = settings.aidsOpen ? "" : "none";
    const n = aids.filter((a) => settings.aids![a.key] ?? a.def).length;
    fold.innerHTML = `Play aids${n ? ` (${n} on)` : ""} <span style="font-size:1.7em;line-height:0;vertical-align:-0.1em">${settings.aidsOpen ? "▾" : "▸"}</span>`;
  };
  for (const a of aids) {
    const label = document.createElement("label");
    label.title = a.title;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = settings.aids[a.key] ?? a.def;
    box.onchange = () => {
      settings.aids![a.key] = box.checked;
      saveSettings();
      setAid(a, box.checked, aidApi);
      show();
    };
    label.append(box, ` ${a.label}`);
    list.appendChild(label);
    if (box.checked) setAid(a, true, aidApi);
  }
  fold.onclick = () => {
    settings.aidsOpen = !settings.aidsOpen;
    saveSettings();
    show();
  };
  show();
}

/** Put the panel at its saved spot, pulled back on screen if it's off it. */
function placePanel(host: HTMLElement) {
  const x = settings.x < 0 ? innerWidth - 250 : settings.x;
  host.style.left = `${Math.max(0, Math.min(innerWidth - 60, x))}px`;
  host.style.top = `${Math.max(0, Math.min(innerHeight - 30, settings.y))}px`;
}
addEventListener("resize", () => ui && placePanel(ui.host));

function render() {
  if (!ui) return;
  if (!ui.host.isConnected) document.documentElement.appendChild(ui.host);
  const c = ctx;
  let status: string;
  if (!c) status = "No game running";
  else if (!c.allowed) status = c.reason;
  else if (!c.shadowReady) status = `${c.gameType}: loading shadow engine…`;
  else if (c.lost) status = `${c.gameType}: game version changed too much — rebuild needed`;
  else if (c.mirror) {
    const p = c.sync?.mirror && c.sync.pct !== undefined ? ` ${Math.floor(c.sync.pct * 100)}% in sync` : "";
    status = `${c.gameType}: mirror mode,${p || " starting"}`;
  } else if (c.resyncing) status = `${c.gameType}: resyncing…`;
  else status = `${c.gameType}: in sync${c.syncedTick >= 0 ? ` @ tick ${c.syncedTick}` : ""}${shadowLagging() ? " (game waits for the bot)" : ""}`;
  if (c?.allowed && c.farm) status += " · Easy farm profile";
  ui.status.textContent = status;
  const s = c?.stats;
  ui.stats.textContent =
    c && c.allowed
      ? `${s ? (s.spawn ? "spawn phase · " : "") + (s.alive || s.spawn ? `${s.tiles} tiles · ${fmt(s.troops / 10)} troops · ${fmt(s.gold)} gold` : "eliminated") : "—"}` +
        (s?.mirv ? ` · MIRV bank vs ${s.mirv} (keep ${fmt(s.keep ?? 0)})` : "") +
        ` · sent ${c.sent}${c.dropped ? ` (dropped ${c.dropped})` : ""}`
      : "";
  const blocked = !!c && !c.allowed;
  ui.btn.disabled = blocked;
  ui.btn.textContent = blocked ? "Unavailable here" : botOn ? "Stop bot" : c ? "Start bot" : "Start bot (next game)";
  ui.btn.className = botOn && !blocked ? "on" : "";
  const today = soloToday();
  const xpGames = today === null ? "" : ` · XP games today ${Math.min(today, soloPerDay)}/${soloPerDay}`;
  ui.msg.textContent = (settings.farm ? `Farm on · ${settings.farmGames} done${xpGames} · ` : "") + lastMsg;
}

function fmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

if (document.body) buildUI();
else document.addEventListener("DOMContentLoaded", buildUI);
setInterval(render, 1000);
console.info(`[ofbot] userscript ${__OFBOT_VERSION__} loaded`);
