// Inclusive calendar/second selections in the ledger's Asia/Kolkata timezone.
export const TIME_ZONE='Asia/Kolkata';
const DAY=86400000;
const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
const labelFormat=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'});
export const PRESETS=[
 ['15m','Last 15 minutes'],['1h','Last hour'],['24h','Last 24 hours'],
 ['today','Today'],['yesterday','Yesterday'],['7d','Last 7 days'],['30d','Last 30 days'],
 ['90d','Last 90 days'],['this-week','This week'],['last-week','Last week'],
 ['this-month','This month'],['last-month','Last month'],['this-year','This year'],['last-year','Last year'],
 ['all','All time'],['custom','Custom range']
];
export const dateKey=seconds=>dayFormat.format(new Date(seconds*1000));
const stamp=day=>Date.parse(day+'T00:00:00Z');
export const isDate=day=>typeof day==='string'&&/^[1-9]\d{3}-\d{2}-\d{2}$/.test(day)&&
 Number.isFinite(stamp(day))&&new Date(stamp(day)).toISOString().slice(0,10)===day;
export const addDays=(day,count)=>new Date(stamp(day)+count*DAY).toISOString().slice(0,10);
const monthStart=day=>day.slice(0,8)+'01';
function addMonths(day,count){const d=new Date(stamp(monthStart(day)));d.setUTCMonth(d.getUTCMonth()+count);return d.toISOString().slice(0,10);}
export const timeKey=seconds=>new Date(seconds*1000+19800000).toISOString().slice(11,19);
export const isTime=t=>typeof t==='string'&&/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(t);
const instant=(day,time)=>Date.parse(day+'T'+(time.length===5?time+':00':time)+'+05:30')/1000;
export const timestampLabel=seconds=>new Intl.DateTimeFormat('en-GB',{timeZone:TIME_ZONE,day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(seconds*1000));
export const rangeLabel=r=>r.all?'All retained history':r.timed?`${timestampLabel(r.from)} – ${timestampLabel(r.to-1)}`:r.start===r.end?labelFormat.format(new Date(stamp(r.start))):
 `${labelFormat.format(new Date(stamp(r.start)))} – ${labelFormat.format(new Date(stamp(r.end)))}`;
export function resolveRange(selection={preset:'7d'},now=Date.now()){
 const today=dateKey(now/1000),preset=selection.preset;
 let start=today,end=today,unit='days';
 if(['15m','1h','24h'].includes(preset)){
  const to=Math.floor(now/1000)+1,from=to-{'15m':900,'1h':3600,'24h':86400}[preset];
  return {preset,start:dateKey(from),end:dateKey(to-1),from,to,timed:true,all:false,unit:'seconds',span:to-from};
 }
 if(preset==='all')return {preset,start:null,end:today,all:true,unit:'all',span:0};
 if(preset==='yesterday')start=end=addDays(today,-1);
 else if(['7d','30d','90d'].includes(preset))start=addDays(today,1-Number(preset.slice(0,-1)));
 else if(preset==='this-week'||preset==='last-week'){
  start=addDays(today,-((new Date(stamp(today)).getUTCDay()+6)%7));unit='week';
  if(preset==='last-week'){end=addDays(start,-1);start=addDays(start,-7);}
 }else if(preset==='this-month'||preset==='last-month'){
  start=monthStart(today);unit='month';
  if(preset==='last-month'){end=addDays(start,-1);start=addMonths(start,-1);}
 }else if(preset==='this-year'||preset==='last-year'){
  start=today.slice(0,4)+'-01-01';unit='year';
  if(preset==='last-year'){start=String(Number(today.slice(0,4))-1)+'-01-01';end=start.slice(0,4)+'-12-31';}
 }
 else if(preset==='custom'){
  start=selection.start;end=selection.end;
  if(!isDate(start)||!isDate(end))throw new Error('Choose both a start and an end date.');
  if(start>end)throw new Error('The start date must be on or before the end date.');
  if(end>today)throw new Error('Choose dates through today or earlier.');
  if(selection.timed){
   if(!isTime(selection.startTime)||!isTime(selection.endTime))throw new Error('Enter valid start and end times, including hours, minutes and seconds.');
   const from=instant(start,selection.startTime),to=instant(end,selection.endTime)+1;
   if(from>=to)throw new Error('The start date and time must be on or before the end.');
   if(to>Math.floor(now/1000)+1)throw new Error('Choose a time through now or earlier.');
   return {preset,start,end,from,to,timed:true,all:false,unit:'seconds',span:to-from};
  }
  unit=['week','month','year'].includes(selection.unit)?selection.unit:'days';
 }else if(preset!=='today')throw new Error('Choose a reporting period.');
 return {preset,start,end,all:false,timed:false,from:instant(start,'00:00:00'),to:instant(addDays(end,1),'00:00:00'),unit,span:Math.round((stamp(end)-stamp(start))/DAY)+1};
}
export function shiftRange(range,direction,now=Date.now()){
 if(range.all||![1,-1].includes(direction))return null;
 if(range.timed){
  const from=range.from+direction*range.span,to=range.to+direction*range.span;
  if(to>Math.floor(now/1000)+1||!isDate(dateKey(from)))return null;
  return {preset:'custom',timed:true,start:dateKey(from),end:dateKey(to-1),startTime:timeKey(from),endTime:timeKey(to-1)};
 }
 const today=dateKey(now/1000);let start,end;
 if(range.unit==='month'){
  start=addMonths(range.start,direction);end=addDays(addMonths(start,1),-1);
 }else if(range.unit==='year'){
  start=String(Number(range.start.slice(0,4))+direction)+'-01-01';end=start.slice(0,4)+'-12-31';
 }else if(range.unit==='week'){
  start=addDays(range.start,7*direction);end=addDays(start,6);
 }else{
  start=addDays(range.start,range.span*direction);end=addDays(range.end,range.span*direction);
  if(end>today)return null;
 }
 if(!isDate(start)||start>today)return null;
 return {preset:'custom',start,end:end>today?today:end,unit:range.unit};
}
export function chartWindow(range,daily){
 const end=range.end,start=range.start||(daily[0]?.date||end);
 const clipped=addDays(end,-364),begin=start<clipped?clipped:start;
 const dates=[];
 for(let d=begin;d<=end;d=addDays(d,1))dates.push(d);
 return {dates,clipped:begin>start,start:begin,end};
}
