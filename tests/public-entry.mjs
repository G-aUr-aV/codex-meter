// Read-only browser regression: opening the public login page from an external link.
// The referring page is an invented loopback fixture; no third-party service is used.
const {chromium}=await import(process.env.METER_PLAYWRIGHT_MODULE||'@playwright/test');
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
const origin=process.argv[2];
if(!/^https:\/\/[a-z-]+\.trycloudflare\.com$/.test(origin))throw new Error('Expected the owned HTTPS tunnel origin');
const referringApp=createServer((_req,res)=>{
 res.writeHead(200,{'Content-Type':'text/html'});res.end(`<a href="${origin}/">Open Meter</a>`);
});
await new Promise(r=>referringApp.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
try{
 for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
  const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[];
  try{
   page.on('pageerror',e=>errors.push(e.name));
   const source='http://127.0.0.1:'+referringApp.address().port;
   await page.goto(source);
   const sessionResponse=page.waitForResponse(r=>r.url()===origin+'/api/session').catch(()=>null);
   const [navigation]=await Promise.all([page.waitForNavigation(),page.getByRole('link',{name:'Open Meter',exact:true}).click()]);
   const headers=await navigation.request().allHeaders();
   assert.equal(headers['sec-fetch-site'],'cross-site');
   assert.equal(headers['sec-fetch-mode'],'navigate');
   assert.equal(headers['sec-fetch-dest'],'document');
   assert.equal(navigation.status(),200);
   await page.getByLabel('Passphrase',{exact:true}).waitFor({state:'visible'});
   assert.equal((await sessionResponse)?.status(),200);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 console.log(JSON.stringify({passed:true,origin,checks:['external-link navigation 200','login page and session endpoint load','desktop and 390px layout','no browser script errors'],credentialsUsed:false}));
}finally{await browser.close();await new Promise(r=>referringApp.close(r));}
