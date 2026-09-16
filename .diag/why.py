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
    except urllib.error.HTTPError as e: return e.code,e.read().decode()[:400]
E=env('.env.prod.smoke'); U='https://crm-api.anan.sa'
req=ur.Request(U+'/auth/login',method='POST'); req.add_header('Content-Type','application/json')
tok=json.loads(ur.urlopen(req,json.dumps({'email':E['DIRECTUS_ADMIN_EMAIL'],'password':E['DIRECTUS_ADMIN_PASSWORD']}).encode(),timeout=45).read())['data']['access_token']
CID='5c7f1af5-019e-4f5d-acf8-95c281d9d4e0'
st,c=call(U+f'/items/conversations/{CID}?fields=id,status,assigned_agent,assigned_team,vendor,last_message_at,archived_at',tok)
print('=== the conversation the messages landed on ===')
print(' ',json.dumps(c['data'],indent=2)[:500] if st==200 else c)
print('\n=== who is ONLINE right now (gateway presence) ===')
try:
    with ur.urlopen(U.replace('crm-api','crm-api')+'/debug/presence',timeout=20) as r:
        print(' ',r.read().decode()[:300])
except Exception as e:
    print('  /debug/presence not reachable through the ALB:',str(e)[:80])
st,u=call(U+"/users?fields=id,first_name,status,role.name&filter[status][_eq]=active&limit=20",tok)
print('\n=== active staff and their roles ===')
for r in (u['data'] if st==200 else []):
    rn=(r.get('role') or {}).get('name')
    if rn and 'WeCare' in str(rn) or rn in ('Agent','Admin','Administrator'):
        print(f"  {r['id'][:8]} {str(r.get('first_name'))[:14]:14s} {rn}")
