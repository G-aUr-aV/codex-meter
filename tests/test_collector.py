import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from collector import Collector, counters, price

BASE=Path(__file__).resolve().parents[1]
SECRET='PRIVATE_PROMPT_SENTINEL_never_publish_or_store'
def usage(i=1000,c=400,o=100,w=0,r=30):
    return dict(input_tokens=i,cached_input_tokens=c,cache_write_input_tokens=w,output_tokens=o,reasoning_output_tokens=r,total_tokens=i+o)
def row(t,p,at='2026-10-20T01:00:00Z'):
    return {'timestamp':at,'type':t,'payload':p}
def prefix(sid='s1',turn='t1'):
    return [row('session_meta',{'id':sid,'timestamp':'2026-10-20T00:00:00Z','cwd':SECRET,'base_instructions':SECRET}),
      row('event_msg',{'type':'task_started','turn_id':turn}),
      row('turn_context',{'turn_id':turn,'model':'gpt-6.1-sol','effort':'high','cwd':SECRET}),
      row('event_msg',{'type':'thread_settings_applied','thread_settings':{'service_tier':'default'}})]
def request(rid='r1',u=None,turn='t1',at='2026-10-20T01:00:01Z'):
    return row('token_usage_record',{'response_id':rid,'turn_id':turn,'usage':u or usage()},at)
