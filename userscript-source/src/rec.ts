/**
 * Game records: one per online game the bot plays (solo games are not kept), so lost online games can be
 * studied afterwards next to their replay: `replay` fetches it, `me` names
 * our player in it, and `bot.on` holds the ticks the bot played (our other
 * moves were the player's). Kept in localStorage (newest last) until exported,
 * and written to the console as one `[ofbot-rec] {json}` line when the game
 * is left, for a headless runner.
 */
const KEY = "ofbot.games.v1";
const MAX = 120;

export interface GameRec {
  v: string; // script version
  id: string; // gameID
  type: string; // Public / Private / Singleplayer
  map: string;
  mode: string;
  difficulty: string;
  players: number; // humans in the lobby
  start: number; // wall time
  replay: string; // the game's record on the public API (once the game is over)
  me: { clientID: string; playerID: string | null; name: string };
  botOn: boolean; // the bot played at some point
  bot: {
    on: [number, number | null][]; // tick ranges the bot was on (null: to the end)
    sent: Record<string, number>; // moves sent, by type
    dropped: number; // moves that went stale or failed
  };
  aids: string[]; // play aids on at the start
  aidSent: Record<string, number>; // moves the play aids sent (macros, auto-donate), by type
  sync: { desyncs: number; resyncs: number; mirror: boolean; lost: boolean; errors: string[] };
  cps: any[]; // checkpoints from the shadow (shadow.ts recStep)
  died: number | null; // tick of our death
  // First win-modal sight; place is among the players alive (bots excluded).
  end: { tick: number; title: string; alive: boolean; place: number | null; of: number | null } | null;
  left: number | null; // wall time the game was left
}

export function recNew(init: any, version: string, aids: string[]): GameRec {
  const info = init?.gameStartInfo ?? {};
  const cfg = info.config ?? {};
  const clientID = String(init?.clientID ?? "?");
  const mine = Array.isArray(info.players) ? info.players.find((p: any) => p?.clientID === clientID) : null;
  return {
    v: version,
    id: String(info.gameID ?? "?"),
    type: String(cfg.gameType ?? "?"),
    map: String(cfg.gameMap ?? "?"),
    mode: String(cfg.gameMode ?? "?"),
    difficulty: String(cfg.difficulty ?? "?"),
    players: Array.isArray(info.players) ? info.players.length : 0,
    start: Date.now(),
    replay: `https://api.openfront.io/public/game/${info.gameID ?? "?"}`,
    me: { clientID, playerID: null, name: String(mine?.username ?? "?") },
    botOn: false,
    bot: { on: [], sent: {}, dropped: 0 },
    aids,
    aidSent: {},
    sync: { desyncs: 0, resyncs: 0, mirror: false, lost: false, errors: [] },
    cps: [],
    died: null,
    end: null,
    left: null,
  };
}

export function recAll(): GameRec[] {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    // Solo games kept by scripts before 0.7.2.2 are dropped.
    return Array.isArray(a) ? a.filter((x) => x && x.type !== "Singleplayer") : [];
  } catch {
    return [];
  }
}

/** The bot was switched on or off at `tick`. */
export function recBot(r: GameRec, on: boolean, tick: number) {
  const last = r.bot.on.at(-1);
  const open = !!last && last[1] === null;
  if (on && !open) r.bot.on.push([Math.max(0, tick), null]);
  if (!on && open) last![1] = Math.max(last![0], tick);
  r.botOn ||= on;
}

export function recCount(m: Record<string, number>, type: string) {
  m[type] = (m[type] ?? 0) + 1;
}

/** An error the bot hit (first line; up to 5 different ones). */
export function recError(r: GameRec, msg: string) {
  const line = String(msg).split("\n")[0].slice(0, 200);
  if (r.sync.errors.length < 5 && !r.sync.errors.includes(line)) r.sync.errors.push(line);
}

/** Adds or replaces `r` (by game ID); the oldest go when storage is short. */
export function recSave(r: GameRec) {
  let all = recAll().filter((x) => x.id !== r.id);
  all.push(r);
  if (all.length > MAX) all = all.slice(-MAX);
  for (;;) {
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
      return;
    } catch {
      if (all.length <= 1) return;
      all = all.slice(Math.ceil(all.length / 2));
    }
  }
}

/** The game was left: save it a last time and print it for a headless runner. */
export function recFinish(r: GameRec) {
  if (r.left) return;
  r.left = Date.now();
  recSave(r);
  console.info(`[ofbot-rec] ${JSON.stringify(r)}`);
}

/**
 * Downloads every kept record but the game still being played (`liveId`) as
 * one JSON file, then removes them from storage. Returns how many.
 */
export function recExport(liveId: string | null): number {
  const all = recAll();
  const out = all.filter((r) => r.id !== liveId);
  if (!out.length) return 0;
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ofbot-games-${new Date().toISOString().slice(0, 10)}.json`;
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  const keep = all.filter((r) => r.id === liveId);
  try {
    if (keep.length) localStorage.setItem(KEY, JSON.stringify(keep));
    else localStorage.removeItem(KEY);
  } catch { /* storage refused: the records stay */ }
  return out.length;
}
