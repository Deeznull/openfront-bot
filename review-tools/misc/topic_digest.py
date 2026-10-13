"""Turn replays_world/topic/*.json (topic_sim.mts output) into compact per-topic markdown digests for Haiku analysts.
Focus players per game: trackerfront top-10 names (PRO), the final #1 (WIN), final #2-3 (TOP3). REST = other humans (aggregates only).
Writes replays_world/topic_digest/{econ,place,capture,pirate,politics}.md
Run: python -I topic_digest.py"""
import json, os, glob, re, statistics as st, collections
HERE = os.path.dirname(os.path.abspath(__file__))
TD = os.path.join(HERE, "replays_world", "topic"); OUT = os.path.join(HERE, "replays_world", "topic_digest"); os.makedirs(OUT, exist_ok=True)
TOPF = json.load(open(os.path.join(HERE, "top_player_games.json"), encoding="utf-8"))
PROS = {n.lower() for n in TOPF["players"]}
TOPG = {g["game_id"]: g for g in TOPF["games"]}
def norm(n): return re.sub(r"^\[[^\]]*\]\s*", "", n or "").strip().lower()
def is_pro(n): return norm(n) in PROS
def med(a): return round(st.median(a), 2) if a else None
def mn(t): return round(t / 600, 1)

games = []
for f in sorted(glob.glob(os.path.join(TD, "*.json"))):
    d = json.load(open(f, encoding="utf-8"))
    names = {h["small"]: h["name"] for h in d["humans"]}
    final = [s for s, t in d["final"] if t > 0] or [d["final"][0][0]]
    role = {}
    for i, s in enumerate(final[:3]): role[s] = "WIN" if i == 0 else "TOP3"
    for s, n in names.items():
        if is_pro(n): role[s] = ("PRO+" + role[s]) if s in role else "PRO"
    d["_names"], d["_role"] = names, role
    d["_name"] = lambda s, d=d: (d["smallMap"].get(str(s), {}).get("name", "?") if s >= 0 else "-")
    d["_typ"] = lambda s, d=d: (d["smallMap"].get(str(s), {}).get("type", "?") if s >= 0 else "-")
    games.append(d)
print("games", len(games), "with pros", sum(1 for d in games if any("PRO" in r for r in d["_role"].values())))

def grp(d, s):
    r = d["_role"].get(s)
    return "FOCUS" if r else "REST"

hdr = lambda d: f"\n## {d['gid']} {d['map']} {mn(d['ticks'])} min, {len(d['humans'])} humans" + (" [TOP-PLAYER GAME]" if d["gid"] in TOPG else "")
def who(d, s): return f"{d['_name'](s)} ({d['_role'].get(s, 'rest')})"

# ---------------- economy ----------------
E = ["# Economy digest (per focus player, cumulative gold by source in K; C=cities(levels) P=ports F=factories W=warships)",
     "Columns: min tiles troops/max goldK | work war(conquest) trade steal(pirating) trainSelf trainOther donRecv | C(lv) P F W SAM Silo DP allies inAtt outAtt"]
agg = collections.defaultdict(lambda: collections.defaultdict(list))  # (group, minute) -> source -> share list
for d in games:
    E.append(hdr(d))
    rows = collections.defaultdict(list)
    for r in d["econ"]: rows[r[1]].append(r)
    for s, rs in rows.items():
        g = grp(d, s)
        for r in rs:
            m = r[0] // 600
            if m in (5, 10, 15, 20, 30, 45):
                tot = sum(r[6:13]) or 1
                for i, k in enumerate(["work", "war", "trade", "steal", "trainSelf", "trainOther", "donRecv"]):
                    agg[(g, m)][k].append(r[6 + i] / tot)
                agg[(g, m)]["totalK"].append(tot); agg[(g, m)]["C"].append(r[13]); agg[(g, m)]["P"].append(r[15]); agg[(g, m)]["F"].append(r[16]); agg[(g, m)]["W"].append(r[17])
        if g != "FOCUS": continue
        E.append(f"### {who(d, s)}")
        for r in rs:
            m = r[0] // 600
            if m % 3 and r is not rs[-1]: continue
            E.append(f"{m} {r[2]} {r[3]//1000}k/{r[4]//1000}k {r[5]} | {' '.join(str(x) for x in r[6:13])} | {r[13]}({r[14]}) {' '.join(str(x) for x in r[15:24])}")
