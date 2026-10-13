import re,sys
for f in sys.argv[1:]:
    out=[];cur='';nxt=0
    for line in open(f,encoding='utf8'):
        m=re.match(r'\[(\d+):(\d+)\] (.*)',line.strip())
        if not m: continue
        t=int(m[1])*60+int(m[2])
        if t>=nxt:
            out.append(cur);cur=f"\n[{m[1]}:{m[2]}] ";nxt=t+30
        cur+=m[3]+' '
    out.append(cur)
    open(f.replace('.txt','.c.txt'),'w',encoding='utf8').write(''.join(out))
