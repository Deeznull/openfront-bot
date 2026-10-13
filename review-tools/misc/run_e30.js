// E30 full-game runner (localhost only). Needs hud.js + act.js pasted first. Extends run_e29.js. window.LOG, window.STOP=true stops, window.LAND={m1,m3,m10}.
// Floor: sends only when troops>50% of max, nothing below 30%. Owner/kind re-read right before each send. Opening 20% attack/3.5s to 0:45.
(() => {
  if (window.__run) clearInterval(window.__run);
  window.LOG = []; window.STOP = false; window.LAND = {}; window.STAT = { boats: 0, builds: [], fails: 0, acts: 0 };
  const b = document.querySelector('build-menu'), g = b.game, me = g.myPlayer(), W = g.width(), H = g.height(), sid = me.smallID();
  const sec = () => g.elapsedGameSeconds ? g.elapsedGameSeconds() : g.ticks() / 10;
  const stamp = () => { const s = Math.floor(sec()); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const log = (m) => { window.LOG.push(stamp() + ' ' + m); };
  const pct = () => 100 * me.troops() / g.config().maxTroops(me);
  const kind = (r) => { const o = g.owner(r); if (!o || !o.isPlayer || !o.isPlayer()) return 'none'; if (o.isMe()) return 'me'; if (me.isAlliedWith(o)) return 'ally'; return o.type() === 'BOT' ? 'bot' : 'nation'; };
  const land = () => (100 * me.numTilesOwned() / g.numLandTiles()).toFixed(2);
  const track = (res) => { window.STAT.acts++; if (!res.startsWith('OK')) window.STAT.fails++; return res; };
  let mine = [], mineAt = -99;
  const mineList = (t) => { if (t - mineAt < 2) return mine; mineAt = t; mine = []; for (let r = 0; r < W * H; r++) if (g.ownerID(r) === sid) mine.push(r); return mine; };
  const cen = (m) => { let cx = 0, cy = 0; for (const r of m) { cx += r % W; cy += (r / W) | 0; } return [cx / m.length, cy / m.length]; };
  const inner = (m) => m.filter((r) => g.neighbors(r).every((q) => g.ownerID(q) === sid));
  const boatDone = [];
  let lastA = -9, lastB = -9, lastC = -9, lastS = -99, lastN = -9, lastAl = -99, busy = false, dead = false, siloDone = false, samDone = false;
  const tick = async () => {
    if (window.STOP || busy) return; busy = true;
    try {
      const t = sec();
      if (!me.isAlive()) { if (!dead) { dead = true; log('DEAD land ' + land()); window.STOP = true; } return; }
      for (const [k, s] of [['m1', 60], ['m3', 180], ['m10', 600]]) if (t >= s && !window.LAND[k]) { window.LAND[k] = land(); log('LAND ' + k + ' ' + land() + '%'); }
      if (t - lastS >= 30) { lastS = t; const inc = me.incomingAttacks().map((a) => { const p = g.playerBySmallID(a.attackerID); return (p && p.displayName ? p.displayName() : '?') + ':' + Math.round(a.troops / 1000) + 'K'; }).join(','); log(`ST land ${land()}% tiles ${me.numTilesOwned()} troops ${Math.round(pct())}% gold ${Math.round(Number(me.gold()) / 1000)}K atkOut ${me.outgoingAttacks().length} in[${inc}] boats ${me.units('Transport').length}`); }
      const p = pct(), early = t < 45;
      const m = mineList(t);
      const canSend = early || p > 50;
      let bestFree = null; const nats = new Map();
      if (t - lastA >= 3.5 || t - lastN >= 3.5) {
        for (const r of m) { if (!g.isBorder(r)) continue; for (const n of g.neighbors(r)) { if (!g.isLand(n)) continue; const k = kind(n); if (k === 'me' || k === 'ally') continue; const o = g.owner(n);
          if (k === 'nation') { if (!nats.has(o.smallID())) nats.set(o.smallID(), { o, n }); } else { const w = k === 'none' ? 0 : o.troops(); if (!bestFree || w < bestFree.w) bestFree = { n, w, k }; } } }
      }
      if (t - lastA >= 3.5 && canSend && (early || p >= 30)) {
        lastA = t;
        if (bestFree) {
          const kk = kind(bestFree.n);
          if (kk === 'bot' || kk === 'none') { if (window.__rt !== 20) { await ratio(20); window.__rt = 20; } log('A ' + track(await attack(bestFree.n % W, (bestFree.n / W) | 0, 0.20))); }
          else log('A skip: owner changed to ' + kk);
        } else if (!early && nats.size === 0) log('A no touching target');
      }
      if (!early && nats.size && !bestFree) {
        const arr = [...nats.values()].sort((a, c) => c.o.troops() - a.o.troops());
        const strongest = arr[0], weakest = arr[arr.length - 1];
        if (t - lastAl >= 60 && !me.isAlliedWith(strongest.o)) { lastAl = t; log('ALLY ' + track(await ally(strongest.o.displayName()))); }
        if (t - lastN >= 3.5 && p > 50 && weakest.o.troops() * 1.5 <= me.troops() && kind(weakest.n) === 'nation' && g.owner(weakest.n).smallID() === weakest.o.smallID()) {
          lastN = t; if (window.__rt !== 40) { await ratio(40); window.__rt = 40; } log('N ' + track(await attack(weakest.n % W, (weakest.n / W) | 0, 0.40)));
        }
      }
      if (t - lastB >= 10 && (early ? p >= 30 : p > 50) && me.units('Transport').length < 3) {
        lastB = t; const [cx, cy] = cen(m);
        const c = [];
        for (let y = Math.max(0, cy - 350 | 0); y < Math.min(H, cy + 350); y++) for (let x = Math.max(0, cx - 350 | 0); x < Math.min(W, cx + 350); x++) { const r = g.ref(x, y); if (!g.isLand(r)) continue; const k = kind(r); if (k !== 'none' && k !== 'bot') continue; if (!g.neighbors(r).some((q) => !g.isLand(q))) continue; const d = Math.hypot(x - cx, y - cy); if (d < 25 || d > 350) continue; if (boatDone.some(([bx, by]) => Math.hypot(bx - x, by - y) < 25)) continue; c.push([x, y]); }
        c.sort(() => Math.random() - .5);
        let done = false;
        for (const [x, y] of c.slice(0, 25)) { const kk = kind(g.ref(x, y)); if (kk !== 'none' && kk !== 'bot') continue; const res = await boat(x, y, 0.40); if (res.startsWith('OK') || res.startsWith('NO EFFECT')) { track(res); boatDone.push([x, y]); window.STAT.boats++; log('B ' + res); done = true; break; } }
        if (!done) log('B no valid coast target in ' + Math.min(25, c.length) + ' tries');
      }
      if (t - lastC >= 4) {
        lastC = t; const gold = Number(me.gold());
        if (gold >= 125000) {
          const [cx, cy] = cen(m);
          const inn = inner(m).sort((a, c) => Math.hypot(a % W - cx, (a / W | 0) - cy) - Math.hypot(c % W - cx, (c / W | 0) - cy));
          const r0 = inn[0] ?? m[0];
          const costOf = async (ty, r) => { const bs = await me.buildables(r, [ty]); const bu = bs.find((u) => u.type === ty); return bu ? Number(bu.cost) : Infinity; };
          let res = null;
          if (gold >= await costOf('City', r0)) { res = await build('City', r0 % W, (r0 / W) | 0); window.STAT.builds.push('City'); }
          else {
            const coast = m.find((r) => g.neighbors(r).some((q) => !g.isLand(q)));
            if (coast && gold >= await costOf('Port', coast)) { res = await build('Port', coast % W, (coast / W) | 0); window.STAT.builds.push('Port'); }
            else if (gold >= await costOf('Factory', r0)) { res = await build('Factory', r0 % W, (r0 / W) | 0); window.STAT.builds.push('Factory'); }
          }
          if (res) log('C ' + track(res));
        }
        if (!siloDone && t >= 420 && gold >= 1000000) { const r0 = inner(m)[0] ?? m[0]; const res = await build('SiloMissile', r0 % W, (r0 / W) | 0); log('SILO ' + track(res)); if (res.startsWith('OK')) { siloDone = true; window.STAT.builds.push('Silo'); } }
        if (!samDone && gold >= 1000000) { let es = false; try { es = g.players().some((q) => q.isAlive() && !q.isMe() && q.units('Missile Silo').length > 0); } catch (e) {} if (es) { const r0 = inner(m)[0] ?? m[0]; const res = await build('SAM', r0 % W, (r0 / W) | 0); log('SAM ' + track(res)); if (res.startsWith('OK')) { samDone = true; window.STAT.builds.push('SAM'); } } }
      }
    } catch (e) { log('ERR ' + e); } finally { busy = false; }
  };
  window.__run = setInterval(() => { if (window.STOP) { clearInterval(window.__run); log('runner stopped'); } else tick(); }, 500);
  return 'e30 runner started';
})()
