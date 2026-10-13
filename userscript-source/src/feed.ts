/**
 * Version-tolerant reading of the engine's per-tick update (GameUpdateViewData:
 * what the page's engine worker sends in game_update_batch, and what the
 * shadow's own runner reports). Shared by page.ts, shadow.ts and the headless
 * test, so all three read updates the same way.
 */

export interface HashEntry {
  tick: number;
  hash: number;
}

/**
 * What mirror mode (mirror.ts) needs from one real tick. Stats rows are
 * `[smallID, tilesOwned, gold, troops, goldEarned]` (NaN where unknown).
 */
export interface FeedEntry {
  tick: number;
  tiles: Uint32Array | null; // [tileRef, packed tile state] pairs
  stats: Float64Array | null; // packed per-player stats rows
  players: number[] | null; // the same rows, from PlayerUpdate objects that carry stats
}

const isHash = (e: any) => !!e && typeof e === "object" && typeof e.tick === "number" && typeof e.hash === "number";

let hashSlot: string | null = null;

/**
 * The hash updates in `gu.updates`: at the GameUpdateType.Hash index when that
 * slot holds them, else wherever entries of that shape are (a newer engine
 * that reordered the enum still works).
 */
export function findHashes(gu: any, index: number): HashEntry[] {
  const ups = gu?.updates;
  if (!ups || typeof ups !== "object") return [];
  for (const k of [index, hashSlot]) {
    if (k === null) continue;
    const a = ups[k];
    if (Array.isArray(a) && a.length > 0 && a.every(isHash)) return a;
  }
  for (const k of Object.keys(ups)) {
    const a = ups[k];
    if (Array.isArray(a) && a.length > 0 && a.every(isHash)) {
      hashSlot = k;
      return a;
    }
  }
  return [];
}

/** Copies (never views) of the parts of `gu` mirror mode reads, or null. */
export function feedEntry(gu: any): FeedEntry | null {
  if (!gu || typeof gu.tick !== "number" || !gu.updates) return null;
  const t = gu.packedTileUpdates;
  const s = gu.packedPlayerUpdates;
  let players: number[] | null = null;
  // Stats inside PlayerUpdate objects: a player's first update in v0.34, and
  // every update in engines that don't pack them.
  for (const k of Object.keys(gu.updates)) {
    const a = gu.updates[k];
    if (!Array.isArray(a)) continue;
    for (const u of a) {
      if (!u || typeof u.smallID !== "number" || typeof u.troops !== "number") continue;
      players ??= [];
      players.push(
        u.smallID,
        typeof u.tilesOwned === "number" ? u.tilesOwned : NaN,
        u.gold === undefined ? NaN : Number(u.gold),
        u.troops,
        NaN,
      );
    }
  }
  return {
    tick: gu.tick,
    tiles: ArrayBuffer.isView(t) ? new Uint32Array(t as any) : null,
    stats: ArrayBuffer.isView(s) ? new Float64Array(s as any) : null,
    players,
  };
}

/** Buffers to transfer when posting feed entries to another thread. */
export function feedTransfers(list: FeedEntry[]): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const e of list) {
    if (e.tiles) out.push(e.tiles.buffer as ArrayBuffer);
    if (e.stats) out.push(e.stats.buffer as ArrayBuffer);
  }
  return out;
}