def legacy(u=None,at='2026-10-20T01:00:02Z'):
    return row('event_msg',{'type':'token_count','info':{'total_token_usage':u or usage(),'last_token_usage':u or usage()}},at)

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.source=self.root/'sessions';self.source.mkdir()
        self.file=self.source/'rollout.jsonl';self.output=self.root/'published'/'report.json'
        self.c=Collector([self.source],self.root/'private',self.output,BASE/'pricing.json')
    def tearDown(self):
        self.c.db.close();self.temp.cleanup()
    def write(self,rows,name=None):
        (self.source/(name or 'rollout.jsonl')).write_text(''.join(json.dumps(r)+'\n' for r in rows))
    def scan(self):
        self.c.scan();return json.loads(self.output.read_text())
    def test_modern_records_supersede_legacy_and_reemits(self):
        self.write(prefix()+[request(),legacy(),legacy(at='2026-10-20T01:00:03Z'),request()])
        r=self.scan();self.assertEqual(r['totals']['total_tokens'],1100);self.assertEqual(r['totals']['requests'],1)
        self.assertAlmostEqual(r['totals']['costUSD'],.00224)
        self.assertEqual(self.scan()['totals'],r['totals'])
    def test_legacy_counts_advancing_totals_and_remains_unpriced(self):
        self.write(prefix()+[legacy(),legacy(at='2026-10-20T01:00:03Z'),legacy(usage(2000,800,200),at='2026-10-20T01:00:04Z')])
        r=self.scan();self.assertEqual(r['totals']['total_tokens'],2200);self.assertEqual(r['totals']['requests'],2)
        self.assertEqual(r['totals']['unpricedRequests'],2)
    def test_duplicate_copied_session_and_response_do_not_double_count(self):
        data=prefix()+[request()];self.write(data);self.write(data,'copy.jsonl')
        self.assertEqual(self.scan()['totals']['requests'],1)
    def test_partial_append_is_retried_and_no_private_text_persists(self):
        self.write(prefix()+[row('response_item',{'type':'message','content':SECRET}),request()])
        with self.file.open('a') as f:f.write(json.dumps(request('r2',at='2026-10-20T01:00:03Z')))
        self.assertEqual(self.scan()['totals']['requests'],1)
        with self.file.open('a') as f:f.write('\n')
        self.assertEqual(self.scan()['totals']['requests'],2)
        self.c.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        for p in self.root.rglob('*'):
            if p.is_file() and self.source not in p.parents:self.assertNotIn(SECRET.encode(),p.read_bytes())
    def test_symlinks_hardlinks_and_directories_are_not_sources(self):
        outside=self.root/'outside.jsonl';outside.write_text(''.join(json.dumps(r)+'\n' for r in prefix()+[request()]))
        (self.source/'link.jsonl').symlink_to(outside)
        (self.source/'dir').symlink_to(self.root,target_is_directory=True)
        os.link(outside,self.source/'hard.jsonl')
        self.assertEqual(self.scan()['totals']['requests'],0)
    def test_child_replay_is_ignored_but_own_usage_counted(self):
        meta=prefix('child','own')[0];meta['payload']['timestamp']='2026-10-20T02:00:00Z'
        own=[row('event_msg',{'type':'task_started','turn_id':'own'},'2026-10-20T02:00:01Z'),
             row('turn_context',{'turn_id':'own','model':'gpt-6-luna'},'2026-10-20T02:00:01Z'),
             row('event_msg',{'type':'thread_settings_applied','thread_settings':{'service_tier':'default'}},'2026-10-20T02:00:01Z')]
        self.write([meta,*prefix()[1:],request(),legacy(),*own,request('child-real',turn='own',at='2026-10-20T02:00:02Z')])
        self.assertEqual(self.scan()['totals']['requests'],1)
    def test_unknown_model_never_gets_invented_price(self):
        rows=prefix();rows[2]['payload']['model']=SECRET;self.write(rows+[request()])
        r=self.scan();self.assertEqual(r['models'][0]['model'],'unknown');self.assertEqual(r['totals']['unpricedRequests'],1)
        self.assertNotIn(SECRET,self.output.read_text())
    def test_counter_reset_is_conservative(self):
        self.write(prefix()+[legacy(),legacy(usage(10,0,1,r=0),at='2026-10-20T01:00:03Z')])
        r=self.scan();self.assertEqual(r['totals']['requests'],1);self.assertEqual(r['coverage']['counterResets'],1)
    def test_unsupported_compressed_history_is_disclosed(self):
        (self.source/'older.jsonl.zst').write_bytes(b'invented compressed fixture')
        self.assertEqual(self.scan()['coverage']['unsupportedFiles'],1)
    def test_token_categories_and_long_context_pricing(self):
        rates=json.loads((BASE/'pricing.json').read_text())
        # 90k ordinary + 200k cache reads + 10k writes; long-context then Fast.
        self.assertAlmostEqual(price(usage(300000,200000,1000,w=10000,r=500),'gpt-6.1-sol','fast',rates),.93)
        self.assertIsNone(counters(usage(10,11,1,r=0)))
        self.assertIsNone(counters(usage(10,0,1,r=2)))
        self.assertIsNone(counters({'input_tokens':True}))
        self.assertIsNone(price(usage(),'codex-auto-review','standard',rates))
        self.assertIsNone(price(usage(),'gpt-6.1-sol','unknown',rates))
    def test_invalid_json_and_oversized_lines_do_not_block_future_events(self):
        self.write(prefix())
        with self.file.open('ab')as f:f.write(b'bad json\n'+b'x'*(4*1024*1024+50)+b'\n'+json.dumps(request()).encode()+b'\n')
        self.scan();r=self.scan();self.assertEqual(r['totals']['requests'],1)
        self.assertEqual(r['coverage']['malformedLines'],1);self.assertEqual(r['coverage']['oversizedLines'],1)

    def test_timestamp_details_preserve_fractional_log_time_and_accounting_precedence(self):
        self.write(prefix()+[request('a',at='2026-10-20T01:00:01.125Z'),legacy(),
            request('b',at='2026-10-20T01:00:02.999Z'),request('b',at='2026-10-20T01:00:02.999Z')])
        r=self.scan();events=r['usageEvents']
        self.assertEqual(len(events),2);self.assertEqual(events[0]['at'],1792458001.125)
        self.assertEqual(events[1]['at'],1792458002.999)
        self.assertEqual(sum(e['total_tokens'] for e in events),r['totals']['total_tokens'])
        self.assertEqual(sum(e['costUSD'] for e in events),r['totals']['costUSD'])
        self.assertEqual(r['coverage']['eventDetailsVersion'],1)
        self.assertEqual(r['coverage']['omittedEvents'],0)
        self.assertNotIn(SECRET,json.dumps(events));self.assertNotIn('response_id',json.dumps(events))
        self.assertEqual(self.scan()['usageEvents'],events)

    def test_detail_limit_is_disclosed_and_does_not_truncate_aggregates(self):
        self.write(prefix()+[request(str(i),at=f'2026-10-20T01:00:0{i}Z') for i in range(1,6)])
        with patch('collector.MAX_USAGE_EVENTS',3):r=self.scan()
        self.assertEqual(r['totals']['requests'],5);self.assertEqual(len(r['usageEvents']),3)
        self.assertEqual(r['coverage']['omittedEvents'],2)
        self.assertEqual(r['coverage']['eventsFrom'],r['usageEvents'][0]['at'])
        self.assertEqual(r['coverage']['eventLimit'],3)

    def test_legacy_timestamp_records_are_unpriced_and_no_activity_publishes_valid_empty_detail(self):
        r=self.scan();self.assertEqual(r['usageEvents'],[]);self.assertEqual(r['coverage']['eventsFrom'],0)
        self.write(prefix()+[legacy(at='2026-10-20T01:00:01.75Z')]);r=self.scan()
        self.assertEqual(len(r['usageEvents']),1);self.assertEqual(r['usageEvents'][0]['legacyRequests'],1)
        self.assertEqual(r['usageEvents'][0]['unpricedRequests'],1)
        self.assertEqual(r['usageEvents'][0]['costUSD'],0)

    def test_full_detail_snapshot_stays_within_server_size_limit(self):
        state=self.c.initial('fixture');state.update(sid='a'*24,tid='b'*24,model='gpt-6.1-sol',tier='standard')
        for i in range(10001):self.c.insert(str(i),state,1792458000+i/1000,usage(),'request')
        r=self.scan();self.assertEqual(len(r['usageEvents']),10000)
        self.assertEqual(r['coverage']['omittedEvents'],1)
        self.assertLess(self.output.stat().st_size,16*1024*1024)

if __name__=='__main__':unittest.main()
