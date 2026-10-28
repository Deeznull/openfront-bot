/**
 * Hold-key macros: hold a key and left-click the map.
 *   X: launch as many Atom Bombs at the tile as the gold pays for (max 50,
 *      the game's per-intent limit; each one still needs a ready silo).
 *   Z / V / H: build a Port / SAM Launcher / Missile Silo there, or, on one
 *      of ours, upgrade it by up to 50 levels (the game stops at the gold).
 * The keys are free in the default keybinds (B is the boat key, so the silo
 * is on H). The click doesn't reach the game while the key is held.
 * Idea from GepingY/OpenFrontIO-AutoClicker; this is our own code.
 */
import { type Aid, type AidApi, gameView, inGame, tileAt, typing } from "./core";

const KEYS: Record<string, string> = {
  KeyX: "Atom Bomb",
  KeyZ: "Port",
  KeyV: "SAM Launcher",
  KeyH: "Missile Silo",
};
const MAX_AMOUNT = 50;

let api: AidApi | null = null;
let held: string | null = null;
const offs: (() => void)[] = [];

function on<K extends keyof WindowEventMap>(t: K, f: (e: WindowEventMap[K]) => void) {
  addEventListener(t, f as any, true);
  offs.push(() => removeEventListener(t, f as any, true));
}

async function act(type: string, x: number, y: number) {
  const g = gameView();
  const me = g?.myPlayer?.();
  const tile = tileAt(x, y);
  if (!me || tile === null || !api) return;
  const items: any[] = (await me.buildables(tile, [type])) ?? [];
  const bu = items.find((b) => b.type === type);
  if (!bu) return api.note(`${type}: not available here`);
  const gold = Number(me.gold());
  const cost = Number(bu.cost) || 0;
  if (bu.canUpgrade !== false && bu.canUpgrade !== undefined) {
    api.send({ type: "upgrade_structure", unit: type, unitId: bu.canUpgrade, amount: MAX_AMOUNT });
    api.note(`Upgrading ${type}`);
  } else if (bu.canBuild !== false && bu.canBuild !== undefined) {
    const nuke = type === "Atom Bomb" || type === "Hydrogen Bomb";
    const n = nuke ? Math.max(1, Math.min(MAX_AMOUNT, cost > 0 ? Math.floor(gold / cost) : 1)) : 1;
    const up = (document.querySelector("build-menu") as any)?.uiState?.rocketDirectionUp;
    api.send({ type: "build_unit", unit: type, tile, rocketDirectionUp: nuke ? up : undefined, amount: nuke ? n : undefined });
    api.note(nuke ? `Launching ${n} × ${type}` : `Building ${type}`);
  } else {
    api.note(`${type}: can't build or upgrade here (gold, place or silo)`);
  }
}

/** Only clicks on the map, not on HUD elements or our panels. */
function onMap(e: Event): boolean {
  const t = e.composedPath()[0] as HTMLElement | undefined;
  return !!t && (t.tagName === "CANVAS" || t.id === "game-input-overlay");
}

export const macros: Aid = {
  key: "macros",
  label: "Hold-key macros (X nuke, Z port, V SAM, H silo + click)",
  title:
    "Hold X and left-click the map to launch as many Atom Bombs as your gold pays for (max 50). " +
    "Hold Z / V / H and click to build a Port / SAM / Missile Silo, or upgrade yours there by up to 50 levels.",
  def: false,
  start(a) {
    api = a;
    on("keydown", (e) => {
      if (!inGame() || typing(e) || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (KEYS[e.code]) held = e.code;
    });
    on("keyup", (e) => {
      if (e.code === held) held = null;
    });
    on("blur", () => (held = null));
    on("pointerdown", (e) => {
      if (!held || e.button !== 0 || !onMap(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void act(KEYS[held], e.clientX, e.clientY);
    });
    // Keep the rest of the click from the game too (no attack on release).
    for (const t of ["pointerup", "mousedown", "mouseup", "click"] as const) {
      on(t, (e) => {
        if (held && (e as MouseEvent).button === 0 && onMap(e)) e.stopImmediatePropagation();
      });
    }
  },
  stop() {
    while (offs.length) offs.pop()!();
    held = null;
    api = null;
  },
};
