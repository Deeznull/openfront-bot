/**
 * Play aids: optional helpers for a human player (overlays, panels, hotkeys).
 * Each aid has its own checkbox in the bot panel and works with the bot on or
 * off. Aids read the game client's own view objects (GameView/PlayerView on
 * its HUD elements); the few that act send intents through page.ts (`api.send`),
 * which shares the bot's rate limiter.
 */

export type Intent = { type: string; [k: string]: any };

export interface AidApi {
  /** Queue one intent for sending now (bot on or off); false if no game. */
  send(i: Intent): boolean;
  /** Short message in the bot panel. */
  note(msg: string): void;
}

export interface Aid {
  key: string;
  label: string;
  title: string;
  /** On for new installs. */
  def: boolean;
  start(api: AidApi): void;
  stop(): void;
}

/** The client's GameView, read from a HUD element that holds it. */
export function gameView(): any {
  const bm = document.querySelector("build-menu") as any;
  if (bm?.game?.myPlayer) return bm.game;
  for (const s of ["player-panel", "control-panel", "leader-board", "events-display"]) {
    const el = document.querySelector(s) as any;
    const g = el?.game ?? el?.g;
    if (g?.playerViews) return g;
  }
  return null;
}

export function inGame(): boolean {
  return document.body?.classList.contains("in-game") ?? false;
}

/** Calls an optional method; undefined when missing or throwing. */
export function call(o: any, m: string, ...a: any[]): any {
  try {
    return typeof o?.[m] === "function" ? o[m](...a) : undefined;
  } catch {
    return undefined;
  }
}

/** Map tile under a screen point, or null (off the map / no game). */
export function tileAt(clientX: number, clientY: number): number | null {
  const bm = document.querySelector("build-menu") as any;
  const g = bm?.game;
  const th = bm?.transformHandler;
  if (!g || !th) return null;
  const c = call(th, "screenToWorldCoordinates", clientX, clientY);
  if (!c || !g.isValidCoord(c.x, c.y)) return null;
  return g.ref(c.x, c.y);
}

/** Is the key event aimed at a text field (chat, name box)? */
export function typing(e: Event): boolean {
  const t = (e.composedPath?.()[0] ?? e.target) as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

export function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

const BOX_CSS = `
  :host{all:initial}
  .w{font:12px/1.35 system-ui,sans-serif;color:#e8eef5;background:rgba(17,24,39,.88);
     border:1px solid #374151;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);min-width:150px}
  .h{padding:4px 8px;cursor:move;border-bottom:1px solid #374151;font-weight:600;display:flex;gap:6px}
  .h span{flex:1}.h small{cursor:pointer;color:#9ca3af;font-weight:400}
  .c{padding:5px 8px}
`;

/**
 * A small draggable, foldable box (own shadow root) for an aid. Its spot and
 * fold state are kept in localStorage under the aid's key.
 */
export function makeBox(key: string, title: string, x: number, y: number, css = "") {
  const sk = `ofbot.box.${key}`;
  let st = { x, y, min: false };
  try {
    Object.assign(st, JSON.parse(localStorage.getItem(sk) ?? "{}"));
  } catch {
    /* defaults */
  }
  const save = () => {
    try {
      localStorage.setItem(sk, JSON.stringify(st));
    } catch {
      /* ignore */
    }
  };
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;z-index:2147483645;";
  const place = () => {
    const px = st.x < 0 ? innerWidth + st.x : st.x;
    host.style.left = `${Math.max(0, Math.min(innerWidth - 60, px))}px`;
    host.style.top = `${Math.max(0, Math.min(innerHeight - 24, st.y))}px`;
  };
  place();
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${BOX_CSS}${css}</style><div class="w"><div class="h"><span></span><small>–</small></div><div class="c"></div></div>`;
  const head = root.querySelector(".h") as HTMLElement;
  (head.querySelector("span") as HTMLElement).textContent = title;
  const fold = head.querySelector("small") as HTMLElement;
  const body = root.querySelector(".c") as HTMLElement;
  const showFold = () => {
    body.style.display = st.min ? "none" : "";
    fold.textContent = st.min ? "+" : "–";
  };
  showFold();
  fold.onclick = () => {
    st.min = !st.min;
    save();
    showFold();
  };
  head.onpointerdown = (e) => {
    if (e.target === fold) return;
    const r = host.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      st.x = Math.max(0, Math.min(innerWidth - 60, ev.clientX - sx));
      st.y = Math.max(0, Math.min(innerHeight - 24, ev.clientY - sy));
      place();
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      save();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  for (const ev of ["pointerdown", "mousedown", "click", "wheel", "contextmenu"]) {
    host.addEventListener(ev, (e) => e.stopPropagation());
  }
  const onResize = () => place();
  addEventListener("resize", onResize);
  document.documentElement.appendChild(host);
  return {
    root,
    body,
    show(on: boolean) {
      host.style.display = on ? "" : "none";
    },
    remove() {
      removeEventListener("resize", onResize);
      host.remove();
    },
  };
}
export type Box = ReturnType<typeof makeBox>;

/** setInterval that only runs while the aid is on; returns a stopper. */
export function every(ms: number, fn: () => void): () => void {
  const id = setInterval(() => {
    try {
      fn();
    } catch (e) {
      console.warn("[ofbot] aid error", e);
    }
  }, ms);
  return () => clearInterval(id);
}
