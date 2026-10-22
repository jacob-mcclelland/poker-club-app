'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const fake = require('./fake-admin');

const FIXED = Date.parse('2026-10-21T03:03:00Z');
const NativeDate = Date;
class DemoDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [FIXED])); }
  static now() { return FIXED; }
}
global.Date = DemoDate;

class HttpsError extends Error { constructor(code, message, details) { super(message); this.code=code; this.details=details; } }
const wrap = (...args) => ({ run: args.at(-1) });
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'firebase-admin/app') return {initializeApp:fake.initializeApp};
  if (request === 'firebase-admin/firestore') return {getFirestore:fake.getFirestore,FieldValue:fake.FieldValue,Timestamp:fake.Timestamp};
  if (request === 'firebase-admin/storage') return {getStorage:fake.getStorage};
  if (request === 'firebase-admin/messaging') return {getMessaging:fake.getMessaging};
  if (request === 'firebase-functions/v2/https') return {onCall:wrap,onRequest:wrap,HttpsError};
  if (request === 'firebase-functions/v2/firestore') return {onDocumentCreated:wrap,onDocumentUpdated:wrap};
  if (request === 'firebase-functions/v2/scheduler') return {onSchedule:wrap};
  if (request === '@anthropic-ai/sdk') return class StubAnthropic {};
  return originalLoad.call(this,request,parent,isMain);
};
let handlers;
try { handlers=require('../../functions/index.js'); }
finally { Module._load=originalLoad; }

const root=path.resolve(__dirname,'../..');
const publicRoot=path.join(root,'public');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
const callLog=[];
function send(res,status,obj) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve,reject)=>{let text='';req.on('data',c=>{text+=c;if(text.length>2e6)reject(Error('Body too large'));});req.on('end',()=>{try{resolve(JSON.parse(text||'{}'));}catch(e){reject(e);}});req.on('error',reject);}); }
function createServer() {
  return http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/__demo/fixtures') return send(res,200,fake.raw);
    if(req.method==='GET'&&url.pathname==='/api/server-time') return send(res,200,{now:FIXED});
    if(req.method==='POST'&&url.pathname==='/__demo/firestore-query') {
      try {
        const body=await readBody(req);
        const q=body.structuredQuery;
        const name=q.from?.[0]?.collectionId;
        const filters=q.where?.compositeFilter?.filters;
        if(!name||!Array.isArray(filters)||filters.some(f=>f.fieldFilter?.op!=='EQUAL')) throw Error('Unsupported firestore-query');
        const rows=Object.entries(fake.raw[name]||{}).filter(([,doc])=>filters.every(f=>{
          const field=f.fieldFilter.field.fieldPath, v=f.fieldFilter.value;
          const expected=v.stringValue!==undefined?v.stringValue:v.integerValue!==undefined?Number(v.integerValue):undefined;
          return doc[field]===expected;
        })).map(([id,doc])=>({document:{name:name+'/'+id,fields:Object.fromEntries(Object.entries(doc).map(([k,v])=>[k,typeof v==='number'?{integerValue:String(v)}:typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)?{timestampValue:v}:{stringValue:String(v)}]))}}));
        return send(res,200,rows);
      } catch(e) { return send(res,400,{error:e.message}); }
    }
    if(req.method==='POST'&&url.pathname.startsWith('/__demo/call/')) {
      const name=decodeURIComponent(url.pathname.slice('/__demo/call/'.length));
      try {
        let {data,auth}=await readBody(req);
        if(!handlers[name]||typeof handlers[name].run!=='function') throw new HttpsError('not-found','Unknown callable: '+name);
        if(name==='getLeaderboard'&&/\/championship-director\.html(?:[?#]|$)/.test(req.headers.referer||'')) data={...data,seasonId:data?.venue==='Tight End'?'season-00001':'season-01748'};
        const result=await handlers[name].run({data,auth:auth||null});
        callLog.push({name,ok:true});console.log('CALL '+name+' OK');
        return send(res,200,{result:result===undefined?null:result});
      } catch(e) {
        callLog.push({name,ok:false,code:e.code||'internal',message:e.message});console.error('CALL '+name+' ERROR '+(e.code||'internal')+': '+e.message);
        return send(res,200,{error:{code:e.code||'internal',message:e.message}});
      }
    }
    if(req.method!=='GET'&&req.method!=='HEAD') return send(res,405,{error:'Method not allowed'});
    let file;
    if(url.pathname.startsWith('/demo/invoices/')) file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    else file=path.resolve(publicRoot,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    const allowed=file.startsWith(publicRoot+path.sep)||file.startsWith(path.join(root,'demo','invoices')+path.sep);
    if(!allowed) return send(res,403,{error:'Forbidden'});
    fs.readFile(file,(err,body)=>{if(err)return send(res,404,{error:'Not found: '+url.pathname});
      if(path.extname(file)==='.html') body=Buffer.from(body.toString('utf8').replace(/<link\b[^>]*\b(?:href|rel)=["'][^"']*fonts\.googleapis\.com[^>]*>/gi,''));
      res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':'no-store'});res.end(req.method==='HEAD'?undefined:body);});
  });
}
if(require.main===module) { const server=createServer();server.listen(Number(process.env.PORT||0),'127.0.0.1',()=>console.log('Demo server http://127.0.0.1:'+server.address().port)); }
module.exports={createServer,callLog,handlers};