E.insert(2, "\n## Aggregate: median share of cumulative income by source (FOCUS = winners/top3/pros, REST = other humans alive)\n" + "\n".join(
    f"{g} min{m} n={len(v['totalK'])}: totalK {med(v['totalK'])} | " + " ".join(f"{k} {med(v[k])}" for k in ["work", "war", "trade", "steal", "trainSelf", "trainOther", "donRecv"]) + f" | C {med(v['C'])} P {med(v['P'])} F {med(v['F'])} W {med(v['W'])}"
    for (g, m), v in sorted(agg.items(), key=lambda kv: (kv[0][1], kv[0][0]))))
open(os.path.join(OUT, "econ.md"), "w", encoding="utf-8").write("\n".join(E))

# ---------------- placement ----------------
P = ["# Structure placement digest",
     "Per build intent: min unit frontDist(to nearest hostile player land border; -1 = none) coastDist(-1 = no coast) nearestOwnCity ownTiles ownCities ownWarships gold(K).",
     "depth = frontDist / sqrt(ownTiles) (0 = on the front, ~0.5+ = deep inside). Nukes: target owner. up_X = upgrade."]
pagg = collections.defaultdict(lambda: collections.defaultdict(list))
firsts = collections.defaultdict(lambda: collections.defaultdict(list))
for d in games:
    P.append(hdr(d))
    by = collections.defaultdict(list)
    for b in d["build"]: by[b[1]].append(b)
    for s, bs in by.items():
        g = grp(d, s)
        seen = {}
        for b in bs:
            u = b[2]
            if u not in seen: seen[u] = b[0]
            if len(b) >= 13 and b[5] >= 0 and b[8] > 0:
                pagg[(g, u)]["depth"].append(b[5] / b[8] ** 0.5)
            if len(b) >= 13:
                pagg[(g, u)]["coast"].append(b[6]); pagg[(g, u)]["ncity"].append(b[7])
            pagg[(g, u)]["n"].append(1)
        for u, t in seen.items(): firsts[g][u].append(t / 600)
        if g != "FOCUS": continue
        P.append(f"### {who(d, s)}: {len(bs)} builds; counts " + ", ".join(f"{u}:{c}" for u, c in collections.Counter(b[2] for b in bs).most_common()))
        lines = []
        for b in bs[:60]:
            if len(b) >= 13:
                dep = round(b[5] / b[8] ** 0.5, 2) if b[5] >= 0 and b[8] > 0 else "nofront"
                lines.append(f"{mn(b[0])} {b[2]} front {b[5]} depth {dep} coast {b[6]} nCity {b[7]} tiles {b[8]} C{b[9]} W{b[10]} g{b[12]//1000}")
            elif b[2].startswith("up_"):
                lines.append(f"{mn(b[0])} {b[2]} g{b[5]//1000}")
            else:
                lines.append(f"{mn(b[0])} {b[2]} -> {d['_name'](b[5])} ({d['_typ'](b[5])})")
        P.extend(lines)
P.insert(3, "\n## Aggregate (median): depth, coastDist, nearest own city; first-build minute\n" + "\n".join(
    f"{g} {u}: n={len(v['n'])} depth {med(v['depth'])} coast {med([c for c in v['coast'] if c >= 0])} noCoast% {round(100*sum(1 for c in v['coast'] if c < 0)/max(1,len(v['coast'])))} nCity {med([c for c in v['ncity'] if c >= 0])}"
    for (g, u), v in sorted(pagg.items(), key=lambda kv: (kv[0][1], kv[0][0]))) + "\n" + "\n".join(
    f"{g} first-build minute: " + " ".join(f"{u} {med(v)} (n={len(v)})" for u, v in sorted(firsts[g].items())) for g in firsts))
open(os.path.join(OUT, "place.md"), "w", encoding="utf-8").write("\n".join(P))

# ---------------- captures ----------------
C = ["# Structure capture digest (structure changed owner because its tile was taken)",
     "Per capture by a focus player: min unit(level) victim(type) victimTroops/max victimTiles victimAttackedBy capturerTroops boatLandingNearby capturerLandAttackOnVictim",
     "Also: focus players' structures LOST."]
