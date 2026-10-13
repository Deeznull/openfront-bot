import re,sys
for f in sys.argv[1:]:
    out=[];last=''
    t0=None
    for line in open(f,encoding='utf8'):
        line=line.strip()
        m=re.match(r'(\d+):(\d+):(\d+)\.\d+ -->',line)
        if m: t0=int(m[1])*3600+int(m[2])*60+int(m[3]);continue
        if not line or line.startswith(('WEBVTT','Kind','Language')) : continue
        line=re.sub(r'<[^>]+>','',line).strip()
        if line and line!=last:
            out.append(f"[{t0//60}:{t0%60:02d}] {line}");last=line
    open(f.replace('.en.vtt','.txt'),'w',encoding='utf8').write('\n'.join(out))
