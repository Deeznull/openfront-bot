/**
 * Mirror mode, for engines without snapshot/restore (v0.34): what keeps the
 * bot playing when the shadow drifts from the real game (a newer site version
 * with small rule changes, or anything else that makes the hashes differ).
 *
 * The page forwards what the real engine worker reports each tick (feed.ts).
 * From tick 0 this keeps a copy of the real tile ownership and each player's
 * tile count, and checks the feed against itself: the tile count in every
 * player's stats row must match the ownership copy. A newer site version that
 * packs things differently fails that check and is reported, instead of
 * "correcting" the shadow with garbage.
 *
 * Before the first hash mismatch it only watches. After `start`, the shadow
 * runs no further ahead than the real game, and after each shadow tick the
 * tiles either side changed are set to the real owner (conquer / relinquish,
 * so tile sets and borders stay consistent), and troops and gold are set from
 * the stats rows, before the bot looks at the game. Hashes can't confirm sync
 * any more, so agreement is measured instead: the share of changed tiles the
 * shadow already had right before the fix, over the last minute.
 */
import type { Game } from "ofengine";
import type { FeedEntry } from "./feed";

/** v0.34 tile state: bits 0-11 are the owner's smallID (GameMapImpl). */
const OWNER_MASK = 0xfff;
const REPORT_EVERY = 100; // ticks between agreement reports (and full scans)
const WINDOW = 6; // reports in the agreement window (1 minute)
const LOW_AGREEMENT = 0.3; // a full window below this: the rules differ too much
const MAX_BACKLOG = 50; // turns the shadow may wait for the real game before going on alone

export type Post = (msg: any) => void;

export class Mirror {
  on = false;
  correct = true;
  lost = false;
  private q: FeedEntry[] = [];
  private qHead = 0;
  private realTick = -1; // newest real tick received
  private owner: Uint16Array | null = null; // real owner smallID per tile
  private stamp: Int32Array | null = null; // dedupe of changed tiles per check
  private count = new Int32Array(OWNER_MASK + 1); // real tiles per smallID
  private troops = new Map<number, number>();
  private gold = new Map<number, number>();
  private realDirty: Uint32Array[] = [];
  private shadowDirty: Uint32Array[] = [];
  // Feed format check.
  private statOk = 0;
  private statBad = 0;
  private tilePairs = 0;
  private tileBad = 0;
  private noTiles = 0;
  // Agreement.
  private checked = 0;
  private wrong = 0;
  private window: [number, number][] = [];
  private lowRuns = 0;
  private ownBadRuns = 0;
  private needFull = false;
  private startTick = -1;
  private lastReport = 0;
  private fixedTiles = 0;
  private fixedStats = 0;

  constructor(
    private post: Post,
    private mySmallID: () => number,
  ) {}

  push(list: FeedEntry[]) {
    for (const e of list) {
      if (!e || typeof e.tick !== "number") continue;
      this.q.push(e);
      if (e.tick > this.realTick) this.realTick = e.tick;
    }
  }

  /** Mirror mode: the shadow waits until the real game has run tick `next`. */
  holds(next: number, backlog: number): boolean {
    return this.on && !this.lost && this.realTick < next && backlog < MAX_BACKLOG;
  }

  /** The shadow's own tile changes this tick (its runner's packedTileUpdates). */
  shadowTiles(t: unknown) {
    if (this.on && t instanceof Uint32Array && t.length > 0) this.shadowDirty.push(t);
  }

  start(correct: boolean) {
    if (this.on) return;
    this.on = true;
    this.correct = correct;
    this.needFull = true;
  }

  feedState(): "ok" | "bad" | "unknown" {
    const checks = this.statOk + this.statBad;
    if (this.noTiles > 20 || this.tileBad > 20 + this.tilePairs * 0.001) return "bad";
    if (checks >= 50 && this.statBad > checks * 0.05) return "bad";
    return this.statOk >= 50 && this.tilePairs > 0 ? "ok" : "unknown";
  }

