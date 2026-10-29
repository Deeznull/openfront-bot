/**
 * Troll chat: the game's "[P1] is cheating!" quick chat with [P1] = you, sent
 * to every other human player in turn, as often as the limits allow. The game
 * lets each recipient get one quick chat from you per 30 ticks (3 s), and
 * page.ts holds aid chat back while the bot's moves need the minute budget,
 * so this gives one send per ~0.6 s (100 a minute, the chat share of the
 * limiter), each to the human who waited longest.
 */
import { type Aid, type AidApi, call, every, gameView, inGame } from "./core";

const KEY = "warnings.cheating";
const STEP_MS = 600;
const PER_RECIPIENT_MS = 3500; // the game's 3 s cooldown plus a margin

let stop: (() => void) | null = null;
const last = new Map<string, number>();

function step(api: AidApi) {
  const g = gameView();
  const me = call(g, "myPlayer");
  if (!g || !me || !inGame()) return last.clear();
  const myId = call(me, "id");
  const now = performance.now();
  let best: string | null = null;
  let bestAt = Infinity;
  for (const p of call(g, "playerViews") ?? []) {
    if (call(p, "type") !== "HUMAN" || !call(p, "isAlive")) continue;
    const id = call(p, "id");
    if (!id || id === myId) continue;
    const at = last.get(id) ?? -Infinity; // never sent: first in line
    if (now - at >= PER_RECIPIENT_MS && at < bestAt) {
      best = id;
      bestAt = at;
    }
  }
  if (best && api.send({ type: "quick_chat", recipient: best, quickChatKey: KEY, target: myId })) {
    last.set(best, now);
  }
}

export const trollAid: Aid = {
  key: "troll",
  label: "Troll chat (\"<you> is cheating!\" to everyone)",
  title:
    "Sends the game's \"[P1] is cheating!\" quick chat with your own name to every other human player in turn, " +
    "as often as the game allows (each player at most every 3 s, about 100 a minute in all). " +
    "It waits while the bot needs the send budget for moves. Not switched on by All.",
  def: false,
  start(api) {
    stop = every(STEP_MS, () => step(api));
  },
  stop() {
    stop?.();
    stop = null;
    last.clear();
  },
};
