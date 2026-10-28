/**
 * Game records: one per game the bot plays, so lost online games can be
 * studied afterwards next to their replay (the game ID fetches it). Kept in
 * localStorage (newest last) and written to the console as one
 * `[ofbot-rec] {json}` line when the game is left, for a headless runner.
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
  botOn: boolean;
  cps: any[]; // checkpoints from the shadow (shadow.ts recStep)
  died: number | null; // tick of our death
  end: { tick: number; title: string; alive: boolean } | null; // first win-modal sight
  left: number | null; // wall time the game was left
}

export function recNew(init: any, version: string): GameRec {
  const info = init?.gameStartInfo ?? {};
  const cfg = info.config ?? {};
  return {
    v: version,
    id: String(info.gameID ?? "?"),
    type: String(cfg.gameType ?? "?"),
    map: String(cfg.gameMap ?? "?"),
    mode: String(cfg.gameMode ?? "?"),
    difficulty: String(cfg.difficulty ?? "?"),
    players: Array.isArray(info.players) ? info.players.length : 0,
    start: Date.now(),
    botOn: false,
    cps: [],
    died: null,
    end: null,
    left: null,
  };
}

export function recAll(): GameRec[] {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
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

/** Downloads every kept record as one JSON file. */
export function recExport() {
  const blob = new Blob([JSON.stringify(recAll(), null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ofbot-games-${new Date().toISOString().slice(0, 10)}.json`;
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
