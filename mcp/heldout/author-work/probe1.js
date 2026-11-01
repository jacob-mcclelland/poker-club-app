const E=require('./engine');const X=require('./load');
const g=E.game('Tight End','9/29/2026',1);
console.log(g.ci.filter(c=>c.playerLower==='casey fenwhistle'), g.el.filter(e=>e.playerLower==='casey fenwhistle'));
const g2=E.game('Tight End','10/20/2026',2);console.log(g2.el.map(e=>[e.rank,e.player,e.bonusPoints,e.status].join(',')));
// ties per game
const keys=new Set(Object.values(X.elims).map(e=>`${e.venue}|${e.date}|${e.gameNum}`));
for(const k of keys){const [v,d,n]=k.split('|');const gg=E.game(v,d,+n);const c={};gg.el.forEach(e=>c[e.rank]=(c[e.rank]||[]).concat(e.player));for(const [r,ps] of Object.entries(c))if(ps.length>1)console.log('TIE',k,r,ps.join(' & '),gg.el.find(e=>e.rank==r).bonusPoints);}
// RSVP-tiebreak pairs
for(const v of ['Tight End','Wild Corgi'])for(const s of E.seasonsOf(v)){const {rows}=E.standings(v,s);for(let i=1;i<rows.length;i++){const a=rows[i-1],b=rows[i];if(a.points===b.points&&a.gamesPlayed===b.gamesPlayed)console.log('samePtsGP',v,s.name,a.rank,a.name,a.rsvpsHonored,'|',b.rank,b.name,b.rsvpsHonored,a.points,a.gamesPlayed);}}
