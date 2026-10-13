"""Index default-settings FFA games with 30+ players across tools/replays, tools/replays_world, tools/replays_slim.
Header-only: reads config, players and winner, never prints replay bodies.
Default = Free For All, Public, Normal size, no modifiers, no random spawn, default nations, no infinite gold/troops,
no instant build, no disabled units, Medium difficulty (full replays only; slim files store no difficulty, so it is marked '?').
Dedupe by gameID, full replay > replays_world > slim.
Run: python -I tools/replay_tools/ffa30_index.py   -> tools/replay_tools/out/ffa30_index.csv + counts."""
import csv, glob, json, os, collections

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
SRC = [("replays", "full"), ("replays_world", "world"), ("replays_slim", "slim")]  # priority order
MIN_PLAYERS = 30


def full_ok(c, np):
    return (c.get("gameMode") == "Free For All" and c.get("gameType") == "Public" and c.get("gameMapSize") == "Normal"
            and not c.get("publicGameModifiers") and not c.get("randomSpawn") and c.get("nations") == "default"
            and not c.get("infiniteGold") and not c.get("infiniteTroops") and not c.get("instantBuild")
            and not c.get("disabledUnits") and c.get("difficulty") == "Medium" and np >= MIN_PLAYERS)


def slim_ok(d, np):
    c = d.get("cfg") or {}
    return (d.get("mode") == "Free For All" and d.get("size") == "Normal" and not c.get("randomSpawn")
            and c.get("nations") == "default" and np >= MIN_PLAYERS)


def rows():
    seen = set()
    for folder, tag in SRC:
        for f in sorted(glob.glob(os.path.join(TOOLS, folder, "*.json"))):
            try:
                d = json.load(open(f, encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            if "info" in d:
                i = d["info"]; c = i.get("config", {}); pl = i.get("players", []); np = len(pl)
                if not full_ok(c, np):
                    continue
                gid = i.get("gameID"); w = i.get("winner") or []
                r = dict(gid=gid, src=tag, map=c.get("gameMap"), size=c.get("gameMapSize"), diff=c.get("difficulty"),
                         players=np, dur_s=i.get("duration"), winner_kind=w[0] if w else None,
                         winner_cid=w[1] if len(w) > 1 else None, commit=d.get("gitCommit", "")[:8],
                         turns=len(d.get("turns", [])), path=os.path.relpath(f, TOOLS))
            elif "cfg" in d:
                np = len(d.get("players", []))
                if not slim_ok(d, np):
                    continue
                gid = d.get("gameID"); w = d.get("winner") or []
                r = dict(gid=gid, src=tag, map=d.get("map"), size=d.get("size"), diff="?", players=np,
                         dur_s=d.get("duration"), winner_kind=w[0] if w else None,
                         winner_cid=w[1] if len(w) > 1 else None, commit="", turns=0,
                         path=os.path.relpath(f, TOOLS))
            else:
                continue
            if gid in seen:
                continue
            seen.add(gid)
            yield r


def main():
    R = list(rows())
    out = os.path.join(HERE, "out", "ffa30_index.csv")
    with open(out, "w", newline="", encoding="utf-8") as fh:
        wr = csv.DictWriter(fh, fieldnames=list(R[0].keys()))
        wr.writeheader(); wr.writerows(R)
    C = collections.Counter
    print("games", len(R), "->", os.path.relpath(out, TOOLS))
    print("src", C(r["src"] for r in R))
    print("map", C(r["map"] for r in R).most_common(12))
    print("winner_kind", C(r["winner_kind"] for r in R))
    print("players>=30 by 10s", sorted(C(min(r["players"], 100) // 10 * 10 for r in R).items()))
    print("with turns", sum(1 for r in R if r["turns"]))


if __name__ == "__main__":
    main()
