import test from 'node:test';
import assert from 'node:assert/strict';
import {selectUsage,timeBuckets,zero} from '../public/usage.mjs';
import {resolveRange} from '../public/time-range.mjs';
const now=Date.parse('2026-10-20T12:00:00+05:30'),at=Date.parse('2026-10-20T10:00:00+05:30')/1000;
const event=(offset,tokens,extra={})=>({at:at+offset,session:'a'.repeat(24),turn:'b'.repeat(24),model:'gpt-6.1-sol',tier:'standard',effort:'high',role:'Codex',...zero(),requests:1,pricedRequests:1,total_tokens:tokens,input_tokens:tokens,costUSD:tokens/1000,...extra});
function fixture(){return {totals:{...zero(),requests:4,total_tokens:10000},models:[],daily:[],turns:[{id:'b'.repeat(24),at:at-300,toolCalls:7,durationSeconds:600}],coverage:{eventDetailsVersion:1,omittedEvents:0},usageEvents:[event(-.001,1000),event(0,2000),event(.999,3000),event(1,4000)]};}
const range=(startTime='10:00:00',endTime=startTime)=>resolveRange({preset:'custom',timed:true,start:'2026-10-20',end:'2026-10-20',startTime,endTime},now);
test('fractional boundaries count only selected request records, including a turn started earlier',()=>{
 const p=selectUsage(fixture(),range());assert.equal(p.totals.total_tokens,5000);assert.equal(p.totals.requests,2);
 assert.equal(p.turns.length,1);assert.equal(p.turns[0].total_tokens,5000);assert.equal(p.turns[0].startedAt,at-300);
 assert.equal(p.turns[0].at,at);assert.equal(p.turns[0].lastUsageAt,at+.999);assert.equal(p.turns[0].toolCalls,7);
 assert.equal(p.models[0].total_tokens,5000);assert.equal(p.incomplete,false);
 const plot=timeBuckets(p);assert.equal(plot.buckets.length,1);assert.equal(plot.totals.total_tokens,5000);assert.equal(plot.granularity,'second');
});
test('partial cutoff at a tied timestamp is disclosed, while later windows are complete',()=>{
 const f=fixture();f.coverage.omittedEvents=3;f.coverage.eventsFrom=at;
 assert.equal(selectUsage(f,range()).incomplete,true);
 assert.equal(selectUsage(f,range('10:00:01')).incomplete,false);
 assert.equal(selectUsage({...f,usageEvents:[]},range('09:00:00')).incomplete,true);
});
test('legacy and unknown models stay unpriced; mixed-model turns do not duplicate totals',()=>{
 const f=fixture();f.usageEvents[2]=event(.999,3000,{model:'unknown',pricedRequests:0,unpricedRequests:1,legacyRequests:1,costUSD:0});
 const p=selectUsage(f,range());assert.equal(p.totals.costUSD,2);assert.equal(p.totals.unpricedRequests,1);
 assert.equal(p.turns[0].model,'mixed');assert.equal(p.models.length,2);assert.equal(p.turns[0].total_tokens,5000);
});
test('missing detail fails visibly and missing turn metadata remains unknown rather than zero',()=>{
 const f=fixture();f.turns=[];const p=selectUsage(f,range());assert.equal(p.turns[0].toolCalls,null);assert.equal(p.turns[0].durationSeconds,null);
 delete f.coverage.eventDetailsVersion;f.usageEvents=[];assert.equal(selectUsage(f,range()).available,false);assert.equal(selectUsage(f,range()).incomplete,true);
});
test('date and all-time paths preserve original aggregates independently of retained events',()=>{
 const f=fixture();f.daily=[{date:'2026-10-20',...zero(),total_tokens:12345,models:[]}];
 assert.equal(selectUsage(f,resolveRange({preset:'today'},now)).totals.total_tokens,12345);
 assert.equal(selectUsage(f,resolveRange({preset:'all'},now)).totals.total_tokens,10000);
});
test('chart switches second/minute/hour/day buckets without losing selected totals',()=>{
 const f=fixture();for(const [seconds,granularity]of [[60,'second'],[3600,'minute'],[86400,'hour'],[864000,'day']]){
  const p=selectUsage(f,{...range(),from:at,to:at+seconds});const plot=timeBuckets(p);
  assert.equal(plot.granularity,granularity);assert.equal(plot.totals.total_tokens,9000);
  assert.equal(plot.buckets.reduce((n,b)=>n+b.total_tokens,0),9000);assert.ok(plot.buckets.length<=365);
 }
 const clipped=timeBuckets({...selectUsage(f,range()),range:{...range(),from:at-500*86400,to:at+2}});
 assert.equal(clipped.clipped,true);assert.ok(clipped.buckets.length<=365);
});
