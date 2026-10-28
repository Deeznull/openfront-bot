/**
 * Script chat: a public chat between players who run this script (or
 * openfront-pro) in the same game, over public Nostr relays. One room per
 * game id; messages are signed with a key kept in localStorage for that room
 * only (a new game gets a new key, so games can't be linked through it).
 * Adapted from devdanetra/openfront-pro (MIT, Copyright (c) 2026 devdanetra):
 * the chat port in src/background.js and the panel rules in src/chat.js
 * (text cleaning, word mask, flood control, mutes, the free-for-all pause).
 * See NOTICE.
 *
 * Names are not verified (anyone can type any name), so each carries a short
 * fingerprint of the sender's key. Network text is only ever set as text.
 * While you are alive in a free-for-all the chat leaves the room altogether:
 * OpenFront's rules forbid outside channels for coordinating there.
 */
import { type Aid, type Box, call, every, gameView, inGame, makeBox } from "./core";
import { MAX_NAME, MAX_TEXT, type Msg, Room, newSecretKey, publicKeyOf, roomOf } from "./nostr";

const RELAYS = ["wss://relay.primal.net", "wss://nos.lol", "wss://nostr.mom", "wss://relay.snort.social"];
const KEY_STORE = "ofbot.chat.key";
const MUTE_STORE = "ofbot.chat.muted";
const MIN_GAP_MS = 1200; // between two of your messages
const PER_MINUTE = 12;
const PRESENCE_MS = 45000; // "here" beat
const PRESENCE_TTL = 100000;
const INBOUND_PER_SEC = 25; // across the room, before any signature check
const FLOOD_WINDOW = 10000;
const FLOOD_MAX = 6; // per sender per window, then a 60 s mute
const FLOOD_MUTE = 60000;
const LOG_LIMIT = 150;

// Masked, not blocked (openfront-pro's short list); the mute is for the rest.
const BAD = [
  "nigger", "nigga", "faggot", "fag", "retard", "retarded", "kike", "spic", "chink", "tranny", "coon",
  "kys", "kill yourself", "rape", "rapist",
  "fuck", "fucking", "fucker", "shit", "bitch", "cunt", "asshole", "whore", "slut", "dick", "pussy",
];
const BAD_RE = new RegExp(`(^|[^\\p{L}])(${BAD.map((w) => w.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}])`, "giu");
const mask = (t: string) => t.replace(BAD_RE, (_m, lead, w) => `${lead}${"•".repeat(Math.min(6, w.length))}`);

/** Network text: drop controls, zero-width and bidi tricks, limit stacked marks. */
function clean(value: unknown, max: number): string {
  let out = "";
  let marks = 0;
  for (const ch of String(value ?? "")) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
      out += " ";
      continue;
    }
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) continue;
    if (c === 0xfeff || c === 0x00ad) continue;
    if (c >= 0x0300 && c <= 0x036f) {
      if (marks >= 2) continue;
      marks++;
    } else marks = 0;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

interface Line {
  sys?: boolean;
  pubkey?: string;
  name?: string;
  text: string;
  at: number;
  mine?: boolean;
}

let box: Box | null = null;
let stopTick: (() => void) | null = null;
let room: Room | null = null;
let roomGame: string | null = null;
let lastGame: string | null = null; // the game the log is about
let me = "";
let relaysOpen = 0;
let paused = false;
let lastHere = 0;
let sentTimes: number[] = [];
let inWindow = 0;
let inCount = 0;
let log: Line[] = [];
const present = new Map<string, { name: string; at: number }>();
const recent = new Map<string, number[]>();
const tempMuted = new Map<string, number>();
let muted = new Set<string>();
let ui: { st: HTMLElement; log: HTMLElement; input: HTMLInputElement; send: HTMLButtonElement } | null = null;

const fp = (pubkey: string) => pubkey.slice(0, 4);
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function loadMuted() {
  try {
    const a = JSON.parse(localStorage.getItem(MUTE_STORE) ?? "[]");
    muted = new Set(Array.isArray(a) ? a.filter((k) => typeof k === "string").slice(-200) : []);
  } catch {
    muted = new Set();
  }
}
function saveMuted() {
  try {
    localStorage.setItem(MUTE_STORE, JSON.stringify([...muted]));
  } catch {
    /* ignore */
  }
}

/** The signing key for this room: kept (in localStorage) for this room only. */
function keyFor(roomName: string): string {
  try {
    const s = JSON.parse(localStorage.getItem(KEY_STORE) ?? "null");
    if (s?.room === roomName && /^[0-9a-f]{64}$/.test(s.sk)) return s.sk;
  } catch {
    /* new key */
  }
  const sk = newSecretKey();
  try {
    localStorage.setItem(KEY_STORE, JSON.stringify({ room: roomName, sk }));
  } catch {
    /* key for this page load only */
  }
  return sk;
}

