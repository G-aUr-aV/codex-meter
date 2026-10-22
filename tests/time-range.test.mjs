import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRange,shiftRange,dateKey,isDate,chartWindow,timeKey} from '../public/time-range.mjs';
const at=day=>Date.parse(day+'T12:00:00+05:30');
const dates=r=>[r.start,r.end];
test('the ledger day changes at Kolkata midnight regardless of device timezone',()=>{
 assert.equal(dateKey(Date.parse('2026-10-19T18:29:59Z')/1000),'2026-10-19');
 assert.equal(dateKey(Date.parse('2026-10-19T18:30:00Z')/1000),'2026-10-20');
 assert.deepEqual(dates(resolveRange({preset:'today'},Date.parse('2026-10-19T18:30:00Z'))),['2026-10-20','2026-10-20']);
});
test('rolling calendar days include today and cross year boundaries',()=>{
 assert.deepEqual(dates(resolveRange({preset:'7d'},at('2026-01-03'))),['2025-12-28','2026-01-03']);
 assert.deepEqual(dates(resolveRange({preset:'30d'},at('2026-10-20'))),['2026-09-21','2026-10-20']);
 assert.equal(resolveRange({preset:'90d'},at('2026-10-20')).span,90);
 assert.deepEqual(dates(resolveRange({preset:'yesterday'},at('2026-01-01'))),['2025-12-31','2025-12-31']);
});
test('weeks start Monday, with a complete preceding week',()=>{
 assert.deepEqual(dates(resolveRange({preset:'this-week'},at('2026-10-20'))),['2026-10-19','2026-10-20']);
 assert.deepEqual(dates(resolveRange({preset:'last-week'},at('2026-10-19'))),['2026-10-12','2026-10-18']);
 assert.deepEqual(dates(resolveRange({preset:'this-week'},at('2026-10-25'))),['2026-10-19','2026-10-25']);
});
test('calendar months and years handle January and leap February',()=>{
 assert.deepEqual(dates(resolveRange({preset:'last-month'},at('2024-03-15'))),['2024-02-01','2024-02-29']);
 assert.deepEqual(dates(resolveRange({preset:'last-month'},at('2026-01-01'))),['2025-12-01','2025-12-31']);
 assert.deepEqual(dates(resolveRange({preset:'this-month'},at('2026-10-20'))),['2026-10-01','2026-10-20']);
 assert.deepEqual(dates(resolveRange({preset:'this-year'},at('2026-10-20'))),['2026-01-01','2026-10-20']);
 assert.deepEqual(dates(resolveRange({preset:'last-year'},at('2026-01-01'))),['2025-01-01','2025-12-31']);
});
test('custom ranges include both ends; incomplete, reversed, invalid and future dates are rejected',()=>{
 const now=at('2026-10-20');
 assert.equal(resolveRange({preset:'custom',start:'2024-02-29',end:'2024-02-29'},now).span,1);
 for(const range of [{start:'',end:'2026-10-20'},{start:'2026-02-30',end:'2026-10-20'},
  {start:'2026-10-20',end:'2026-10-19'},{start:'2026-10-20',end:'2026-10-21'}])
  assert.throws(()=>resolveRange({preset:'custom',...range},now));
 assert.equal(isDate('2024-02-29'),true);assert.equal(isDate('2026-02-29'),false);
});
test('relative presets advance across midnight while custom dates stay fixed',()=>{
 assert.notDeepEqual(dates(resolveRange({preset:'7d'},at('2026-10-20'))),dates(resolveRange({preset:'7d'},at('2026-10-21'))));
 const selected={preset:'custom',start:'2026-10-01',end:'2026-10-10'};
 assert.deepEqual(dates(resolveRange(selected,at('2026-10-20'))),dates(resolveRange(selected,at('2026-10-21'))));
});
test('previous and next rolling/custom periods keep their length and cannot move into the future',()=>{
 const now=at('2026-10-20'),current=resolveRange({preset:'7d'},now),previous=shiftRange(current,-1,now);
 assert.deepEqual([previous.start,previous.end],['2026-10-07','2026-10-13']);
 assert.deepEqual(dates(resolveRange(shiftRange(resolveRange(previous,now),1,now),now)),dates(current));
 assert.equal(shiftRange(current,1,now),null);
 assert.equal(shiftRange(resolveRange({preset:'all'},now),-1,now),null);
});
test('calendar navigation preserves month/week/year boundaries and clamps the current period to today',()=>{
 const now=at('2024-03-15'),month=resolveRange({preset:'this-month'},now),previous=shiftRange(month,-1,now);
 assert.deepEqual([previous.start,previous.end],['2024-02-01','2024-02-29']);
 const back=resolveRange(shiftRange(resolveRange(previous,now),1,now),now);
 assert.deepEqual(dates(back),['2024-03-01','2024-03-15']);assert.equal(shiftRange(back,1,now),null);
 const week=shiftRange(resolveRange({preset:'this-week'},at('2026-10-20')),-1,at('2026-10-20'));
 assert.deepEqual([week.start,week.end],['2026-10-12','2026-10-18']);
 const year=shiftRange(resolveRange({preset:'this-year'},now),-1,now);
 assert.deepEqual([year.start,year.end],['2023-01-01','2023-12-31']);
});
test('long custom/all-time charts show the latest 365 calendar days rather than the first empty year',()=>{
 const r=resolveRange({preset:'custom',start:'2020-01-01',end:'2026-10-20'},at('2026-10-20'));
 const plot=chartWindow(r,[]);assert.equal(plot.dates.length,365);assert.equal(plot.dates.at(-1),'2026-10-20');assert.equal(plot.clipped,true);
 const one=chartWindow(resolveRange({preset:'yesterday'},at('2026-10-20')),[]);
 assert.deepEqual(one.dates,['2026-10-19']);assert.equal(one.clipped,false);
});
test('second selections include the complete end second and parse IST independently of the device',()=>{
 const r=resolveRange({preset:'custom',timed:true,start:'2026-10-20',end:'2026-10-20',startTime:'00:00:00',endTime:'00:00:00'},at('2026-10-20'));
 assert.equal(r.from,Date.parse('2026-10-19T18:30:00Z')/1000);assert.equal(r.to-r.from,1);
 assert.equal(timeKey(r.from),'00:00:00');
 const minute=resolveRange({preset:'custom',timed:true,start:'2026-10-20',end:'2026-10-20',startTime:'10:30',endTime:'10:31'},at('2026-10-20'));
 assert.equal(minute.to-minute.from,61);
});
test('timed presets are exact rolling windows; navigation preserves seconds across midnight',()=>{
 const now=Date.parse('2026-10-20T00:00:10.500+05:30');
 for(const [preset,span]of [['15m',900],['1h',3600],['24h',86400]]){
  const r=resolveRange({preset},now);assert.equal(r.to-r.from,span);assert.equal(r.to,Math.floor(now/1000)+1);
  const previous=resolveRange(shiftRange(r,-1,now),now);assert.equal(previous.to,r.from);assert.equal(previous.span,span);
  assert.equal(shiftRange(r,1,now),null);
 }
});
test('invalid, reversed and future times leave the last valid selection available',()=>{
 const base={preset:'custom',timed:true,start:'2026-10-20',end:'2026-10-20',startTime:'10:00:00',endTime:'10:00:00'};
 for(const extra of [{startTime:''},{endTime:'24:00:00'},{endTime:'10:60:00'},{endTime:'10:00:60'},{startTime:'10:00:01'},{endTime:'12:00:01'}])
  assert.throws(()=>resolveRange({...base,...extra},at('2026-10-20')));
 assert.equal(resolveRange(base,at('2026-10-20')).span,1);
});
