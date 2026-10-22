import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {createApp,hashPassphrase,sanitizeReport} from '../server.mjs';
const pass='a test passphrase for fixtures only';
async function fixture(t,{mustChange=false}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'meter-test-'));
 await writeFile(dir+'/auth.json',JSON.stringify(await hashPassphrase(pass,mustChange)),{mode:0o600});
 const report={version:1,generatedAt:Date.now()/1000,totals:{input_tokens:1000,total_tokens:1100},daily:[],turns:[],sessions:[],models:[],coverage:{},pricing:{models:{}}};
 await writeFile(dir+'/report.json',JSON.stringify(report));
 // Port 0 for an isolated local fixture; Origin remains explicit.
 const origin='http://127.0.0.1:4318';
 const app=await createApp({stateDir:dir,reportFile:dir+'/report.json',origins:[origin],insecureLocal:true});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.address().port;
 t.after(async()=>{await new Promise(r=>app.close(r));await rm(dir,{recursive:true,force:true});});
 const request=(pathname,options={})=>new Promise((resolve,reject)=>{
   const body=options.body;
   const headers={Host:'127.0.0.1:4318',...(body?{'Content-Length':Buffer.byteLength(body)}:{}),...(options.headers||{})};
   const req=httpRequest(url+pathname,{...options,headers},res=>{
     const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
   });req.on('error',reject);req.end(body);
 });
 const post=(pathname,data,extra={})=>request(pathname,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});
 const login=async()=>{const r=await post('/api/login',{passphrase:pass});return {r,cookie:r.headers.get('set-cookie')?.split(';')[0],s:await r.json()};};
 return {dir,report,request,post,login,origin};
}
test('unauthenticated report denied and static routes cannot expose local files',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/report')).status,401);
 for(const p of ['/auth.json','/pricing.json','/collector.py','/.git/config','/..%2f..%2fauth.json','/input/sessions','/api/report?path=/etc/passwd'])assert.ok([400,401,404].includes((await f.request(p)).status));
 const home=await f.request('/');assert.equal(home.status,200);assert.equal(home.headers.get('cache-control'),'no-store');assert.match(home.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('login sets protected cookie; report requires valid session; logout invalidates it',async t=>{
 const f=await fixture(t),{r,cookie,s}=await f.login();assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/SameSite=Strict/);
 assert.equal((await f.request('/api/report',{headers:{Cookie:cookie}})).status,200);
 assert.equal((await f.post('/api/logout',{}, {Cookie:cookie})).status,403);
 assert.equal((await f.post('/api/logout',{}, {Cookie:cookie,'X-CSRF-Token':s.csrf})).status,200);
 assert.equal((await f.request('/api/report',{headers:{Cookie:cookie}})).status,401);
});
test('origin, host, content type, body bounds and methods fail closed',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post('/api/login',{passphrase:pass},{Origin:'https://evil.example'})).status,403);
 assert.equal((await f.post('/api/login',{passphrase:pass},{Host:'evil.example'})).status,421);
 assert.equal((await f.post('/api/login',{passphrase:pass},{'Content-Type':'text/plain'})).status,415);
 assert.equal((await f.post('/api/login',{passphrase:'x'.repeat(5000)})).status,413);
 assert.equal((await f.request('/api/session',{method:'OPTIONS'})).status,405);
 assert.equal((await f.request('/api/session',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
});
test('external links can open the login document while cross-site APIs and subresources remain blocked',async t=>{
 const f=await fixture(t),{cookie}=await f.login();
 const navigation={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
 const home=await f.request('/',{headers:navigation});
 assert.equal(home.status,200);assert.match(home.headers.get('content-type'),/text\/html/);
 for(const pathname of ['/api/session','/api/report','/app.js','/style.css'])
  assert.equal((await f.request(pathname,{headers:{...navigation,Cookie:cookie}})).status,403);
 for(const extra of [{'Sec-Fetch-Mode':'cors'},{'Sec-Fetch-Dest':'iframe'},{'Sec-Fetch-Dest':'empty'}])
  assert.equal((await f.request('/',{headers:{...navigation,...extra}})).status,403);
 assert.equal((await f.request('/',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await f.post('/api/login',{passphrase:pass},navigation)).status,403);
 assert.equal((await f.post('/',{},navigation)).status,403);
 assert.equal((await f.request('/api/report',{headers:{Cookie:cookie}})).status,200);
});
test('first-use passphrase replacement is mandatory and old passphrase stops working',async t=>{
 const f=await fixture(t,{mustChange:true}),{cookie,s}=await f.login();
 assert.equal((await f.request('/api/report',{headers:{Cookie:cookie}})).status,428);
 const r=await f.post('/api/password',{current:pass,newPassphrase:'another fixture passphrase here'}, {Cookie:cookie,'X-CSRF-Token':s.csrf});assert.equal(r.status,200);
 assert.equal((await f.request('/api/report',{headers:{Cookie:cookie}})).status,401);
 assert.equal((await f.post('/api/login',{passphrase:pass})).status,401);
 assert.equal((await f.post('/api/login',{passphrase:'another fixture passphrase here'})).status,200);
});
test('repeated login attempts are throttled',async t=>{
 const f=await fixture(t);for(let i=0;i<6;i++)assert.equal((await f.post('/api/login',{passphrase:'wrong fixture password'})).status,401);
 assert.equal((await f.post('/api/login',{passphrase:pass})).status,429);
});
test('report boundary discards extra data, arbitrary model strings, and nonfinite numbers',()=>{
 const sentinel='<script>private source text</script>';
 const r=sanitizeReport({version:1,totals:{total_tokens:Infinity},daily:[],content:sentinel,turns:[{model:sentinel,prompt:sentinel,session:sentinel}],pricing:{models:{[sentinel]:{}}}});
 assert.ok(!JSON.stringify(r).includes(sentinel));assert.equal(r.totals.total_tokens,0);assert.equal(r.turns[0].model,'unknown');
});
test('concurrent authentication stays within the hash concurrency cap',async t=>{
 const f=await fixture(t);
 const responses=await Promise.all(Array.from({length:10},()=>f.post('/api/login',{passphrase:pass})));
 const statuses=responses.map(r=>r.status);assert.ok(statuses.every(s=>s===200||s===429));
 assert.ok(statuses.includes(429));assert.ok(statuses.filter(s=>s===200).length<=2);
});
test('timestamp records share authentication and the report boundary excludes private or arbitrary fields',async t=>{
 const f=await fixture(t),sentinel='PRIVATE_CONTENT_SENTINEL';
 f.report.usageEvents=[{at:123.456,session:'a'.repeat(24),turn:'b'.repeat(24),model:'gpt-6.1-sol',tier:'standard',effort:'high',role:'Codex',total_tokens:123,prompt:sentinel,response_id:sentinel,filename:sentinel}];
 f.report.coverage={eventDetailsVersion:1,eventLimit:10000,omittedEvents:0,eventsFrom:123.456};
 await writeFile(f.dir+'/report.json',JSON.stringify(f.report));
 const denied=await f.request('/api/report');assert.equal(denied.status,401);assert.ok(!(await denied.text()).includes('usageEvents'));
 const {cookie}=await f.login();const r=await f.request('/api/report',{headers:{Cookie:cookie}}),report=await r.json();
 assert.equal(report.usageEvents[0].at,123.456);assert.equal(report.coverage.eventDetailsVersion,1);
 assert.ok(!JSON.stringify(report).includes(sentinel));
 assert.equal((await f.request('/usageEvents.json')).status,404);
 assert.equal((await f.request('/api/report?start=123',{headers:{Cookie:cookie}})).status,400);
});
test('gzip and plain report responses agree; concurrent readers and HEAD preserve the contract',async t=>{
 const f=await fixture(t),{cookie}=await f.login();
 const responses=await Promise.all(Array.from({length:12},()=>f.request('/api/report',{headers:{Cookie:cookie,'Accept-Encoding':'gzip'}})));
 for(const r of responses){assert.equal(r.status,200);assert.equal(r.headers.get('content-encoding'),'gzip');assert.equal(r.headers.get('vary'),'Accept-Encoding');assert.equal(JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer()))).totals.total_tokens,1100);}
 const plain=await f.request('/api/report',{headers:{Cookie:cookie,'Accept-Encoding':'gzip;q=0'}});assert.equal(plain.headers.get('content-encoding'),null);assert.equal((await plain.json()).totals.total_tokens,1100);
 const head=await f.request('/api/report',{method:'HEAD',headers:{Cookie:cookie,'Accept-Encoding':'gzip'}});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.ok(Number(head.headers.get('content-length'))>0);
});
test('corrupt, missing, symlinked and oversized reports fail without leaking internals',async t=>{
 const f=await fixture(t),{cookie}=await f.login();
 await writeFile(f.dir+'/report.json','invalid JSON with private contents');
 const r=await f.request('/api/report',{headers:{Cookie:cookie}});assert.equal(r.status,503);assert.ok(!(await r.text()).includes('private contents'));
 await rm(f.dir+'/report.json');assert.equal((await f.request('/api/report',{headers:{Cookie:cookie}})).status,503);
 await writeFile(f.dir+'/report.json','x'.repeat(16*1024*1024+1));assert.equal((await f.request('/api/report',{headers:{Cookie:cookie}})).status,503);
 await rm(f.dir+'/report.json');const {symlink}=await import('node:fs/promises');await symlink(f.dir+'/auth.json',f.dir+'/report.json');assert.equal((await f.request('/api/report',{headers:{Cookie:cookie}})).status,503);
});
test('idle sessions expire and cookie/header protections remain enforced',async t=>{
 const f=await fixture(t),{cookie}=await f.login(),realNow=Date.now,future=Date.now()+3600001;
 try{Date.now=()=>future;assert.equal((await f.request('/api/report',{headers:{Cookie:cookie}})).status,401);}finally{Date.now=realNow;}
 const home=await f.request('/');assert.match(home.headers.get('content-security-policy'),/connect-src 'self'/);assert.equal(home.headers.get('x-content-type-options'),'nosniff');
 assert.equal((await f.request('/api/report',{headers:{Cookie:cookie+'; '+cookie}})).status,401);
});
