from pathlib import Path
import json, hashlib, sqlite3, datetime, os, argparse
parser=argparse.ArgumentParser(description='Read-only native accounting snapshot; no harness or network calls.')
parser.add_argument('--repo',type=Path,required=True)
parser.add_argument('--out',type=Path,required=True)
args=parser.parse_args()
ROOT=args.repo.resolve()
DEST=args.out.resolve()/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
if DEST.is_relative_to(ROOT):raise SystemExit('Output must remain outside the live repository')
os.umask(0o077)
DEST.mkdir(parents=True,exist_ok=False)
# Explicit accounting-only field projection. Never persist message/tool content or auth.
SCALARS=set('type role id uuid message_id messageId requestId request_id sessionId session_id parent_id parent_session_id parentCallId agentId agent_id turnId turn_id model modelID model_name modelAlias provider providerID provider_name timestamp time created_at updated_at created_timestamp time_created time_updated startTime lastUpdated ts model_id current_model_id sessionUpdate start_time end_time name billing stop_reason stopReason ordinal cost_source is_compaction isSidechain phase'.split())-{'name'}
TREES=set('payload info message usage tokens total_token_usage last_token_usage thread_token_usage turn_token_usage event data model_config stats statistics cost cache cache_creation input_tokens_details output_tokens_details response time modelUsage usageMetadata params update $set'.split())
def clean(d, numeric=False):
 if isinstance(d,dict):
  out={}
  for k,v in d.items():
   if k == 'modelUsage' and isinstance(v,dict):out[k]={a:clean(b,True) for a,b in v.items()}
   elif k in SCALARS and isinstance(v,(str,int,float,bool,type(None))):out[k]=v
   elif k in TREES or 'token' in k.lower() or k in ['input','output','cached','thoughts','tool','total','cacheRead','cacheWrite','inputOther','inputCacheRead','inputCacheCreation','reasoning','read','write','amount','totalCost','cost','inputTokenCount','outputTokenCount']:
    if isinstance(v,(dict,list)):
     c=clean(v,True)
     if c not in [{},[]]:out[k]=c
    elif isinstance(v,(int,float,type(None))):out[k]=v
   elif numeric and isinstance(v,(int,float,type(None))):out[k]=v
  return out
 if isinstance(d,list):return [x for v in d if (x:=clean(v,numeric)) not in [{},[]]]
 return d if isinstance(d,(int,float,type(None))) else None
patterns=[
'.local/franchise-runtimes/native-live/b4-openai/codex/sessions/**/*.jsonl',
'.local/franchise-runtimes/native-live/b4-anthropic/claude/projects/**/*.jsonl',
'.local/franchise-runtimes/native-live/b4-google/**/chats/*.jsonl',
'.local/franchise-runtimes/native-live/b4-mistral/**/session/*/meta.json',
'.local/franchise-runtimes/native-live/b4-mistral/**/session/*/messages.jsonl',
'.local/franchise-runtimes/native-live/b4-xai/grok/sessions/**/summary.json',
'.local/franchise-runtimes/native-live/b4-xai/grok/sessions/**/updates.jsonl',
'.local/franchise-runtimes/native-live/b4-xai/grok/sessions/**/events.jsonl',
'.local/native-provider-configs/kimi/kimi/sessions/wd_workspace_*/**/wire.jsonl',
'.local/native-provider-configs/minimax/**/v2/sessions/**/messages.jsonl',
'.local/native-provider-configs/deepseek/**/llm_request.*.jsonl',
'.local/franchise-runtimes/native-live/b4-meta/**/llm_request.*.jsonl',
'.local/franchise-runtimes/native-live/b4-qwen/qwen/projects/*workspace/chats/*.jsonl',
'.local/native-draft/production.stdout.log']
manifest=[]
qwenRoot=Path('/Users/joey/.qwen/projects')
qwenFiles=[p for d in qwenRoot.glob('*black4-fantasy-football*') if d.name.endswith(('franchises-qwen-workspace','b4-qwen-workspace')) for p in d.glob('chats/*.jsonl')]
for p in sorted({p for pat in patterns for p in ROOT.glob(pat)} | set(qwenFiles)):
 if not p.is_file() or p.is_symlink():continue
 raw=p.read_bytes();rel=str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p);sha=hashlib.sha256(raw).hexdigest();bad=0;records=[]
 if p.suffix=='.json':
  try:
   records=[{'line':1,'accounting':clean(json.loads(raw))}]
   # Model selection only; never retain the surrounding config/auth.
   if p.name=='meta.json':records[0]['accounting']['selected_model']=json.loads(raw).get('config',{}).get('active_model')
  except:bad=1
 else:
  for i,line in enumerate(raw.splitlines(),1):
   try:
    d=json.loads(line);c=clean(d)
    if c:records.append({'line':i,'accounting':c})
   except:bad+=1
 target=hashlib.sha256(rel.encode()).hexdigest()[:20]+'.json'
 (DEST/target).write_text(json.dumps(records))
 manifest.append({'path':rel,'bytesRead':len(raw),'sha256':sha,'mtime':p.stat().st_mtime,'projection':target,'records':len(records),'unparsedLines':bad})
