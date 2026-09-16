import io,re,json,urllib.request,urllib.error
def env(p):
    d={}
    for line in io.open(p,encoding='utf-8',errors='replace'):
        m=re.match(r'^([A-Z0-9_]+)\s*=\s*(.*)$',line.strip())
        if m: d[m.group(1)]=m.group(2).strip().strip('"').strip("'")
    return d
def call(url,token=None):
    req=urllib.request.Request(url); req.add_header('Authorization','Bearer '+token)
    try:
        with urllib.request.urlopen(req,timeout=45) as r: return r.status,json.loads(r.read().decode())
    except urllib.error.HTTPError as e: return e.code,e.read().decode()[:300]
E=env('.env.prod.smoke'); U='https://crm-api.anan.sa'
import urllib.request as ur
req=ur.Request(U+'/auth/login',method='POST'); req.add_header('Content-Type','application/json')
tok=json.loads(ur.urlopen(req,json.dumps({'email':E['DIRECTUS_ADMIN_EMAIL'],'password':E['DIRECTUS_ADMIN_PASSWORD']}).encode(),timeout=45).read())['data']['access_token']
st,m=call(U+'/items/messages?fields=id,conversation,sender_type,content,date_created&filter[conversation][_eq]=5c7f1af5-0000-0000-0000-000000000000&sort=-date_created&limit=5',tok)
# The id above is a guess; list by the real conversation instead.
st,convs=call(U+'/items/conversations?fields=id&filter[last_message_at][_gte]=2026-09-16T10:00:00&limit=5',tok)
print('conversations with activity since 10:00 UTC:', [c['id'][:8] for c in convs['data']])
for c in convs['data']:
    st,m=call(U+f"/items/messages?fields=id,sender_type,content,date_created&filter[conversation][_eq]={c['id']}&sort=-date_created&limit=6",tok)
    print(f"\n=== {c['id'][:8]} ===")
    for r in (m['data'] if st==200 else []):
        print(f"  {str(r['date_created'])[11:19]}  {r['sender_type']:9s} {str(r.get('content'))[:60]!r}")
