"""End-of-game player stats (recorded by the live server in every replay) for all full replays in replays_world + replays,
any engine commit. Compares PRO (trackerfront top-10 names), WIN (game winner), PEAK3 (top-3 peak tiles, not winner) and REST.
Also per-pro intent timelines (build order, political intents) for top-player games, from raw intents (no re-sim needed).
Writes replays_world/topic_digest/final_stats.md.  Run: python -I final_stats_digest.py"""
import json, os, glob, re, statistics as st, collections
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "replays_world", "topic_digest"); os.makedirs(OUT, exist_ok=True)
TOPF = json.load(open(os.path.join(HERE, "top_player_games.json"), encoding="utf-8"))
PROS = {n.lower() for n in TOPF["players"]}
TOPG = {g["game_id"] for g in TOPF["games"]}
norm = lambda n: re.sub(r"^\[[^\]]*\]\s*", "", n or "").strip().lower()
I = lambda a, i: int(a[i]) if a and len(a) > i and a[i] is not None else 0
def med(a): return round(st.median(a), 2) if a else None
def mean(a): return round(sum(a) / len(a), 2) if a else None

files = {}
for d_ in ("replays_world", "replays"):
    for f in glob.glob(os.path.join(HERE, d_, "*.json")):
        gid = os.path.basename(f)[:-5]
        if re.fullmatch(r"[A-Za-z0-9]{10}", gid) and gid not in files: files[gid] = f
rows = []  # per player dicts
timelines = []
UNITS = ["city", "port", "fact", "defp", "wshp", "saml", "silo"]
for gid, f in sorted(files.items()):
    try: d = json.load(open(f, encoding="utf-8"))
    except Exception: continue
    info = d.get("info", {})
    cfg = info.get("config", {})
    if cfg.get("gameMode") not in (None, "Free For All"): continue
    players = info.get("players", [])
    if len(players) < 8: continue
    dur = (info.get("duration") or 0) / 60 or (len(d.get("turns", [])) / 600)
    win = info.get("winner") or []
    wcid = win[1] if isinstance(win, list) and len(win) > 1 and win[0] == "player" else None
    peaks = sorted(((I(p.get("stats", {}).get("tiles"), 0), p["clientID"]) for p in players), reverse=True)
    top3 = {c for _, c in peaks[:3]}
    for p in players:
        s = p.get("stats") or {}
        if not s: continue
        role = "PRO" if norm(p.get("username")) in PROS else "WIN" if p["clientID"] == wcid else "PEAK3" if p["clientID"] in top3 else "REST"
        g = s.get("gold") or []
        u = s.get("units") or {}
        bt = (s.get("boats") or {}).get("trade") or []
        al = s.get("alliances") or []
        r = dict(gid=gid, role=role, won=p["clientID"] == wcid, name=p.get("username"), dur=dur, map=cfg.get("gameMap"),
                 killedAt=int(s["killedAt"]) / 600 if s.get("killedAt") else None,
                 gold=[I(g, i) / 1e6 for i in range(7)], peakTiles=I(s.get("tiles"), 0),
                 conq=[I(s.get("conquests"), i) for i in range(3)], tradeBoats=[I(bt, i) for i in range(5)],
                 units={k: [I(u.get(k), i) for i in range(5)] for k in UNITS}, betrayals=I([s.get("betrayals")], 0),
                 all=[I(al, i) for i in range(6)])
        rows.append(r)
    # intent timelines for pros in top games
    if gid in TOPG:
        cid2name = {p["clientID"]: p.get("username") for p in players}
        pros = {c for c, n in cid2name.items() if norm(n) in PROS}
        for c in pros:
            ev = collections.defaultdict(list)
            for t in d.get("turns", []):
                for it in t.get("intents", []):
                    if it.get("clientID") != c: continue
                    ty = it["type"]
                    if ty in ("build_unit",): ev[it["unit"]].append(t["turnNumber"] / 600)
                    elif ty in ("upgrade_structure",): ev["up_" + it["unit"]].append(t["turnNumber"] / 600)
                    elif ty in ("allianceRequest", "breakAlliance", "donate_gold", "donate_troops", "embargo", "embargo_all", "targetPlayer", "move_warship", "boat", "allianceExtension"):
                        ev[ty].append(t["turnNumber"] / 600)
            me = next(r for r in rows[::-1] if r["gid"] == gid and r["name"] == cid2name[c])
            timelines.append((gid, cfg.get("gameMap"), len(players), round(dur, 1), cid2name[c], me["won"], me["peakTiles"], me["killedAt"], ev))

