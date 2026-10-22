'use strict';
const fs = require('fs');
const path = require('path');
const FIXED = Date.parse('2026-10-21T03:03:00Z');
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

class Timestamp {
  constructor(ms) { this.seconds = Math.floor(ms / 1000); this.nanoseconds = (ms % 1000) * 1e6; }
  static fromDate(d) { return new Timestamp(d.getTime()); }
  static fromMillis(ms) { return new Timestamp(ms); }
  static now() { return new Timestamp(Date.now()); }
  toDate() { return new Date(this.toMillis()); }
  toMillis() { return this.seconds * 1000 + this.nanoseconds / 1e6; }
  valueOf() { return this.toMillis(); }
  toJSON() { return this.toDate().toISOString(); }
}
function toValue(v) {
  if (typeof v === 'string' && ISO.test(v)) return Timestamp.fromMillis(Date.parse(v));
  if (Array.isArray(v)) return v.map(toValue);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,toValue(x)]));
  return v;
}
function clone(v) { if (v instanceof Timestamp) return Timestamp.fromMillis(v.toMillis()); if (Array.isArray(v)) return v.map(clone); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,clone(x)])); return v; }
const raw = Object.fromEntries(fs.readdirSync(path.join(__dirname, '..', 'fixtures')).filter(x => x.endsWith('.json')).map(x => [x.slice(0,-5), JSON.parse(fs.readFileSync(path.join(__dirname,'..','fixtures',x),'utf8'))]));
const data = Object.fromEntries(Object.entries(raw).map(([k,v]) => [k,new Map(Object.entries(v).map(([id,doc]) => [id,toValue(doc)]))]));
const marker = (op, args) => ({ __fieldValue: op, args });
const FieldValue = { serverTimestamp: () => marker('serverTimestamp',[]), delete: () => marker('delete',[]), arrayRemove: (...x) => marker('arrayRemove',x), arrayUnion: (...x) => marker('arrayUnion',x), increment: x => marker('increment',[x]) };
function at(obj, key) { return String(key).split('.').reduce((a,k) => a == null ? undefined : a[k],obj); }
function same(a,b) { return JSON.stringify(a) === JSON.stringify(b); }
function compare(a,b) { const x = a instanceof Timestamp ? a.toMillis() : a, y = b instanceof Timestamp ? b.toMillis() : b; return x === y ? 0 : x == null ? -1 : y == null ? 1 : x < y ? -1 : 1; }
function materialize(old, input, merge) {
  const result = merge ? clone(old || {}) : {};
  for (const [key,val] of Object.entries(input || {})) {
    if (val && val.__fieldValue) {
      const before = at(result,key);
      if (val.__fieldValue === 'delete') { delete result[key]; continue; }
      if (val.__fieldValue === 'serverTimestamp') result[key] = Timestamp.fromMillis(FIXED);
      else if (val.__fieldValue === 'increment') result[key] = (Number(before) || 0) + Number(val.args[0]);
      else if (val.__fieldValue === 'arrayRemove') result[key] = (Array.isArray(before) ? before : []).filter(x => !val.args.some(y => same(x,y)));
      else if (val.__fieldValue === 'arrayUnion') result[key] = [...(Array.isArray(before) ? before : []), ...val.args.filter(x => !(Array.isArray(before) ? before : []).some(y => same(x,y)))];
      else throw Error('Unsupported FieldValue.' + val.__fieldValue);
    } else if (merge && val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Timestamp)) result[key] = materialize(result[key], val, true);
    else result[key] = clone(val);
  }
  return result;
}
class DocSnapshot {
  constructor(ref, value) { this.ref=ref; this.id=ref.id; this.exists=value !== undefined; this._value=value; }
  data() { return this.exists ? clone(this._value) : undefined; }
  get(field) { return at(this.data(),field); }
}
class QuerySnapshot {
  constructor(docs) { this.docs=docs; this.size=docs.length; this.empty=!docs.length; }
  forEach(fn) { this.docs.forEach(fn); }
}
class DocRef {
  constructor(db, collection, id) { this.db=db; this.collectionName=collection; this.id=id; this.path=collection+'/'+id; }
  async get() { return new DocSnapshot(this, this.db._map(this.collectionName).get(this.id)); }
  async set(value, options={}) { if (options && Object.keys(options).some(k => k !== 'merge')) throw Error('Unsupported doc.set option'); this.db._map(this.collectionName).set(this.id,materialize(this.db._map(this.collectionName).get(this.id),value,!!options.merge)); }
  async update(value) { const map=this.db._map(this.collectionName); if (!map.has(this.id)) throw Error('doc.update missing '+this.path); map.set(this.id,materialize(map.get(this.id),value,true)); }
  async delete() { this.db._map(this.collectionName).delete(this.id); }
  collection(name) { return new CollectionRef(this.db,this.path+'/'+name); }
}
class Query {
  constructor(db, name, filters=[], orders=[], max=null) { Object.assign(this,{db,name,filters,orders,max}); }
  where(field,op,value) { if (!['==','!=','<','<=','>','>=','in','not-in','array-contains','array-contains-any'].includes(op)) throw Error('Unsupported where '+op); return new Query(this.db,this.name,[...this.filters,{field,op,value}],this.orders,this.max); }
  orderBy(field,direction='asc') { if (!['asc','desc'].includes(direction)) throw Error('Unsupported orderBy '+direction); return new Query(this.db,this.name,this.filters,[...this.orders,{field,direction}],this.max); }
  limit(n) { if (!Number.isInteger(n)||n<0) throw Error('Unsupported limit '+n); return new Query(this.db,this.name,this.filters,this.orders,n); }
  async get() {
    let docs=[...this.db._map(this.name)].map(([id,v]) => new DocSnapshot(new DocRef(this.db,this.name,id),v));
    for(const {field,op,value} of this.filters) docs=docs.filter(s => { const x=at(s._value,field), c=compare(x,value); switch(op) { case '==':return same(x,value); case '!=':return x!==undefined&&!same(x,value); case '<':return x!==undefined&&c<0; case '<=':return x!==undefined&&c<=0; case '>':return x!==undefined&&c>0; case '>=':return x!==undefined&&c>=0; case 'in':return Array.isArray(value)&&value.some(y=>same(x,y)); case 'not-in':return Array.isArray(value)&&x!==undefined&&!value.some(y=>same(x,y)); case 'array-contains':return Array.isArray(x)&&x.some(y=>same(y,value)); case 'array-contains-any':return Array.isArray(x)&&Array.isArray(value)&&x.some(y=>value.some(z=>same(y,z))); default:throw Error('Unsupported where '+op); } });
    if(this.orders.length) docs.sort((a,b)=>{for(const o of this.orders){const c=compare(at(a._value,o.field),at(b._value,o.field));if(c)return o.direction==='desc'?-c:c;}return 0;});
    return new QuerySnapshot(this.max===null?docs:docs.slice(0,this.max));
  }
}
class CollectionRef extends Query {
  constructor(db,name) { super(db,name); this.id=name.split('/').at(-1); this.path=name; }
  doc(id) { return new DocRef(this.db,this.name,id || this.db._id()); }
  async add(value) { const ref=this.doc(); await ref.set(value); return ref; }
}
class Database {
  constructor() { this.store=data; this.seq=0; }
  _id() { return 'demo-added-'+String(++this.seq).padStart(5,'0'); }
  _map(name) { if(!this.store[name]) this.store[name]=new Map(); return this.store[name]; }
  collection(name) { return new CollectionRef(this,name); }
  doc(path) { const pieces=path.split('/'); if(pieces.length<2||pieces.length%2) throw Error('Unsupported db.doc path '+path); return new DocRef(this,pieces.slice(0,-1).join('/'),pieces.at(-1)); }
  batch() { const jobs=[]; const b={set:(r,v,o)=>{jobs.push(()=>r.set(v,o));return b;},update:(r,v)=>{jobs.push(()=>r.update(v));return b;},delete:r=>{jobs.push(()=>r.delete());return b;},commit:async()=>{for(const job of jobs)await job();}}; return b; }
  async runTransaction(fn) { const jobs=[]; const tx={get:r=>r.get(),set:(r,v,o)=>{jobs.push(()=>r.set(v,o));return tx;},update:(r,v)=>{jobs.push(()=>r.update(v));return tx;},delete:r=>{jobs.push(()=>r.delete());return tx;}}; const result=await fn(tx); for(const job of jobs)await job(); return result; }
}
const db=new Database();
module.exports={ db, raw, Timestamp, FieldValue, initializeApp:()=>({name:'[DEFAULT]'}), getFirestore:()=>db, getStorage:()=>({bucket:()=>{throw Error('Unsupported storage.bucket');}}), getMessaging:()=>({sendEachForMulticast:async()=>{throw Error('Unsupported messaging.sendEachForMulticast');}}) };