  /** After each shadow tick and each real batch: catch up and, when both games are at the same tick, check. */
  sync(g: Game) {
    const ga = g as any;
    if (!this.owner) {
      const n = ga.width() * ga.height();
      this.owner = new Uint16Array(n);
      this.stamp = new Int32Array(n).fill(-1);
    }
    const now = g.ticks();
    while (this.qHead < this.q.length && this.q[this.qHead].tick <= now) this.apply(ga, this.q[this.qHead++]);
    if (this.qHead > 512) {
      this.q.splice(0, this.qHead);
      this.qHead = 0;
    }
    if (this.realTick < now) return; // the real game hasn't reached this tick yet
    if (!this.on) {
      if (now - this.lastReport >= REPORT_EVERY) this.watch(ga, now);
    } else if (!this.lost) {
      this.check(ga, now);
    }
  }

  private isPlayer(g: any, id: number): boolean {
    const p = g.playerBySmallID(id);
    return !!p && typeof p.isPlayer === "function" && p.isPlayer();
  }

  private apply(g: any, e: FeedEntry) {
    const own = this.owner!;
    const n = own.length;
    const t = e.tiles;
    if (!t) this.noTiles++;
    else {
      if (t.length % 2) this.tileBad++;
      for (let i = 0; i + 1 < t.length; i += 2) {
        const ref = t[i];
        const o = t[i + 1] & OWNER_MASK;
        this.tilePairs++;
        if (ref >= n || (o !== 0 && !this.isPlayer(g, o))) {
          this.tileBad++;
          continue;
        }
        const prev = own[ref];
        if (prev !== o) {
          this.count[prev]--;
          this.count[o]++;
          own[ref] = o;
        }
      }
      if (this.on) this.realDirty.push(t);
    }
    for (const s of [e.stats, e.players]) {
      if (!s) continue;
      if (s.length % 5) {
        this.statBad++;
        continue;
      }
      for (let i = 0; i < s.length; i += 5) {
        const id = s[i];
        if (!Number.isInteger(id) || id <= 0 || id > OWNER_MASK || !this.isPlayer(g, id)) {
          this.statBad++;
          continue;
        }
        if (Number.isFinite(s[i + 1])) {
          if (s[i + 1] === this.count[id]) this.statOk++;
          else this.statBad++;
        }
        if (Number.isFinite(s[i + 2])) this.gold.set(id, s[i + 2]);
        if (Number.isFinite(s[i + 3])) this.troops.set(id, s[i + 3]);
      }
    }
  }

  private ownerReader(g: any): (t: number) => number {
    const buf = typeof g.map()?.tileStateBuffer === "function" ? g.map().tileStateBuffer() : null;
    return buf instanceof Uint16Array && buf.length === this.owner!.length
      ? (t) => buf[t] & OWNER_MASK
      : (t) => g.ownerID(t);
  }

  /** Real owner differs from the shadow's on these tiles (whole map). */
  private scan(g: any): { owned: number; diff: number[] } {
    const own = this.owner!;
    const read = this.ownerReader(g);
    let owned = 0;
    const diff: number[] = [];
    for (let t = 0; t < own.length; t++) {
      const r = own[t];
      const s = read(t);
      if (r === 0 && s === 0) continue;
      owned++;
      if (r !== s) diff.push(t);
    }
    return { owned, diff };
  }

  /** Before mirror mode: report the feed check, and flag a divergence the hashes may have missed. */
  private watch(g: any, now: number) {
    this.lastReport = now;
    const { owned, diff } = this.scan(g);
    const feed = this.feedState();
    this.post({ t: "sync", tick: now, mirror: false, feed, owned: owned ? 1 - diff.length / owned : 1 });
    if (diff.length > 0 && feed === "ok") this.post({ t: "diverged", tick: now, tiles: diff.length });
  }