cagg = collections.defaultdict(collections.Counter)
for d in games:
    C.append(hdr(d))
    for s in d["_role"]:
        mine = [c for c in d["cap"] if c["to"] == s]
        lost = [c for c in d["cap"] if c["from"] == s]
        if not mine and not lost: continue
        C.append(f"### {who(d, s)}: captured {len(mine)} (" + ", ".join(f"{u}:{n}" for u, n in collections.Counter(c['u'] for c in mine).most_common()) + f"), lost {len(lost)}")
        for c in mine[:40]:
            others = [a for a in c["vAtt"] if a != s]
            C.append(f"{mn(c['t'])} {c['u']}{c['lvl']} from {d['_name'](c['from'])}({c['vType']}) {c['vTr']//1000}k/{c['vMax']//1000}k tiles {c['vTiles']} attackedBy {[d['_name'](a) for a in others][:3]} myTr {c['cTr']//1000}k boat {c['boat']} land {int(c['cLand'])}")
        if lost: C.append("lost: " + "; ".join(f"{mn(c['t'])} {c['u']} to {d['_name'](c['to'])}" for c in lost[:15]))
    for c in d["cap"]:
        g = grp(d, c["to"]) if c["to"] in d["_names"] else "NONHUMAN"
        m = c["t"] // 600
        ph = "early<10" if m < 10 else "mid10-25" if m < 25 else "late25+"
        key = (g, ph)
        cagg[key]["n"] += 1; cagg[key][c["u"]] += 1; cagg[key]["boat"] += c["boat"]; cagg[key]["land"] += int(c["cLand"])
        cagg[key]["victimWeak<40%"] += int(c["vMax"] > 0 and c["vTr"] / c["vMax"] < 0.4)
        cagg[key]["victimAttackedByOther"] += int(any(a != c["to"] for a in c["vAtt"]))
        cagg[key]["victimNation"] += int(c["vType"] == "NATION")
C.insert(3, "\n## Aggregate counts by capturer group and phase\n" + "\n".join(f"{g} {ph}: " + " ".join(f"{k} {v}" for k, v in cnt.most_common()) for (g, ph), cnt in sorted(cagg.items())))
open(os.path.join(OUT, "capture.md"), "w", encoding="utf-8").write("\n".join(C))

# ---------------- pirating ----------------
R = ["# Pirating digest (warships capture trade ships; stolen gold goes to the pirate)",
     "Reaction = what the VICTIM did towards the PIRATE within 120 s after a theft (land/boat attack on pirate, embargo, breakAlliance, targetPlayer).",
     "Baseline = the same victim->pirate actions in the 120 s window ending at the theft (before it)."]
ragg = collections.Counter()
pir = collections.defaultdict(lambda: collections.Counter())
for d in games:
    acts = collections.defaultdict(list)  # (actor, target) -> ticks
    for a in d["att"]:
        if a[3] >= 0: acts[(a[1], a[3])].append((a[0], a[2]))
    for p in d["pol"]:
        if p[2] in ("embargo", "breakAlliance", "targetPlayer") and p[3] >= 0: acts[(p[1], p[3])].append((p[0], p[2]))
    rel = {}
    allied = set()
    for e in sorted(d["polEv"]):
        if e[1] == "acc": allied.add(frozenset((e[2], e[3])))
        if e[1] == "broke": allied.discard(frozenset((e[2], e[3])))
    stolen = [t for t in d["trade"] if t[1] == "stolen"]
    spawns = collections.Counter(t[2] for t in d["trade"] if t[1] == "spawn")
    ws = collections.Counter(u[2] for u in d["unitEv"] if u[1] == "W")
    lines = []
    seen_pairs = set()
    for t in stolen:
        tick, pirate, victim = t[0], t[2], t[3]
        pir[(d["gid"], pirate)]["stolen"] += 1
        if victim not in d["_names"] or pirate not in d["_names"]:
            ragg["victim_or_pirate_nonhuman"] += 1; continue
        if (pirate, victim) in seen_pairs: continue  # count the first theft per pair (later ones overlap)
        seen_pairs.add((pirate, victim))
        after = sorted({k for (tt, k) in acts[(victim, pirate)] if tick < tt <= tick + 1200})
        before = sorted({k for (tt, k) in acts[(victim, pirate)] if tick - 1200 <= tt <= tick})
        ragg["firstTheftPairs"] += 1
        ragg["reactAny"] += int(bool(after)); ragg["baselineAny"] += int(bool(before))
        for k in after: ragg["react_" + k] += 1
        for k in before: ragg["base_" + k] += 1
        if grp(d, pirate) == "FOCUS" or grp(d, victim) == "FOCUS":
            lines.append(f"{mn(tick)} {who(d, pirate)} robbed {who(d, victim)}; victim before:{before or '-'} after:{after or '-'}")
    focus_pir = [(s, pir[(d['gid'], s)]['stolen']) for s in d["_role"]]
    R.append(hdr(d) + "\n" + "; ".join(f"{who(d, s)} stole {n}, warships {ws[s]}, tradeSpawns {spawns[s]}" for s, n in focus_pir))
    R.extend(lines[:25])
