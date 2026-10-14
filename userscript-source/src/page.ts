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
  x: number;
  y: number;
}
const SETTINGS_KEY = "ofbot.settings.v1";
// x < 0: default spot at the top right, under the game's timer bar.
const settings: Settings = { autoStart: false, emojis: false, team: true, share: true, x: -1, y: 130 };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"));
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

function hook(w: Worker) {
  const realPost = RealWorker.prototype.postMessage.bind(w) as (m: any, t?: any) => void;
  const realTerminate = RealWorker.prototype.terminate.bind(w);
  (w as any).postMessage = (msg: any, transfer?: any) => {
    try {
      if (msg && typeof msg === "object") {
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
  });
}

function disposeCtx(reason: string) {
  if (!ctx) return;
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
  };
  if (!allowed) {
    note(reason);
    return;
  }
  if (settings.autoStart) botOn = true;
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
      c.shadowHashes.set(m.tick, m.hash);
      compare(c, m.tick);
      break;
    case "intents":
      if (!botOn || c.resyncing || c.lost) return;
      for (const i of m.intents as Intent[]) enqueue(c, i);
      break;
    case "state":
      c.stats = m;
      render();
      break;
    case "sync":
      c.sync = m;
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
  const now = performance.now();
  if (now - bucket.secAt >= 1000) {
    bucket.sec = 0;
    bucket.secAt = now;
  }
  bucket.min = bucket.min.filter((t) => now - t < 60_000);
  const online = c.gameType !== "Singleplayer";
  const perSec = online ? 5 : 10;
  const perMin = online ? 130 : Infinity;
  return bucket.sec < perSec && bucket.min.length < perMin;
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
  const before = c.queue.length;
  c.queue = c.queue.filter((q) => now - q.at < 2500);
  c.dropped += before - c.queue.length;
  while (c.queue.length && canSend(c)) {
    if (!c.handlers || !c.bus) {
      c.bus = findBus();
      c.handlers = c.bus ? handlersOf(c.bus) : null;
      if (!c.handlers) return; // HUD not up yet; retry next pump
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
      continue;
    }
    try {
      handler(route[1](i));
      c.sent++;
      bucket.sec++;
      bucket.min.push(now);
    } catch (e) {
      console.warn("[ofbot] send failed", i, e);
      c.bus = c.handlers = null; // rediscover (new game / new bus)
      return;
    }
  }
}
setInterval(pump, 100);

// ------------------------------------------------------------------ control

function pushEnable() {
  const c = ctx;
  if (!c?.shadow || !c.allowed) return;
  c.shadow.post({ t: "enable", on: botOn, emojis: settings.emojis, team: settings.team, share: settings.share });
}

function setBot(on: boolean) {
  botOn = on;
  if (!on && ctx) ctx.queue.length = 0;
  pushEnable();
  render();
}

// ----------------------------------------------------------------------- UI

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
</style>
<div class="p">
  <div class="h"><span>OpenFront Bot</span><small class="x" title="Collapse">–</small></div>
  <div class="b">
    <div class="s"></div>
    <div class="t"></div>
    <button></button>
    <label><input type="checkbox" class="auto"> Auto-start in each game</label>
    <label><input type="checkbox" class="emo"> Bot may send emojis</label>
    <label><input type="checkbox" class="team"> Team up with other script bots</label>
    <label><input type="checkbox" class="share"> Send/receive troops &amp; gold with them</label>
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
  const body = q<HTMLElement>(".b");
  q<HTMLElement>(".x").onclick = () => {
    body.style.display = body.style.display === "none" ? "" : "none";
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
  else status = `${c.gameType}: in sync${c.syncedTick >= 0 ? ` @ tick ${c.syncedTick}` : ""}`;
  ui.status.textContent = status;
  const s = c?.stats;
  ui.stats.textContent =
    c && c.allowed
      ? `${s ? (s.spawn ? "spawn phase · " : "") + (s.alive || s.spawn ? `${s.tiles} tiles · ${fmt(s.troops)} troops · ${fmt(s.gold)} gold` : "eliminated") : "—"}` +
        ` · sent ${c.sent}${c.dropped ? ` (dropped ${c.dropped})` : ""}`
      : "";
  const blocked = !!c && !c.allowed;
  ui.btn.disabled = blocked;
  ui.btn.textContent = blocked ? "Unavailable here" : botOn ? "Stop bot" : c ? "Start bot" : "Start bot (next game)";
  ui.btn.className = botOn && !blocked ? "on" : "";
  ui.msg.textContent = lastMsg;
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
