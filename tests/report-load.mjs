// Maximum retained report and concurrent-read check using invented numbers only.
import {createApp,hashPassphrase} from '../server.mjs';
import {zero} from '../public/usage.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
const dir=await mkdtemp(path.join(tmpdir(),'meter-load-')),origin='http://127.0.0.1:4326',pass='invented load fixture passphrase';
const usageEvents=Array.from({length:10000},(_,i)=>({at:1792458000+i/10,turn:(i%2500).toString(16).padStart(24,'0'),session:(i%100).toString(16).padStart(24,'0'),model:'gpt-6.1-sol',tier:'standard',effort:'high',role:'Codex',...zero(),input_tokens:1000,total_tokens:1000,requests:1,pricedRequests:1,costUSD:.002}));
const turns=usageEvents.slice(0,2500).map(e=>({...e,id:e.turn,toolCalls:7,durationSeconds:125}));
const data={version:1,generatedAt:Date.now()/1000,totals:{...zero(),requests:10000,total_tokens:10000000},daily:[],models:[],sessions:[],turns,usageEvents,coverage:{eventDetailsVersion:1,eventLimit:10000},pricing:{models:{}}};
const raw=JSON.stringify(data);assert.ok(Buffer.byteLength(raw)<16*1024*1024);
await writeFile(dir+'/report.json',raw);await writeFile(dir+'/auth.json',JSON.stringify(await hashPassphrase(pass)),{mode:0o600});
const app=await createApp({stateDir:dir,reportFile:dir+'/report.json',origins:[origin],insecureLocal:true});await new Promise(r=>app.listen(0,'127.0.0.1',r));
function request(route,options={}){return new Promise((resolve,reject)=>{
 const req=httpRequest({hostname:'127.0.0.1',port:app.address().port,path:route,method:options.method||'GET',headers:{Host:'127.0.0.1:4326',...options.headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(options.body);
});}
try{
 const body=JSON.stringify({passphrase:pass}),login=await request('/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},body});assert.equal(login.status,200);
 const cookie=login.headers['set-cookie'][0].split(';')[0],start=performance.now();
 const replies=await Promise.all(Array.from({length:16},()=>request('/api/report',{headers:{Cookie:cookie,'Accept-Encoding':'gzip'}})));
 const elapsed=Math.round(performance.now()-start),first=replies[0];
 assert.ok(replies.every(r=>r.status===200&&r.body.equals(first.body)));const report=JSON.parse(gunzipSync(first.body));
 assert.equal(report.usageEvents.length,10000);assert.equal(report.turns.length,2500);assert.equal(report.totals.total_tokens,10000000);
 const rss=process.memoryUsage().rss;assert.ok(rss<256*1024*1024,'Fixture process exceeded live service memory cap');assert.ok(first.body.length<Buffer.byteLength(raw)/4);
 console.log(JSON.stringify({passed:true,inventedData:true,records:10000,concurrentReaders:16,sourceBytes:Buffer.byteLength(raw),gzipBytes:first.body.length,coldConcurrentReadMs:elapsed,rssMiB:Math.round(rss/1024/1024)}));
}finally{await new Promise(r=>app.close(r));await rm(dir,{recursive:true,force:true});}
