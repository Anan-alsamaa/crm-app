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
st,m=call(U+'/items/messages?fields=id,conversation,sender_type,date_created&sort=-date_created&limit=8',tok)
print('=== the 8 most recent MESSAGES in the whole system ===')
for r in (m['data'] if st==200 else []):
    print(f"  {str(r['date_created'])[:19]}  conv={str(r.get('conversation'))[:8]}  from={r['sender_type']}")
st,c=call(U+'/items/conversations?fields=id,status,assigned_agent,date_created,external_customer_id,acquisition_channel,contact.phone,contact.external_customer_id&sort=-date_created&limit=4',tok)
print('\n=== the 4 newest CONVERSATIONS ===')
for r in (c['data'] if st==200 else []):
    ct=r.get('contact') or {}
    print(f"  {str(r['date_created'])[:19]} {r['id'][:8]} agent={str(r.get('assigned_agent'))[:8]:8s} "
          f"phone={ct.get('phone')} yiji_id={ct.get('external_customer_id')}")
