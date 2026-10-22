import http from 'node:http';
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzip as gzipCallback } from 'node:zlib';

const scrypt = promisify(scryptCallback);
const gzip = promisify(gzipCallback);
const METRICS = ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens',
  'reasoning_output_tokens','total_tokens','requests','pricedRequests','unpricedRequests','costUSD','legacyRequests'];
const SAFE_MODELS = new Set(['gpt-6.1-sol','gpt-6-sol','gpt-6-astra','gpt-6-luna','gpt-5.6-sol','gpt-5.6-luna','codex-auto-review','mixed','unknown']);
const SAFE_TIERS = new Set(['standard','fast','flex','batch','ultrafast','unknown']);
const SAFE_EFFORT = new Set(['low','medium','high','xhigh','max','ultra','minimal','none','unknown']);
const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e15 ? n : 0;
const metrics = value => Object.fromEntries(METRICS.map(k => [k, number(value?.[k])]));
const id = s => typeof s === 'string' && /^[a-f0-9]{24}$/.test(s) ? s : '000000000000000000000000';
const model = s => SAFE_MODELS.has(s) ? s : 'unknown';
const role = s => ['Codex','Review','Agent'].includes(s) ? s : 'Codex';
const bounded = (a, limit) => Array.isArray(a) ? a.slice(0, limit) : [];
export function sanitizeReport(r) {
  if (r?.version !== 1 || !r.totals || !Array.isArray(r.daily)) throw new Error('invalid_snapshot');
  return {
    version: 1, generatedAt: number(r.generatedAt), timezone: 'Asia/Kolkata', totals: metrics(r.totals),
    daily: bounded(r.daily,365).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date)).map(d => ({date:d.date,...metrics(d),
      models:bounded(d.models,20).map(m => ({model:model(m.model),...metrics(m)}))})),
    models:bounded(r.models,20).map(m => ({model:model(m.model),...metrics(m)})),
    sessions:bounded(r.sessions,2000).map(s => ({id:id(s.id),firstAt:number(s.firstAt),lastAt:number(s.lastAt),role:role(s.role),...metrics(s)})),
    turns:bounded(r.turns,2500).map(t => ({id:id(t.id),session:id(t.session),at:number(t.at),model:model(t.model),
      role:role(t.role),tier:SAFE_TIERS.has(t.tier)?t.tier:'unknown',effort:SAFE_EFFORT.has(t.effort)?t.effort:'unknown',
      toolCalls:number(t.toolCalls),durationSeconds:number(t.durationSeconds),...metrics(t)})),
    usageEvents:bounded(r.usageEvents,10000).map(e=>({at:number(e.at),session:id(e.session),turn:id(e.turn),
      model:model(e.model),tier:SAFE_TIERS.has(e.tier)?e.tier:'unknown',effort:SAFE_EFFORT.has(e.effort)?e.effort:'unknown',
      role:role(e.role),...metrics(e)})),
    coverage:Object.fromEntries(['sourceFiles','lagBytes','lastEventAt','scanMs','allSessions','allTurns','omittedTurns','daysLimit',
      'malformedLines','oversizedLines','counterResets','unsupportedFiles','eventDetailsVersion','eventLimit','omittedEvents','eventsFrom'].map(k=>[k,number(r.coverage?.[k])])),
    pricing:{verified:'2026-10-20',currency:'USD',basis:'API-equivalent token estimates',
      models:Object.fromEntries(Object.entries(r.pricing?.models||{}).filter(([k])=>SAFE_MODELS.has(k)).map(([k,v])=>[k,
        Object.fromEntries(['input','cached','write','output','long_threshold','long_input','long_output','long_cached'].filter(f=>v[f]!==undefined).map(f=>[f,number(v[f])]))]))}
  };
}

