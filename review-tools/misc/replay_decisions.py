#!/usr/bin/env python3
"""Decision log of one player from an OpenFront public-API game record (stdlib only).

Usage:  python tools\\replay_decisions.py <game.json> <username|clientID> [--state <state.json>] [--raw]
                                          [--no-boats] [--minutes 0] [--out <file>]

Two modes:
 * ENRICHED (default): reads tools\\replays\\state\\<gameID>.state.json, made by the deterministic
   headless replay tools\\OF34\\tests\\replay\\DecisionLog.ts (OF34 = the exact engine commit that
   played the game, hash-verified). It knows target NAME/TYPE (Tribe/Nation/human), troops
   sent as % of own troops, target troops, gold before each buy, structure counts, alliances
   (formed / ended), incoming attacks and nukes. If the state file is missing it is generated
   (needs node + tools\\OF34\\node_modules; ~1 min per 13 game minutes).
 * RAW (--raw or no node): reads only the record's intents (public ids stay opaque, tile -> x,y).

Clock: game seconds = (turn - 200)/10 (20 s spawn phase in public games, 1 turn = 100 ms).
Troops are IN-GAME units (raw/10), like the HUD. 'K' = thousand.
"""
import json, os, subprocess, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(HERE, "replays", "state")
OF34 = os.path.join(HERE, "OF34")


