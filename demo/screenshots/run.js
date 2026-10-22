'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'../..');
let playwright;
try { playwright=require('playwright'); }
catch (_) { playwright=require(path.join(process.env.APPDATA,'npm','node_modules','playwright')); }
const {chromium}=playwright;
const {createServer,callLog,handlers}=require('./server');
const fixtures=require('../fixtures/players.json');
const rounds=require('../fixtures/shotRounds.json');
const names=[...new Set(Object.values(fixtures).map(p=>p.name).filter(Boolean))];
const shotNames=Object.values(rounds).filter(r=>r.venue==='Tight End'&&r.status!=='draft').map(r=>r.submitter?.name).filter(Boolean);
let firstPlace=''; // set from the real getLeaderboard handler in main()
const specs=[
  {file:'01-player-home.png',url:'/index.html',viewport:{width:390,height:844},auth:null,note:'Player home standings with Tight End and generated player names',setup:async p=>{await p.locator('.tab-btn').filter({hasText:'Standings'}).click();},check:t=>t.includes('Tight End')&&countNames(t)>=1},
  {file:'02-standings.png',url:'/leaderboard.html?venue=Tight%20End',viewport:{width:390,height:844},auth:null,note:'Current Tight End Fall 2026 standings',check:t=>t.includes(firstPlace)},
  {file:'03-player-clock.png',url:'/clock.html?venue=tight&game=1',viewport:{width:390,height:844},auth:null,note:'Running Tight End Game 1 clock',check:t=>/\b\d{1,2}:\d{2}\b/.test(t)},
  {file:'04-tonight.png',url:'/tonight.html',viewport:{width:1180,height:820},auth:'demo-admin',note:'Tight End October 20 checkins and game information',setup:async p=>{await p.locator('#eventSelect option').filter({hasText:'10/20/2026'}).first().waitFor({state:'attached'});const value=await p.locator('#eventSelect option').evaluateAll(opts=>opts.find(x=>x.textContent.includes('10/20/2026')&&x.textContent.includes('Tight End'))?.value);if(!value)throw Error('Tonight event option missing');await p.locator('#eventSelect').selectOption(value);await p.evaluate(()=>{document.body.style.zoom='0.75';});},check:t=>t.includes('Tight End')&&countNames(t)>=10},
  {file:'05-director.png',url:'/staff/director.html',viewport:{width:1180,height:820},auth:'demo-admin',note:'Tight End October 20 Game 2 director roster',setup:async p=>{await p.locator('#eventSelect option').filter({hasText:'10/20/2026'}).first().waitFor({state:'attached'});const value=await p.locator('#eventSelect option').evaluateAll(opts=>opts.find(x=>x.textContent.includes('10/20/2026')&&x.textContent.includes('Tight End'))?.value);if(!value)throw Error('Director event option missing');await p.locator('#eventSelect').selectOption(value);await p.locator('#gameSelect').selectOption('2');},check:t=>countNames(t)>=10},
  {file:'06-tv-clock.png',url:'/staff/timer.html?venue=tight&noshowcase',viewport:{width:1920,height:1080},auth:'demo-admin',note:'Tight End television clock',check:t=>/\b\d{1,2}:\d{2}\b/.test(t)},
  {file:'07-bar-board.png',url:'/bar.html',viewport:{width:1180,height:820},auth:'demo-admin',note:'Tight End bar board with three submitted rounds. The page filters draft rounds before rendering',setup:async p=>{await p.locator('#card-toggle-btn').click();await p.evaluate(()=>{document.body.style.zoom='0.7';});},check:t=>shotNames.every(n=>t.includes(n))},
  {file:'08-championship.png',url:'/staff/championship-director.html',viewport:{width:1440,height:900},auth:'demo-admin',note:'Summer 2026 championship seating for Tight End',setup:async p=>{await p.evaluate(()=>{document.body.style.zoom='0.8';});},check:t=>countNames(t)>=16},
  {file:'09-admin.png',url:'/admin/index.html',viewport:{width:1440,height:900},auth:'demo-admin',note:'Admin hub and its operations sections',setup:async p=>{await p.addStyleTag({content:'#userDisplay { text-transform: none !important; }'});},check:t=>['Data & Records','Access & Identity','League Operations','Bar & Analytics'].every(x=>t.toLowerCase().includes(x.toLowerCase()))},
  {file:'10-sample-invoice.png',url:'/demo/invoices/quillfeather-lounge.html',viewport:{width:1100,height:1300},auth:null,note:'Generated sample invoice',check:t=>t.includes('SAMPLE DATA')&&t.includes('$660.00')}
];
function countNames(text) { return names.filter(n=>text.includes(n)).length; }
function delay(ms) { return new Promise(r=>setTimeout(r,ms)); }

