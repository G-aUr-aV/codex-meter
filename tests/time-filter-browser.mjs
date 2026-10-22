// Known amounts straddle Kolkata midnight. The browser deliberately uses LA time.
const {chromium}=await import(process.env.METER_PLAYWRIGHT_MODULE||'@playwright/test');
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp,hashPassphrase} from '../server.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=await mkdtemp(path.join(tmpdir(),'meter-time-browser-'));
const now=Date.parse('2026-10-20T12:00:00+05:30'),pass='invented fixture passphrase only',model='gpt-6.1-sol';
const id=n=>n.toString(16).padStart(24,'0');
const amount=n=>({input_tokens:n-100,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:100,reasoning_output_tokens:0,total_tokens:n,requests:1,pricedRequests:1,unpricedRequests:0,legacyRequests:0,costUSD:n/1000});
const rows=[['2026-09-30',9000],['2026-10-01',8000],['2026-10-07',1000],['2026-10-13',2000],['2026-10-14',3000],['2026-10-18',4000],['2026-10-19',5000],['2026-10-20',6000],['2026-10-20',7000]];
const turns=rows.map(([date,tokens],i)=>({id:id(i+1),session:id(i+100),at:Date.parse(i===6?'2026-10-19T18:29:59Z':i===7?'2026-10-19T18:30:00Z':date+'T12:00:00+05:30')/1000,model:i===8?'gpt-6-luna':model,tier:'standard',effort:'high',role:'Codex',toolCalls:1,durationSeconds:1,...amount(tokens)})).reverse();
const usageEvents=turns.filter(t=>t.id!==id(9)).map(t=>({...t,turn:t.id}));
const split=turns.find(t=>t.id===id(9)),end=split.at;
split.at-=600;split.input_tokens-=100;split.output_tokens+=100;split.requests=split.pricedRequests=2;
usageEvents.push({...split,...amount(3000),turn:split.id,at:end-.001},{...split,...amount(4000),turn:split.id,at:end});
usageEvents.sort((a,b)=>a.at-b.at);
const sum=entries=>Object.fromEntries(Object.keys(amount(1000)).map(k=>[k,entries.reduce((n,r)=>n+r[k],0)]));
const daily=[...new Set(rows.map(r=>r[0]))].map(date=>{
 const entries=turns.filter(t=>rows[Number.parseInt(t.id,16)-1][0]===date);
 return {date,...sum(entries),models:[...new Set(entries.map(t=>t.model))].map(model=>({model,...sum(entries.filter(t=>t.model===model))}))};
});
const report={version:1,generatedAt:now/1000,totals:sum(turns),daily,models:[{model,...sum(turns.filter(t=>t.model===model))},{model:'gpt-6-luna',...sum([split])}],turns,sessions:[],usageEvents,coverage:{allTurns:9,allSessions:9,eventDetailsVersion:1,eventLimit:10000,omittedEvents:0,eventsFrom:usageEvents[0].at},pricing:{models:{}}};
await writeFile(dir+'/auth.json',JSON.stringify(await hashPassphrase(pass)),{mode:0o600});
await writeFile(dir+'/report.json',JSON.stringify(report));
const app=await createApp({stateDir:dir,reportFile:dir+'/report.json',origins:['http://127.0.0.1:4320'],insecureLocal:true});
await new Promise(r=>app.listen(4320,'127.0.0.1',r));const origin='http://127.0.0.1:4320';
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100},timezoneId:'America/Los_Angeles'}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const setPreset=preset=>page.getByLabel('Reporting period',{exact:true}).selectOption(preset);
const assertMetric=async(tokens,cost,count)=>{
 assert.equal(await page.locator('#metric-tokens').textContent(),tokens);
 assert.equal(await page.locator('#metric-cost').textContent(),cost);
 assert.equal(await page.locator('#metric-turns').textContent(),String(count));
};
const apply=async(start,end)=>{
 await page.locator('#custom-range').click();await page.getByLabel('Start date',{exact:true}).fill(start);await page.getByLabel('End date',{exact:true}).fill(end);await page.getByRole('button',{name:'Apply dates',exact:true}).click();
};
try{
 await page.clock.setFixedTime(new Date(now));
 await page.goto(origin);await page.getByLabel('Passphrase',{exact:true}).fill(pass);await page.getByRole('button',{name:'Open your dashboard'}).click();await page.locator('#app').waitFor({state:'visible'});await page.locator('#metric-tokens').filter({hasText:'25K'}).waitFor();
 await assertMetric('25K','$25.00',5);assert.equal(await page.locator('#next-period').isDisabled(),true);
 for(const [preset,tokens,cost,count]of [['today','13K','$13.00',2],['yesterday','5K','$5.00',1],['this-week','18K','$18.00',3],['last-week','9K','$9.00',3],['this-month','36K','$36.00',8],['last-month','9K','$9.00',1],['30d','45K','$45.00',9],['90d','45K','$45.00',9],['this-year','45K','$45.00',9],['last-year','0','$0.00',0],['all','45K','$45.00',9]]){
  await setPreset(preset);await assertMetric(tokens,cost,count);
 }
 assert.equal(await page.locator('#previous-period').isDisabled(),true);
 await setPreset('this-month');await page.locator('#previous-period').click();await assertMetric('9K','$9.00',1);assert.match(await page.locator('#date-caption').textContent(),/Sep 1, 2026.*Sep 30, 2026/);await page.locator('#next-period').click();await assertMetric('36K','$36.00',8);
 await setPreset('7d');await page.locator('#previous-period').click();await assertMetric('3K','$3.00',2);await page.locator('#next-period').click();await assertMetric('25K','$25.00',5);
 await apply('2026-10-13','2026-10-19');await assertMetric('14K','$14.00',4);assert.match(await page.locator('#date-caption').textContent(),/Oct 13, 2026.*Oct 19, 2026/);
 await page.locator('[data-view="sessions"]').click();assert.equal(await page.locator('#sessions-body tr').count(),4);
 await page.locator('[data-view="models"]').click();assert.equal(await page.locator('#models-body tr').count(),1);assert.equal(await page.locator('#models-body td').nth(2).textContent(),'13.6K');assert.equal(await page.locator('#models-body td').nth(4).textContent(),'400');assert.equal(await page.locator('#models-body td').nth(5).textContent(),'$14.00');
 await page.locator('[data-view="overview"]').click();assert.equal(await page.locator('#turns-body .turn-link').count(),4);assert.equal(await page.locator('#chart rect.chart-bar').count(),7);
 const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadPromise;
 assert.equal(download.suggestedFilename(),'meter-turns-2026-10-13_2026-10-19.csv');
 const stream=await download.createReadStream();let csv='';for await(const chunk of stream)csv+=chunk;
 const exported=csv.trim().split('\r\n');assert.equal(exported.length,5);assert.equal(exported.slice(1).reduce((n,line)=>n+Number(line.split(',')[12]),0),14000);
 await page.locator('#custom-range').click();await page.getByLabel('Start date',{exact:true}).fill('2026-10-01');await page.getByRole('button',{name:'Cancel',exact:true}).click();await assertMetric('14K','$14.00',4);
 await apply('2026-10-20','2026-10-19');assert.match(await page.locator('#range-error').textContent(),/start date/);await assertMetric('14K','$14.00',4);await page.locator('#cancel-range').click();
 await apply('','2026-10-19');assert.match(await page.locator('#range-error').textContent(),/both/);await page.locator('#cancel-range').click();
 await apply('2026-10-19','2026-10-21');assert.match(await page.locator('#range-error').textContent(),/today/);await page.locator('#cancel-range').click();
 await apply('2026-09-01','2026-09-01');await assertMetric('0','$0.00',0);assert.match(await page.locator('#date-caption').textContent(),/Sep 1, 2026/);assert.match(await page.locator('#chart').textContent(),/No recorded activity/);
 await apply('2020-01-01','2026-10-20');await assertMetric('45K','$45.00',9);assert.match(await page.locator('#chart-subtitle').textContent(),/latest 365 days/);
 // Simulate an older aggregate outside the published daily window.
 report.totals.total_tokens+=90000;report.totals.requests+=1;
 await writeFile(dir+'/report.json',JSON.stringify(report));await new Promise(r=>setTimeout(r,5100));await page.locator('#refresh').click();await page.locator('#range-history').waitFor({state:'visible'});assert.match(await page.locator('#coverage-note').textContent(),/incomplete/);
 await setPreset('all');assert.equal(await page.locator('#metric-tokens').textContent(),'135K');assert.equal(await page.locator('#range-history').isHidden(),true);
 await setPreset('7d');await mkdir(root+'artifacts',{recursive:true});
 await page.screenshot({path:root+'artifacts/time-filters-desktop.png',fullPage:true});
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1&&e.getBoundingClientRect().width).map(e=>e.tagName+'#'+e.id+'.'+e.className).slice(0,10))));
  await page.locator('#custom-range').click();assert.equal(await page.locator('#range-dialog').isVisible(),true);
  const box=await page.locator('#range-dialog').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
  assert.equal(await page.locator('#range-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  if(width===390)await page.screenshot({path:root+'artifacts/time-filters-mobile-dialog.png'});
  await page.keyboard.press('Escape');assert.equal(await page.locator('#range-dialog').isHidden(),true);
 }
 await page.setViewportSize({width:390,height:844});await apply('2026-10-19','2026-10-20');await assertMetric('18K','$18.00',3);
 // Fine timestamp regressions use a turn that starts ten minutes before its usage.
 for(const preset of ['15m','1h']){await setPreset(preset);await assertMetric('7K','$7.00',1);}
 await setPreset('24h');await assertMetric('18K','$18.00',3);
 const applyTime=async(startTime,endTime)=>{
  await page.locator('#custom-range').click();await page.getByLabel('Start date',{exact:true}).fill('2026-10-20');await page.getByLabel('End date',{exact:true}).fill('2026-10-20');await page.locator('#include-time').check();await page.getByLabel('Start time',{exact:true}).fill(startTime);await page.getByLabel('End time',{exact:true}).fill(endTime);await page.getByRole('button',{name:'Apply dates',exact:true}).click();
 };
 await applyTime('11:59:59','11:59:59');await assertMetric('3K','$3.00',1);assert.match(await page.locator('#date-caption').textContent(),/11:59:59/);assert.match(await page.locator('#turn-time-note').textContent(),/selected times/);
 await page.locator('#turns-body .turn-link').first().click();assert.match(await page.locator('.detail-row').textContent(),/Selected timestamps/);assert.match(await page.locator('.detail-row').textContent(),/11:50:00/);
 await page.locator('[data-view="sessions"]').click();assert.match(await page.locator('#sessions-body').textContent(),/3K/);await page.locator('[data-view="models"]').click();assert.match(await page.locator('#models-body').textContent(),/\$3.00/);await page.locator('[data-view="overview"]').click();
 const fineDownloadPromise=page.waitForEvent('download');await page.locator('#export').click();const fineDownload=await fineDownloadPromise;
 assert.equal(fineDownload.suggestedFilename(),'meter-turns-2026-10-20T11-59-59_2026-10-20T11-59-59-IST.csv');
 const fineStream=await fineDownload.createReadStream();let fineCSV='';for await(const chunk of fineStream)fineCSV+=chunk;
 const [header,line]=fineCSV.trim().split('\r\n').map(s=>s.split(','));assert.equal(Number(line[header.indexOf('total_tokens')]),3000);assert.equal(line[header.indexOf('scope')],'selected-time');
 await page.locator('#previous-period').click();await assertMetric('0','$0.00',0);await page.locator('#next-period').click();await assertMetric('3K','$3.00',1);
 await applyTime('12:00:00','12:00:00');await assertMetric('4K','$4.00',1);assert.equal(await page.locator('#next-period').isDisabled(),true);
 await applyTime('11:59:59','12:00:00');await assertMetric('7K','$7.00',1);assert.match(await page.locator('#chart-subtitle').textContent(),/second/);assert.equal(await page.locator('#chart rect.chart-bar').count(),2);
 await page.locator('#chart-cost').click();assert.match(await page.locator('#chart-total').textContent(),/\$7.00/);await page.locator('#chart-tokens').click();
 await applyTime('12:00:00','11:59:59');assert.match(await page.locator('#range-error').textContent(),/start date and time/);await page.locator('#cancel-range').click();await assertMetric('7K','$7.00',1);
 await applyTime('11:59:59','12:00:01');assert.match(await page.locator('#range-error').textContent(),/now/);await page.locator('#cancel-range').click();
 await applyTime('','12:00:00');assert.match(await page.locator('#range-error').textContent(),/valid start and end/);await page.locator('#cancel-range').click();
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});await page.locator('#custom-range').click();assert.equal(await page.locator('#time-fields').isVisible(),true);
  assert.equal(await page.locator('#range-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(width===390)await page.screenshot({path:root+'artifacts/seconds-mobile-dialog.png'});
  await page.keyboard.press('Escape');
 }
 await page.setViewportSize({width:1440,height:1100});await page.screenshot({path:root+'artifacts/seconds-desktop.png',fullPage:true});
 // Missing detail, partial data and refresh failures stay visible and recover.
 await page.route(origin+'/api/report',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture snapshot unavailable'})}),{times:1});
 await page.locator('#refresh').click();await page.locator('#global-error').waitFor({state:'visible'});await assertMetric('7K','$7.00',1);
 await page.locator('#refresh').click();await page.locator('#global-error').waitFor({state:'hidden'});
 const fakeReport=async data=>{await page.route(origin+'/api/report',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(data)}),{times:1});await page.locator('#refresh').click();await page.waitForFunction(()=>!document.getElementById('refresh').disabled);};
 await fakeReport({...report,usageEvents:[usageEvents.at(-1)],coverage:{...report.coverage,omittedEvents:9,eventsFrom:end}});await assertMetric('4K','$4.00',1);assert.equal(await page.locator('#range-history').isVisible(),true);
 await fakeReport({...report,usageEvents:[],coverage:{...report.coverage,eventDetailsVersion:0}});await assertMetric('0','$0.00',0);assert.match(await page.locator('#coverage-note').textContent(),/not ready/);
 await page.locator('#refresh').click();await page.locator('#range-history').waitFor({state:'hidden'});await assertMetric('7K','$7.00',1);
 const unknown={...usageEvents.at(-1),model:'unknown',tier:'unknown',pricedRequests:0,unpricedRequests:1,costUSD:0,legacyRequests:1};
 await fakeReport({...report,usageEvents:[unknown],turns:[]});assert.equal(await page.locator('#metric-cost').textContent(),'—');await page.locator('#turns-body .turn-link').first().click();assert.match(await page.locator('.detail-row').textContent(),/Unavailable/);assert.match(await page.locator('.detail-row').textContent(),/Legacy cumulative/);
 await page.locator('#refresh').click();await page.locator('#metric-cost').filter({hasText:'$7.00'}).waitFor();
 await setPreset('7d');await assertMetric('25K','$25.00',5); // original date behavior survives the time mode
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2,timezoneId:'Asia/Kolkata'}),phone=await mobile.newPage();
 try{
  phone.on('pageerror',e=>errors.push(e.message));await phone.clock.setFixedTime(new Date(now));await phone.goto(origin);
  await phone.getByLabel('Passphrase',{exact:true}).fill(pass);await phone.getByRole('button',{name:'Open your dashboard'}).tap();await phone.locator('#metric-tokens').filter({hasText:'25K'}).waitFor();
  await phone.locator('#custom-range').tap();await phone.getByLabel('Start date',{exact:true}).fill('2026-10-20');await phone.getByLabel('End date',{exact:true}).fill('2026-10-20');await phone.locator('#include-time').check();
  await phone.getByLabel('Start time',{exact:true}).fill('11:59:59');await phone.getByLabel('End time',{exact:true}).fill('11:59:59');await phone.getByRole('button',{name:'Apply dates',exact:true}).tap();
  assert.equal(await phone.locator('#metric-tokens').textContent(),'3K');assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await mobile.close();}
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['all presets in a different device timezone','midnight boundary inclusion','calendar and rolling navigation','inclusive custom dates','metrics/models/sessions/chart/CSV agree','draft cancellation','invalid and future ranges','empty range keeps dates','long-range chart clipping','partial-history disclosure','all-time aggregate preserved','320px/390px dialog and mobile apply','timed presets','fractional end-second boundaries','partial-turn scope and CSV','second navigation','invalid/future times','timed mobile dialog','return to original date behavior','no script errors'],ownerDataUsed:false}));
}finally{await browser.close();await new Promise(r=>app.close(r));await rm(dir,{recursive:true,force:true});}