export async function hashPassphrase(passphrase, mustChangePassword = false) {
  const salt = randomBytes(32).toString('hex');
  const digest = await scrypt(passphrase, salt, 64, {N:32768,r:8,p:1,maxmem:64*1024*1024});
  return {version:1,salt,digest:digest.toString('hex'),mustChangePassword};
}
async function matches(passphrase, auth) {
  const digest = await scrypt(passphrase,auth.salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  return timingSafeEqual(digest,Buffer.from(auth.digest,'hex'));
}
const cookieKey = '__Host-meter';
const sessionHash = s => createHash('sha256').update(s).digest('hex');
const equal = (a,b) => typeof a==='string' && typeof b==='string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const validPassphrase = p => typeof p==='string' && [...p].length>=14 && [...p].length<=256 && Buffer.byteLength(p)<=1024;

export async function createApp(config) {
  const publicRoot=config.publicRoot||fileURLToPath(new URL('./public/',import.meta.url));
  const authFile=path.join(config.stateDir,'auth.json');
  const authStat=await lstat(authFile);
  if (!authStat.isFile() || authStat.isSymbolicLink() || (authStat.mode & 0o077)) throw new Error('unsafe_auth_file');
  let auth=JSON.parse(await readFile(authFile,'utf8'));
  if (auth.version!==1 || !/^[a-f0-9]{64}$/.test(auth.salt) || !/^[a-f0-9]{128}$/.test(auth.digest)) throw new Error('invalid_auth');
  const origins=new Set(config.origins);
  if (!origins.size || [...origins].some(o=>new URL(o).origin!==o || (!o.startsWith('https://')&&!config.insecureLocal))) throw new Error('invalid_origin');
  const hosts=new Set([...origins].map(o=>new URL(o).host));
  // Loopback health probes are harmless; private API calls still require the configured origin/host.
  const assets=new Map();
  for (const [url,file,mime] of [
    ['/','index.html','text/html; charset=utf-8'],['/app.js','app.js','text/javascript; charset=utf-8'],
    ['/style.css','style.css','text/css; charset=utf-8'],['/time-range.mjs','time-range.mjs','text/javascript; charset=utf-8'],
    ['/usage.mjs','usage.mjs','text/javascript; charset=utf-8'],['/manifest.webmanifest','manifest.webmanifest','application/manifest+json'],
    ['/icon.svg','icon.svg','image/svg+xml'],['/icon-192.png','icon-192.png','image/png'],['/icon-512.png','icon-512.png','image/png']
  ]) assets.set(url,{body:await readFile(path.join(publicRoot,file)),mime});
  const sessions=new Map(), attempts=new Map();
  let activeHashes=0, changingPassword=false, cached=null, cachedAt=0, snapshotLoad=null;
  // One bounded load/compression at a time; concurrent readers share immutable
  // buffers instead of parsing a large usage report for every connection.
  async function snapshot(){
    if(cached&&Date.now()-cachedAt<=5000)return cached;
    if(snapshotLoad)return snapshotLoad;
    snapshotLoad=(async()=>{
      const st=await lstat(config.reportFile);
      if(!st.isFile()||st.isSymbolicLink()||st.size>16*1024*1024)throw new Error('invalid_snapshot');
      const report=sanitizeReport(JSON.parse(await readFile(config.reportFile,'utf8')));
      const plain=Buffer.from(JSON.stringify(report)),compressed=await gzip(plain);
      cached={plain,compressed};cachedAt=Date.now();return cached;
    })();
    try{return await snapshotLoad;}finally{snapshotLoad=null;}
  }
  const secure=!config.insecureLocal;
  const cookieName=secure?cookieKey:'meter-local';
  function makeSession(res) {
    if(sessions.size>=20) sessions.delete(sessions.keys().next().value);
    const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('hex'),now=Date.now();
    sessions.set(sessionHash(token),{csrf,created:now,last:now});
    res.setHeader('Set-Cookie',`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure?'; Secure':''}`);
    return {authenticated:true,csrf,mustChangePassword:!!auth.mustChangePassword};
  }
  function session(req) {
    const raw=req.headers.cookie||'';
    if(raw.length>4096) return null;
    const candidates=raw.split(';').map(c=>c.trim()).filter(c=>c.startsWith(cookieName+'='));
    if(candidates.length!==1) return null;
    const token=candidates[0].slice(cookieName.length+1);
    if(!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key=sessionHash(token),s=sessions.get(key),now=Date.now();
    if(!s || now-s.created>43200000 || now-s.last>3600000){sessions.delete(key);return null;}
    s.last=now;return {...s,key};
  }
  function reply(res,status,value,mime='application/json; charset=utf-8') {
    const body=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));
    res.writeHead(status,{'Content-Type':mime,'Content-Length':body.length});
    res.end(res._headOnly?undefined:body);
  }
  async function body(req,allowed) {
    if(req.headers['content-type']?.split(';')[0].trim()!=='application/json') throw {status:415};
    if(req.headers['transfer-encoding'] || !/^\d+$/.test(req.headers['content-length']||'') || Number(req.headers['content-length'])>4096) throw {status:413};
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>4096)throw {status:413};chunks.push(chunk);}
    let result;
    try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw {status:400};}
    if(!result || Array.isArray(result) || typeof result!=='object' || Object.keys(result).some(k=>!allowed.includes(k)))throw {status:400};
    return result;
  }
  function throttle(req) {
    const now=Date.now();
    // A global cap is enforced independently of the untrusted proxy IP header.
    const ip=String(req.headers['cf-connecting-ip']||req.socket.remoteAddress).slice(0,80);
    for(const [key,times] of attempts) if(times.every(t=>now-t>900000))attempts.delete(key);
    if(attempts.size>1024)return false;
    for(const [key,limit,window] of [['global',12,60000],['ip:'+ip,6,900000]]){
      const recent=(attempts.get(key)||[]).filter(t=>now-t<window);
      if(recent.length>=limit)return false;
    }
    for(const key of ['global','ip:'+ip])attempts.set(key,[...(attempts.get(key)||[]),now].slice(-20));
    return true;
  }
  const server=http.createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:8000,keepAliveTimeout:3000},async(req,res)=>{
    res._headOnly=req.method==='HEAD';
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=()');
    if(secure)res.setHeader('Strict-Transport-Security','max-age=31536000');
    try{
      const url=new URL(req.url,'http://invalid');
      if(url.pathname==='/healthz' && ['GET','HEAD'].includes(req.method))return reply(res,200,{ok:true});
      if(!hosts.has(req.headers.host))return reply(res,421,{error:'Unexpected host'});
      // External links must be able to open the public login document. Fetch
      // Metadata still blocks cross-site API, subresource and framed requests.
      const entryNavigation=req.method==='GET'&&url.pathname==='/'&&
        req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
      if(req.headers['sec-fetch-site']==='cross-site'&&!entryNavigation)return reply(res,403,{error:'Cross-site request rejected'});
      if(!['GET','HEAD','POST'].includes(req.method))return reply(res,405,{error:'Method not allowed'});
      if(req.method==='POST' && !origins.has(req.headers.origin))return reply(res,403,{error:'Origin rejected'});
      if(url.search)return reply(res,400,{error:'Unexpected query parameters'});
      if(req.method==='GET'||req.method==='HEAD'){
        const asset=assets.get(url.pathname);
        if(asset)return reply(res,200,asset.body,asset.mime);
      }
      const s=session(req);
      if(url.pathname==='/api/session'&&['GET','HEAD'].includes(req.method))return reply(res,200,s?
        {authenticated:true,csrf:s.csrf,mustChangePassword:!!auth.mustChangePassword}:{authenticated:false});
      if(url.pathname==='/api/login'&&req.method==='POST'){
        if(activeHashes>=2 || !throttle(req)){res.setHeader('Retry-After','60');return reply(res,429,{error:'Too many attempts. Please wait before trying again.'});}
        const data=await body(req,['passphrase']);
        const pass=data.passphrase;
        if(typeof pass!=='string'||Buffer.byteLength(pass)>1024)return reply(res,400,{error:'Invalid sign-in request'});
        if(activeHashes>=2){res.setHeader('Retry-After','60');return reply(res,429,{error:'Please wait before trying again'});}
        activeHashes++;
        const checkedAuth=auth;
        let ok=false;try{ok=await matches(pass,checkedAuth);}finally{activeHashes--;}
        if(!ok||checkedAuth!==auth)return reply(res,401,{error:'Incorrect passphrase'});
        return reply(res,200,makeSession(res));
      }
      if(url.pathname.startsWith('/api/')){
        if(!s)return reply(res,401,{error:'Sign in to continue'});
        if(req.method==='POST'&&!equal(req.headers['x-csrf-token'],s.csrf))return reply(res,403,{error:'Session verification failed'});
        if(url.pathname==='/api/logout'&&req.method==='POST'){
          sessions.delete(s.key);res.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`);
          res.setHeader('Clear-Site-Data','"cache", "cookies", "storage"');return reply(res,200,{ok:true});
        }
        if(url.pathname==='/api/password'&&req.method==='POST'){
          if(changingPassword||activeHashes>=2||!throttle(req))return reply(res,429,{error:'Please wait before trying again'});
          const data=await body(req,['current','newPassphrase']);
          if(!validPassphrase(data.newPassphrase)||typeof data.current!=='string'||Buffer.byteLength(data.current)>1024)return reply(res,400,{error:'Use a passphrase of 14 to 256 characters'});
          if(changingPassword||activeHashes>=2)return reply(res,429,{error:'Please wait before trying again'});
          changingPassword=true;
          try{
          activeHashes++;let ok;try{ok=await matches(data.current,auth);}finally{activeHashes--;}
          if(!ok)return reply(res,401,{error:'Incorrect current passphrase'});
          if(data.newPassphrase===data.current)return reply(res,400,{error:'Choose a different passphrase'});
          if(activeHashes>=2)return reply(res,429,{error:'Please wait before trying again'});
          activeHashes++;let replacement;try{replacement=await hashPassphrase(data.newPassphrase);}finally{activeHashes--;}
          await writeFile(authFile+'.tmp',JSON.stringify(replacement),{mode:0o600,flag:'w'});
          await rename(authFile+'.tmp',authFile);auth=replacement;sessions.clear();
          return reply(res,200,makeSession(res));
          }finally{changingPassword=false;}
        }
        if(auth.mustChangePassword)return reply(res,428,{error:'Set your personal passphrase to open the dashboard'});
        if(url.pathname==='/api/report'&&['GET','HEAD'].includes(req.method)){
          let wire;
          try{wire=await snapshot();}catch{return reply(res,503,{error:'The usage snapshot is not ready. Please try again shortly.'});}
          // Sign-out/password rotation can happen while a report is loading.
          if(!session(req))return reply(res,401,{error:'Sign in to continue'});
          const compress=String(req.headers['accept-encoding']||'').split(',').some(part=>{
            const [coding,...parameters]=part.trim().split(';');
            const q=parameters.map(p=>p.trim()).find(p=>p.startsWith('q='));
            const quality=q===undefined?1:Number(q.slice(2));return coding==='gzip'&&quality>0&&quality<=1;
          });
          res.setHeader('Vary','Accept-Encoding');if(compress)res.setHeader('Content-Encoding','gzip');
          return reply(res,200,compress?wire.compressed:wire.plain);
        }
      }
      return reply(res,404,{error:'Not found'});
    }catch(e){reply(res,e.status||500,{error:e.status?'Invalid request':'Request could not be completed'});}
  });
  server.maxRequestsPerSocket=100;
  server.maxConnections=128;
  server.timeout=15000;
  server.on('clientError',(_e,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  const prune=setInterval(()=>{const now=Date.now();for(const [k,s]of sessions)if(now-s.created>43200000||now-s.last>3600000)sessions.delete(k);},60000);prune.unref();
  server.on('close',()=>clearInterval(prune));
  return server;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const config=JSON.parse(await readFile(process.argv[2]||'/config/app.json','utf8'));
  const server=await createApp(config);
  server.listen(config.port||4318,'127.0.0.1',()=>console.log('Meter web service ready on loopback'));
}