  private check(g: any, now: number) {
    if (this.startTick < 0) this.startTick = now;
    const own = this.owner!;
    const stamp = this.stamp!;
    const read = this.ownerReader(g);
    const fix: number[] = [];
    // Tiles either game changed since the last check.
    for (const list of [this.realDirty, this.shadowDirty]) {
      for (const t of list) {
        for (let i = 0; i + 1 < t.length; i += 2) {
          const ref = t[i];
          if (ref >= own.length || stamp[ref] === now) continue;
          stamp[ref] = now;
          this.checked++;
          if (own[ref] !== read(ref)) {
            this.wrong++;
            fix.push(ref);
          }
        }
      }
      list.length = 0;
    }
    const full = this.needFull || now - this.lastReport >= REPORT_EVERY;
    let ownedAgree = -1;
    if (full) {
      const { owned, diff } = this.scan(g);
      ownedAgree = owned ? 1 - diff.length / owned : 1;
      for (const t of diff) if (stamp[t] !== now) fix.push(t);
    }
    const me = this.mySmallID();
    const mp: any = me > 0 ? g.playerBySmallID(me) : null;
    const meShadow = mp?.isPlayer?.() ? mp.numTilesOwned() : 0;
    const troopsShadow = mp?.isPlayer?.() ? Number(mp.troops()) : 0;
    if (this.correct) {
      for (const t of fix) this.fixTile(g, t);
      for (const [id, v] of this.troops) {
        const p = g.playerBySmallID(id);
        if (p?.isPlayer?.() && p.troops() !== v) {
          p.setTroops(v);
          this.fixedStats++;
        }
      }
      for (const [id, v] of this.gold) {
        const p = g.playerBySmallID(id);
        if (p?.isPlayer?.() && Number(p.gold()) !== v) {
          setGold(p, v);
          this.fixedStats++;
        }
      }
    }
    if (!full) return;
    this.needFull = false;
    this.lastReport = now;
    this.window.push([this.checked, this.wrong]);
    if (this.window.length > WINDOW) this.window.shift();
    this.checked = this.wrong = 0;
    let c = 0;
    let w = 0;
    for (const [a, b] of this.window) {
      c += a;
      w += b;
    }
    const pct = c > 0 ? 1 - w / c : 1;
    const feed = this.feedState();
    const meReal = me > 0 ? this.count[me] : 0;
    this.post({
      t: "sync",
      tick: now,
      mirror: true,
      correct: this.correct,
      feed,
      pct,
      owned: ownedAgree,
      meReal,
      meShadow,
      troopsReal: me > 0 ? (this.troops.get(me) ?? 0) : 0,
      troopsShadow,
      fixedTiles: this.fixedTiles,
      fixedStats: this.fixedStats,
    });
    if (!this.correct) return;
    // Give up when the feed can't be read, the shadow can't be kept on our
    // own territory, or it keeps predicting the game badly.
    if (feed === "bad") return this.lose("the game's update format is not recognised");
    if (feed === "unknown" && now - this.startTick > 600) return this.lose("the game's updates could not be verified");
    const after = mp?.isPlayer?.() ? mp.numTilesOwned() : 0;
    this.ownBadRuns = Math.abs(after - meReal) > Math.max(5, meReal * 0.02) ? this.ownBadRuns + 1 : 0;
    if (this.ownBadRuns >= 3) return this.lose("own territory could not be kept in sync");
    this.lowRuns = c >= 200 && pct < LOW_AGREEMENT ? this.lowRuns + 1 : 0;
    if (this.lowRuns >= WINDOW) return this.lose(`agreement stayed at ${Math.round(pct * 100)}%`);
  }

  private fixTile(g: any, t: number) {
    const r = this.owner![t];
    try {
      if (r === 0) {
        if (g.hasOwner(t)) g.relinquish(t);
      } else {
        const p = g.playerBySmallID(r);
        if (!p?.isPlayer?.() || !g.isLand(t) || g.ownerID(t) === r) return;
        p.conquer(t);
      }
      this.fixedTiles++;
    } catch {
      /* water / impassable in our copy of the map: leave it */
    }
  }

  private lose(why: string) {
    this.lost = true;
    this.post({ t: "lost", msg: why });
  }
}

/** Gold is a bigint in v0.34; set it without counting it as income. */
function setGold(p: any, v: number) {
  if (typeof p._gold === "bigint") p._gold = BigInt(Math.max(0, Math.round(v)));
  else if (typeof p._gold === "number") p._gold = v;
  else {
    const cur = Number(p.gold());
    if (v > cur) p.addGold(BigInt(Math.round(v - cur)));
    else p.removeGold(BigInt(Math.round(cur - v)));
  }
}
