import io,re,json,urllib.request,urllib.error
def env(p):
    d={}
    for line in io.open(p,encoding='utf-8',errors='replace'):
        m=re.match(r'^([A-Z0-9_]+)\s*=\s*(.*)$',line.strip())
        if m: d[m.group(1)]=m.group(2).strip().strip('"').strip("'")
    return d
def call(url,method='GET',token=None,body=None):
    req=urllib.request.Request(url,method=method); req.add_header('Content-Type','application/json')
    if token: req.add_header('Authorization','Bearer '+token)
    data=json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req,data,timeout=45) as r:
            raw=r.read().decode(); return r.status,(json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
E=env('.env.prod.smoke'); U='https://crm-api.anan.sa'
st,res=call(U+'/auth/login','POST',body={'email':E['DIRECTUS_ADMIN_EMAIL'],'password':E['DIRECTUS_ADMIN_PASSWORD']})
tok=res['data']['access_token']
st,c=call(U+'/items/conversations?fields=id,status,assigned_agent,assigned_team,vendor,last_message_at,date_created,contact.name,contact.phone&sort=-date_created&limit=6',token=tok)
print('=== most recent conversations ===')
for r in c['data']:
    print(f"  {r['id'][:8]} status={r['status']!r:8s} agent={str(r.get('assigned_agent'))[:8]:8s} "
          f"created={str(r.get('date_created'))[:16]} last_msg={str(r.get('last_message_at'))[:16]} "
          f"contact={(r.get('contact') or {}).get('phone')}")
