// OpenFront JS HUD (localhost only, READ-ONLY). Paste the whole file into javascript_tool once.
// It installs window.hud(), window.owner(x,y), window.ownerT(x,y) and returns hud() as text.
// Later calls: `hud()` | `hud(tx,ty)` (distances from that tile) | `owner(sx,sy,800)` (screenshot coords, 800 = frame width) | `ownerT(tx,ty)` (tile).
(() => {
  const K = (n) => { n = Math.round(n); const a = Math.abs(n);
    return a >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : '' + n; };
  const TY = { NATION: 'Nation', BOT: 'Bot', HUMAN: 'Human', FAKEHUMAN: 'Nation' };
  const ctx = () => {
    const b = document.querySelector('build-menu');
    if (b && b.game) return { g: b.game, th: b.transformHandler };
    const m = document.querySelector('single-player-modal');
    return { menu: m ? m.selectedDifficulty : null, map: m ? m.selectedMap : null };
  };
  const desc = (g, p, me) => {
    if (!p || !p.isPlayer || !p.isPlayer()) return 'NOBODY (unowned)';
    const rel = p.isMe() ? 'ME' : me && me.isAlliedWith && me.isAlliedWith(p) ? 'ALLY' : me && me.isFriendly && me.isFriendly(p) ? 'TEAM' : 'enemy';
    return `${p.displayName()}(${TY[p.type()] || p.type()}) ${K(p.troops())} troops ${p.numTilesOwned()} tiles ${rel}`;
  };
  const tileInfo = (g, x, y) => {
    if (!g.isValidCoord(x, y)) return `tile ${x},${y} off-map`;
    const r = g.ref(x, y);
    if (!g.isLand(r)) return `tile ${x},${y} WATER`;
    return `tile ${x},${y}: ` + desc(g, g.owner(r), g.myPlayer());
  };
  window.ownerT = (x, y) => { const c = ctx(); return c.g ? tileInfo(c.g, Math.floor(x), Math.floor(y)) : 'not in game'; };
  // frameW = width of the screenshot coordinate frame you click in (e.g. 800); omit for CSS px.
  window.owner = (sx, sy, frameW) => {
    const c = ctx(); if (!c.g) return 'not in game';
    const k = frameW ? innerWidth / frameW : 1;
    const w = c.th.screenToWorldCoordinates(sx * k, sy * k);
    return `screen ${sx},${sy} -> ` + tileInfo(c.g, w.x, w.y);
  };
  window.hud = (rx, ry) => {
    const c = ctx();
    if (!c.g) return `MENU diff=${c.menu} map=${c.map} (not in game)`;
    const g = c.g, cfg = g.config(), gc = cfg.gameConfig ? cfg.gameConfig() : {};
    const me = g.myPlayer(), W = g.width(), H = g.height();
    const s = Math.floor(g.elapsedGameSeconds ? g.elapsedGameSeconds() : g.ticks() / 10);
    const spawn = g.inSpawnPhase();
    let head = `t=${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} tick=${g.ticks()} diff=${gc.difficulty} map=${gc.gameMap} mode=${gc.gameMode} players=${g.players().length}` + (spawn ? ' SPAWN-PHASE' : '');
    const mySid = me ? me.smallID() : -1;
    const spawned = me && me.numTilesOwned() > 0;
    // one pass over the map: my centroid, border neighbours
    const own = new Map(); // sid -> {border}
    let sx = 0, sy = 0, n = 0;
    const N = W * H;
    for (let r = 0; r < N; r++) {
      if (g.ownerID(r) !== mySid || mySid < 0) continue;
      sx += r % W; sy += (r / W) | 0; n++;
      if (!g.isBorder(r)) continue;
      for (const nb of g.neighbors(r)) { const o = g.ownerID(nb); if (o && o !== mySid) own.set(o, true); }
    }
    let ox, oy, from;
    if (rx !== undefined) { ox = rx; oy = ry; from = `tile ${rx},${ry}`; }
    else if (n) { ox = sx / n; oy = sy / n; from = 'my centre'; }
    else { const cc = c.th.screenCenter(); ox = cc.screenX; oy = cc.screenY; from = 'screen centre'; }
    // nearest tile of every owner to the reference point
    const best = new Map();
    for (let r = 0; r < N; r++) {
      const o = g.ownerID(r); if (!o || o === mySid) continue;
      const dx = (r % W) - ox, dy = ((r / W) | 0) - oy, d = dx * dx + dy * dy;
      const b = best.get(o); if (b === undefined || d < b) best.set(o, d);
    }
    let meTxt = 'me: not spawned';
    if (me && spawned) {
      const mx = cfg.maxTroops ? cfg.maxTroops(me) : 0, tr = me.troops();
      meTxt = `me troops ${K(tr)}/${K(mx)} (${mx ? Math.round(100 * tr / mx) : '?'}%) land ${(100 * me.numTilesOwned() / g.numLandTiles()).toFixed(2)}% tiles ${me.numTilesOwned()} gold ${K(Number(me.gold()))} at ${Math.round(ox)},${Math.round(oy)}`
        + ` atk-out ${me.outgoingAttacks().length} atk-in ${me.incomingAttacks().length}`;
    } else if (me && !me.isAlive() && !spawn) meTxt = 'me: DEAD';
    const rows = [];
    for (const [sid, d] of best) {
      const p = g.playerBySmallID(sid); if (!p || !p.isPlayer || !p.isPlayer() || !p.isAlive()) continue;
      rows.push({ p, d: Math.round(Math.sqrt(d)), border: own.has(sid) });
    }
    rows.sort((a, b) => (b.border - a.border) || a.d - b.d);
    const nb = rows.filter((r) => r.border || r.d <= 150).slice(0, 10).map((r) => {
      const p = r.p, al = me && me.isAlliedWith(p) ? ' ALLY' : '';
      const ratio = me && spawned ? ` x${(p.troops() / Math.max(1, me.troops())).toFixed(1)}` : '';
      return `${p.displayName()}(${TY[p.type()] || p.type()}) ${K(p.troops())}${ratio} ${p.numTilesOwned()}t dist ${r.d}${r.border ? ' BORDER' : ''}${al}`;
    });
    const nat = rows.filter((r) => r.p.type() === 'NATION' || r.p.type() === 'FAKEHUMAN').sort((a, b) => a.d - b.d)[0];
    const natTxt = nat ? `nearest Nation ${nat.p.displayName()} ${nat.d} tiles from ${from}` : 'nearest Nation none';
    return `${head}\n${meTxt}\n${natTxt}\nneighbours: ${nb.join('; ') || 'none within 150'}`;
  };
  return window.hud();
})()
