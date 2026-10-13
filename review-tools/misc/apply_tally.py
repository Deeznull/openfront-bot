"""Apply an H-batch tally file (lines 'ID: name=w; name=w [TAG]') via weights_update.py, mapping short names to canonical rows."""
import sys, re, subprocess
M = {'Early boats': 'Early boats (tiny/many)', 'Price-out': 'Price-out / check gold before betray', 'Kill-steal': 'Kill-steal / bot kill',
     'Free enclosure': 'Free enclosure / annexation', 'Hit traitor-debuff players': 'Push betrayer while debuffed',
     'SAM before enemy silo/SAM density': 'SAM before enemy silo / SAM density', 'Renew in last 30 s': 'Renew in the last 30 s',
     'Many early alliances': 'Many early alliances / accept incoming'}
out = []
for l in open(sys.argv[1], encoding='utf-8').read().splitlines():
    if ': ' not in l: continue
    for p in l.split(': ', 1)[1].split(';'):
        p = re.sub(r'^NEW\s+', '', re.sub(r'\s*\[(WHY|N)\]', '', p).strip())
        if '=' in p:
            k, v = p.rsplit('=', 1); v = re.match(r'\s*([0-9.]+)', v).group(1); out.append(M.get(k.strip(), k.strip()) + '=' + v)
subprocess.run([sys.executable, 'tools/weights_update.py', '; '.join(out)], check=True)
