const E=require('./engine');const X=require('./load');
const by={};Object.values(X.players).forEach(p=>{const f=p.name.split(/\s+/)[0];(by[f]=by[f]||[]).push(p.name+(p.addedVia?'(imp)':''));});
const st={};for(const v of ['Tight End','Wild Corgi'])for(const s of E.seasonsOf(v))st[v+s.name]=new Set(E.standings(v,s).rows.map(r=>r.name));
Object.entries(by).sort().forEach(([f,l])=>console.log(f,l.length,l.join(', ')));
// players by surname
