import sys, os, glob, json, collections, datetime
sys.path.insert(0, sys.argv[1])
import pyarrow.parquet as pq
d = sys.argv[2]
rows=[]
for f in sorted(glob.glob(os.path.join(d,'*.parquet'))):
    names=[c for c in pq.ParquetFile(f).schema_arrow.names if c not in('record_json','thinking_json')]
    rows+=pq.read_table(f,columns=names).to_pylist()
C=collections.Counter
print(len(rows))
print('map',C(r['map'] for r in rows).most_common())
print('run',C(r['run_name'] for r in rows).most_common())
print('engine',C(r['engine'] for r in rows), 'ver',C(r['record_version'] for r in rows))
print('commit',C(r['git_commit'][:8] for r in rows).most_common())
print('stage',sorted(C(r['stage'] for r in rows).items(), key=lambda x:str(x[0])))
print('winner kind',C((json.loads(r['winner'])[0] if r['winner'] else None) for r in rows))
print('winner name',C((json.loads(r['winner'])[1] if r['winner'] and len(json.loads(r['winner']))>1 else None) for r in rows).most_common(8))
ts=[r['created_at'] for r in rows]
print(datetime.datetime.utcfromtimestamp(min(ts)/1000), datetime.datetime.utcfromtimestamp(max(ts)/1000))
print('policy_repo',C(r['policy_repo'] for r in rows))
print('world',C((r['run_name'],r['stage'],r['engine']) for r in rows if r['map']=='World'))
