import sys, os, glob, json, collections
sys.path.insert(0, sys.argv[1])
import pyarrow.parquet as pq
d = sys.argv[2]
C=collections.Counter
seen=C(); ex={}
for f in sorted(glob.glob(os.path.join(d,'*.parquet'))):
    t=pq.read_table(f,columns=['game_id','stage','record_json','num_turns']).to_pylist()
    for r in t:
        try: rec=json.loads(r['record_json'])
        except Exception as e: seen['bad']+=1; continue
        info=rec.get('info',{})
        cfg=info.get('config',{})
        key=(r['stage'], cfg.get('gameMap'), cfg.get('gameType'), cfg.get('gameMode'), cfg.get('difficulty'), cfg.get('bots'), cfg.get('nations'), len(info.get('players',[])))
        seen[key]+=1
        ex.setdefault(key,(f,r['game_id']))
for k,v in seen.most_common(30): print(v,k,ex.get(k))
f,g=ex[seen.most_common(1)[0][0]]
t=pq.read_table(f,columns=['game_id','record_json']).to_pylist()
rec=[json.loads(r['record_json']) for r in t if r['game_id']==g][0]
print(list(rec.keys()))
print(json.dumps(rec['info'])[:3000])
print(json.dumps(rec['turns'][:6])[:1500])
