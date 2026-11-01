// Independent second method: per-player game-by-game history (no leaderboard code path).
const X=require('./load');const BP={1:90,2:85,3:80,4:70,5:60,6:50,7:40,8:30,9:20,10:10};
const t=s=>{const [m,d,y]=s.split('/').map(Number);return y*10000+m*100+d;};
const win={TE_S:['Tight End','6/30/2026','8/4/2026'],TE_F:['Tight End','8/25/2026','11/10/2026'],WC_S:['Wild Corgi','7/2/2026','8/6/2026'],WC_F:['Wild Corgi','8/27/2026','11/12/2026']};
const regular=new Set(Object.values(X.schedule).filter(s=>s.type==='Regular').map(s=>s.venue+'|'+s.date));
function hist(name,key){const [v,a,b]=win[key];const inw=d=>t(d)>=t(a)&&t(d)<=t(b)&&regular.has(v+'|'+d);
 const games={};
 Object.values(X.elims).filter(e=>e.player===name&&e.venue===v&&inw(e.date)).forEach(e=>games[e.date+'#'+e.gameNum]={rank:e.rank,pts:(e.bonusPoints!=null?e.bonusPoints:BP[e.rank])+10});
 Object.values(X.checkins).filter(c=>c.player===name&&c.venue===v&&inw(c.date)&&c.attendanceOnly===true).forEach(c=>{const k=c.date+'#'+c.gameNum;if(!games[k])games[k]={rank:null,pts:10};else if(games[k].rank==null)games[k].pts+=10;});
 const bc=Object.values(X.bounties).filter(x=>x.player===name&&x.venue===v&&inw(x.date)).reduce((s,x)=>s+x.count,0);
 const g=Object.values(games);return {pts:g.reduce((s,x)=>s+x.pts,0),gp:g.length,wins:g.filter(x=>x.rank===1).length,best:Math.min(...g.map(x=>x.rank??99)),b:bc,games};}
const q=[['Alex Pellbrook','TE_F'],['Drew Ashgrove','TE_F'],['Drew Ashgrove','WC_F'],['Kendall Vossington','TE_S'],['Dana Kestrelton','WC_F'],['Jordan Wexmoor','WC_F'],['Yael Thistlecombe','TE_F'],['Yael Thistlecombe','WC_F'],['Rowan Wexmoor','WC_F'],['Kendall Sablewood','TE_F'],['Casey Fenwhistle','TE_F'],['Wren Larkspurne','WC_F'],['Wren Gallowpike','TE_F'],['Yael Larkspurne','WC_F'],['Val Thistlecombe','WC_S'],['Gray Dellacourt','TE_F'],['Frankie Wexmoor','TE_F'],['Avery Orrinsby','TE_F'],['Jordan Wexmoor','TE_F'],['Jordan W','TE_F'],['Avery Orrinsb','TE_F'],['Frankie','WC_F'],['Jordan Coldharbour','WC_F'],['Oakley Kestrelton','WC_F'],['Kendall Vossington','TE_F']];
for(const [n,k] of q){const h=hist(n,k);console.log(n,k,'pts',h.pts,'gp',h.gp,'wins',h.wins,'best',h.best,'bounties',h.b);}
console.log(hist('Frankie Wexmoor','WC_F').games['10/1/2026#2']);
console.log(hist('Bailey Umberhill','TE_F').games['10/20/2026#2']);
console.log('Casey F',hist('Casey Fenwhistle','TE_F').games);
