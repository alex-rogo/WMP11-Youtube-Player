import sys, struct, re, collections, os, glob, json
TL=sys.argv[1]
names=collections.defaultdict(dict); guids={}; cur=None
for line in open(TL,encoding='utf-8-sig'):
    if line.startswith('TYPE '):
        m=re.match(r'TYPE (\S+) kind=(\S+) guid=(\S+)',line); cur=m.group(1); guids[m.group(3).lower()]=cur; continue
    p=line.strip().split('\t')
    if len(p)>=2 and re.fullmatch(r'-?\d+',p[0]): names[cur][int(p[0])]=p[1]
G={}
for iface,mp in names.items():
    if 'Event' in iface: continue
    for k,v in mp.items(): G.setdefault(k,v)
for iface,mp in names.items():
    for k,v in mp.items(): G.setdefault(k,v)
def an(pid, iface):
    if iface in names and pid in names[iface]: return names[iface][pid]
    return G.get(pid, f'attr{pid}')
class P:
    def __init__(s,d): s.d=d; s.unk=collections.Counter()
    def ws(s,o):
        e=o
        while s.d[e:e+2]!=b'\0\0': e+=2
        return s.d[o:e].decode('utf-16le','replace'), e+2
    def attr(s,o,tagname):
        d=s.d; ln,ty=struct.unpack_from('<HB',d,o); p=o+3
        if ty==0xe0 or ty==0x00:
            n,p=s.ws(p); v,p=s.ws(p); return n,v,(p if ln==0 else o+ln)
        if ty&0x40: p+=4
        base=ty&0x1f
        if base==0:
            n,p=s.ws(p); v,p=s.ws(p)
        else:
            pid=struct.unpack_from('<I',d,p)[0]; p+=4; n=an(pid,tagname)
            if base==0x04: v=str(struct.unpack_from('<i',d,p)[0]); p+=4
            elif base==0x01: v='true' if struct.unpack_from('<h',d,p)[0] else 'false'; p+=2
            elif base in (0x08,0x0d): v,p=s.ws(p)
            elif base==0x18: v='res://wmploc/RT_STRING/#%d'%struct.unpack_from('<I',d,p)[0]; p+=4
            else: raise ValueError(f'attr type {ty:02x} at {o:x}')
        if ty&0x80: v='jscript:'+v
        if ty&0x40: v='wmpprop:'+v
        return n,v,(p if ln==0 else o+ln)
    def elem(s,o,depth,end):
        d=s.d; total,choff,tag,nch,nat=struct.unpack_from('<HHBBB',d,o); p=o+7
        name,p=s.ws(p); guid=None
        if tag&0x80:
            g=d[p:p+16]; p+=16
            guid='{%08x-%04x-%04x-%s-%s}'%(struct.unpack_from('<IHH',g)+(g[8:10].hex(),g[10:].hex()))
        cn=guids.get(guid.strip('{}'),'') if guid else ''
        iface={'VIEW':'IWMPLayoutView','SUBVIEW':'IWMPLayoutSubView'}.get(TAGS.get(tag),'I'+cn if cn else 'IWMPRegionalButton' if tag==3 else '')
        if name: tagname=name.upper() if tag==3 else name
        elif tag in TAGS: tagname=TAGS[tag]
        elif cn: tagname=cn.replace('WMP','').replace('Ctrl','').upper()
        else: tagname='ACTIVEXCONTROL'
        attrs=[]
        for _ in range(nat):
            n,v,p=s.attr(p,iface); attrs.append((n,v))
        s.unk[(tag,guid,tagname)]+=1
        children=[]
        if choff:
            c=o+choff
            for _ in range(nch):
                ce,csz=s.elem(c,depth+1,end)
                children.append(ce); c=c+csz if csz else None
                if c is None: break
        return (tagname,attrs,children,guid), total
TAGS={0x0c:'VIEW',0x0d:'SUBVIEW'}
def esc(v): return v.replace('&','&amp;').replace('"','&quot;').replace('<','&lt;').replace('>','&gt;')
def xml(e,ind=0):
    t,a,c,g=e; sp='    '*ind
    at=''.join(f'\n{sp}      {n}="{esc(v)}"' for n,v in a) if len(a)>2 else ''.join(f' {n}="{esc(v)}"' for n,v in a)
    if g: at=f' clsid="{g}"'+at
    if not c: return f'{sp}<{t}{at}/>\n'
    return f'{sp}<{t}{at}>\n'+''.join(xml(x,ind+1) for x in c)+f'{sp}</{t}>\n'
if __name__=='__main__':
    stats=collections.Counter()
    for f in sys.argv[3:] if len(sys.argv)>3 else sorted(glob.glob(os.path.join(sys.argv[2],'*.wsz'))):
        d=open(f,'rb').read(); pr=P(d)
        try:
            hsz=struct.unpack_from('<H',d,2)[0]; root,_=pr.elem(hsz,0,len(d))
            out=f[:-4]+'.wms'
            open(out,'w',encoding='utf-8').write('<!-- decompiled from '+os.path.basename(f)+' -->\n<THEME>\n'+xml(root,1)+'</THEME>\n')
            print('ok ',os.path.basename(f))
        except Exception as e: print('ERR',os.path.basename(f),e)
        stats.update(pr.unk)
    for k,v in sorted(stats.items(),key=lambda x:str(x[0])): print(v,k)