function myName(g: any): string {
  let n = String(call(call(g, "myPlayer"), "displayName") ?? "");
  if (!n) {
    try {
      n = localStorage.getItem("username") ?? "";
    } catch {
      /* none */
    }
  }
  return clean(n, MAX_NAME) || "Player";
}

function sys(text: string) {
  push({ sys: true, text, at: Date.now() });
}
function push(l: Line) {
  log.push(l);
  if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT);
  render();
}

function onMsg(m: Msg) {
  if (muted.has(m.pubkey) || (tempMuted.get(m.pubkey) ?? 0) > Date.now()) return;
  const name = clean(m.name, MAX_NAME) || "?";
  if (m.type === "here") {
    if (!present.has(m.pubkey)) sys(`${name} #${fp(m.pubkey)} is here`);
    present.set(m.pubkey, { name, at: Date.now() });
    return render();
  }
  if (m.type === "bye") {
    if (present.delete(m.pubkey)) sys(`${name} #${fp(m.pubkey)} left`);
    return;
  }
  const now = Date.now();
  const times = (recent.get(m.pubkey) ?? []).filter((t) => now - t < FLOOD_WINDOW);
  times.push(now);
  recent.set(m.pubkey, times);
  if (times.length > FLOOD_MAX) {
    tempMuted.set(m.pubkey, now + FLOOD_MUTE);
    sys(`${name} #${fp(m.pubkey)} muted for a minute (flooding)`);
    return;
  }
  present.set(m.pubkey, { name, at: now });
  const text = clean(m.text, MAX_TEXT);
  if (text) push({ pubkey: m.pubkey, name, text, at: m.at });
}

function join(gameId: string, name: string) {
  leave();
  const rn = roomOf(gameId);
  const sk = keyFor(rn);
  me = publicKeyOf(sk);
  roomGame = gameId;
  let announced = false;
  room = new Room(
    RELAYS,
    rn,
    sk,
    onMsg,
    (open, total) => {
      relaysOpen = open;
      if (open && !announced && room) {
        announced = true;
        lastHere = Date.now();
        room.publish("here", "", name);
      }
      render(total);
    },
    () => {
      const now = Date.now();
      if (now - inWindow > 1000) {
        inWindow = now;
        inCount = 0;
      }
      return ++inCount <= INBOUND_PER_SEC;
    },
  );
}

function leave(name = "") {
  const r = room;
  room = null;
  roomGame = null;
  relaysOpen = 0;
  present.clear();
  if (!r) return;
  r.onMessage = () => {};
  r.onStatus = () => {};
  r.accept = () => false;
  try {
    r.publish("bye", "", name);
  } catch {
    /* closing */
  }
  setTimeout(() => r.close(), 300); // let "bye" out first
}

function say(text: string, name: string) {
  text = text.trim().slice(0, MAX_TEXT);
  if (!text) return;
  if (!room) return sys("Not connected");
  const now = Date.now();
  sentTimes = sentTimes.filter((t) => now - t < 60000);
  if ((sentTimes.length && now - sentTimes[sentTimes.length - 1] < MIN_GAP_MS) || sentTimes.length >= PER_MINUTE) {
    return sys("Slow down");
  }
  const { sent } = room.publish("msg", text, name);
  if (!sent) return sys("No relay reachable");
  sentTimes.push(now);
  push({ pubkey: me, name, text, at: now, mine: true });
}

