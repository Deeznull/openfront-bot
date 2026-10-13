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
