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
CID=None
st,c=call(U+'/items/conversations?fields=id,assigned_agent,status,vendor&filter[last_message_at][_gte]=2026-09-16T10:00:00&limit=1',tok)
CID=c['data'][0]['id']; print('conversation:',CID)
print('  assigned_agent:',c['data'][0]['assigned_agent'])
print('  status        :',c['data'][0]['status'])
st,ev=call(U+f"/items/routing_events?fields=id,agent,outcome,stage,date_created&filter[conversation][_eq]={CID}&sort=-date_created&limit=8",tok)
print('\n=== routing_events for this chat ===')
for r in (ev['data'] if st==200 else []):
    print(f"  {str(r['date_created'])[11:19]} stage={r.get('stage'):10s} outcome={r.get('outcome'):9s} agent={str(r.get('agent'))[:8]}")
if st==200 and not ev['data']: print('  (NONE - the ladder never recorded anything)')
st,n=call(U+"/items/notifications?fields=id,recipient,type,title,date_created&sort=-date_created&limit=6",tok)
print('\n=== most recent notifications (any chat) ===')
for r in (n['data'] if st==200 else []):
    print(f"  {str(r['date_created'])[11:19]} type={r.get('type'):12s} to={str(r.get('recipient'))[:8]}")
