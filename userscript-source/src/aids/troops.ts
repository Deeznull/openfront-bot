/**
 * Troop timing and safe donation, in one small box.
 * - A bar of our troops against the cap, with a mark where troop growth is
 *   fastest (the game's growth (10 + T^0.73/4) * (1 - T/max) peaks there),
 *   growth per second, and a cue: below the mark troops grow faster by
 *   waiting; well above it they grow slower, so it's a good time to attack.
 * - What an attack at the current attack ratio sends, and how much can be
 *   donated while keeping a 35% reserve of the cap.
 * Ideas from Erogz/OpenFrontIO-TroopTiming and
 * Chrome-Extensions-labs/OpenFront-donor-calculator; this is our own code.
 */
import { type Aid, type Box, call, every, fmt, gameView, inGame, makeBox } from "./core";

const RESERVE = 0.35;
let box: Box | null = null;
let stopTick: (() => void) | null = null;

const growth = (t: number, max: number) => Math.max(0, (10 + Math.pow(t, 0.73) / 4) * (1 - t / max));

/** Troop count (fraction of the cap) where growth peaks. */
function peak(max: number): number {
  let best = 0;
  let at = 0;
  for (let f = 0.05; f < 1; f += 0.01) {
    const g = growth(f * max, max);
    if (g > best) {
      best = g;
      at = f;
    }
  }
  return at;
}

function tick() {
  if (!box) return;
  const g = gameView();
  const me = call(g, "myPlayer");
  if (!g || !me || !inGame() || !call(me, "isAlive")) return box.show(false);
  box.show(true);
  const troops = Number(call(me, "troops")) || 0;
  const max = Number(call(call(g, "config"), "maxTroops", me)) || 0;
  if (max <= 0) return;
  const f = Math.min(1, troops / max);
  const pk = peak(max);
  // Growth is per tick; 10 ticks a second. Troops are kept ×10 internally.
  const perSec = (growth(troops, max) * 10) / 10;
  let cue: string;
  let cls: string;
  if (f < pk - 0.05) {
    cue = "Wait: troops still grow faster";
    cls = "w8";
  } else if (f <= pk + 0.1) {
    cue = "Peak growth: good to attack";
    cls = "ok";
  } else {
    cue = "Above peak: growth slowing, attack";
    cls = "go";
  }
  const ratio = Number((document.querySelector("build-menu") as any)?.uiState?.attackRatio) || 0;
  const send = troops * ratio;
  const spare = Math.max(0, troops - RESERVE * max);
  box.body.innerHTML =
    `<div class="bar"><u style="width:${(f * 100).toFixed(1)}%"></u><i style="left:${(pk * 100).toFixed(1)}%"></i></div>` +
    `<div class="l"><span>${fmt(troops / 10)} / ${fmt(max / 10)}</span><em>${Math.round(f * 100)}% · +${fmt(perSec)}/s</em></div>` +
    `<div class="${cls}">${cue}</div>` +
    (ratio > 0 ? `<div class="l"><span>Attack ${Math.round(ratio * 100)}%</span><em>${fmt(send / 10)} troops</em></div>` : "") +
    `<div class="l"><span>Safe to donate</span><em>${spare > 0 ? fmt(spare / 10) : "save up"}</em></div>`;
}

const CSS = `
  .w{width:190px}
  .bar{position:relative;height:8px;border-radius:4px;background:linear-gradient(90deg,#b91c1c,#ca8a04 30%,#16a34a 45%,#ca8a04 70%,#6b7280);margin:3px 0}
  .bar u{position:absolute;left:0;top:0;bottom:0;background:rgba(255,255,255,.35);border-right:2px solid #fff;text-decoration:none;border-radius:4px 0 0 4px}
  .bar i{position:absolute;top:-2px;bottom:-2px;width:2px;background:#fde047}
  .l{display:flex;justify-content:space-between;gap:6px}.l em{font-style:normal;color:#cbd5e1}
  .w8{color:#fca5a5}.ok{color:#86efac}.go{color:#fde047}
`;

export const troopsAid: Aid = {
  key: "troops",
  label: "Troop timing + safe donation",
  title:
    "A box with your troops against the cap and where growth is fastest (yellow mark), when to wait or attack, " +
    "what an attack at your ratio sends, and how much you can donate keeping a 35% reserve.",
  def: false,
  start() {
    // Top centre by default: the helper's advisor/team panels take the top left.
    box = makeBox("troops", "Troops", Math.max(8, innerWidth / 2 - 110), 44, CSS);
    stopTick = every(500, tick);
    tick();
  },
  stop() {
    stopTick?.();
    box?.remove();
    box = stopTick = null;
  },
};