R.insert(3, "\n## Aggregate (first theft per pirate-victim pair, humans only)\n" + " ".join(f"{k} {v}" for k, v in sorted(ragg.items())))
open(os.path.join(OUT, "pirate.md"), "w", encoding="utf-8").write("\n".join(R))

# ---------------- politics ----------------
L = ["# Politics digest",
     "Intent rows: min type target(role/type) amount targetTroops/my targetTiles/my sharesBorder friendly myAllies. Events: acc/rej/broke/conq.",
     "allianceRequest spam to many players is shown as a count per minute."]
lagg = collections.defaultdict(collections.Counter)
for d in games:
    L.append(hdr(d))
    for s in d["_role"]:
        ps = [p for p in d["pol"] if p[1] == s and p[2] not in ("move_warship",)]
        ev = [e for e in d["polEv"] if s in (e[2], e[3]) and e[1] in ("acc", "broke", "conq")]
        L.append(f"### {who(d, s)}: " + ", ".join(f"{k}:{n}" for k, n in collections.Counter(p[2] for p in ps).most_common()))
        req = collections.Counter()
        for p in ps:
            if p[2] == "allianceRequest": req[int(p[0] // 600)] += 1; continue
            if p[2] in ("emoji", "quick_chat"): continue
            if len(p) >= 10:
                L.append(f"{mn(p[0])} {p[2]} {d['_name'](p[3])}({d['_role'].get(p[3], d['_typ'](p[3]))}) {p[4]} tr {p[5]} tiles {p[6]} border {p[7]} friendly {p[8]} allies {p[9]}")
            else:
                L.append(f"{mn(p[0])} {p[2]} {p[4]}")
        if req: L.append("allianceRequests per minute: " + " ".join(f"m{m}:{n}" for m, n in sorted(req.items())))
        for e in ev[:30]:
            o = e[3] if e[2] == s else e[2]
            tag = {"acc": "ALLIED", "broke": ("BETRAYED" if e[2] == s else "WAS-BETRAYED-BY"), "conq": ("CONQUERED" if e[2] == s else "CONQUERED-BY")}[e[1]]
            L.append(f"{mn(e[0])} {tag} {d['_name'](o)}({d['_role'].get(o, d['_typ'](o))})")
    for p in d["pol"]:
        g = grp(d, p[1]); m = p[0] // 600
        ph = "early<10" if m < 10 else "mid10-25" if m < 25 else "late25+"
        lagg[(g, ph)][p[2]] += 1
    for e in d["polEv"]:
        if e[1] == "broke": lagg[(grp(d, e[2]), "any")]["betrayals_by"] += 1; lagg[(grp(d, e[3]), "any")]["betrayed"] += 1
        if e[1] == "acc": lagg[(grp(d, e[2]), "any")]["allianceAccepted_requester"] += 1
L.insert(3, "\n## Aggregate counts (per group, phase)\n" + "\n".join(f"{g} {ph}: " + " ".join(f"{k} {v}" for k, v in c.most_common()) for (g, ph), c in sorted(lagg.items())) +
         "\nFOCUS players per game ~3-4, REST ~30-50, so compare per-player rates.")
open(os.path.join(OUT, "politics.md"), "w", encoding="utf-8").write("\n".join(L))
for f in sorted(os.listdir(OUT)): print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, "KB")
