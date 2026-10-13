// E29 opening runner (localhost only). Needs hud.js and act.js pasted first. Paste, it starts at once. window.LOG = result lines, window.STOP=true stops.
// Attack every 3.5s @20% (troops>=30% after 0:45), boat every 10s @40% (<=3 in flight, different coast, troops>=45% after 0:45), City when gold>=cost, land% at 1:00 and 3:00.
(() => {
  window.LOG = []; window.STOP = false; window.LAND = {};
  const b = document.querySelector('build-menu'), g = b.game, me = g.myPlayer(), W = g.width(), H = g.height(), sid = me.smallID();
  const sec = () => g.elapsedGameSeconds ? g.elapsedGameSeconds() : g.ticks() / 10;
  const stamp = () => { const s = Math.floor(sec()); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const log = (m) => { window.LOG.push(stamp() + ' ' + m); };
  const pct = () => 100 * me.troops() / g.config().maxTroops(me);
  const kind = (r) => { const o = g.owner(r); if (!o || !o.isPlayer || !o.isPlayer()) return 'none'; if (o.isMe()) return 'me'; if (me.isAlliedWith(o)) return 'ally'; return o.type() === 'BOT' ? 'bot' : 'nation'; };
  const mineList = () => { const a = []; for (let r = 0; r < W * H; r++) if (g.ownerID(r) === sid) a.push(r); return a; };
  const targets = [], boatDone = [];
  let lastA = -9, lastB = -9, lastC = -9, busy = false, city = false;
  const tick = async () => {
    if (window.STOP || busy) return; busy = true;
    try {
      const t = sec();
      if (t >= 60 && !window.LAND.m1) { window.LAND.m1 = (100 * me.numTilesOwned() / g.numLandTiles()).toFixed(2); log('LAND 1:00 ' + window.LAND.m1 + '%'); }
      if (t >= 180 && !window.LAND.m3) { window.LAND.m3 = (100 * me.numTilesOwned() / g.numLandTiles()).toFixed(2); log('LAND 3:00 ' + window.LAND.m3 + '%'); }
      const mine = mineList(); if (!mine.length) { log('DEAD'); window.STOP = true; return; }
      const ok = (min) => t < 45 || pct() >= min;
      // attack
      if (t - lastA >= 3.5 && ok(30)) {
        lastA = t; let best = null;
        for (const r of mine) { if (!g.isBorder(r)) continue; for (const n of g.neighbors(r)) { if (!g.isLand(n)) continue; const k = kind(n); if (k === 'me' || k === 'ally' || k === 'nation') continue;
          const o = g.owner(n); const w = k === 'none' ? 0 : o.troops(); if (!best || w < best.w) best = { n, w, k }; } }
        if (best) log('A ' + await attack(best.n % W, (best.n / W) | 0, 0.20)); else log('A no touching bot/wilderness tile');
      }
      // boat
      if (t - lastB >= 10 && ok(45) && me.units('Transport').length < 3) {
        lastB = t; let cx = 0, cy = 0; for (const r of mine) { cx += r % W; cy += (r / W) | 0; } cx /= mine.length; cy /= mine.length;
        const c = [];
        for (let y = Math.max(0, cy - 350 | 0); y < Math.min(H, cy + 350); y++) for (let x = Math.max(0, cx - 350 | 0); x < Math.min(W, cx + 350); x++) { const r = g.ref(x, y); if (!g.isLand(r)) continue; const k = kind(r); if (k !== 'none' && k !== 'bot') continue; if (!g.neighbors(r).some((q) => !g.isLand(q))) continue; const d = Math.hypot(x - cx, y - cy); if (d < 25 || d > 350) continue; if (boatDone.some(([bx, by]) => Math.hypot(bx - x, by - y) < 25)) continue; c.push([x, y]); }
        c.sort(() => Math.random() - .5);
        let done = false;
        for (const [x, y] of c.slice(0, 25)) { const res = await boat(x, y, 0.40); if (res.startsWith('OK') || res.startsWith('NO EFFECT')) { boatDone.push([x, y]); log('B ' + res); done = true; break; } }
        if (!done) log('B no valid coast target in ' + Math.min(25, c.length) + ' tries');
      }
      // city
      if (!city && t - lastC >= 4 && Number(me.gold()) >= 125000) {
        lastC = t; let cx = 0, cy = 0; for (const r of mine) { cx += r % W; cy += (r / W) | 0; } cx /= mine.length; cy /= mine.length;
        const inner = mine.filter((r) => g.neighbors(r).every((q) => g.ownerID(q) === sid)).sort((a, b) => Math.hypot(a % W - cx, (a / W | 0) - cy) - Math.hypot(b % W - cx, (b / W | 0) - cy));
        const r = inner[0] ?? mine[0]; const res = await build('City', r % W, (r / W) | 0); log('C ' + res); if (res.startsWith('OK')) city = true;
      }
    } catch (e) { log('ERR ' + e); } finally { busy = false; }
  };
  window.__run = setInterval(() => { if (window.STOP || sec() > 185) { clearInterval(window.__run); log('runner stopped'); } else tick(); }, 500);
  return 'runner started';
})()
