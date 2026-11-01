const X=require('./load');
const {players,schedule,checkins,elims,bounties}=X;
console.log('players',Object.keys(players).length);
Object.entries(players).slice(150).forEach(([k,v])=>console.log(k,JSON.stringify(v)));
Object.entries(players).filter(([k,v])=>v.aliases).forEach(([k,v])=>console.log('alias',k,JSON.stringify(v)));
// games
const g={};
for(const c of Object.values(checkins)){const k=`${c.venue}|${c.date}|${c.gameNum}`;g[k]=g[k]||{ci:0,el:0,b:0,types:new Set()};g[k].ci++;g[k].types.add(c.gameType);}
for(const c of Object.values(elims)){const k=`${c.venue}|${c.date}|${c.gameNum}`;g[k]=g[k]||{ci:0,el:0,b:0,types:new Set()};g[k].el++;}
for(const c of Object.values(bounties)){const k=`${c.venue}|${c.date}|${c.gameNum}`;g[k]=g[k]||{ci:0,el:0,b:0,types:new Set()};g[k].b++;}
Object.entries(g).sort((a,b)=>X.pd(a[0].split('|')[1])-X.pd(b[0].split('|')[1])).forEach(([k,v])=>console.log(k,v.ci,v.el,v.b,[...v.types].join(',')));
Object.values(schedule).filter(s=>s.type!=='Regular').forEach(s=>console.log('sched',s.date,s.venue,s.type));
// odd checkins
Object.entries(checkins).filter(([k,c])=>!c.gameType||c.manuallyAdded).forEach(x=>console.log(JSON.stringify(x)));
