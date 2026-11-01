const E=require('./engine');
const R=(v,s)=>E.standings(v,E.seasonsOf(v).find(x=>x.name===s)).rows;
const te=R('Tight End','Fall 2026'),wc=R('Wild Corgi','Fall 2026');
const g=E.game('Tight End','9/22/2026',1);console.log(g.el.map(e=>e.player+':'+(te.find(r=>r.name===e.player)||{}).rank).join(' | '));
for(const n of ['Drew Ashgrove','Dana Kestrelton','Jordan Wexmoor','Kendall Vossington'])console.log(n,'TE',JSON.stringify((({games,...r})=>r)(te.find(r=>r.name===n)||{})),'WC',JSON.stringify((({games,...r})=>r)(wc.find(r=>r.name===n)||{})));
console.log(te.filter(r=>r.rank===44).map(r=>r.name), wc.filter(r=>r.rank===42).map(r=>r.name));
console.log(te.slice(0,2).map(r=>r.name+r.points));
