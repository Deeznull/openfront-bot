// OpenFront ACT (localhost only). Paste whole file into javascript_tool once per page load (after the game started).
// Installs window.attack(tx,ty,ratio,allowNation,expectId) boat(tx,ty,ratio) build(type,tx,ty) ally(name) ratio(pct). All async except ratio; each returns a text result read back from game state.
// Emits the same EventBus events the UI emits (no mouse/keys). Game must NOT be paused (paused = events are not processed -> reports FAIL/NO EFFECT).
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ctx = () => {
    const b = document.querySelector('build-menu');
    if (!b || !b.game || !b.eventBus) throw new Error('not in game');
    const g = b.game, me = g.myPlayer();
    if (!me || !me.isAlive()) throw new Error('not alive/spawned');
    return { g, me, bus: b.eventBus, ui: b.uiState };
  };
  // event classes are found among the bus listeners (same class objects the UI uses)
  const cls = (bus, n) => { for (const k of bus.listeners.keys()) if (k.name === n) return k; throw new Error('no event class ' + n); };
  const until = async (f, ms = 2500) => { for (let t = 0; t < ms; t += 100) { const v = f(); if (v) return v; await sleep(100); } return f(); };
  const sum = (me) => me.outgoingAttacks().reduce((a, x) => a + x.troops, 0);
  const K = (n) => Math.round(n / 100) / 10 + 'K';
  const nm = (g, t) => { const o = g.owner(t); return o && o.isPlayer && o.isPlayer() ? o.displayName() : 'NOBODY'; };
  const UT = { city: 'City', port: 'Port', factory: 'Factory', defensepost: 'Defense Post', defpost: 'Defense Post', silo: 'Missile Silo', missilesilo: 'Missile Silo', sam: 'SAM Launcher', samlauncher: 'SAM Launcher', warship: 'Warship', atom: 'Atom Bomb', atombomb: 'Atom Bomb', hbomb: 'Hydrogen Bomb', mirv: 'MIRV' };

  window.attack = async (tx, ty, r, allowNation, expectId) => {
    const { g, me, bus, ui } = ctx(); r = r ?? ui.attackRatio;
    if (!g.isValidCoord(tx, ty)) return 'FAIL off-map';
    const t = g.ref(tx, ty);
    if (!g.isLand(t)) return `FAIL ${tx},${ty} is water`;
    const o0 = g.owner(t), id0 = expectId ?? (o0.smallID ? o0.smallID() : o0.id()), nm0 = nm(g, t); // owner at pick time (or the caller's expectId)
    const a = await me.actions(t, ['Transport']);
    if (!a.canAttack) return `FAIL canAttack=false at ${tx},${ty} (owner ${nm(g, t)})`;
    // re-read owner right before the send: abort if it changed since the pick, or (unless allowNation=true) if it is a Nation/human
    const o1 = g.owner(t), id1 = o1.smallID ? o1.smallID() : o1.id(), ty1 = o1.isPlayer && o1.isPlayer() ? o1.type() : 'NONE';
    if (id1 !== id0) return `ABORT owner changed ${nm0} -> ${nm(g, t)} @${tx},${ty} (nothing sent)`;
    if (!allowNation && ty1 !== 'BOT' && ty1 !== 'NONE') return `ABORT owner ${nm(g, t)} is ${ty1}, not bot/unowned @${tx},${ty} (nothing sent)`;
    const n0 = me.outgoingAttacks().length, s0 = sum(me), tr = me.troops() * r;
    bus.emit(new (cls(bus, 'SendAttackIntentEvent'))(o1.id(), tr));
    const ok = await until(() => me.outgoingAttacks().length > n0 || sum(me) > s0 + 1);
    return `${ok ? 'OK' : 'NO EFFECT'} attack ${nm(g, t)} @${tx},${ty} sent ${K(tr)} (${Math.round(r * 100)}%) atk-out ${n0}->${me.outgoingAttacks().length}`;
  };

  window.boat = async (tx, ty, r) => {
    const { g, me, bus, ui } = ctx(); r = r ?? ui.attackRatio;
    if (!g.isValidCoord(tx, ty)) return 'FAIL off-map';
    const t = g.ref(tx, ty);
    if (!g.isLand(t)) return `FAIL ${tx},${ty} is water (pick a coast LAND tile)`;
    const a = await me.actions(t, ['Transport']);
    const bu = (a.buildableUnits || []).find((u) => u.type === 'Transport');
    if (!bu || bu.canBuild === false) return `FAIL no transport possible to ${tx},${ty} (owner ${nm(g, t)}; too many boats, no route or no shore)`;
    const boats = () => me.units('Transport').length;
    const b0 = boats(), tr = me.troops() * r;
    bus.emit(new (cls(bus, 'SendBoatAttackIntentEvent'))(t, tr));
    const ok = await until(() => boats() > b0);
    return `${ok ? 'OK' : 'NO EFFECT'} boat -> ${nm(g, t)} @${tx},${ty} sent ${K(tr)} (${Math.round(r * 100)}%) boats ${b0}->${boats()}`;
  };

  window.build = async (type, tx, ty) => {
    const { g, me, bus } = ctx();
    const ut = UT[String(type).toLowerCase().replace(/[ _-]/g, '')] || type;
    if (!g.isValidCoord(tx, ty)) return 'FAIL off-map';
    const t = g.ref(tx, ty);
    const bs = await me.buildables(t, [ut]);
    const bu = bs.find((u) => u.type === ut);
    if (!bu) return `FAIL unknown/unavailable unit ${ut}`;
    if (bu.canBuild === false && bu.canUpgrade === false) return `FAIL cannot build ${ut} at ${tx},${ty} (gold ${K(Number(me.gold()))} cost ${K(Number(bu.cost))}; tile owner ${nm(g, t)}; need own land)`;
    const n0 = me.units(ut).length, g0 = Number(me.gold());
    if (bu.canUpgrade !== false) bus.emit(new (cls(bus, 'SendUpgradeStructureIntentEvent'))(bu.canUpgrade, ut));
    else bus.emit(new (cls(bus, 'BuildUnitIntentEvent'))(ut, t, undefined, undefined));
    const ok = await until(() => me.units(ut).length > n0 || (bu.canUpgrade !== false && Number(me.gold()) < g0 - Number(bu.cost) / 2));
    return `${ok ? 'OK' : 'NO EFFECT'} ${bu.canUpgrade !== false ? 'upgrade' : 'build'} ${ut} @${tx},${ty} ${ut} count ${n0}->${me.units(ut).length} gold ${K(g0)}->${K(Number(me.gold()))} (cost ${K(Number(bu.cost))})`;
  };

  window.ally = async (name) => {
    const { g, me, bus } = ctx();
    const q = String(name).toLowerCase();
    const p = g.players().find((x) => x.isPlayer() && x.isAlive() && !x.isMe() && x.displayName().toLowerCase() === q)
      || g.players().find((x) => x.isPlayer() && x.isAlive() && !x.isMe() && x.displayName().toLowerCase().includes(q));
    if (!p) return `FAIL no player matching "${name}"`;
    if (me.isAlliedWith(p)) return `OK already allied with ${p.displayName()}`;
    bus.emit(new (cls(bus, 'SendAllianceRequestIntentEvent'))(me, p));
    const ok = await until(() => me.isRequestingAllianceWith(p) || me.isAlliedWith(p));
    return `${ok ? 'OK' : 'NO EFFECT'} alliance request to ${p.displayName()} (${p.type()}) requesting=${me.isRequestingAllianceWith(p)} allied=${me.isAlliedWith(p)}`;
  };

  window.ratio = async (pct) => {
    const { ui } = ctx(); const b = document.querySelector('build-menu');
    pct = Math.max(1, Math.min(100, Math.round(pct)));
    const cur = Math.round(ui.attackRatio * 100);
    if (cur !== pct) b.eventBus.emit(new (cls(b.eventBus, 'AttackRatioEvent'))(pct - cur));
    const cp = document.querySelector('control-panel');
    if (cp && Math.abs(ui.attackRatio - pct / 100) > 1e-9 && ui.attackRatio * 100 > 0) { cp.attackRatio = pct / 100; cp.onAttackRatioChange(pct / 100); }
    if (cp && cp.updateComplete) await cp.updateComplete;
    const sl = cp && cp.querySelector('input[type=range]');
    const lab = cp ? (cp.innerText.match(/\d+(\.\d+)?\s*%/g) || []).join(' ') : '';
    const okv = Math.abs(ui.attackRatio - pct / 100) < 1e-9;
    return `${okv ? 'OK' : 'MISMATCH'} ratio ui=${Math.round(ui.attackRatio * 1000) / 10}% slider.value=${sl ? sl.value : '?'} labels=[${lab}]`;
  };
  return 'act.js installed: attack boat build ally ratio';
})()
;
// E31 full-game runner (localhost only). Extends run_e30.js. Needs act.js pasted first (bundle: e31_bundle.js = act.js + this). Can be installed BEFORE spawn: it waits until you own land.
// window.LOG, window.STOP=true stops, window.LAND={m1,m3,m10}, window.AL={req,acc,dec}, window.STAT.
// New vs e30: ally every Nation within 150 tiles from 0:10 (re-request every 20 s until accepted, accept/decline logged), boats <=20% to coasts <=150 tiles and never while a >=2x Nation borders,
// 40% troop floor while a >=2x Nation borders, Nation attacks only at >=1.5x (ratio 0.4), Defense Post on the border of a >=2x Nation after the first City, attack() gets expectId (owner picked) and aborts on a change.
(() => {
  if (window.__run) clearInterval(window.__run);
  window.LOG = []; window.STOP = false; window.LAND = {}; window.STAT = { boats: 0, builds: [], fails: 0, acts: 0, aborts: 0 };
  window.AL = { req: {}, acc: {}, dec: {}, st: {} };
  const b = document.querySelector('build-menu'), g = b.game, W = g.width(), H = g.height();
  let me = null, sid = -1, everAlive = false;
  const sec = () => g.elapsedGameSeconds ? g.elapsedGameSeconds() : g.ticks() / 10;
  const stamp = () => { const s = Math.floor(sec()); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const log = (m) => { window.LOG.push(stamp() + ' ' + m); };
  const pct = () => 100 * me.troops() / g.config().maxTroops(me);
  const kind = (r) => { const o = g.owner(r); if (!o || !o.isPlayer || !o.isPlayer()) return 'none'; if (o.isMe()) return 'me'; if (me.isAlliedWith(o)) return 'ally'; return o.type() === 'BOT' ? 'bot' : 'nation'; };
  const land = () => (100 * me.numTilesOwned() / g.numLandTiles()).toFixed(2);
  const track = (res) => { window.STAT.acts++; if (res.startsWith('ABORT')) window.STAT.aborts++; else if (!res.startsWith('OK')) window.STAT.fails++; return res; };
  let mine = [], mineAt = -99;
  const mineList = (t) => { if (t - mineAt < 2) return mine; mineAt = t; mine = []; for (let r = 0; r < W * H; r++) if (g.ownerID(r) === sid) mine.push(r); return mine; };
  const cen = (m) => { let cx = 0, cy = 0; for (const r of m) { cx += r % W; cy += (r / W) | 0; } return [cx / m.length, cy / m.length]; };
  const inner = (m) => m.filter((r) => g.neighbors(r).every((q) => g.ownerID(q) === sid));
  const boatDone = [];
  let lastA = -9, lastB = -9, lastC = -9, lastS = -99, lastN = -9, lastAR = -99, busy = false, dead = false, siloDone = false, samDone = false, dpN = 0, threat = null;
  const isNat = (p) => p.type() === 'NATION' || p.type() === 'FAKEHUMAN';
  const tick = async () => {
    if (window.STOP || busy) return; busy = true;
    try {
      me = g.myPlayer();
      if (!me || !me.isAlive() || me.numTilesOwned() === 0) { if (everAlive && !dead) { dead = true; log('DEAD land ' + (me ? land() : '?')); window.STOP = true; } return; }
      if (!everAlive) { everAlive = true; log('SPAWNED runner active'); }
      sid = me.smallID(); const t = sec();
      for (const [k, s] of [['m1', 60], ['m3', 180], ['m10', 600]]) if (t >= s && !window.LAND[k]) { window.LAND[k] = land(); log('LAND ' + k + ' ' + land() + '%'); }
      if (t - lastS >= 30) { lastS = t; const inc = me.incomingAttacks().map((a) => { const p = g.playerBySmallID(a.attackerID); return (p && p.displayName ? p.displayName() : '?') + ':' + Math.round(a.troops / 1000) + 'K'; }).join(','); log(`ST land ${land()}% tiles ${me.numTilesOwned()} troops ${Math.round(pct())}% gold ${Math.round(Number(me.gold()) / 1000)}K atkOut ${me.outgoingAttacks().length} in[${inc}] boats ${me.units('Transport').length} allies ${Object.keys(window.AL.acc).length}`); }
      const p = pct(), early = t < 45;
      const m = mineList(t);
      // ---- alliance tracking (every tick) ----
      for (const nm of Object.keys(window.AL.st)) {
        const s = window.AL.st[nm], q = g.playerBySmallID(s.id);
        if (!q || !q.isAlive || !q.isAlive()) continue;
        if (me.isAlliedWith(q)) { if (!window.AL.acc[nm]) { window.AL.acc[nm] = stamp(); log('ALLY ACCEPT ' + nm); } s.pending = false; }
        else {
          if (window.AL.acc[nm] && !s.lost) { s.lost = true; log('ALLY LOST ' + nm); }
          if (me.isRequestingAllianceWith(q)) s.pending = true;
          else if (s.pending) { s.pending = false; window.AL.dec[nm] = (window.AL.dec[nm] || []).concat(stamp()); log('ALLY DECLINE/EXPIRED ' + nm); }
        }
      }
      // ---- alliance requests: every Nation within 150 tiles of my centroid, from 0:10, re-request every 20 s until accepted ----
      if (t >= 10 && t - lastAR >= 20) {
        lastAR = t; const [cx, cy] = cen(m); const md = new Map();
        for (let r = 0; r < W * H; r++) { const id = g.ownerID(r); if (id === 0 || id === sid) continue; const d = Math.hypot(r % W - cx, ((r / W) | 0) - cy); const c = md.get(id); if (c === undefined || d < c) md.set(id, d); }
        for (const [id, d] of [...md.entries()].sort((a, c) => a[1] - c[1])) {
          if (d > 150) break; const q = g.playerBySmallID(id); if (!q || !q.isPlayer || !q.isPlayer() || !q.isAlive() || !isNat(q)) continue;
          const nm = q.displayName(); if (me.isAlliedWith(q)) continue;
          const s = window.AL.st[nm] || (window.AL.st[nm] = { id, pending: false });
          window.AL.req[nm] = (window.AL.req[nm] || []).concat(stamp());
          log('ALLY REQ ' + nm + ' dist ' + Math.round(d) + ' ' + track(await ally(nm))); s.pending = me.isRequestingAllianceWith(q);
        }
      }
      // ---- border scan ----
      let bestFree = null; const nats = new Map();
      for (const r of m) { if (!g.isBorder(r)) continue; for (const n of g.neighbors(r)) { if (!g.isLand(n)) continue; const k = kind(n); if (k === 'me' || k === 'ally') continue; const o = g.owner(n);
        if (k === 'nation') { if (!nats.has(o.smallID())) nats.set(o.smallID(), { o, n, r }); } else { const w = k === 'none' ? 0 : o.troops(); if (!bestFree || w < bestFree.w) bestFree = { n, w, k }; } } }
      threat = null; for (const v of nats.values()) if (v.o.troops() >= 2 * me.troops() && (!threat || v.o.troops() > threat.o.troops())) threat = v;
      const floor = threat && t >= 60 ? 40 : 30;
      // ---- opening / free-land attacks (bot or wilderness only, expectId = owner picked) ----
      if (t - lastA >= 3.5 && (early || p * 0.8 >= floor) && bestFree) {
        lastA = t;
        const kk = kind(bestFree.n);
        if (kk === 'bot' || kk === 'none') { if (window.__rt !== 20) { await ratio(20); window.__rt = 20; } const o = g.owner(bestFree.n); log('A ' + track(await attack(bestFree.n % W, (bestFree.n / W) | 0, 0.20, false, o.smallID ? o.smallID() : o.id()))); }
        else log('A skip: owner changed to ' + kk);
      }
      // ---- Nation attack: only at >=1.5x its troops, ratio 0.4, floor kept ----
      if (t >= 60 && nats.size && t - lastN >= 3.5 && p * 0.6 >= floor) {
        const arr = [...nats.values()].sort((a, c) => a.o.troops() - c.o.troops()), w = arr[0];
        if (w.o.troops() * 1.5 <= me.troops() && kind(w.n) === 'nation') {
          lastN = t; if (window.__rt !== 40) { await ratio(40); window.__rt = 40; } log('N ' + track(await attack(w.n % W, (w.n / W) | 0, 0.40, true, w.o.smallID())));
        }
      }
      // ---- boats: <=20% troops, coasts within 150 tiles, never while a >=2x Nation borders ----
      if (t - lastB >= 10 && !threat && (early ? p >= 30 : p * 0.8 >= floor) && me.units('Transport').length < 3) {
        lastB = t; const [cx, cy] = cen(m);
        const c = [];
        for (let y = Math.max(0, cy - 150 | 0); y < Math.min(H, cy + 150); y++) for (let x = Math.max(0, cx - 150 | 0); x < Math.min(W, cx + 150); x++) { const r = g.ref(x, y); if (!g.isLand(r)) continue; const k = kind(r); if (k !== 'none' && k !== 'bot') continue; if (!g.neighbors(r).some((q) => !g.isLand(q))) continue; const d = Math.hypot(x - cx, y - cy); if (d < 20 || d > 150) continue; if (boatDone.some(([bx, by]) => Math.hypot(bx - x, by - y) < 25)) continue; c.push([x, y]); }
        c.sort(() => Math.random() - .5);
        let done = false;
        for (const [x, y] of c.slice(0, 25)) { const kk = kind(g.ref(x, y)); if (kk !== 'none' && kk !== 'bot') continue; const res = await boat(x, y, 0.20); if (res.startsWith('OK') || res.startsWith('NO EFFECT')) { track(res); boatDone.push([x, y]); window.STAT.boats++; log('B ' + res); done = true; break; } }
        if (!done) log('B no valid coast target in ' + Math.min(25, c.length) + ' tries (of ' + c.length + ')');
      }
      // ---- builds ----
      if (t - lastC >= 4) {
        lastC = t; const gold = Number(me.gold());
        const costOf = async (ty, r) => { const bs = await me.buildables(r, [ty]); const bu = bs.find((u) => u.type === ty); return bu ? Number(bu.cost) : Infinity; };
        if (threat && window.STAT.builds.includes('City') && dpN < 3 && gold >= 50000) {
          const r = threat.r; const res = await build('DefensePost', r % W, (r / W) | 0); log('DP vs ' + threat.o.displayName() + ' ' + track(res)); if (res.startsWith('OK')) { dpN++; window.STAT.builds.push('DefensePost'); }
        }
        if (gold >= 125000) {
          const [cx, cy] = cen(m);
          const inn = inner(m).sort((a, c) => Math.hypot(a % W - cx, (a / W | 0) - cy) - Math.hypot(c % W - cx, (c / W | 0) - cy));
          const r0 = inn[0] ?? m[0]; let res = null;
          if (gold >= await costOf('City', r0)) { res = await build('City', r0 % W, (r0 / W) | 0); if (res.startsWith('OK')) window.STAT.builds.push('City'); }
          else {
            const coast = m.find((r) => g.neighbors(r).some((q) => !g.isLand(q)));
            if (coast && gold >= await costOf('Port', coast)) { res = await build('Port', coast % W, (coast / W) | 0); if (res.startsWith('OK')) window.STAT.builds.push('Port'); }
            else if (gold >= await costOf('Factory', r0)) { res = await build('Factory', r0 % W, (r0 / W) | 0); if (res.startsWith('OK')) window.STAT.builds.push('Factory'); }
          }
          if (res) log('C ' + track(res));
        }
        if (!siloDone && t >= 420) { const r0 = inner(m)[0] ?? m[0]; if (gold >= await costOf('SiloMissile', r0)) { const res = await build('SiloMissile', r0 % W, (r0 / W) | 0); log('SILO ' + track(res)); if (res.startsWith('OK')) { siloDone = true; window.STAT.builds.push('Silo'); } } }
        if (!samDone) { let es = false; try { es = g.players().some((q) => q.isAlive() && !q.isMe() && q.units('Missile Silo').length > 0); } catch (e) {} if (es) { const r0 = inner(m)[0] ?? m[0]; if (gold >= await costOf('SAM', r0)) { const res = await build('SAM', r0 % W, (r0 / W) | 0); log('SAM ' + track(res)); if (res.startsWith('OK')) { samDone = true; window.STAT.builds.push('SAM'); } } } }
      }
    } catch (e) { log('ERR ' + e); } finally { busy = false; }
  };
  window.__run = setInterval(() => { if (window.STOP) { clearInterval(window.__run); log('runner stopped'); } else tick(); }, 500);
  return 'e31 runner installed (waits for spawn)';
})()
