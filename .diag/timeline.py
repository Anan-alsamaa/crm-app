import io,re,json,urllib.request as ur,urllib.error
def env(p):
    d={}
    for line in io.open(p,encoding='utf-8',errors='replace'):
        m=re.match(r'^([A-Z0-9_]+)\s*=\s*(.*)$',line.strip())
        if m: d[m.group(1)]=m.group(2).strip().strip('"').strip("'")
    return d
def call(url,tok):
    req=ur.Request(url); req.add_header('Authorization','Bearer '+tok)
    try:
        with ur.urlopen(req,timeout=45) as r: return r.status,json.loads(r.read().decode())
    except urllib.error.HTTPError as e: return e.code,e.read().decode()[:300]
E=env('.env.prod.smoke'); U='https://crm-api.anan.sa'
req=ur.Request(U+'/auth/login',method='POST'); req.add_header('Content-Type','application/json')
tok=json.loads(ur.urlopen(req,json.dumps({'email':E['DIRECTUS_ADMIN_EMAIL'],'password':E['DIRECTUS_ADMIN_PASSWORD']}).encode(),timeout=45).read())['data']['access_token']
CID='5c7f1af5-019e-4f5d-acf8-95c281d9d4e0'
names={'98d6ba2c':'Mohamed','6dffef93':'Nada','18becef7':'Amjad','c82c90a3':'Shatha'}
ev=[]
st,m=call(U+f'/items/messages?fields=sender_type,date_created&filter[conversation][_eq]={CID}&filter[date_created][_gte]=2026-09-16T11:00:00&sort=date_created&limit=20',tok)
for r in (m['data'] if st==200 else []): ev.append((r['date_created'],f"message from {r['sender_type']}"))
st,r2=call(U+f'/items/routing_events?fields=agent,outcome,stage,date_created&filter[conversation][_eq]={CID}&filter[date_created][_gte]=2026-09-16T11:00:00&sort=date_created&limit=20',tok)
for r in (r2['data'] if st==200 else []):
    ev.append((r['date_created'],f"ladder {r['stage']}/{r['outcome']} -> {names.get(str(r.get('agent'))[:8],str(r.get('agent'))[:8])}"))
st,n=call(U+f'/items/notifications?fields=recipient,type,date_created&filter[date_created][_gte]=2026-09-16T11:00:00&sort=date_created&limit=20',tok)
for r in (n['data'] if st==200 else []):
    ev.append((r['date_created'],f"NOTIFY {r['type']} -> {names.get(str(r.get('recipient'))[:8],str(r.get('recipient'))[:8])}"))
print('=== timeline since 11:00 UTC ===')
for t,d in sorted(ev): print(f"  {str(t)[11:19]}  {d}")
