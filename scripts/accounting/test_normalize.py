import unittest,tempfile,json
from pathlib import Path
from normalize import parse_snapshot
class AccountingAuditTests(unittest.TestCase):
 def parse(self,path,records):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'manifest.json').write_text(json.dumps({'sources':[{'path':path,'projection':'rows.json'}]}));(p/'rows.json').write_text(json.dumps([{'line':i+1,'accounting':r} for i,r in enumerate(records)]));return parse_snapshot(p)[1]
 def test_isolated_qwen_streaming_final_replaces_old_record(self):
  row={'type':'assistant','sessionId':'s','uuid':'u','timestamp':'2026-09-11T00:00:00Z','model':'qwen','usageMetadata':{'promptTokenCount':100,'cachedContentTokenCount':80,'candidatesTokenCount':5}}
  final={**row,'usageMetadata':{**row['usageMetadata'],'candidatesTokenCount':9}}
  rs=self.parse('.local/franchise-runtimes/native-live/b4-qwen/qwen/projects/test-workspace/chats/a.jsonl',[row,final]);self.assertEqual(len(rs),1);self.assertEqual(rs[0]['tokens'],{'uncachedInput':20,'cacheRead':80,'cacheWrite':None,'output':9})
 def test_kimi_usage_echo_is_not_double_counted(self):
  row={'type':'usage.record','time':1789150000000,'agentId':'main','model':'kimi-k3','usage':{'inputOther':20,'inputCacheRead':80,'inputCacheCreation':0,'output':9}}
  rs=self.parse('.local/native-provider-configs/kimi/kimi/sessions/wd_workspace_x/session_a/agents/main/wire.jsonl',[row,{'type':'context.append_loop_event','event':row}]);self.assertEqual(len(rs),1);self.assertEqual(rs[0]['tokens']['uncachedInput'],20);self.assertEqual(rs[0]['tokens']['cacheRead'],80)
 def test_missing_cache_is_not_assumed_zero(self):
  row={'type':'assistant','sessionId':'s','uuid':'u','timestamp':'2026-09-11T00:00:00Z','model':'qwen','usageMetadata':{'promptTokenCount':100,'candidatesTokenCount':5}}
  rs=self.parse('/Users/joey/.qwen/projects/workspace/chats/a.jsonl',[row]);self.assertIsNone(rs[0]['tokens']['uncachedInput']);self.assertIsNone(rs[0]['tokens']['cacheRead'])
if __name__=='__main__':unittest.main()
