'use strict';
import {PRESETS,dateKey,timeKey,timestampLabel,resolveRange,shiftRange,rangeLabel,chartWindow} from './time-range.mjs';
import {METRICS,zero,plus,selectUsage,timeBuckets} from './usage.mjs';
const $=id=>document.getElementById(id);
const compact=new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1});
const integer=new Intl.NumberFormat('en-US');
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:n<1?4:2}).format(n);
const keys=METRICS;
const prettyModel=s=>s==='codex-auto-review'?'Internal review':s==='unknown'?'Unrecognized model':s==='mixed'?'Multiple models':s.replace('gpt-','GPT-').replace(/-sol$/,' Sol').replace(/-luna$/,' Luna').replace(/-astra$/,' Astra');
const dateLabel=s=>new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Kolkata',month:'short',day:'numeric'}).format(new Date(s+'T00:00:00+05:30'));
const clock=s=>new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Kolkata',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'}).format(new Date(s*1000));
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const svg=(tag,attrs,text)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;};
let csrf=null,report=null,selection={preset:'7d'},view='overview',measure='tokens',filter='all',limit=12,requiredChange=false;
let polling=false;
async function api(url,method='GET',data){
 const headers={};if(method==='POST'){headers['Content-Type']='application/json';if(csrf)headers['X-CSRF-Token']=csrf;}
 const response=await fetch(url,{method,headers,credentials:'same-origin',cache:'no-store',...(data!==undefined?{body:JSON.stringify(data)}:{})});
 const result=await response.json();
 if(!response.ok){if(response.status===401&&url!=='/api/login'&&url!=='/api/password')signedOut();throw new Error(result.error||'The request could not be completed');}
 return result;
}
function signedOut(){csrf=null;report=null;$('range-dialog').close();$('app').hidden=true;$('login-screen').hidden=false;$('turns-body').replaceChildren();$('sessions-body').replaceChildren();$('models-body').replaceChildren();$('model-mix').replaceChildren();$('chart').replaceChildren();}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;setTimeout(()=>{$('toast').hidden=true;},3500);}
async function signedIn(session){
 csrf=session.csrf;requiredChange=session.mustChangePassword;
 if(requiredChange){$('login-screen').hidden=false;$('app').hidden=true;openPassword(true);return;}
 $('login-screen').hidden=true;$('app').hidden=false;
 await refresh();
}
function period(){return selectUsage(report,resolveRange(selection));}
function renderRange(p){
 $('period-select').value=selection.preset;
 $('date-caption').textContent=rangeLabel(p.range);
 $('previous-period').disabled=!shiftRange(p.range,-1);
 $('next-period').disabled=!shiftRange(p.range,1);
 $('custom-range').classList.toggle('active',selection.preset==='custom');
 $('range-history').hidden=!p.incomplete;
 $('range-history').textContent=p.incomplete?(p.range.timed?'Partial time detail. Older usage remains in date totals and All time.':'Partial daily history in this range. All time includes older usage.'):'';
 $('turn-time-note').textContent=p.range.timed?'Usage within the selected times · recorded timestamps':'Turns use their start date; totals use request dates';
}
function chooseRange(next){selection=next;limit=12;render();}
function openRange(){
 const r=resolveRange(selection),today=dateKey(Date.now()/1000);
 $('range-start').max=today;$('range-end').max=today;
 $('range-start').value=r.start||report?.daily[0]?.date||today;$('range-end').value=r.end;
 $('include-time').checked=!!r.timed;$('time-fields').hidden=!r.timed;
 $('range-start-time').value=r.timed?timeKey(r.from):'00:00:00';
 $('range-end-time').value=r.timed?timeKey(r.to-1):r.end===today?timeKey(Date.now()/1000):'23:59:59';
 $('range-error').textContent='';$('range-dialog').showModal();
}
function emptyTable(body,columns,text){const tr=node('tr'),td=node('td','empty-state',text);td.colSpan=columns;tr.append(td);body.replaceChildren(tr);}
function costText(t){return t.pricedRequests?money(t.costUSD)+(t.unpricedRequests?' + unpriced':''):'Unpriced';}
function render(){
 if(!report)return;
 const p=period(),t=p.totals;
 $('metric-cost').textContent=t.pricedRequests?money(t.costUSD):t.requests?'—':'$0.00';
 $('metric-coverage').textContent=t.requests?`${integer.format(t.pricedRequests)} of ${integer.format(t.requests)} requests priced`:'No recorded requests in this period';
 $('metric-tokens').textContent=compact.format(t.total_tokens);
 $('metric-io').textContent=`${compact.format(t.input_tokens)} input · ${compact.format(t.output_tokens)} output`;
 $('metric-cache').textContent=t.input_tokens?(t.cached_input_tokens/t.input_tokens*100).toFixed(1)+'%':'0%';
 $('metric-cached').textContent=`${compact.format(t.cached_input_tokens)} input tokens reused`;
 $('metric-turns').textContent=integer.format(p.range.all?report.coverage.allTurns:p.turns.length);
 $('metric-sessions').textContent=`Across ${p.range.all?report.coverage.allSessions:new Set(p.turns.map(t=>t.session)).size} local sessions${!p.range.all&&report.coverage.omittedTurns?' · retained turns':''}`;
 renderRange(p);
 const age=Math.max(0,Math.round(Date.now()/1000-report.generatedAt));
 $('sync-status').replaceChildren(node('span','status-dot'),document.createTextNode(age>90?`Snapshot ${Math.floor(age/60)}m old`:'Updated just now'));
 let note='Costs are API-equivalent estimates, not subscription charges.';
 if(t.unpricedRequests)note+=` ${integer.format(t.unpricedRequests)} requests have no reliable price and are excluded from the cost subtotal. Their tokens are included.`;
 if(report.coverage.lagBytes)note+=' Some log bytes are awaiting collection.';
 if(report.coverage.malformedLines||report.coverage.oversizedLines||report.coverage.counterResets||report.coverage.unsupportedFiles)note+=' Some source records could not be counted reliably; see Privacy & pricing.';
 if(p.range.timed)note+=' Usage is assigned to each logged timestamp; it does not reconstruct when individual tokens were generated. Legacy batches are assigned to their log timestamp.';
 if(p.incomplete)note+=p.range.timed?' This window reaches beyond available time detail; the displayed subtotal is partial. Older usage remains in date totals and All time.':' This date range reaches beyond available daily history; the displayed subtotal may be incomplete. All time retains the full ledger total.';
 if(p.range.timed&&p.available===false)note+=' Time detail is not ready; refresh after the next collection.';
 $('coverage-note').lastElementChild.textContent=note;
 renderChart(p);renderMix(p);renderTurns(p);renderSessions(p);renderModels(p);renderPrices();
 $('privacy-coverage').textContent=`Current coverage: ${report.coverage.sourceFiles} retained files; ${report.coverage.allSessions} sessions; ${report.coverage.allTurns} turns. ${report.coverage.malformedLines} malformed lines, ${report.coverage.oversizedLines} oversized lines, ${report.coverage.counterResets} ambiguous counter resets, ${report.coverage.unsupportedFiles} unsupported compressed files. Turns belong to individual threads; delegated agents and automatic review have separate rows. ${report.coverage.omittedTurns?report.coverage.omittedTurns+' older turns are outside the detailed list; aggregate totals are retained.':''}`;
}
function renderChart(p){
 const wrap=$('chart');wrap.replaceChildren();
 const metric=measure==='cost'?'costUSD':'total_tokens';
 let grouped,plotted,clipped,granularity='day';
 if(p.range.timed){
  const timeline=timeBuckets(p);plotted=timeline.totals;clipped=timeline.clipped;granularity=timeline.granularity;
  grouped=timeline.buckets.map(b=>({value:b[metric],label:granularity==='day'?dateLabel(dateKey(b.at)):timeKey(b.at).slice(0,granularity==='second'?8:5),description:timestampLabel(b.at)+' – '+timestampLabel(b.endAt)}));
 }else{
  const window=chartWindow(p.range,p.daily);clipped=window.clipped;
  plotted=p.daily.filter(d=>d.date>=window.start&&d.date<=window.end).reduce(plus,zero());
  const buckets=window.dates.map(date=>({date,value:p.daily.find(d=>d.date===date)?.[metric]||0}));
  grouped=[];const step=Math.max(1,Math.ceil(buckets.length/31));
  for(let i=0;i<buckets.length;i+=step){const group=buckets.slice(i,i+step);grouped.push({value:group.reduce((a,b)=>a+b.value,0),label:dateLabel(group[0].date),description:dateLabel(group[0].date)+(group.at(-1).date!==group[0].date?' – '+dateLabel(group.at(-1).date):'')});}
 }
 $('chart-subtitle').textContent=(p.range.timed?'Usage by '+granularity+(measure==='cost'?' · USD estimates':''):(measure==='cost'?'Daily priced subtotal · USD estimates':'A daily view of your token usage'))+(clipped?' · latest 365 days of this range':'');
 $('chart-legend').textContent=measure==='cost'?'API-equivalent cost · priced work':'Input + output tokens';
 $('chart-total').textContent=measure==='cost'?money(plotted.costUSD)+' plotted':compact.format(plotted.total_tokens)+' plotted';
 if(!plotted.requests){wrap.append(node('div','empty-state',p.incomplete?'No retained records available in this range.':clipped?'No recorded activity in the chart’s date window.':'No recorded activity in this period.'));return;}
 const graph=svg('svg',{viewBox:'0 0 600 210',role:'img','aria-label':(p.range.timed?'Recorded ':'Daily ')+(measure==='cost'?'API-equivalent cost chart':'token activity chart')});
 const max=Math.max(...grouped.map(d=>d.value),1),top=15,bottom=180,height=165,left=48,width=535;
 for(let i=0;i<=3;i++){const y=top+i*height/3;graph.append(svg('line',{x1:left,y1:y,x2:590,y2:y,class:'chart-gridline'}),svg('text',{x:0,y:y+3,class:'chart-label'},measure==='cost'?money(max*(3-i)/3):compact.format(max*(3-i)/3)));}
 const gap=width/Math.max(grouped.length,1),bar=Math.min(30,gap*.55);
 grouped.forEach((d,i)=>{const h=d.value/max*height;const rect=svg('rect',{x:left+gap*i+(gap-bar)/2,y:bottom-h,width:bar,height:Math.max(h,1),rx:Math.min(3,bar/3),class:'chart-bar'});rect.append(svg('title',{},`${d.description}: ${measure==='cost'?money(d.value):integer.format(d.value)+' tokens'}`));graph.append(rect);if(i%Math.max(1,Math.ceil(grouped.length/6))===0)graph.append(svg('text',{x:left+gap*i+gap/2,y:204,'text-anchor':'middle',class:'chart-label'},d.label));});wrap.append(graph);
}
function renderMix(p){
 const target=$('model-mix');target.replaceChildren();
 if(!p.models.length){target.append(node('p','empty-state','Your models will appear here.'));return;}
 for(const m of p.models.slice(0,4)){
  const row=node('div'),heading=node('div','model-row-title');heading.append(node('span','',prettyModel(m.model)),node('span','',compact.format(m.total_tokens)));
  const track=node('div','model-track'),bar=svg('svg',{viewBox:'0 0 100 5',preserveAspectRatio:'none','aria-hidden':'true'});bar.append(svg('rect',{x:0,y:0,width:m.total_tokens/p.totals.total_tokens*100,height:5,rx:2.5,fill:m.model==='codex-auto-review'?'#b5a2c6':'#809e64'}));track.append(bar);
  const caption=node('div','model-row-caption');caption.append(node('span','',`${(m.total_tokens/p.totals.total_tokens*100).toFixed(1)}% of tokens`),node('span','',costText(m)));row.append(heading,track,caption);target.append(row);
 }
}
function renderTurns(p){
 const select=$('model-filter'),selected=select.value;
 select.replaceChildren(new Option('All models','all'),...[...new Set([...p.models.map(m=>m.model),...p.turns.map(t=>t.model)])].map(m=>new Option(prettyModel(m),m)));select.value=[...select.options].some(o=>o.value===selected)?selected:'all';filter=select.value;
 const all=p.turns.filter(t=>filter==='all'||t.model===filter),shown=all.slice(0,limit),body=$('turns-body');body.replaceChildren();
 if(!shown.length)emptyTable(body,6,'No turns match this period and model.');
 for(const t of shown){
  const row=node('tr'),first=node('td'),button=node('button','turn-link',`Turn ${t.id.slice(0,6)}`);button.setAttribute('aria-expanded','false');
  first.append(button,node('div','turn-meta',`${clock(t.at)} · ${t.session.slice(0,6)}`));
  const m=node('td');m.append(node('span','model-pill'+(t.role==='Review'?' review':''),prettyModel(t.model)));
  const cost=node('td',t.pricedRequests?'cost-cell':'unpriced',costText(t));
  row.append(first,m,node('td','',compact.format(t.total_tokens)),node('td','',t.input_tokens?(t.cached_input_tokens/t.input_tokens*100).toFixed(0)+'%':'—'),cost,node('td','','↗'));
  const detail=node('tr','detail-row');detail.hidden=true;const td=node('td');td.colSpan=6;const grid=node('div','detail-grid');
  for(const [label,value]of [['Input tokens',integer.format(t.input_tokens)],['Cached input',integer.format(t.cached_input_tokens)],['Cache-write input',integer.format(t.cache_write_input_tokens)],['Output tokens',integer.format(t.output_tokens)],['Reasoning (in output)',integer.format(t.reasoning_output_tokens)],['Model requests',integer.format(t.requests)],[t.windowed?'Tool calls (full turn)':'Tool calls',t.toolCalls===null?'Unavailable':integer.format(t.toolCalls)],[t.windowed?'Duration (full turn)':'Duration',t.durationSeconds===null?'Unavailable':t.durationSeconds>=60?`${(t.durationSeconds/60).toFixed(1)} min`:`${t.durationSeconds.toFixed(1)} sec`],['Speed / reasoning',`${t.tier} / ${t.effort}`],['Accounting',t.legacyRequests?'Legacy cumulative · unpriced':'Recorded request IDs'],['Price coverage',`${t.pricedRequests} of ${t.requests} requests`],['Session',t.session.slice(0,12)],...(t.windowed?[['Usage scope','Selected timestamps'],['First / last usage',clock(t.at)+' / '+clock(t.lastUsageAt)],['Turn started',t.startedAt===null?'Unavailable':clock(t.startedAt)]]:[])]){const cell=node('div');cell.append(node('span','',label),node('strong','',value));grid.append(cell);}td.append(grid);detail.append(td);
  button.addEventListener('click',()=>{detail.hidden=!detail.hidden;button.setAttribute('aria-expanded',String(!detail.hidden));});body.append(row,detail);
 }
 $('turns-caption').textContent=`Showing ${shown.length} of ${all.length} retained turns${report.coverage.omittedTurns?' · older details omitted':''}`;$('more-turns').hidden=limit>=all.length;
}
function renderSessions(p){
 const sessions=new Map();for(const t of p.turns){if(!sessions.has(t.session))sessions.set(t.session,{id:t.session,at:t.at,turns:0,role:t.role,...zero()});const s=sessions.get(t.session);s.turns++;plus(s,t);}
 const body=$('sessions-body');body.replaceChildren();
 for(const s of sessions.values()){const row=node('tr'),first=node('td');first.append(node('strong','',`Session ${s.id.slice(0,8)}`),node('div','turn-meta',`${s.role} · ${clock(s.at)}`));row.append(first,node('td','',s.turns),node('td','',compact.format(s.total_tokens)),node('td','',s.input_tokens?(s.cached_input_tokens/s.input_tokens*100).toFixed(1)+'%':'—'),node('td',s.pricedRequests?'cost-cell':'unpriced',costText(s)));body.append(row);}if(!sessions.size)emptyTable(body,5,'No sessions in this period.');
}
function renderModels(p){
 const body=$('models-body');body.replaceChildren();for(const m of p.models){const row=node('tr');row.append(node('td','',prettyModel(m.model)),node('td','',integer.format(m.requests)),node('td','',compact.format(m.input_tokens)),node('td','',compact.format(m.cached_input_tokens)),node('td','',compact.format(m.output_tokens)),node('td',m.pricedRequests?'cost-cell':'unpriced',costText(m)));body.append(row);}if(!p.models.length)emptyTable(body,6,'No model activity in this period.');
}
function renderPrices(){const body=$('prices-body');body.replaceChildren();for(const [name,p]of Object.entries(report.pricing.models)){const row=node('tr');row.append(node('td','',prettyModel(name)),node('td','',money(p.input)),node('td','',money(p.cached)),node('td','',money(p.output)));body.append(row);}}
async function refresh(){if(polling||!csrf||requiredChange)return;polling=true;const requestedSession=csrf;$('refresh').disabled=true;try{const next=await api('/api/report');if(csrf!==requestedSession)return;report=next;$('global-error').hidden=true;render();}catch(e){if(csrf===requestedSession){$('global-error').textContent=e.message;$('global-error').hidden=false;}}finally{polling=false;$('refresh').disabled=false;}}
function changeView(name){view=name;for(const v of ['overview','sessions','models','privacy'])$('view-'+v).hidden=v!==name;for(const b of document.querySelectorAll('[data-view]'))b.classList.toggle('active',b.dataset.view===name);const titles={overview:['Overview','Your usage, at a glance.','A little visibility into the work happening behind every prompt.'],sessions:['Sessions','Every session, in perspective.','A numeric ledger of your conversations. No conversation content.'],models:['Models','Find your model mix.','Understand which models do the work, and where your tokens go.'],privacy:['Privacy & pricing','Clarity without the content.','Understand exactly what is collected, counted and estimated.']};$('breadcrumb-view').textContent=titles[name][0];$('page-title').textContent=titles[name][1];$('page-subtitle').textContent=titles[name][2];$('range-row').hidden=name==='privacy';$('export').hidden=name==='privacy';}
function openPassword(required=false){requiredChange=required;$('password-title').textContent=required?'Set your personal passphrase':'Change your passphrase';$('cancel-password').hidden=required;$('password-error').textContent='';$('password-dialog').showModal();}
$('password-dialog').addEventListener('cancel',e=>{if(requiredChange)e.preventDefault();});
$('password-button').addEventListener('click',()=>openPassword());$('cancel-password').addEventListener('click',()=>$('password-dialog').close());
$('privacy-password').addEventListener('click',()=>openPassword());
$('privacy-logout').addEventListener('click',()=>$('logout').click());
$('password-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{if($('new-passphrase').value!==$('confirm-passphrase').value)throw new Error('The new passphrases do not match.');const session=await api('/api/password','POST',{current:$('current-passphrase').value,newPassphrase:$('new-passphrase').value});$('password-form').reset();requiredChange=false;$('password-dialog').close();await signedIn(session);toast('Your passphrase was updated.');}catch(e){$('password-error').textContent=e.message;}finally{button.disabled=false;}});
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;$('login-error').textContent='';try{const session=await api('/api/login','POST',{passphrase:$('passphrase').value});$('login-form').reset();await signedIn(session);}catch(e){$('login-error').textContent=e.message;}finally{button.disabled=false;}});
$('logout').addEventListener('click',async()=>{try{await api('/api/logout','POST',{});signedOut();}catch(e){toast(e.message);}});
$('refresh').addEventListener('click',refresh);
for(const b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>changeView(b.dataset.view));
for(const [value,label]of PRESETS)$('period-select').add(new Option(label,value));
$('period-select').value=selection.preset;
$('period-select').addEventListener('change',()=>{const preset=$('period-select').value;if(preset==='custom'){openRange();$('period-select').value=selection.preset;}else chooseRange({preset});});
$('custom-range').addEventListener('click',openRange);
$('cancel-range').addEventListener('click',()=>$('range-dialog').close());
$('include-time').addEventListener('change',()=>{$('time-fields').hidden=!$('include-time').checked;});
$('range-form').addEventListener('submit',e=>{e.preventDefault();try{const next={preset:'custom',start:$('range-start').value,end:$('range-end').value,timed:$('include-time').checked,startTime:$('range-start-time').value,endTime:$('range-end-time').value};resolveRange(next);chooseRange(next);$('range-dialog').close();}catch(error){$('range-error').textContent=error.message;}});
for(const [id,direction]of [['previous-period',-1],['next-period',1]])$(id).addEventListener('click',()=>{const next=shiftRange(resolveRange(selection),direction);if(next)chooseRange(next);});
for(const m of ['tokens','cost'])$('chart-'+m).addEventListener('click',()=>{measure=m;for(const a of ['tokens','cost'])$('chart-'+a).classList.toggle('selected',a===m);if(report)renderChart(period());});
$('model-filter').addEventListener('change',()=>{filter=$('model-filter').value;limit=12;if(report)renderTurns(period());});
$('more-turns').addEventListener('click',()=>{limit+=20;renderTurns(period());});
$('export').addEventListener('click',()=>{if(!report)return;const p=period(),columns=['id','session','at','model','tier','effort','role',...keys,'toolCalls','durationSeconds','scope','lastUsageAt','turnStartedAt'];const rows=p.turns.filter(t=>filter==='all'||t.model===filter);const csv=[columns.join(','),...rows.map(r=>columns.map(k=>k==='at'?new Date(r.at*1000).toISOString():k==='scope'?(r.windowed?'selected-time':'whole-turn'):k==='lastUsageAt'?(r.windowed?new Date(r.lastUsageAt*1000).toISOString():''):k==='turnStartedAt'?(r.startedAt!=null?new Date(r.startedAt*1000).toISOString():''):r[k]).join(','))].join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=node('a');link.href=url;link.download='meter-turns-'+(p.range.all?'all-time':p.range.timed?p.range.start+'T'+timeKey(p.range.from).replaceAll(':','-')+'_'+p.range.end+'T'+timeKey(p.range.to-1).replaceAll(':','-')+'-IST':p.range.start+'_'+p.range.end)+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
setInterval(()=>{if(!document.hidden&&csrf&&!requiredChange)refresh();},30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&csrf)refresh();});
api('/api/session').then(s=>{if(s.authenticated)signedIn(s);}).catch(()=>{$('login-error').textContent='Unable to connect. Please try again.';});
