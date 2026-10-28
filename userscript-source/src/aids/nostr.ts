/**
 * Minimal Nostr client for the chat aid: enough of NIP-01 to publish and
 * receive EPHEMERAL events (kind 20787, which relays forward and are meant not
 * to store) in one room per game on a few public relays.
 * Adapted from devdanetra/openfront-pro src/nostr.js (MIT, Copyright (c) 2026
 * devdanetra), public-room part only (no team channel). The event format and
 * room names are the same, so this chat and openfront-pro's public chat meet
 * in the same rooms. See NOTICE.
 */
import "./vendor/nostr-crypto.js";

const C = (globalThis as any).OFR_NOSTR_CRYPTO;

export const KIND = 20787;
export const MAX_TEXT = 280;
export const MAX_NAME = 32;
const MAX_SKEW = 120; // seconds a message's clock may differ from ours
const MAX_BODY = 4096;
const TYPES = new Set(["msg", "here", "bye"]);

const hex = (b: Uint8Array): string => C.bytesToHex(b);
const sha256hex = (t: string) => hex(C.sha256(C.utf8ToBytes(t)));

/** Room for one game: hashed and lowercase (relays may fold "t" tag case). */
export const roomOf = (gameId: string) => `ofpro${sha256hex(`openfront-pro:${gameId}`).slice(0, 24)}`;
export const newSecretKey = (): string => hex(C.schnorr.utils.randomPrivateKey());
export const publicKeyOf = (sk: string): string => hex(C.schnorr.getPublicKey(sk));

function eventId(ev: any) {
  return sha256hex(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));
}

function makeEvent(sk: string, room: string, type: string, text: string, name: string) {
  const now = Math.floor(Date.now() / 1000);
  const ev: any = {
    pubkey: publicKeyOf(sk),
    created_at: now,
    kind: KIND,
    tags: [
      ["t", room],
      ["x", type],
      ["name", String(name).slice(0, MAX_NAME)],
      ["expiration", String(now + 300)], // NIP-40, for relays that would keep it anyway
    ],
    content: String(text).slice(0, MAX_TEXT),
  };
  ev.id = eventId(ev);
  ev.sig = hex(C.schnorr.sign(ev.id, sk));
  return ev;
}

export interface Msg {
  id: string;
  pubkey: string;
  at: number;
  type: string;
  name: string;
  text: string;
}

/** Everything from a relay is untrusted: shape, size, id, signature, clock. */
function readEvent(ev: any, room: string): Msg | null {
  try {
    if (!ev || typeof ev !== "object" || ev.kind !== KIND) return null;
    if (typeof ev.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(ev.pubkey)) return null;
    if (typeof ev.sig !== "string" || !/^[0-9a-f]{128}$/.test(ev.sig)) return null;
    if (typeof ev.id !== "string" || typeof ev.content !== "string" || !Array.isArray(ev.tags)) return null;
    if (!Number.isInteger(ev.created_at)) return null;
    if (ev.content.length > MAX_BODY || ev.tags.length > 12) return null;
    if (Math.abs(ev.created_at - Date.now() / 1000) > MAX_SKEW) return null;
    const tag = (k: string) => {
      const t = ev.tags.find((x: any) => Array.isArray(x) && x[0] === k);
      return t && typeof t[1] === "string" ? (t[1] as string) : null;
    };
    if (tag("t") !== room) return null;
    const type = tag("x") ?? "";
    if (!TYPES.has(type)) return null; // team-channel events are not read here
    if (ev.content.length > MAX_TEXT * 2) return null;
    if (eventId(ev) !== ev.id) return null;
    if (!C.schnorr.verify(ev.sig, ev.id, ev.pubkey)) return null;
    return {
      id: ev.id,
      pubkey: ev.pubkey,
      at: ev.created_at * 1000,
      type,
      name: (tag("name") ?? "").slice(0, MAX_NAME),
      text: ev.content.slice(0, MAX_TEXT),
    };
  } catch {
    return null;
  }
}

interface Sock {
  ws: WebSocket | null;
  open: boolean;
  retry: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One room on several relays: publish to all, take the first copy of each event. */
export class Room {
  private sockets = new Map<string, Sock>();
  private seen = new Set<string>();
  private closed = false;
  private subId = `ofpro-${Math.random().toString(36).slice(2, 10)}`;
  constructor(
    private relays: string[],
    readonly room: string,
    private sk: string,
    public onMessage: (m: Msg) => void,
    public onStatus: (open: number, total: number) => void,
    public accept: () => boolean, // cheap gate run before any signature check
  ) {
    for (const url of relays) this.connect(url);
  }

  private connect(url: string) {
    if (this.closed) return;
    const st: Sock = this.sockets.get(url) ?? { ws: null, open: false, retry: 0, timer: null };
    st.timer = null;
    this.sockets.set(url, st);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    st.ws = ws;
    ws.onopen = () => {
      if (this.closed) return ws.close();
      st.open = true;
      st.retry = 0;
      const since = Math.floor(Date.now() / 1000) - 5;
      ws.send(JSON.stringify(["REQ", this.subId, { kinds: [KIND], "#t": [this.room], since }]));
      this.status();
    };
    ws.onmessage = (e) => {
      let data: any;
      try {
        data = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        return;
      }
      if (!Array.isArray(data) || data[0] !== "EVENT" || data[1] !== this.subId) return;
      const ev = data[2];
      if (!ev || this.seen.has(ev.id) || !this.accept()) return;
      const m = readEvent(ev, this.room);
      if (!m) return;
      this.remember(m.id);
      this.onMessage(m);
    };
    ws.onclose = () => {
      st.open = false;
      this.status();
      if (this.closed) return;
      // back off: 2s, 4s, 8s ... capped at a minute
      st.timer = setTimeout(() => this.connect(url), Math.min(60000, 2000 * 2 ** st.retry++));
    };
    ws.onerror = () => {};
  }

  private remember(id: string) {
    this.seen.add(id);
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
  }

  private status() {
    this.onStatus([...this.sockets.values()].filter((s) => s.open).length, this.relays.length);
  }

  /** Signs and sends; returns how many relays took it and the event. */
  publish(type: "msg" | "here" | "bye", text: string, name: string) {
    const ev = makeEvent(this.sk, this.room, type, text, name);
    this.remember(ev.id); // our own echo is not news
    let sent = 0;
    for (const st of this.sockets.values()) {
      if (!st.open || !st.ws) continue;
      try {
        st.ws.send(JSON.stringify(["EVENT", ev]));
        sent++;
      } catch {
        /* closing; onclose reconnects */
      }
    }
    return { sent, ev };
  }

  /** Closes every socket and stops reconnecting. */
  close() {
    this.closed = true;
    for (const st of this.sockets.values()) {
      if (st.timer) clearTimeout(st.timer);
      try {
        if (st.open) st.ws?.send(JSON.stringify(["CLOSE", this.subId]));
        st.ws?.close();
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear();
  }
}