async function main() {
  if(!handlers.getLeaderboard?.run) throw Error('getLeaderboard handler missing');
  const leaderboard=await handlers.getLeaderboard.run({data:{venue:'Tight End'},auth:null});
  firstPlace=leaderboard.standings?.[0]?.name;
  if(!firstPlace) throw Error('getLeaderboard returned no first place');
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  let browser;
  const forbidden=[];const pageErrors=[];const report=[];
  fs.mkdirSync(path.join(root,'docs','screenshots'),{recursive:true});
  fs.mkdirSync(path.join(__dirname,'out'),{recursive:true});
  try {
    browser=await chromium.launch({headless:true});
    for(const spec of specs) {
      const context=await browser.newContext({viewport:spec.viewport,timezoneId:'America/Denver',serviceWorkers:'block'});
      const page=await context.newPage();
      const consoleErrors=[];
      page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
      page.on('response',r=>{if(r.status()===404) consoleErrors.push('404 '+r.url());});
      page.on('pageerror',e=>pageErrors.push({page:spec.file,error:e.stack||e.message}));
      await page.clock.install({time:new Date('2026-10-21T03:03:00Z')});
      await page.addInitScript((auth)=>{
        const NativeDate=Date, fixed=Date.parse('2026-10-21T03:03:00Z');
        class DemoDate extends NativeDate { constructor(...args) { super(...(args.length?args:[fixed])); } static now() { return fixed; } }
        window.Date=DemoDate;
        window.__DEMO_AUTH=auth?{uid:auth,email:'admin@example.com'}:null;
        const nativeFetch=window.fetch.bind(window);
        window.fetch=(input,init)=>{
          const url=typeof input==='string'?input:input?.url||'';
          if(url.startsWith('https://firestore.googleapis.com/v1/projects/demo-poker/databases/(default)/documents:runQuery')) return nativeFetch('/__demo/firestore-query',init);
          return nativeFetch(input,init);
        };
      },spec.auth);
      await page.route('**/*',async route=>{
        const url=route.request().url();
        if(/^https?:\/\//.test(url)&&!url.startsWith(base)) {
          const host=new URL(url).hostname;
          if(/(?:^|\.)(?:googleapis\.com|cloudfunctions\.net|firebaseio\.com|firebaseapp\.com)$/.test(host)) forbidden.push({page:spec.file,url});
          await route.abort();return;
        }
        await route.continue();
      });
      await page.route('https://www.gstatic.com/firebasejs/10.7.1/*',async route=>{
        const name=path.basename(new URL(route.request().url()).pathname);
        const file=path.join(__dirname,'fake-sdk',name);
        if(!fs.existsSync(file)) throw Error('Missing fake SDK '+name);
        await route.fulfill({status:200,contentType:'text/javascript; charset=utf-8',body:fs.readFileSync(file)});
      });
      const url=base+spec.url;
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
      if(spec.setup) await spec.setup(page);
      let text='';let ok=false;
      for(let i=0;i<80;i++) {
        text=await page.locator('body').innerText().catch(()=> '');
        if(spec.check(text)) {ok=true;break;}
        await delay(150);
      }
      const stem=spec.file.replace(/\.png$/,'');
      fs.writeFileSync(path.join(__dirname,'out',stem+'.txt'),text,'utf8');
      await page.screenshot({path:path.join(root,'docs','screenshots',spec.file),fullPage:false,animations:'disabled'});
      const entry={page:spec.file,requestedUrl:spec.url,url:page.url(),clock:await page.evaluate(()=>new Date().toISOString()),viewport:spec.viewport,auth:spec.file==='10-sample-invoice.png'?'n/a':spec.auth?'signed in':'signed out',note:spec.note,matched:countNames(text),ok,consoleErrors};
      report.push(entry);
      console.log(JSON.stringify(entry));
      await context.close();
    }
    const lines=['# Demo screenshots','',...report.map(x=>`- ${x.page}: ${x.requestedUrl}${x.requestedUrl!==new URL(x.url).pathname+new URL(x.url).search?' (redirects to '+new URL(x.url).pathname+')':''}, ${x.viewport.width}x${x.viewport.height}, ${x.auth}. ${x.note}${x.ok?'':' (data assertion failed)'}.`),''];
    fs.writeFileSync(path.join(root,'docs','screenshots','README.md'),lines.join('\n'),'utf8');
    console.log(`SUMMARY pages=${report.length} failed=${report.filter(x=>!x.ok).length} forbidden=${forbidden.length} callableErrors=${callLog.filter(x=>!x.ok).length} pageErrors=${pageErrors.length}`);
    if(forbidden.length) console.error('FORBIDDEN '+JSON.stringify(forbidden));
    if(pageErrors.length) console.error('PAGE_ERRORS '+JSON.stringify(pageErrors));
    if(report.some(x=>!x.ok)||forbidden.length||callLog.some(x=>!x.ok)||pageErrors.length) process.exitCode=1;
  } finally { if(browser)await browser.close();await new Promise(r=>server.close(r)); }
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
