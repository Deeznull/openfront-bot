"""Tactic weights live INSIDE KNOWLEDGE.md (section '## TACTIC WEIGHTS'; tactic_weights.md was merged into it 2026-10-11).
Usage: python tools/weights_update.py "Name A=3; Name B=2"   (run from the project root; "" = just refresh)
Does: adds each FIT to the table row (new name -> new row with the next id), re-sorts the table by total,
refreshes every '(wN Tnn)' tag on KNOWLEDGE lines, re-sorts tagged bullets AND tagged schema rows ('XX-nnn | ...') inside each section by weight
(tagged lines swap among tagged slots only; untagged lines never move), and rewrites the '> MOST-SEEN PRO HABITS' header (top 8)."""
import re, sys
ALIAS = {'Accept strong incoming alliances / renew last 30 s': 'Renew in the last 30 s', 'Many early alliances': 'Many early alliances / accept incoming',
         'Tiny early boats/sleeper cells': 'Early boats (tiny/many)', 'Steal a rival city early (port snipe)': 'Steal rival city/port snipe',
         'Kill-steal sizing': 'Kill-steal / bot kill', 'Nuke targeting order / SAM before enemy silo': 'Nuke targeting order',
         'Price-out a rich rival': 'Price-out / check gold before betray', 'Betrayal recipe / betray late': 'Betray late only',
         'Kill passive giants': 'Mitochondria (was misread as kill passive giants)', 'Mitochondria': 'Mitochondria (was misread as kill passive giants)',
         'Check gold before betray': 'Price-out / check gold before betray',
         'Nuke to drop troops then push': 'Hydro then troop push', 'Attack betrayal-debuffed player': 'Push betrayer while debuffed',
         'Factory rail linking': 'Link factories and ports for train gold', 'Wait for target to spend troops then go': 'Slam target after it overspends troops',
         'Hydro retaliation deterrence': 'Own hydro bomb as deterrent/counter', 'Snipe silo to deny hydro': 'Snipe enemy silos to deter',
         'Early bot stealing/annexing': 'Kill-steal / bot kill', 'Attack betrayer during debuff': 'Push betrayer while debuffed'}
ROW = re.compile(r'^\| (T\d+) \| (.+?) \| (.+?) \| ([\d.]+) \|$')
TAG = re.compile(r'\(w[\d.]+ (T\d+)\)')
SCHEMA = re.compile(r'^[A-Z]{2}-\d{3} \| ')  # machine-schema rows (KNOWLEDGE.md 2026-10-11 format): 'XX-nnn | ...'
PATH = sys.argv[2] if len(sys.argv) > 2 else 'KNOWLEDGE.md'


def main(arg):
    add = {}
    for part in arg.split(';'):
        if '=' in part:
            k, v = part.rsplit('=', 1); k = ALIAS.get(k.strip(), k.strip()); add[k] = round(add.get(k, 0) + float(v), 1)
    lines = open(PATH, encoding='utf-8').read().splitlines()
    rows = {}; order = []; first = None
    for i, l in enumerate(lines):
        m = ROW.match(l)
        if m:
            first = i if first is None else first
            rows[m.group(1)] = [m.group(2), m.group(3), float(m.group(4))]; order.append(i)
    if first is None:
        sys.exit('no TACTIC WEIGHTS rows (| Tnn | name | tallies | total |) in ' + PATH)
    byname = {v[0]: k for k, v in rows.items()}
    nxt = max(int(k[1:]) for k in rows) + 1
    for name, n in add.items():
        if name in byname:
            r = rows[byname[name]]; r[1] += f'+{n:g}'; r[2] = round(r[2] + n, 1)
        else:
            rows[f'T{nxt:02d}'] = [name, f'{n:g}', n]; nxt += 1
    table = [f'| {k} | {v[0]} | {v[1]} | {v[2]:g} |' for k, v in sorted(rows.items(), key=lambda kv: -kv[1][2])]
    lines = lines[:first] + table + [l for i, l in enumerate(lines) if i > first and i not in order]
    w = {k: v[2] for k, v in rows.items()}
    lines = [TAG.sub(lambda m: f'(w{w.get(m.group(1), 0):g} {m.group(1)})', l) for l in lines]
    # re-sort tagged bullets inside each '## ' section (contiguous bullet runs only; tables untouched)
    out = []; run = []

    def flush():
        # only tagged lines swap among the tagged slots; untagged lines (details, verdicts) never move
        key = lambda l: -max(w.get(t, 0) for t in TAG.findall(l))
        tagged = iter(sorted([l for l in run if TAG.search(l)], key=key))
        out.extend(next(tagged) if TAG.search(l) else l for l in run); run.clear()
    kind = None  # a run is either '- ' bullets or schema rows, never mixed

    for l in lines:
        k = 'b' if l.startswith('- ') else 's' if SCHEMA.match(l) else None
        if k and (k == kind or not run):
            run.append(l); kind = k
        elif k:
            flush(); run.append(l); kind = k
        else:
            flush(); kind = None; out.append(l)
    flush()
    top = sorted(rows.values(), key=lambda v: -v[2])[:8]
    hdr = '> MOST-SEEN PRO HABITS (TACTIC WEIGHTS section below, video/replay fit-weighted counts; follow these first in [H] games): ' + ' · '.join(f'{v[0]} ({v[2]:g})' for v in top)
    if not any(l.startswith('> MOST-SEEN PRO HABITS') for l in out):
        out.insert(1, hdr)
    out = [hdr if l.startswith('> MOST-SEEN PRO HABITS') else l for l in out]
    open(PATH, 'w', encoding='utf-8', newline='\r\n').write('\n'.join(out) + '\n')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '')
