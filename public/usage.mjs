import {dateKey} from './time-range.mjs';
export const METRICS=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens','requests','pricedRequests','unpricedRequests','costUSD','legacyRequests'];
export const zero=()=>Object.fromEntries(METRICS.map(k=>[k,0]));
export const plus=(a,b)=>{for(const k of METRICS)a[k]+=(b[k]||0);return a;};
export function selectUsage(report,range){
 const daily=report.daily.filter(d=>(!range.start||d.date>=range.start)&&d.date<=range.end);
 if(!range.timed){
  const models=new Map();for(const d of daily)for(const m of d.models){if(!models.has(m.model))models.set(m.model,{model:m.model,...zero()});plus(models.get(m.model),m);}
  return {range,daily,totals:range.all?report.totals:daily.reduce(plus,zero()),
   models:(range.all?[...report.models]:[...models.values()]).sort((a,b)=>b.total_tokens-a.total_tokens),
   turns:report.turns.filter(t=>(!range.start||dateKey(t.at)>=range.start)&&dateKey(t.at)<=range.end),
   incomplete:!range.all&&report.daily.reduce((n,d)=>n+d.requests,0)<report.totals.requests&&(!report.daily.length||range.start<report.daily[0].date)};
 }
 const available=report.coverage.eventDetailsVersion===1;
 const events=(report.usageEvents||[]).filter(e=>e.at>=range.from&&e.at<range.to);
 const totals=zero(),models=new Map(),turns=new Map(),metadata=new Map(report.turns.map(t=>[t.id,t]));
 for(const e of events){
  plus(totals,e);if(!models.has(e.model))models.set(e.model,{model:e.model,...zero()});plus(models.get(e.model),e);
  if(!turns.has(e.turn)){
   const meta=metadata.get(e.turn);
   turns.set(e.turn,{id:e.turn,session:e.session,at:e.at,lastUsageAt:e.at,startedAt:meta?.at??null,model:e.model,tier:e.tier,effort:e.effort,role:e.role,
    toolCalls:meta?.toolCalls??null,durationSeconds:meta?.durationSeconds??null,windowed:true,...zero()});
  }
  const t=turns.get(e.turn);plus(t,e);t.at=Math.min(t.at,e.at);t.lastUsageAt=Math.max(t.lastUsageAt,e.at);
  if(t.model!==e.model)t.model='mixed';if(t.tier!==e.tier)t.tier='unknown';if(t.effort!==e.effort)t.effort='unknown';
 }
 return {range,daily:[],events,totals,available,models:[...models.values()].sort((a,b)=>b.total_tokens-a.total_tokens),turns:[...turns.values()].sort((a,b)=>b.at-a.at),
  incomplete:!available||(report.coverage.omittedEvents>0&&range.from<=report.coverage.eventsFrom)};
}
export function timeBuckets(period){
 const r=period.range,clipped=r.to-r.from>365*86400,start=Math.max(r.from,r.to-365*86400),span=r.to-start;
 const step=span<=120?1:span<=7200?60:span<=172800?3600:86400;
 const buckets=Array.from({length:Math.ceil(span/step)},(_,i)=>({at:start+i*step,endAt:Math.min(start+(i+1)*step,r.to)-1,...zero()}));
 const totals=zero();for(const e of period.events){if(e.at<start)continue;plus(buckets[Math.floor((e.at-start)/step)],e);plus(totals,e);}
 return {buckets,totals,clipped,granularity:step===1?'second':step===60?'minute':step===3600?'hour':'day'};
}