function tick() {
  if (!box) return;
  const m = /\/game\/([A-Za-z0-9]{4,16})(?:[/?#]|$)/.exec(location.pathname);
  const gameId = m ? m[1] : null;
  const g = gameView();
  const name = myName(g);
  box.show(!!gameId);
  if (!gameId) {
    if (room) leave(name);
    log = [];
    lastGame = null;
    return;
  }
  if (lastGame !== gameId) {
    log = []; // another game: another room
    lastGame = gameId;
  }
  // Alive (or spawning) in a running free-for-all: out of the room.
  const cfg = g ? (call(call(g, "config"), "gameConfig") ?? {}) : {};
  const me0 = g ? call(g, "myPlayer") : null;
  const playing = !!g && inGame() && (!me0 || call(me0, "isAlive") === true);
  paused = playing && !/team/i.test(String(cfg.gameMode ?? ""));
  if (paused) {
    if (room) leave(name);
    return render();
  }
  if (roomGame !== gameId) join(gameId, name);
  const now = Date.now();
  if (room && relaysOpen && now - lastHere > PRESENCE_MS) {
    lastHere = now;
    room.publish("here", "", name);
  }
  for (const [k, p] of present) if (now - p.at > PRESENCE_TTL) present.delete(k);
  render();
}

function render(total = RELAYS.length) {
  if (!ui) return;
  ui.st.textContent = paused
    ? "Paused: you are alive in a free-for-all (OpenFront's rules forbid outside chat there)"
    : room
      ? `${relaysOpen}/${total} relays · ${present.size} other${present.size === 1 ? "" : "s"} here`
      : "Not connected";
  ui.input.disabled = ui.send.disabled = paused || !room;
  const rows = log.map((l) => {
    const row = document.createElement("div");
    row.className = l.sys ? "r s" : l.mine ? "r me" : "r";
    const t = document.createElement("em");
    t.textContent = clock(l.at);
    row.append(t);
    if (!l.sys && l.pubkey) {
      const who = document.createElement("b");
      who.textContent = `${l.name} #${fp(l.pubkey)}`;
      if (!l.mine) {
        const key = l.pubkey;
        who.title = "Click to mute this sender";
        who.onclick = (e) => {
          if (!e.isTrusted) return;
          muted.add(key);
          saveMuted();
          log = log.filter((x) => x.pubkey !== key);
          sys(`Muted #${fp(key)}`);
        };
      }
      row.append(who);
    }
    const s = document.createElement("span");
    s.textContent = l.sys || l.mine ? l.text : mask(l.text);
    row.append(s);
    return row;
  });
  const atEnd = ui.log.scrollTop + ui.log.clientHeight >= ui.log.scrollHeight - 4;
  ui.log.replaceChildren(...rows);
  if (atEnd) ui.log.scrollTop = ui.log.scrollHeight;
}

const CSS = `
  .w{width:260px}
  .st{color:#93c5fd;font-size:11px;margin-bottom:3px}
  .log{height:150px;overflow-y:auto;overflow-x:hidden;margin-bottom:4px}
  .r{word-break:break-word;padding:1px 0}.r em{font-style:normal;color:#6b7280;margin-right:4px;font-size:10px}
  .r b{color:#a5b4fc;margin-right:4px;cursor:pointer}.me b{color:#fde047;cursor:default}.s{color:#9ca3af;font-style:italic}
  form{display:flex;gap:4px}
  input{flex:1;min-width:0;font:12px system-ui,sans-serif;background:#111827;color:#e8eef5;border:1px solid #374151;border-radius:4px;padding:2px 5px}
  button{font:12px system-ui,sans-serif;background:#2563eb;color:#fff;border:0;border-radius:4px;padding:2px 8px;cursor:pointer}
  button:disabled,input:disabled{opacity:.5}
  .n{color:#6b7280;font-size:10px;margin-top:3px}
`;

export const chatAid: Aid = {
  key: "chat",
  label: "Script chat (Nostr)",
  title:
    "A chat box for players running this script or openfront-pro in the same game. Messages, your in-game name and a " +
    "per-game key go to public Nostr relays (relay.primal.net, nos.lol, nostr.mom, relay.snort.social), which also see your IP. " +
    "Paused while you are alive in a free-for-all.",
  def: false,
  start() {
    loadMuted();
    box = makeBox("chat", "Script chat", -280, 120, CSS);
    box.body.innerHTML =
      `<div class="st"></div><div class="log"></div>` +
      `<form><input maxlength="${MAX_TEXT}" placeholder="Message (public)"><button type="submit">Send</button></form>` +
      `<div class="n">Public Nostr relays; names are not verified. Click a name to mute.</div>`;
    const input = box.body.querySelector("input") as HTMLInputElement;
    ui = {
      st: box.body.querySelector(".st") as HTMLElement,
      log: box.body.querySelector(".log") as HTMLElement,
      input,
      send: box.body.querySelector("button") as HTMLButtonElement,
    };
    // Keys typed here must not reach the game's hotkeys.
    for (const ev of ["keydown", "keyup", "keypress"]) input.addEventListener(ev, (e) => e.stopPropagation());
    (box.body.querySelector("form") as HTMLFormElement).onsubmit = (e) => {
      e.preventDefault();
      if (!e.isTrusted) return; // only real user input sends
      say(input.value, myName(gameView()));
      input.value = "";
    };
    box.show(false);
    stopTick = every(1000, tick);
    tick();
  },
  stop() {
    stopTick?.();
    stopTick = null;
    leave(myName(gameView()));
    log = [];
    lastGame = null;
    recent.clear();
    tempMuted.clear();
    ui = null;
    box?.remove();
    box = null;
  },
};
