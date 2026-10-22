// Browser QA uses only invented data and fixture credentials, never owner data.
const {chromium}=await import(process.env.METER_PLAYWRIGHT_MODULE||'@playwright/test');
import {mkdtemp,writeFile,rm,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createApp,hashPassphrase} from '../server.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=await mkdtemp(path.join(tmpdir(),'meter-browser-'));
const origin='http://127.0.0.1:4319';
const fixturePass='fixture only private dashboard passphrase';
const key=i=>i.toString(16).padStart(24,'0');
const base={input_tokens:120000,cached_input_tokens:100000,cache_write_input_tokens:0,output_tokens:4000,reasoning_output_tokens:2000,total_tokens:124000,requests:8,pricedRequests:8,unpricedRequests:0,costUSD:.128,legacyRequests:0};
const now=Date.now()/1000,turns=[];
for(let i=0;i<24;i++)turns.push({id:key(i+1),session:key(Math.floor(i/4)+100),at:now-i*3600,model:i%3?'gpt-6.1-sol':'gpt-6-luna',tier:'standard',effort:'high',role:'Codex',toolCalls:7,durationSeconds:125,...base});
const daily=[];for(let i=6;i>=0;i--){const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date((now-i*86400)*1000));const factor=[5,9,4,12,15,8,11][i];const m={...Object.fromEntries(Object.entries(base).map(([k,v])=>[k,v*factor])),model:'gpt-6.1-sol'};daily.push({date,...m,models:[m]});}
const report={version:1,generatedAt:now,timezone:'Asia/Kolkata',totals:base,daily,models:[],sessions:[],turns,coverage:{sourceFiles:7,allSessions:6,allTurns:24,lagBytes:0},pricing:JSON.parse(await readFile(root+'pricing.json','utf8'))};
await writeFile(dir+'/auth.json',JSON.stringify(await hashPassphrase(fixturePass,true)),{mode:0o600});
await writeFile(dir+'/report.json',JSON.stringify(report));
const app=await createApp({stateDir:dir,reportFile:dir+'/report.json',origins:[origin],insecureLocal:true});
await new Promise(r=>app.listen(4319,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1100},deviceScaleFactor:1});
const page=await context.newPage(),errors=[],outbound=[];
page.on('pageerror',e=>errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('401'))errors.push(m.text());});
page.on('request',r=>{if(!r.url().startsWith(origin))outbound.push(new URL(r.url()).hostname);});
try{
 assert.equal((await context.request.get(origin+'/api/report')).status(),401);
 await page.goto(origin);await page.getByLabel('Passphrase',{exact:true}).fill(fixturePass);await page.getByRole('button',{name:'Open your dashboard'}).click();
 await page.locator('#password-dialog').waitFor({state:'visible'});assert.match(await page.locator('#password-title').textContent(),/Set your personal/);
 assert.equal((await context.request.get(origin+'/api/report')).status(),428);
 await page.getByLabel('Current passphrase').fill(fixturePass);await page.getByLabel('New passphrase',{exact:true}).fill('a personal fixture passphrase');await page.getByLabel('Confirm new passphrase').fill('a personal fixture passphrase');await page.getByRole('button',{name:'Save passphrase'}).click();await page.locator('#password-dialog').waitFor({state:'hidden'});
 await page.locator('#metric-tokens').filter({hasText:/[0-9]/}).waitFor();
 assert.equal(await page.locator('#app').isVisible(),true);
 await mkdir(root+'artifacts',{recursive:true});
 await page.screenshot({path:root+'artifacts/desktop.png',fullPage:true});
 await page.locator('#chart-cost').click();assert.match(await page.locator('#chart-subtitle').textContent(),/USD/);
 await page.locator('#turns-body .turn-link').first().click();assert.equal(await page.locator('.detail-row').first().isVisible(),true);
 assert.ok((await page.locator('.detail-row').first().textContent()).includes('Reasoning (in output)'));
 await page.locator('#model-filter').selectOption('gpt-6.1-sol');assert.ok((await page.locator('#turns-body .model-pill').allTextContents()).every(s=>s.includes('Sol')));
 await page.locator('#model-filter').selectOption('all');await page.locator('#more-turns').click();assert.equal(await page.locator('#turns-body .turn-link').count(),24);
 await page.getByLabel('Reporting period',{exact:true}).selectOption('7d');assert.equal(await page.locator('#turns-body .turn-link').count(),12);
 const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadPromise;assert.match(download.suggestedFilename(),/^meter-turns-/);
 for(const tab of ['sessions','models','privacy','overview']){await page.locator(`[data-view="${tab}"]`).click();assert.equal(await page.locator('#view-'+tab).isVisible(),true);}
 await page.setViewportSize({width:390,height:844});await page.getByLabel('Reporting period',{exact:true}).selectOption('7d');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:root+'artifacts/mobile.png',fullPage:true});
 await page.locator('[data-view="privacy"]').click();assert.equal(await page.locator('#privacy-logout').isVisible(),true);
 await page.locator('#privacy-password').click();await page.getByLabel('Current passphrase').fill('a personal fixture passphrase');await page.getByLabel('New passphrase',{exact:true}).fill('a replacement fixture passphrase');await page.getByLabel('Confirm new passphrase').fill('a replacement fixture passphrase');await page.getByRole('button',{name:'Save passphrase'}).click();await page.locator('#password-dialog').waitFor({state:'hidden'});
 let releaseRefresh,notifyPending;const heldRefresh=new Promise(r=>releaseRefresh=r),pendingRefresh=new Promise(r=>notifyPending=r);
 const completedRefresh=new Promise(resolve=>page.route(origin+'/api/report',async route=>{const response=await route.fetch(),data=await response.json();notifyPending();await heldRefresh;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});resolve();}));
 await page.locator('#refresh').click();await pendingRefresh;
 await page.locator('#privacy-logout').click();await page.locator('#login-screen').waitFor({state:'visible'});releaseRefresh();await completedRefresh;await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
 assert.equal(await page.locator('#turns-body .turn-link').count(),0);assert.equal(await page.locator('#app').isHidden(),true);
 await page.unroute(origin+'/api/report');assert.equal((await context.request.get(origin+'/api/report')).status(),401);
 const manifest=await(await context.request.get(origin+'/manifest.webmanifest')).json();assert.equal(manifest.display,'standalone');assert.equal(manifest.icons.length,2);
 for(const icon of manifest.icons){const r=await context.request.get(origin+icon.src);assert.equal(r.status(),200);assert.match(r.headers()['content-type'],/image\/png/);}
 assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);
 console.log(JSON.stringify({passed:true,checks:['signed-out gate','bootstrap login and mandatory passphrase replacement','dashboard','chart switch','turn details','CSV export','all navigation','390px layout','mobile password rotation','logout during in-flight refresh','install manifest/icons','no browser errors','no third-party requests'],screenshots:'artifacts/desktop.png and artifacts/mobile.png (invented data)'}));
}finally{await browser.close();await new Promise(r=>app.close(r));await rm(dir,{recursive:true,force:true});}
