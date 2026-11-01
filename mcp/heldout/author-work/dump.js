const E=require('./engine');const X=require('./load');
for(const v of ['Tight End','Wild Corgi'])for(const s of E.seasonsOf(v)){const {rows}=E.standings(v,s);console.log('==',v,s.name,rows.length);rows.slice(0,25).forEach(r=>console.log(r.rank,r.tied?'T':' ',r.name,r.points,r.gamesPlayed,r.rsvpsHonored,r.wins,r.bounties));
 // ties
 const t=rows.filter(r=>r.tied);console.log('tied rows',t.length, t.slice(0,12).map(r=>r.rank+':'+r.name+':'+r.points).join(' | '));
 // equal points different rank
 for(let i=1;i<rows.length;i++)if(rows[i].points===rows[i-1].points&&rows[i].rank!==rows[i-1].rank&&rows[i].rank<=25)console.log('  ptsEq-diffrank',rows[i-1].rank,rows[i-1].name,rows[i-1].gamesPlayed,rows[i-1].rsvpsHonored,'|',rows[i].rank,rows[i].name,rows[i].gamesPlayed,rows[i].rsvpsHonored,rows[i].points);
}
