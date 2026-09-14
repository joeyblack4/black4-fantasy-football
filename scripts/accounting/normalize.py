#!/usr/bin/env python3
"""Offline accounting projection. Reads sanitized snapshots; never invokes a harness."""
import argparse, json, csv, hashlib, datetime
from pathlib import Path
from collections import Counter, defaultdict
from decimal import Decimal
CATS=['uncachedInput','cacheRead','cacheWrite','output']
EPOCH='native-production-20260908-v1'
def dt(x):
 if x is None:return None
 if isinstance(x,(int,float)):return datetime.datetime.fromtimestamp(x/(1000 if x>1e11 else 1),datetime.timezone.utc)
 try:return datetime.datetime.fromisoformat(x.replace('Z','+00:00')).replace(tzinfo=datetime.timezone.utc) if '+' not in x and not x.endswith('Z') else datetime.datetime.fromisoformat(x.replace('Z','+00:00'))
 except:return None
def iso(x):return dt(x).isoformat() if dt(x) else None
def sub(a,*bs):return a-sum(bs) if a is not None and all(b is not None for b in bs) and a>=sum(bs) else None
def tokens(i,r,w,o):return dict(zip(CATS,[i,r,w,o]))
def sha(d):return hashlib.sha256(json.dumps(d,sort_keys=True).encode()).hexdigest()
def metric(rs,key):
 vals=[r[key] for r in rs if r.get(key) is not None]
 return {'knownSubtotal':round(sum(vals),8) if vals else None,'coveredRecords':len(vals),'records':len(rs),'total':round(sum(vals),8) if vals and len(vals)==len(rs) else None}
