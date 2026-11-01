import {createRequire} from 'module';const require=createRequire(import.meta.url);
const E=require('./engine.js');const X=require('./load.js');
import {buildSeating,buildChampionshipRanking,rankByBounties,splitOverrides} from './champ-seating.mjs';
for(const [venue,date] of [['Tight End','8/11/2026'],['Wild Corgi','8/13/2026']]){
  const s=E.currentSeason(venue,date);const {rows}=E.standings(venue,s);
  const lead=buildChampionshipRanking(rows);const bty=rankByBounties(lead);
  const att={1:{},2:{}},time={1:{},2:{}};
  for(const g of [1,2]){
    Object.values(X.checkins).filter(c=>c.venue===venue&&c.date===date&&c.gameNum===g&&c.status==='active').forEach(c=>{att[g][c.player]='ci';const t=Date.parse(c.createdAt);if(!(c.player in time[g]&&time[g][c.player]<=t))time[g][c.player]=t;});
    Object.values(X.rsvps).filter(c=>c.venue===venue&&c.date===date&&c.gameNum===g&&c.status==='active').forEach(c=>{if(!att[g][c.player])att[g][c.player]='rsvp';});
    Object.values(X.rsvps).filter(c=>c.venue===venue&&c.date===date&&c.gameNum===g&&c.status==='declined').forEach(c=>{if(!att[g][c.player])att[g][c.player]='declined';});
  }
  const doc=Object.values(X.champ).find(d=>d.venue===venue&&d.date===date);
  const raw={1:{},2:{}};Object.entries(doc).forEach(([k,v])=>{const m=k.match(/^g([12])_(.*)$/);if(m)raw[m[1]][m[2]]=v;});
  const sp=splitOverrides(raw);
  console.log('=====',venue,date,s.name,'checkins g1',Object.keys(att[1]).length,'ci',Object.values(att[1]).filter(x=>x==='ci').length,'rsvp',Object.values(att[1]).filter(x=>x==='rsvp').length);
  for(const [g,data,f] of [[1,bty,'bounties'],[2,lead,'points']]){
    const st=buildSeating({ranked:data,attendance:att[g],checkinTime:time[g],overrides:sp.overrides[g],seats:sp.seats[g],doorsClosed:sp.doors[g],scoreField:f});
    console.log('-- game',g);
    for(const sec of ['playing','cleared','ondeck','consolation','consolWait','out'])console.log(sec,st[sec].length,st[sec].map(p=>`${p.origRank}:${p.name}:${p.score}:${p.status}${p.manual?'*':''}`).join(' | '));
    console.log(JSON.stringify(st.meta));
  }
}
