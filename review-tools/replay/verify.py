import sys, os, glob, json, collections
sys.path.insert(0, sys.argv[1])
import pyarrow.parquet as pq
C=collections.Counter
maps=C(); diff=C(); npl=C(); mode=C(); ids=C(); human=0; n=0; types=C(); dur=[]
for f in sorted(glob.glob(os.path.join(sys.argv[2],'*.parquet'))):
    for r in pq.read_table(f,columns=['record_json','num_turns']).to_pylist():
        try: rec=json.loads(r['record_json'])
        except Exception: types['bad']+=1; continue
        n+=1
        if 'info' not in rec: types['noinfo']+=1; continue
        i=rec['info']; c=i['config']
        maps[c.get('gameMap')]+=1; diff[c.get('difficulty')]+=1; mode[(c.get('gameType'),c.get('gameMode'))]+=1
        npl[len(i['players'])]+=1
        for p in i['players']: ids[p['clientID']]+=1
        for t in rec['turns']:
            for it in t['intents']: types[it['type']]+=1
        dur.append(r['num_turns'])
print(n, maps, diff, mode, npl, ids.most_common(5))
print(types.most_common())
dur.sort(); print('turns min/med/max', dur[0], dur[len(dur)//2], dur[-1])
