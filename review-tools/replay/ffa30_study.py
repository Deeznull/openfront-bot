"""FFA 30+ default-settings study over full-turn replays (tools/replays + tools/replays_world, rows from out/ffa30_index.csv).
Parses each game with tools/load.py parse() (data only, never executed) and prints markdown tables:
median [Q1-Q3] n=count per group. Groups: W = winner, T = rank 2-3, O = rest (alive >= 5 min).
Time is game seconds (turn/10). Run: python -I tools/replay_tools/ffa30_study.py > tools/replay_tools/out/ffa30_study.md"""
import csv, json, os, sys, statistics as st, collections

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)
from load import parse

INDEX = os.path.join(HERE, "out", "ffa30_index.csv")
GROUPS = ("W", "T", "O")
UNITS = ("City", "Port", "Factory", "Defense Post", "Warship", "Missile Silo", "SAM Launcher", "Atom Bomb", "Hydrogen Bomb")
MARKS = (300, 600, 900)  # 5, 10, 15 min


def q(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return "n=0"
    n = len(xs)
    if n < 4:
        return "%.1f n=%d" % (st.median(xs), n)
    qs = st.quantiles(xs, n=4)
    return "%.1f [%.1f-%.1f] n=%d" % (st.median(xs), qs[0], qs[2], n)


def metrics(p, g):
    m = {}
    m["final_tiles"] = p["final_tiles"]
    m["peak_troops"] = p["peak"]
    m["kills"] = len(p["stats"].get("kills", []))
    m["spawn_t"] = p["t_spawn"]
    m["first_attack_t"] = p["attacks"][0][0] if p["attacks"] else None
    m["attacks_n"] = len(p["attacks"])
    tot = sum(a[1] for a in p["attacks"]) or 1
    for cls in ("human", "nation", "bot", "wild"):
        m["atk_troops_%s" % cls] = 100.0 * sum(a[1] for a in p["attacks"] if a[2] == cls) / tot
    m["boats_n"] = len(p["boats"])
    m["alliance_req"] = len(p["req"])
    m["alliance_ext"] = len(p["ext"])
    m["alliance_brk"] = len(p["brk"])
    m["alive_min"] = (p["end"] or 0) / 60
    for u in UNITS:
        for mk in MARKS:
            m["%s@%d" % (u, mk // 60)] = sum(1 for t, un in p["builds"] if un == u and t <= mk)
        m["%s_total" % u] = sum(1 for t, un in p["builds"] if un == u)
    m["upgrades_n"] = len(p["upgrades"])
    m["attacks_pre5"] = sum(1 for a in p["attacks"] if a[0] <= 300)
    m["boats_pre5"] = sum(1 for b in p["boats"] if b[0] <= 300)
    m["first_boat_t"] = p["boats"][0][0] if p["boats"] else None
    m["alliance_req_pre10"] = sum(1 for a in p["req"] if a[0] <= 600)
    m["ext_per_req"] = (len(p["ext"]) / len(p["req"])) if p["req"] else None
    m["median_atk_troops"] = st.median([a[1] for a in p["attacks"]]) if p["attacks"] else None
    m["atk_pct_of_peak"] = (100.0 * m["median_atk_troops"] / p["peak"]) if p["attacks"] and p["peak"] else None
    bt = sum(b[1] for b in p["boats"]); at = sum(a[1] for a in p["attacks"])
    m["boat_troop_share"] = 100.0 * bt / (bt + at) if bt + at else None
    m["first_city_t"] = min([t for t, un in p["builds"] if un == "City"], default=None)
    m["first_nuke_t"] = min([t for t, un in p["builds"] if un in ("Atom Bomb", "Hydrogen Bomb")], default=None)
    m["first_silo_t"] = min([t for t, un in p["builds"] if un == "Missile Silo"], default=None)
    return m


def main():
    idx = list(csv.DictReader(open(INDEX, encoding="utf-8")))
    idx = [r for r in idx if int(r["turns"] or 0) > 0]
    per = collections.defaultdict(lambda: collections.defaultdict(list))  # group -> metric -> values
    per_map = collections.defaultdict(lambda: collections.defaultdict(list))
    games = []
    skipped = 0
    for r in idx:
        d = json.load(open(os.path.join(TOOLS, r["path"]), encoding="utf-8"))
        g = parse(d)
        if not g:
            skipped += 1
            continue
        games.append((r["gid"], g["map"], g["nact"], g["dur"] / 60, g["win_share"], g["survivors"]))
        for p in g["players"]:
            if p["group"] == "O" and p["end"] < 300:
                continue  # keep the comparison fair: dead before 5 min left out of O
            m = metrics(p, g)
            for k, v in m.items():
                if v is None:
                    continue
                per[p["group"]][k].append(v)
                per_map[g["map"]][(p["group"], k)].append(v)
    C = collections.Counter
    print("# FFA 30+ default study (full-turn replays)\n")
    print("games parsed", len(games), "skipped", skipped)
    print("maps", C(x[1] for x in games).most_common())
    print("players alive-at-end median", q([x[5] for x in games]), "| winner share %", q([100 * x[4] for x in games]))
    print("game minutes", q([x[3] for x in games]), "| active players", q([x[2] for x in games]), "\n")
    keys = [k for k in per["W"].keys()]
    print("## Per-player metrics by group (W winner, T rank 2-3, O rest alive>=5min)\n")
    print("| metric | W | T | O |")
    print("|---|---|---|---|")
    for k in keys:
        print("| %s | %s | %s | %s |" % (k, q(per["W"][k]), q(per["T"][k]), q(per["O"][k])))
    print("\n## By map (winner only, median)\n")
    maps = [m for m, _ in C(x[1] for x in games).most_common(3)]
    print("| metric | " + " | ".join(maps) + " |")
    print("|---|" + "---|" * len(maps))
    for k in ("spawn_t", "first_attack_t", "City@10", "Port@10", "Factory@10", "Defense Post@10", "Warship@10", "boats_n", "alliance_req", "attacks_n", "atk_troops_human", "atk_troops_nation", "Atom Bomb_total", "Hydrogen Bomb_total", "Missile Silo_total", "final_tiles", "peak_troops"):
        row = []
        for m in maps:
            row.append(q(per_map[m][("W", k)]))
        print("| %s | %s |" % (k, " | ".join(row)))


if __name__ == "__main__":
    main()
