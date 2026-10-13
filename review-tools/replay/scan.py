import sys, os, glob, json
sys.path.insert(0, sys.argv[1])
import pyarrow.parquet as pq
d = sys.argv[2]
tot = 0
for f in sorted(glob.glob(os.path.join(d, '*.parquet'))):
    pf = pq.ParquetFile(f)
    print(os.path.basename(f), pf.metadata.num_rows, [c for c in pf.schema_arrow.names] if f.endswith('000000.parquet') else '')
    tot += pf.metadata.num_rows
print('total rows', tot)
t = pq.read_table(os.path.join(d, 'train-000000.parquet'), columns=[c for c in pq.ParquetFile(os.path.join(d,'train-000000.parquet')).schema_arrow.names if c not in ('record_json','thinking_json')])
rows = t.to_pylist()
for r in rows[:3]: print(r)