L = ["# End-of-game stats: pros vs winners vs rest (FFA, 8+ players, all full replays, any version)",
     f"Players: {len(rows)} in {len({r['gid'] for r in rows})} games. Gold in millions, cumulative over the player's life.",
     "PRO = trackerfront top-10 name, WIN = winner (non-pro), PEAK3 = top-3 peak tiles (non-winner, non-pro), REST = everyone else.\n"]
GK = ["work", "war", "trade", "steal", "trainSelf", "trainOther", "donRecv"]
for role in ("PRO", "WIN", "PEAK3", "REST"):
    rs = [r for r in rows if r["role"] == role]
    if role == "REST": rs = [r for r in rs if sum(r["gold"]) > 1]  # drop early deaths/AFK
    if not rs: continue
    tot = [sum(r["gold"]) for r in rs]
    L.append(f"## {role} n={len(rs)} (won {sum(r['won'] for r in rs)}), median life {med([r['killedAt'] or r['dur'] for r in rs])} min, median total gold {med(tot)}M")
    L.append("median share: " + " ".join(f"{k} {med([r['gold'][i] / max(1e-9, sum(r['gold'])) for r in rs])}" for i, k in enumerate(GK)))
    L.append("median gold/min (M): " + " ".join(f"{k} {med([r['gold'][i] / max(1, r['killedAt'] or r['dur']) for r in rs])}" for i, k in enumerate(GK)))
    L.append("units [built, destroyed, captured, lost, upgraded] means: " + "; ".join(f"{k} " + "/".join(str(mean([r['units'][k][i] for r in rs])) for i in range(5)) for k in UNITS))
    L.append(f"trade boats [sent, arrived, captured(by me), destroyed, lost] means: " + "/".join(str(mean([r['tradeBoats'][i] for r in rs])) for i in range(5)))
    L.append(f"conquests [human, nation, bot] means: " + "/".join(str(mean([r['conq'][i] for r in rs])) for i in range(3)))
    L.append(f"alliances [formed, brokenByOther, expired, heldToEnd, peakConcurrent] means: " + "/".join(str(mean([r['all'][i] for r in rs])) for i in range(5)) + f"; betrayals mean {mean([r['betrayals'] for r in rs])}")
    L.append(f"pirates (stole >0): {sum(1 for r in rs if r['gold'][3] > 0)}/{len(rs)}; steal>10% of income: {sum(1 for r in rs if r['gold'][3] > 0.1 * max(1e-9, sum(r['gold'])))}\n")
L.append("## Per-pro game lines: name, game, map, players, duration, won, peakTiles, killedAt | gold M work/war/trade/steal/trainSelf/trainOther | built C/P/F/W/SAM/Silo/DP, captured C/P/F | betrayals, alliances formed")
for r in [r for r in rows if r["role"] == "PRO"]:
    u = r["units"]
    L.append(f"{r['name']} {r['gid']} {r['map']} {round(r['dur'])}m won={int(r['won'])} peak {r['peakTiles']} killed {round(r['killedAt'],1) if r['killedAt'] else '-'} | "
             + "/".join(str(round(x, 1)) for x in r["gold"][:6]) + f" | {u['city'][0]}/{u['port'][0]}/{u['fact'][0]}/{u['wshp'][0]}/{u['saml'][0]}/{u['silo'][0]}/{u['defp'][0]} cap {u['city'][2]}/{u['port'][2]}/{u['fact'][2]} | b{r['betrayals']} a{r['all'][0]}")
L.append("\n## Pro intent timelines (top-player games; minutes of each intent; first 12 shown per type)")
for gid, mp, n, dur, name, won, peak, killed, ev in timelines:
    L.append(f"### {name} {gid} {mp} {n}p {dur}m won={int(won)} peak {peak} killed {round(killed,1) if killed else '-'}")
    for k, v in sorted(ev.items(), key=lambda kv: kv[1][0]):
        L.append(f"{k} x{len(v)}: " + " ".join(f"{x:.1f}" for x in v[:12]))
open(os.path.join(OUT, "final_stats.md"), "w", encoding="utf-8").write("\n".join(L))
print("rows", len(rows), "timelines", len(timelines), os.path.getsize(os.path.join(OUT, "final_stats.md")) // 1024, "KB")