for p in list(ROOT.glob('.local/native-provider-configs/**/sessions.db'))+list(ROOT.glob('.local/franchise-runtimes/native-live/**/sessions.db'))+list(ROOT.glob('.local/native-provider-configs/**/opencode.db'))+list(ROOT.glob('.local/franchise-runtimes/native-live/**/opencode.db')):
 con=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True);con.row_factory=sqlite3.Row;con.execute('BEGIN');data={}
 if p.name=='sessions.db':
  data['usage_ledger']=[dict(x) for x in con.execute('SELECT * FROM usage_ledger')]
  data['sessions']=[dict(x) for x in con.execute('SELECT id,parent_session_id,working_dir,created_at,updated_at,provider_name,model_config_json FROM sessions')]
  for s in data['sessions']:s['model_config']=clean(json.loads(s.pop('model_config_json') or '{}'))
 else:
  data['messages']=[dict(id=x['id'],session_id=x['session_id'],time_created=x['time_created'],time_updated=x['time_updated'],data=clean(json.loads(x['data']))) for x in con.execute('SELECT id,session_id,time_created,time_updated,data FROM message')]
  data['sessions']=[dict(x) for x in con.execute('SELECT id,parent_id,directory,time_created,time_updated,model FROM session')]
 co='deepseek' if 'deepseek' in str(p) else 'meta' if 'b4-meta' in str(p) else 'zai'
 allowed={str(ROOT/'franchises'/co/'workspace'),str(ROOT/'.local/franchise-runtimes/native-live'/('b4-'+co)/'workspace')}
 ids={s['id'] for s in data['sessions'] if s.get('working_dir',s.get('directory')) in allowed}
 while True:
  more={s['id'] for s in data['sessions'] if s.get('parent_session_id',s.get('parent_id')) in ids}-ids
  if not more:break
  ids.update(more)
 data['sessions']=[s for s in data['sessions'] if s['id'] in ids]
 for table in ['usage_ledger','messages']:
  if table in data:data[table]=[r for r in data[table] if r['session_id'] in ids]
 con.rollback();con.close();rel=str(p.relative_to(ROOT));raw=json.dumps(data,sort_keys=True).encode();target=hashlib.sha256(rel.encode()).hexdigest()[:20]+'.json';(DEST/target).write_bytes(raw)
 manifest.append({'path':rel,'projection':target,'projectionSha256':hashlib.sha256(raw).hexdigest(),'snapshot':'SQLite read-only transaction; accounting columns only'})
(DEST/'manifest.json').write_text(json.dumps({'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceRoot':str(ROOT),'sources':manifest},indent=2))
print(json.dumps({'snapshot':str(DEST),'sources':len(manifest),'bytesRead':sum(x.get('bytesRead',0) for x in manifest)}))