def clock(t):
    neg = t < 0
    t = abs(t)
    s = int(t)
    return ("-" if neg else "") + "%d:%02d" % (s // 60, s % 60)


def k(v):  # raw troops -> in-game display
    v = v / 10.0
    if v >= 1e6:
        return "%.2fM" % (v / 1e6)
    if v >= 1e3:
        return "%.1fK" % (v / 1e3)
    return "%d" % v


def g(v):  # gold
    if v >= 1e6:
        return "%.2fM" % (v / 1e6)
    if v >= 1e3:
        return "%.0fK" % (v / 1e3)
    return "%d" % v


def find_player(rec, who):
    for p in rec["info"]["players"]:
        if p["clientID"] == who:
            return p
    for p in rec["info"]["players"]:
        if p["username"] == who:
            return p
    sys.exit("player not found: " + who)


def ensure_state(path, state_path, client):
    if os.path.exists(state_path):
        return True
    if not os.path.isdir(os.path.join(OF34, "node_modules")):
        return False
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    cmd = ["npx.cmd" if os.name == "nt" else "npx", "tsx", "tests/replay/DecisionLog.ts", os.path.abspath(path), client, state_path]
    sys.stderr.write("generating state (headless replay, ~1 min)...\n")
    r = subprocess.run(cmd, cwd=OF34, capture_output=True, text=True)
    return os.path.exists(state_path)


def tname(o):
    if not o or o.get("type") == "wild":
        return "wilderness"
    return "%s '%s'" % (o["type"], o["name"])


def run_enriched(st, out, opts):
    ev, sm, meta = st["events"], st["samples"], st["meta"]
    P = lambda s: out.append(s)
    P("GAME %s %s | %s players | player %s | winner %s | duration %ss | replay hash mismatches: %d"
      % (meta["gameID"], meta["map"], meta["players"], meta["me"], meta["winner"], meta["duration"], meta["hashMismatches"]))
    P("Troops = in-game units (raw/10). % = troops sent / own troops at that moment. 'ratio' = sent / target troops.")
    P("")
    P("== DECISION LOG ==")
    attacks = collections.OrderedDict()
    buys, allies, boats = [], [], []
    boat_min = collections.Counter()
    req_out, req_in_acc = [], 0
    for e in ev:
        t, ty = e["t"], e["type"]
        c = clock(t)
        if ty == "spawn":
            P("%s | SPAWN at (%d,%d)" % (c, e["tile"]["x"], e["tile"]["y"]))
        elif ty == "attack":
            tg = e["target"]
            pct = 100.0 * e["sent"] / max(1, e["troops"])
            ratio = ("%.2fx its troops (%s)" % (e["sent"] / max(1, tg["troops"]), k(tg["troops"]))) if tg["type"] != "wild" else "n/a"
            mode = "wilderness" if tg["type"] == "wild" else tname(tg)
            P("%s | ATTACK %s | land, sent %s = %.0f%% of %s | ratio %s | target tiles %s | my tiles %d | out-attacks %d%s"
              % (c, mode, k(e["sent"]), pct, k(e["troops"]), ratio, tg["tiles"] if tg["type"] != "wild" else "-", e["tiles"], e["outAtk"],
                 " | ALLY!" if e.get("allied") else ""))
            key = tname(tg)
            a = attacks.setdefault(key, {"first": t, "n": 0, "sent": 0, "type": tg["type"], "tiles0": tg["tiles"]})
            a["n"] += 1
            a["sent"] += e["sent"]
        elif ty == "boat" and not opts["no_boats"]:
            tg = e["target"]
            pct = 100.0 * e["sent"] / max(1, e["troops"])
            P("%s | BOAT -> %s at (%d,%d) | sent %s = %.0f%% of %s | my tiles %d"
              % (c, tname(tg), e["dst"]["x"], e["dst"]["y"], k(e["sent"]), pct, k(e["troops"]), e["tiles"]))
            boat_min[int(t // 60)] += 1
            boats.append(e)
        elif ty == "build_unit":
            cn = e["counts"]
            P("%s | BUY %s @(%d,%d) | gold before %s, cost %s | owned: %dC %dP %dF %dSilo %dSAM %dDP | troops %s/%s"
              % (c, e["unit"], e["tile"]["x"], e["tile"]["y"], g(e["gold"]), g(e["cost"]), cn["city"], cn["port"], cn["fact"], cn["silo"], cn["sam"], cn["defp"],
                 k(e["troops"]), k(e["maxTroops"])))
            buys.append(e)
        elif ty == "upgrade_structure":
            P("%s | UPGRADE structure #%s x%s | gold before %s" % (c, e["unitId"], e.get("amount"), g(e["gold"])))
            buys.append(dict(e, unit="Upgrade"))
        elif ty == "allianceRequest":
            P("%s | ALLY requested -> %s | they had asked me first: %s | my tiles %d vs %d" % (c, tname(e["other"]), e["incomingReqFromThem"], e["tiles"], e["other"]["tiles"]))
            req_out.append(e)
        elif ty == "allianceRequest_IN":
            P("%s | ALLY request received from %s" % (c, tname(e["other"])))
        elif ty == "allianceReject_BY_THEM":
            P("%s | ALLY rejected by %s" % (c, tname(e["other"])))
        elif ty == "ALLIED":
            P("%s | ALLY accepted/formed with %s | tiles me %d vs them %d" % (c, tname(e["other"]), e["myTiles"], e["theirTiles"]))
            allies.append({"t": t, "name": tname(e["other"]), "end": None, "how": None})
        elif ty == "ALLY_ENDED":
            how = e["how"]
            if how == "expired" and any(b["type"] == "breakAlliance" and abs(b["t"] - t) < 1.5 and b["other"]["name"] == e["name"] for b in ev):
                how = "broken_by_me (betrayal)"
                e["how"] = how
            P("%s | ALLY ended with %s (%s)" % (c, tname(e["other"]) if e["other"]["id"] else e["name"], how))
            for a in allies:
                if a["end"] is None and (e["name"] in a["name"]):
                    a["end"], a["how"] = t, e["how"]
                    break
        elif ty == "allianceExtension":
            P("%s | ALLY renew requested with %s" % (c, tname(e["other"])))
        elif ty == "breakAlliance":
            P("%s | ALLY BREAK (betray) %s | my tiles %d vs %d, my troops %s vs %s" % (c, tname(e["other"]), e["tiles"], e["other"]["tiles"], k(e["troops"]), k(e["other"]["troops"])))
        elif ty == "breakAlliance_IN":
            P("%s | ALLY broken BY %s" % (c, tname(e["other"])))
        elif ty == "targetPlayer":
            P("%s | TARGET marked %s" % (c, tname(e["other"])))
        elif ty == "NUKE_OUT":
            P("%s | NUKE launched %s at %s (%d,%d)" % (c, e["unit"], tname(e["to"]), e["tile"]["x"], e["tile"]["y"]))
        elif ty == "NUKE_IN":
            P("%s | NUKE RECEIVED %s from %s at (%d,%d)" % (c, e["unit"], tname(e["from"]), e["tile"]["x"], e["tile"]["y"]))
        elif ty == "ATTACKED_BY":
            if e["other"]["type"] != "Tribe" or e["troops"] > 20000:
                P("%s | UNDER ATTACK by %s | %s troops vs my %s (%.0f%%) | my tiles %d"
                  % (c, tname(e["other"]), k(e["troops"]), k(e["myTroops"]), 100.0 * e["troops"] / max(1, e["myTroops"]), e["myTiles"]))
        elif ty in ("cancel_attack", "cancel_boat"):
            P("%s | CANCEL %s" % (c, ty))
        elif ty == "emoji":
            P("%s | EMOJI %s to %s" % (c, e.get("emoji"), tname(e["other"])))
        elif ty == "embargo":
            P("%s | EMBARGO %s %s" % (c, e["action"], tname(e["other"])))
        elif ty == "move_warship":
            P("%s | WARSHIP move" % c)
    P("")
    P("== CHECKPOINTS (every 60 s; idle = troops > 60% of max) ==")
    for s in sm:
        if int(s["t"]) % 60 == 0 and s["t"] > 0 and (s["t"] <= 600 or int(s["t"]) % 300 == 0):
            cn = s["counts"]
            P("%s | land %.2f%% (%d tiles) rank %d/%d | troops %s/%s (%.0f%%) | gold %s | %dC %dP %dF %dSilo %dSAM | out-attacks %d (%s) | allies %d | top rival %s"
              % (clock(s["t"]), s["landPct"], s["tiles"], s["rank"], s["alive"], k(s["troops"]), k(s["maxTroops"]), 100.0 * s["troops"] / max(1, s["maxTroops"]),
                 g(s["gold"]), cn["city"], cn["port"], cn["fact"], cn["silo"], cn["sam"], s["outAtk"], k(s["outAtkTroops"]), len(s["allies"]),
                 ("%s %d tiles" % (s["top"]["name"], s["top"]["tiles"])) if s["top"] else "-"))
    idle = [s for s in sm if s["troops"] > 0.6 * s["maxTroops"]]
    P("troop idle: %d of %d 10-s samples above 60%% of max (%.0f%%); mean troops %.0f%% of max"
      % (len(idle), len(sm), 100.0 * len(idle) / max(1, len(sm)), 100.0 * sum(s["troops"] / max(1, s["maxTroops"]) for s in sm) / max(1, len(sm))))
    P("")
    P("== SUMMARY ==")
    P("ALLIES (formed): " + ("; ".join("%s %s%s" % (clock(a["t"]), a["name"], (" -> ended %s %s" % (clock(a["end"]), a["how"])) if a["end"] is not None else " (to end)") for a in allies) or "none"))
    P("alliance requests sent: %d, formed: %d, extensions asked: %d, betrayals: %d, requests received: %d"
      % (len(req_out), len(allies), sum(1 for e in ev if e["type"] == "allianceExtension"), sum(1 for e in ev if e["type"] == "breakAlliance"), sum(1 for e in ev if e["type"] == "allianceRequest_IN")))
    order = collections.OrderedDict()
    for b in buys:
        order.setdefault(b["unit"], []).append(clock(b["t"]))
    P("BUY ORDER (first 40): " + ", ".join("%s %s" % (clock(b["t"]), b["unit"]) for b in buys[:40]))
    P("BUY totals: " + ", ".join("%s x%d (first %s, last %s)" % (u, len(l), l[0], l[-1]) for u, l in order.items()))
    P("ATTACK ORDER by target (first time, #attacks, total sent):")
    for name, a in attacks.items():
        P("   %s | %s | n=%d | sent %s" % (clock(a["first"]), name, a["n"], k(a["sent"])))
    if boats:
        bt = collections.Counter(tname(b["target"]).split(" ")[0] for b in boats)
        P("BOATS: %d total; per minute %s; destination types %s" % (len(boats), dict(sorted(boat_min.items())), dict(bt)))
        small = sum(1 for b in boats if b["sent"] / max(1, b["troops"]) <= 0.05)
        P("boats <=5%% of troops: %d of %d" % (small, len(boats)))
    nk = [e for e in ev if e["type"] in ("NUKE_OUT", "NUKE_IN")]
    P("NUKES out %d / in %d" % (sum(1 for e in nk if e["type"] == "NUKE_OUT"), sum(1 for e in nk if e["type"] == "NUKE_IN")))


def run_raw(rec, me, out):
    W = None
    mp = rec["info"]["config"]["gameMap"].lower().replace(" ", "")
    mf = os.path.join(HERE, "OF34", "resources", "maps", mp, "manifest.json")
    if os.path.exists(mf):
        W = json.load(open(mf))["map"]["width"]
    cid = me["clientID"]
    out.append("RAW MODE (no state): targets are opaque public ids. map width %s" % W)
    for turn in rec["turns"]:
        for it in turn["intents"]:
            if it.get("clientID") != cid or it["type"] == "mark_disconnected":
                continue
            t = (turn["turnNumber"] - 200) / 10.0
            extra = {kk: vv for kk, vv in it.items() if kk not in ("type", "clientID")}
            if "tile" in it and W:
                extra["xy"] = (it["tile"] % W, it["tile"] // W)
            if "dst" in it and W:
                extra["xy"] = (it["dst"] % W, it["dst"] // W)
            out.append("%s | %s %s" % (clock(t), it["type"], extra))


def main():
    a = sys.argv[1:]
    if len(a) < 2:
        print(__doc__)
        sys.exit(1)
    path, who = a[0], a[1]
    opts = {"no_boats": "--no-boats" in a}
    state_path = None
    outfile = None
    if "--state" in a:
        state_path = a[a.index("--state") + 1]
    if "--out" in a:
        outfile = a[a.index("--out") + 1]
    rec = json.load(open(path, encoding="utf8"))
    me = find_player(rec, who)
    state_path = state_path or os.path.join(STATE_DIR, rec["info"]["gameID"] + ".state.json")
    out = []
    if "--raw" not in a and ensure_state(path, state_path, me["clientID"]):
        run_enriched(json.load(open(state_path)), out, opts)
    else:
        run_raw(rec, me, out)
    text = "\n".join(out)
    if outfile:
        open(outfile, "w", encoding="utf8").write(text + "\n")
    else:
        sys.stdout.reconfigure(encoding="utf8")
        print(text)


if __name__ == "__main__":
    main()
