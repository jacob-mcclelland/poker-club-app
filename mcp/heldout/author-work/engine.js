// Independent re-implementation of computeLeaderboard (functions/index.js) over the fixtures.
const X=require('./load');
const BP={1:90,2:85,3:80,4:70,5:60,6:50,7:40,8:30,9:20,10:10};
const pd=s=>{const d=new Date(s);return isNaN(d)?null:d;};
const inWin=(d,s,e)=>{d=pd(d);if(!d)return false;s=pd(s);e=pd(e);if(s&&d<s)return false;if(e&&d>e)return false;return true;};
const elig=t=>(t===undefined||t===null||t==='')?true:t==='Regular';
function seasonsOf(v){return Object.entries(X.seasons).map(([id,s])=>({id,...s})).filter(s=>s.venue===v);}
function currentSeason(v,today='10/20/2026'){let best=null;const t=pd(today);for(const s of seasonsOf(v)){const st=pd(s.startDate);if(st>t)continue;if(!best||st>pd(best.startDate))best=s;}return best;}
function nonSeason(v){const o=new Set();for(const r of Object.values(X.schedule)){if((r.venue||r.location)!==v)continue;if(elig(r.type))continue;o.add(r.date);}return o;}
function standings(venue,season){
  const s=season||currentSeason(venue);const {startDate,endDate,seasonNumber}=s;
  const ns=nonSeason(venue);const ps={};const pe={};
  const ens=n=>ps[n]=ps[n]||{points:0,bounties:0,gamesPlayed:0,wins:0,games:new Set()};
  for(const d of Object.values(X.elims)){if(d.venue!==venue)continue;if(d.status==='removed')continue;if(!elig(d.gameType))continue;if(ns.has(d.date))continue;if(!inWin(d.date,startDate,endDate))continue;
    const gk=`${d.date}-${d.gameNum}`;const pl=d.playerLower||d.player.toLowerCase();(pe[pl]=pe[pl]||new Set()).add(gk);
    const st=ens(d.player);let pts=0,win=false;
    if(d.totalPoints!=null){pts=d.totalPoints;win=d.rank===1;}else if(d.bonusPoints!=null){pts=d.bonusPoints+10;win=d.rank===1||d.bonusPoints===90;}else if(d.rank!=null){if(d.rank>10){pts=d.rank;win=d.rank>=100}else{pts=(BP[d.rank]||0)+10;win=d.rank===1;}}
    st.points+=pts;if(!st.games.has(gk)){st.games.add(gk);st.gamesPlayed++;}if(win)st.wins++;}
  const seen=new Set();
  for(const d of Object.values(X.bounties)){if(d.venue!==venue||d.status==='removed')continue;const k=`${d.player.toLowerCase()}|${d.date}|${d.gameNum}`;if(seen.has(k))continue;seen.add(k);if(ns.has(d.date))continue;if(!inWin(d.date,startDate,endDate))continue;ens(d.player).bounties+=d.count||0;}
  for(const d of Object.values(X.checkins)){if(d.venue!==venue||d.attendanceOnly!==true)continue;const gk=`${d.date}-${d.gameNum}`;const pl=d.playerLower||d.player.toLowerCase();
    if(d.status==='removed')continue;if(!inWin(d.date,startDate,endDate))continue;if(!elig(d.gameType))continue;if(pe[pl]&&pe[pl].has(gk))continue;
    const st=ens(d.player);st.points+=10;if(!st.games.has(gk)){st.games.add(gk);st.gamesPlayed++;}}
  const rh={},hg={};const byL={};Object.entries(ps).forEach(([n,st])=>byL[n.toLowerCase()]=st);
  for(const d of Object.values(X.rsvps)){if(d.venue!==venue||d.status!=='converted')continue;if(ns.has(d.date))continue;if(!inWin(d.date,startDate,endDate))continue;const pl=d.playerLower;const st=byL[pl];const gk=`${d.date}-${d.gameNum}`;if(!st||!st.games.has(gk))continue;hg[pl]=hg[pl]||new Set();if(hg[pl].has(gk))continue;hg[pl].add(gk);rh[pl]=(rh[pl]||0)+1;}
  const rows=Object.entries(ps).map(([name,st])=>({name,points:st.points,bounties:st.bounties,gamesPlayed:st.gamesPlayed,rsvpsHonored:rh[name.toLowerCase()]||0,wins:st.wins,qualified:st.wins>0,games:st.games}))
   .sort((a,b)=>b.points-a.points||b.gamesPlayed-a.gamesPlayed||b.rsvpsHonored-a.rsvpsHonored||a.name.localeCompare(b.name));
  rows.forEach((r,i)=>{if(i===0)r.rank=1;else{const p=rows[i-1];r.rank=(r.points===p.points&&r.gamesPlayed===p.gamesPlayed&&r.rsvpsHonored===p.rsvpsHonored)?p.rank:i+1;}});
  rows.forEach(r=>r.tied=rows.filter(o=>o.rank===r.rank).length>1);
  return {season:s,rows};
}
function game(venue,date,gameNum){
  const ci=Object.entries(X.checkins).filter(([k,c])=>c.venue===venue&&c.date===date&&c.gameNum===gameNum).sort((a,b)=>a[1].createdAt.localeCompare(b[1].createdAt)||a[0].localeCompare(b[0]));
  const el=Object.values(X.elims).filter(c=>c.venue===venue&&c.date===date&&c.gameNum===gameNum).sort((a,b)=>a.rank-b.rank);
  const bo=Object.values(X.bounties).filter(c=>c.venue===venue&&c.date===date&&c.gameNum===gameNum);
  return {ci:ci.map(x=>x[1]),ciIds:ci.map(x=>x[0]),el,bo};
}
module.exports={standings,game,currentSeason,seasonsOf,BP};
