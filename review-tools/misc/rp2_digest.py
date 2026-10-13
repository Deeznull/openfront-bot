#!/usr/bin/env python3
"""RP2 digest of one DecisionLog2 state file -> readable per-game digest + metrics json.
Usage: python tools/rp2_digest.py <gameID>   (reads tools/replays/state2/<id>.state.json)"""
import json, sys, os, collections, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
gid = sys.argv[1]
S = json.load(open(os.path.join(HERE, "replays", "state2", gid + ".state.json")))
rec = json.load(open(os.path.join(HERE, "replays", gid + ".json")))
ev, sm, meta = S["events"], S["samples"], S["meta"]
out = []
P = out.append


def c(t):
    t = int(t)
    return "%d:%02d" % (t // 60, t % 60)


def k(v):
    v = v / 10.0
    if v >= 1e6: return "%.2fM" % (v / 1e6)
    if v >= 1e3: return "%.0fK" % (v / 1e3)
    return "%d" % v


def gd(v):
    if v >= 1e6: return "%.1fM" % (v / 1e6)
    if v >= 1e3: return "%.0fK" % (v / 1e3)
    return "%d" % v


def terr(ct):
    if not ct or not ct.get("n"): return "-"
    t = ct["terr"]; n = ct["n"]
    return "/".join("%s%d%%" % (a[0], round(100 * b / n)) for a, b in sorted(t.items(), key=lambda x: -x[1]))


def tn(o):
    return "wild" if o["type"] == "wild" else "%s:%s" % (o["type"], o["name"])


ATK = [e for e in ev if e["type"] == "attack"]
BOAT = [e for e in ev if e["type"] == "boat"]
BUY = [e for e in ev if e["type"] == "build_unit"]
UPG = [e for e in ev if e["type"] == "upgrade_structure"]
dur = meta["duration"]
winner_me = meta["winner"] and meta["winner"][1] == meta["clientID"]
P("=== %s %s | %d players | %s | win=%s | dur %s | hash mismatches %d | land tiles %d ===" % (
    gid, meta["map"], meta["players"], meta["me"], winner_me, c(dur), meta["hashMismatches"], meta["landTiles"]))

# ---- land/rank/troops/gold at minutes
P("-- LAND/RANK/TROOPS/GOLD at minutes (land%, rank, troops% of cap, gold, allies, structs C/P/F/S/SAM/DP)")
for m in (1, 2, 3, 5, 8, 10, 12, 15, 20):
    s = [x for x in sm if abs(x["t"] - m * 60) < 6]
    if not s: continue
    x = s[0]
    cn = x["counts"]
    P("  %2d:00 land %.2f%% rank %d/%d troops %d%% gold %s allies %d | %dC %dP %dF %dS %dSAM %dDP | outAtk %d | top: %s" % (
        m, x["landPct"], x["rank"], x["alive"], 100 * x["troops"] / x["maxTroops"], gd(x["gold"]), len(x["allies"]),
        cn["city"], cn["port"], cn["fact"], cn["silo"], cn["sam"], cn["defp"], x["outAtk"], (x["top"] or {}).get("name")))
pct = [100 * x["troops"] / x["maxTroops"] for x in sm if x["t"] >= 60]
P("  troop%% mean (after 1:00) %.0f, samples >60%%: %.0f%%, >90%%: %.0f%%, <30%%: %.0f%%" % (
    st.mean(pct), 100 * sum(p > 60 for p in pct) / len(pct), 100 * sum(p > 90 for p in pct) / len(pct), 100 * sum(p < 30 for p in pct) / len(pct)))

# ---- spawn
sp = [e for e in ev if e["type"] == "spawn"]
P("-- SPAWN picks: %d" % len(sp) + (" | " + " ".join("%s(%d,%d)" % (c(e["t"]) if e["t"] >= 0 else "-%ds" % abs(int(e["t"])), e["tile"]["x"], e["tile"]["y"]) for e in sp[-4:]) if sp else ""))

# ---- opening attacks
P("-- OPENING ATTACKS 0:00-2:30 (t | target | sent%% | ratio | contact tiles dir terrain | gap since previous attack s)")
prev = None
for e in ATK:
    if e["t"] > 150: break
    tg = e["target"]
    ratio = "%.1fx(%s)" % (e["sent"] / max(1, tg["troops"]), k(tg["troops"])) if tg["type"] != "wild" else "-"
    ct = e.get("contact") or {}
    gap = "" if prev is None else "%.1f" % (e["t"] - prev)
    P("  %s %5.1f | %-28s | %3.0f%% (%s) | %s | n=%s %s %s mag%s | gap %s%s" % (
        c(e["t"]), e["t"], tn(tg)[:28], 100 * e["sent"] / max(1, e["troops"]), k(e["sent"]), ratio, ct.get("n"), ct.get("dir"), terr(ct), ct.get("avgMag"), gap,
        " COUNTER" if e.get("isCounter") else ""))
    prev = e["t"]

# ---- sends: size / spacing by phase
P("-- ATTACK SENDS by phase: n, median sent%%, p10-p90, median gap s, attacks/min, share to wild/Tribe/Nation/human")
phases = [(0, 60), (60, 180), (180, 300), (300, 600), (600, 900), (900, 1e9)]
metrics = {"gid": gid, "map": meta["map"], "players": meta["players"], "dur": dur, "me": meta["me"], "win": winner_me}
for a, b in phases:
    xs = [e for e in ATK if a <= e["t"] < b]
    if not xs: continue
    ps = sorted(100 * e["sent"] / max(1, e["troops"]) for e in xs)
    gaps = [xs[i + 1]["t"] - xs[i]["t"] for i in range(len(xs) - 1)]
    kinds = collections.Counter(e["target"]["type"] for e in xs)
    mins = (min(b, dur) - a) / 60
    P("  %s-%s n=%d med%% %.1f (p10 %.1f p90 %.1f) gap med %.1fs | %.1f/min | %s" % (
        c(a), c(min(b, dur)), len(xs), st.median(ps), ps[len(ps) // 10], ps[min(len(ps) - 1, len(ps) * 9 // 10)],
        st.median(gaps) if gaps else 0, len(xs) / mins, dict(kinds)))
# exact slider values histogram (rounded to nearest 1%)
hist = collections.Counter(round(100 * e["sent"] / max(1, e["troops"])) for e in ATK if e["t"] > 0)
P("  sent%% histogram (top): " + " ".join("%d%%:%d" % kv for kv in hist.most_common(10)))
# bursts: orders within same second
sec = collections.Counter(int(e["t"]) for e in ATK)
P("  max attacks in one second: %d; seconds with >=3 attacks: %d" % (max(sec.values()), sum(1 for v in sec.values() if v >= 3)))

# ---- terrain contact aggregate
terr_tot = collections.Counter(); mag_w = 0; ntot = 0
dirs = collections.Counter()
for e in ATK:
    ct = e.get("contact") or {}
    if ct.get("n") and e["t"] > 0:
        for a, b in ct["terr"].items(): terr_tot[a] += b
        ntot += ct["n"]; mag_w += ct["avgMag"] * ct["n"]
        dirs[ct["dir"]] += 1
P("-- ATTACK CONTACT TERRAIN (tile-weighted, all attacks): " + " ".join("%s %.0f%%" % (a, 100 * b / max(1, ntot)) for a, b in terr_tot.most_common()) +
  " | avg magnitude %.1f | dir counts %s" % (mag_w / max(1, ntot), dict(dirs.most_common(8))))
for tt in ("wild", "Tribe", "Nation", "human"):
    xs = [e for e in ATK if e["target"]["type"] == tt and (e.get("contact") or {}).get("n")]
    if not xs: continue
    tc = collections.Counter(); nn = 0
    for e in xs:
        for a, b in e["contact"]["terr"].items(): tc[a] += b
        nn += e["contact"]["n"]
    P("   vs %-6s n=%d terrain %s" % (tt, len(xs), " ".join("%s %.0f%%" % (a, 100 * b / nn) for a, b in tc.most_common())))

# ---- targets order
P("-- TARGET ORDER (first attack on each target; count; total sent; first %% ; first ratio; contact dir/terr; tgt rank)")
first = collections.OrderedDict()
for e in ATK:
    tg = e["target"]
    key = tn(tg)
    if key not in first:
        first[key] = dict(t=e["t"], n=0, sent=0, pct=100 * e["sent"] / max(1, e["troops"]), ratio=(e["sent"] / max(1, tg["troops"])) if tg["type"] != "wild" else None,
                          ct=e.get("contact"), rank=e.get("tgtRank"), tiles=tg["tiles"], allied=e.get("allied"), my=e["tiles"], tr=tg["troops"], mytr=e["troops"], counter=e.get("isCounter"))
    first[key]["n"] += 1; first[key]["sent"] += e["sent"]
cnt = 0
for key, v in first.items():
    if key == "wild":
        P("  wild: first %s n=%d" % (c(v["t"]), v["n"])); continue
    cnt += 1
    if cnt > 45: break
    P("  %s %-30s n=%-3d sent %-7s first %2.0f%% ratio %s tiles %s vs my %s (%.2fx) rank %s %s %s%s" % (
        c(v["t"]), key[:30], v["n"], k(v["sent"]), v["pct"], ("%.1fx" % v["ratio"]) if v["ratio"] is not None else "-", v["tiles"], v["my"],
        v["tiles"] / max(1, v["my"]), v["rank"], (v["ct"] or {}).get("dir"), terr(v["ct"]), " COUNTER" if v["counter"] else ""))
# ally attacks
ally_atk = [e for e in ATK if e.get("allied")]
P("-- attacks while ALLIED with target: %d" % len(ally_atk))
# follow-up streams: runs of attacks at same target within 120s
P("-- FOLLOW-UP STREAMS (same target, n>=6 attacks): ")
for key, v in first.items():
    if key != "wild" and v["n"] >= 6:
        xs = [e for e in ATK if tn(e["target"]) == key]
        ps = [100 * e["sent"] / max(1, e["troops"]) for e in xs]
        P("  %s %s n=%d window %s-%s big first %0.f%% then median %.1f%%, ratios med %.2fx" % (
            c(xs[0]["t"]), key, len(xs), c(xs[0]["t"]), c(xs[-1]["t"]), ps[0], st.median(ps[1:]) if len(ps) > 1 else 0,
            st.median([e["sent"] / max(1, e["target"]["troops"]) for e in xs])))

# ---- boats
P("-- BOATS: total %d; per minute: %s" % (len(BOAT), dict(sorted(collections.Counter(int(e["t"] // 60) for e in BOAT).items()))))
bp = sorted(100 * e["sent"] / max(1, e["troops"]) for e in BOAT)
if bp:
    P("  sent%% median %.1f, <=1.5%%: %d, <=5%%: %d, >=20%%: %d; dst types %s" % (
        st.median(bp), sum(p <= 1.5 for p in bp), sum(p <= 5 for p in bp), sum(p >= 20 for p in bp), dict(collections.Counter(e["target"]["type"] for e in BOAT))))
    P("  dst distance from my border-centroid: median %.0f, max %.0f; dstTerr %s; nearestMyCoast median %s" % (
        st.median([e["dstDist"] for e in BOAT]), max(e["dstDist"] for e in BOAT), dict(collections.Counter(e["dstTerr"] for e in BOAT)),
        st.median([e["nearestMyCoast"] for e in BOAT if e.get("nearestMyCoast") is not None] or [0])))
    P("  dst dirs %s; first 12 boats:" % dict(collections.Counter(e["dstDir"] for e in BOAT).most_common(8)))
    for e in BOAT[:12]:
        P("    %s %4.1f -> %-26s dst(%d,%d) %s %s d=%s sent %.1f%% (%s) tiles %d" % (c(e["t"]), e["t"], tn(e["target"])[:26], e["dst"]["x"], e["dst"]["y"], e["dstDir"], e["dstTerr"],
            e["dstDist"], 100 * e["sent"] / max(1, e["troops"]), k(e["sent"]), e["tiles"]))

# ---- builds
P("-- BUILDS (%d buys, %d upgrades). t | unit | gold before | cost | terr | dFront | dCoast | dSameType | dCentroid | owned counts" % (len(BUY), len(UPG)))
byunit = collections.Counter(e["unit"] for e in BUY)
P("  by unit: %s" % dict(byunit))
for e in BUY[:40]:
    cn = e["counts"]
    P("  %s %-12s gold %-6s cost %-6s %-8s dFront %s dCoast %s dSame %s(n%d) dCen %s shore=%s | %dC %dP %dF" % (
        c(e["t"]), e["unit"], gd(e["gold"]), gd(e["cost"]), e.get("terr"), e.get("dFront"), e.get("dCoast"), e.get("dSameType"), e.get("nSameType", 0), e.get("dCentroid"),
        e.get("isShore"), cn["city"], cn["port"], cn["fact"]))
if len(BUY) > 40:
    P("  ... %d more buys; later units by type:" % (len(BUY) - 40))
    for u in sorted(byunit):
        xs = [e for e in BUY if e["unit"] == u and e.get("dFront") is not None]
        if xs:
            P("    %s n=%d dFront med %s p90 %s | dCoast med %s | dSame med %s | terr %s | first %s last %s | gold-before med %s" % (
                u, len(xs), st.median([e["dFront"] for e in xs]), sorted(e["dFront"] for e in xs)[len(xs) * 9 // 10], st.median([e["dCoast"] for e in xs if e["dCoast"] is not None] or [0]),
                st.median([e["dSameType"] for e in xs if e["dSameType"] is not None] or [0]), dict(collections.Counter(e["terr"] for e in xs)), c(xs[0]["t"]), c(xs[-1]["t"]),
                gd(st.median([e["gold"] for e in xs]))))
# per-unit placement summary for the first 40 too
for u in sorted(byunit):
    xs = [e for e in BUY if e["unit"] == u and e.get("dFront") is not None]
    if xs:
        P("  [placement] %s n=%d: dFront med %s (min %s max %s), dCoast med %s, share on shore %.0f%%, dSame med %s, terr %s" % (
            u, len(xs), st.median([e["dFront"] for e in xs]), min(e["dFront"] for e in xs), max(e["dFront"] for e in xs),
            st.median([e["dCoast"] for e in xs if e["dCoast"] is not None] or [0]), 100 * sum(1 for e in xs if e.get("isShore")) / len(xs),
            st.median([e["dSameType"] for e in xs if e["dSameType"] is not None] or [0]), dict(collections.Counter(e["terr"] for e in xs))))
for e in UPG[:12]:
    P("  %s UPGRADE x%s gold %s" % (c(e["t"]), e.get("amount"), gd(e["gold"])))

# ---- structure deltas not explained by builds (captures)
cap = collections.Counter(); caplist = []
for e in ev:
    if e["type"] == "STRUCT_DELTA" and e["delta"] > 0 and e["unit"] in ("city", "port", "fact", "silo", "sam", "defp"):
        recent = [b for b in BUY if b["unit"].lower().startswith({"city": "city", "port": "port", "fact": "factory", "silo": "missile", "sam": "sam", "defp": "defense"}[e["unit"]]) and 0 <= e["t"] - b["t"] < 60]
        if len(recent) < e["delta"]:
            cap[e["unit"]] += e["delta"]; caplist.append((e["t"], e["unit"], e["delta"]))
P("-- STRUCTURE GAINS not explained by own builds (captures, approx): %s; first 10: %s" % (dict(cap), [(c(a), b, d) for a, b, d in caplist[:10]]))

# ---- alliances
reqs = [e for e in ev if e["type"] == "allianceRequest"]
ext = [e for e in ev if e["type"] == "allianceExtension"]
al = [e for e in ev if e["type"] == "ALLIED"]
inn = [e for e in ev if e["type"] == "allianceRequest_IN"]
rej = [e for e in ev if e["type"] == "allianceReject_BY_THEM"]
ends = [e for e in ev if e["type"] == "ALLY_ENDED"]
brk = [e for e in ev if e["type"] == "breakAlliance"]
P("-- ALLIANCES: requests out %d (first %s), in %d, formed %d, rejected-by-them %d, extensions %d, breaks %d, ended %s" % (
    len(reqs), c(reqs[0]["t"]) if reqs else "-", len(inn), len(al), len(rej), len(ext), len(brk), dict(collections.Counter(e["how"] for e in ends))))
bymin = {}
for m in (1, 2, 3, 5, 8, 10):
    s = [x for x in sm if abs(x["t"] - m * 60) < 6]
    if s: bymin[m] = len(s[0]["allies"])
P("  allies held at minute: %s; requests out by 1/2/3/5 min: %s" % (bymin, [sum(1 for e in reqs if e["t"] < m * 60) for m in (1, 2, 3, 5)]))
rk = [(e["myRank"], e["otherRank"], e["other"]["tiles"] / max(1, e["tiles"])) for e in reqs if e.get("otherRank")]
if rk:
    P("  requested allies: other rank median %s (my rank median %s); other tiles/my tiles median %.2f; requested those who ALREADY asked me %d of %d; shared border %d of %d" % (
        st.median([a[1] for a in rk]), st.median([a[0] for a in rk]), st.median([a[2] for a in rk]),
        sum(1 for e in reqs if e["incomingReqFromThem"]), len(reqs), sum(1 for e in reqs if e.get("borderContact")), len(reqs)))
    types = collections.Counter(e["other"]["type"] for e in reqs)
    P("  request target types %s" % dict(types))
P("  FORMED (t | who | their tiles vs mine | their rank):")
for e in al[:30]:
    rq = [r for r in reqs if r["other"]["id"] == e["other"]["id"] and r["t"] <= e["t"]]
    asked = "I asked %s" % c(rq[-1]["t"]) if rq else "THEY asked"
    P("   %s %-26s tiles %d vs me %d (%.2fx) | %s | gap request->accept %s" % (
        c(e["t"]), tn(e["other"])[:26], e["theirTiles"], e["myTiles"], e["theirTiles"] / max(1, e["myTiles"]), asked, ("%.0fs" % (e["t"] - rq[-1]["t"])) if rq else "-"))
P("  first 15 requests out (t | who | their rank/tiles | border contact dir/len | asked by them first):")
for e in reqs[:15]:
    bc = e.get("borderContact") or {}
    P("   %s %-26s rank %s tiles %d (me rank %s, %d) | border %s n=%s %s | theyAskedFirst %s" % (
        c(e["t"]), tn(e["other"])[:26], e.get("otherRank"), e["other"]["tiles"], e.get("myRank"), e["tiles"], bc.get("dir"), bc.get("n"), terr(bc), e["incomingReqFromThem"]))
P("  ENDED / BROKEN (t | who | how | their tiles vs mine | their troops vs mine):")
for e in ends[:40]:
    P("   %s %-26s %s tiles %s" % (c(e["t"]), (tn(e["other"]) if e["other"]["id"] else e["name"])[:26], e["how"], e["other"]["tiles"] if e["other"]["id"] else "-"))
for e in brk:
    t0 = e["t"]
    oa = [a for a in ATK if a["target"]["id"] == e["other"]["id"] and a["t"] >= t0 - 1]
    P("  BREAK %s -> %s | victim tiles %d vs my %d (%.2fx) troops %s vs my %s | next attack on victim after %s | n attacks on victim next 60s %d" % (
        c(t0), tn(e["other"]), e["other"]["tiles"], e["tiles"], e["other"]["tiles"] / max(1, e["tiles"]), k(e["other"]["troops"]), k(e["troops"]),
        ("%.1fs" % (oa[0]["t"] - t0)) if oa else "none", sum(1 for a in oa if a["t"] - t0 < 60)))

# ---- embargoes
emb = [e for e in ev if e["type"] in ("embargo", "embargo_all")]
P("-- EMBARGOES: %d" % len(emb))
for e in emb[:20]:
    if e["type"] == "embargo":
        P("  %s %s %s | rank %s vs my %s | shares border %s | allied %s | they attack me %s | my ports %s" % (c(e["t"]), e["action"], tn(e["other"]), e.get("otherRank"), e.get("myRank"), e.get("shares"), e.get("allied"), e.get("incomingFromThem"), e.get("myPorts")))
    else:
        P("  %s embargo_all %s" % (c(e["t"]), e.get("raw")))

# ---- nukes
nk = [e for e in ev if e["type"] in ("NUKE_OUT", "NUKE_IN")]
P("-- NUKES out %d in %d" % (sum(e["type"] == "NUKE_OUT" for e in nk), sum(e["type"] == "NUKE_IN" for e in nk)))
bn = [e for e in BUY if e["unit"] in ("Atom Bomb", "Hydrogen Bomb", "MIRV", "AtomBomb", "HydrogenBomb", "Missile Silo", "MissileSilo", "SAM Launcher", "SAMLauncher")]
for e in bn[:30]:
    P("  BUY %s %s gold %s cost %s" % (c(e["t"]), e["unit"], gd(e["gold"]), gd(e["cost"])))
for e in nk[:40]:
    P("  %s %s %s from %s -> %s (%s tiles) at %s" % (c(e["t"]), e["type"], e["unit"], e["from"]["name"], e["to"]["name"], e["to"]["tiles"], e["tile"]))

# ---- reactions to being attacked
P("-- REACTIONS to ATTACKED_BY (t | attacker | atk troops vs my troops | contact dir/terr | first own reaction within 30s)")
att = [e for e in ev if e["type"] == "ATTACKED_BY"]
reacts = []
for a in att:
    t0 = a["t"]
    if t0 < 0: continue
    later = [e for e in ev if t0 <= e["t"] <= t0 + 30 and e["type"] in ("attack", "boat", "build_unit", "allianceRequest", "embargo", "emoji", "cancel_attack", "upgrade_structure", "breakAlliance")]
    desc = []
    for e in later[:5]:
        if e["type"] == "attack":
            desc.append("+%.0fs ATTACK %s %.0f%%%s" % (e["t"] - t0, tn(e["target"])[:18], 100 * e["sent"] / max(1, e["troops"]), "(=attacker)" if e["target"]["id"] == a["other"]["id"] else ""))
        elif e["type"] == "build_unit":
            desc.append("+%.0fs BUY %s" % (e["t"] - t0, e["unit"]))
        else:
            desc.append("+%.0fs %s %s" % (e["t"] - t0, e["type"], tn(e["other"])[:18] if e.get("other") else ""))
    ca = a.get("contactIn") or {}
    reacts.append((t0, a, later))
    P("  %s %-26s atk %s vs my %s (%.0f%%) rank %s %s | in at %s %s | %s" % (
        c(t0), tn(a["other"])[:26], k(a["troops"]), k(a["myTroops"]), 100 * a["troops"] / max(1, a["myTroops"]), a.get("atkRank"), "ALLY" if a.get("allied") else "", ca.get("dir"), terr(ca),
        "; ".join(desc) if desc else "NO REACTION in 30s"))
    if len(reacts) >= 40: break

# ---- quiet periods: gaps >= 25s with no attack
P("-- QUIET PERIODS (gap >= 25 s between attack orders; what else happened)")
times = [e["t"] for e in ATK if e["t"] > 0]
qn = 0
for i in range(len(times) - 1):
    if times[i + 1] - times[i] >= 25:
        a, b = times[i], times[i + 1]
        oth = [e for e in ev if a < e["t"] < b and e["type"] in ("boat", "build_unit", "allianceRequest", "allianceExtension", "upgrade_structure", "emoji", "embargo", "cancel_attack", "breakAlliance", "targetPlayer", "move_warship", "NUKE_OUT")]
        cc = collections.Counter(e["type"] for e in oth)
        P("  %s-%s (%ds): %s" % (c(a), c(b), b - a, dict(cc)))
        qn += 1
        if qn >= 25: break
# actions per minute by type
P("-- ACTIONS PER MINUTE (attack/boat/build/ally-req/other)")
for m in range(0, int(dur // 60) + 1):
    xs = [e for e in ev if m * 60 <= e["t"] < (m + 1) * 60]
    cc = collections.Counter(e["type"] for e in xs)
    P("  min %2d: atk %2d boat %2d build %2d ally-req %2d ext %d emoji %d cancel %d" % (
        m, cc["attack"], cc["boat"], cc["build_unit"] + cc["upgrade_structure"], cc["allianceRequest"], cc["allianceExtension"], cc["emoji"], cc["cancel_attack"]))

# ---- misc intents
oth = collections.Counter(e["type"] for e in ev if e["type"] in ("emoji", "targetPlayer", "move_warship", "donate_troops", "donate_gold", "cancel_attack", "cancel_boat", "delete_unit", "quick_chat"))
P("-- OTHER intents: %s" % dict(oth))
for e in ev:
    if e["type"] == "targetPlayer":
        P("  %s TARGET-PLAYER %s" % (c(e["t"]), tn(e["other"])))
    if e["type"] in ("donate_troops", "donate_gold"):
        P("  %s %s %s" % (c(e["t"]), e["type"], e.get("raw")))

# stats
try:
    me = [p for p in rec["info"]["players"] if p["clientID"] == meta["clientID"]][0]
    P("-- STATS (record): %s" % json.dumps(me.get("stats"))[:600])
except Exception as ex:
    pass

open(os.path.join(HERE, "..", "_rp2", "digest_%s.txt" % gid), "w", encoding="utf8").write("\n".join(out))
print("\n".join(out)[:200])