def parse_snapshot(folder):
 manifest=json.loads((folder/'manifest.json').read_text()); records={};coverage=[]
 def add(company,s,row,key,t,model,tok,kind='call',parent=None,reported=None,cli=None,raw=None,start=None):
  identity=f'{company}:{key}';r={'id':identity,'franchiseId':'b4-'+company,'sessionId':s,'parentSessionId':parent,'at':iso(t),'startAt':iso(start or t),'model':model,'tokens':tok,'granularity':kind,'providerReportedUsd':reported,'cliEstimateUsd':cli,'rawUsage':raw,'evidenceRef':row,'coverage':'observed records; not proven complete'}
  # Same native message may be persisted repeatedly while streaming. Keep final usage only.
  records[identity]=r
 for source in manifest['sources']:
  p=source['path'];data=json.loads((folder/source['projection']).read_text());ref=source['projection'];coverage.append(source)
  if p.endswith('sessions.db'):
   co='deepseek' if 'deepseek' in p else 'meta';sessions={s['id']:s for s in data['sessions']}
   for u in data['usage_ledger']:
    s=sessions[u['session_id']];r=u.get('cache_read_tokens');w=u.get('cache_write_tokens')
    add(co,u['session_id'],ref+'#usage_ledger:'+str(u['id']),u['session_id']+':ledger:'+str(u['id']),u['created_timestamp'],u['model'],tokens(sub(u['input_tokens'],r),r,w,u['output_tokens']),parent=s.get('parent_session_id'),reported=u['cost'] if u.get('cost_source')=='provider_reported' else None,cli=u['cost'] if u.get('cost_source') not in [None,'provider_reported'] else None,raw=u)
   continue
  if p.endswith('opencode.db'):
   sessions={s['id']:s for s in data['sessions']}
   for m in data['messages']:
    d=m['data'];u=d.get('tokens');s=sessions.get(m['session_id'],{})
    if d.get('role')!='assistant' or not u:continue
    # OpenCode input/output categories are disjoint from cache/reasoning.
    o=u.get('output');reason=u.get('reasoning');o=o+reason if o is not None and reason is not None else None
    add('zai',m['session_id'],ref+'#message:'+m['id'],m['id'],d.get('time',{}).get('completed') or m['time_created'],d.get('modelID'),tokens(u.get('input'),u.get('cache',{}).get('read'),u.get('cache',{}).get('write'),o),parent=s.get('parent_id'),cli=d.get('cost'),raw=u,start=d.get('time',{}).get('created'))
   continue
  if 'llm_request' in p:continue # retained as corroboration; ledger is canonical
  for x in data:
   d=x['accounting'];e=ref+':'+str(x['line']);s=Path(p).stem
   if '/b4-openai/' in p:
    if d.get('type')=='session_meta':s=d.get('payload',{}).get('id',s)
    if d.get('type')!='token_usage_record':continue
    a=d['payload'];u=a['usage'];s=a['session_id'];model=None
    # Nearest prior turn_context owns the executed model; never infer from roster.
    for old in data[:data.index(x)+1]:
     od=old['accounting']
     if od.get('type')=='turn_context' and od.get('payload',{}).get('model'):model=od['payload']['model']
    add('openai',s,e,s+':'+str(d.get('ordinal',x['line'])),d['timestamp'],model,tokens(sub(u.get('input_tokens'),u.get('cached_input_tokens'),u.get('cache_write_input_tokens')),u.get('cached_input_tokens'),u.get('cache_write_input_tokens'),u.get('output_tokens')),raw=u)
   elif '/b4-anthropic/' in p:
    m=d.get('message',{});u=m.get('usage')
    if d.get('type')!='assistant' or not u or not m.get('id') or m.get('model')=='<synthetic>':continue
    add('anthropic',d.get('sessionId',s),e,m['id'],d.get('timestamp'),m.get('model'),tokens(u.get('input_tokens'),u.get('cache_read_input_tokens'),u.get('cache_creation_input_tokens'),u.get('output_tokens')),parent='sidechain-parent-UNKNOWN' if d.get('isSidechain') else None,raw=u)
   elif '/b4-google/' in p:
    u=d.get('tokens')
    if not isinstance(u,dict) or not d.get('id'):continue
    # One Gemini message is updated repeatedly across tool-loop calls; final tokens replace prior copies.
    o=u.get('output');th=u.get('thoughts');o=o+th if o is not None and th is not None else None
    add('google',s,e,d['id'],d.get('timestamp'),d.get('model'),tokens(sub(u.get('input'),u.get('cached')),u.get('cached'),None,o),'message-aggregate',raw=u)
   elif '/.qwen/' in p or '/b4-qwen/qwen/' in p:
    u=d.get('usageMetadata')
    if not u or d.get('type')!='assistant':continue
    # Qwen candidates already include reasoning: total = prompt + candidates in captured native evidence.
    add('qwen',d['sessionId'],e,d['uuid'],d['timestamp'],d.get('model'),tokens(sub(u.get('promptTokenCount'),u.get('cachedContentTokenCount')),u.get('cachedContentTokenCount'),None,u.get('candidatesTokenCount')),raw=u)
   elif '/b4-mistral/' in p and p.endswith('meta.json'):
    u=d.get('stats',{});s=d['session_id']
    add('mistral',s,e,s,d.get('end_time') or d.get('start_time'),d.get('selected_model'),tokens(sub(u.get('session_prompt_tokens'),u.get('session_cached_tokens')),u.get('session_cached_tokens'),None,u.get('session_completion_tokens')),'session-aggregate',parent=d.get('parent_session_id'),cli=u.get('session_cost'),raw=u,start=d.get('start_time'))
   elif '/b4-xai/' in p and p.endswith('updates.jsonl'):
    a=d.get('params',{});v=a.get('update',{});u=v.get('usage');s=a.get('sessionId',s)
    if v.get('sessionUpdate')!='turn_completed' or not u:continue
    # Parent totals contain modelUsage; use only the disaggregated model rows, not both.
    for model,z in u.get('modelUsage',{}).items():
     add('xai',s,e,s+':'+str(d['timestamp'])+':'+model,d['timestamp'],model,tokens(sub(z.get('inputTokens'),z.get('cachedReadTokens'),z.get('cacheCreationTokens')),z.get('cachedReadTokens'),z.get('cacheCreationTokens'),z.get('outputTokens')),'turn-aggregate',reported=z['costUsdTicks']/1e10 if z.get('costUsdTicks') is not None else None,raw=z,start=d['timestamp']-v.get('elapsed_ms',0)/1000)
   elif '/kimi/' in p and p.endswith('wire.jsonl'):
    if d.get('type')!='usage.record':continue # context.append_loop_event repeats the same usage
    u=d['usage'];parts=Path(p).parts;s=next(a for a in parts if a.startswith('session_'));agent=d.get('agentId','UNKNOWN')
    add('kimi',s+':'+agent,e,s+':'+agent+':'+str(d['time']),d['time'],'moonshotai/kimi-k3' if d.get('model')=='kimi-k3' else d.get('model'),tokens(u.get('inputOther'),u.get('inputCacheRead'),u.get('inputCacheCreation'),u.get('output')),parent=s+':main' if agent!='main' else None,raw=u)
   elif '/minimax/' in p and p.endswith('messages.jsonl'):
    a=d.get('message',{});u=a.get('usage')
    if a.get('role')!='assistant' or not u:continue
    s=Path(p).parent.name
    add('minimax',s,e,d['message_id'],a.get('timestamp'),a.get('model'),tokens(u.get('input'),u.get('cacheRead'),u.get('cacheWrite'),u.get('output')),cli=u.get('cost',{}).get('total'),raw=u)
 return manifest,list(records.values()),coverage

