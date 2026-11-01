const E=require('./engine');const X=require('./load');
const show=(v,d,n)=>{const g=E.game(v,d,n);console.log('##',v,d,n,'field',g.ci.length,'elims',g.el.map(e=>e.rank+':'+e.player+':'+e.bonusPoints).join(' | '));console.log('   bounties',g.bo.map(b=>b.player+':'+b.count).join(' | '));return g;};
show('Tight End','9/8/2026',1);show('Wild Corgi','9/24/2026',2);show('Wild Corgi','7/9/2026',2);show('Tight End','10/13/2026',2);show('Wild Corgi','10/15/2026',1);show('Wild Corgi','10/15/2026',2);show('Wild Corgi','9/17/2026',1);show('Tight End','9/22/2026',1);
const g=show('Wild Corgi','9/10/2026',2);console.log(g.ci.map(c=>c.createdAt+' '+c.player).join('\n'));
const R=(v,s)=>E.standings(v,E.seasonsOf(v).find(x=>x.name===s)).rows;
const find=(v,s,n)=>R(v,s).find(r=>r.name===n);
for(const [v,s,n] of [['Tight End','Fall 2026','Casey Fenwhistle'],['Wild Corgi','Fall 2026','Kendall Everhollow'],['Wild Corgi','Fall 2026','Kendall Sablewood'],['Wild Corgi','Fall 2026','Kendall Vossington'],['Tight End','Fall 2026','Gray Rastervale'],['Tight End','Fall 2026','Bailey Umberhill'],['Wild Corgi','Fall 2026','Wren Larkspurne'],['Tight End','Fall 2026','Wren Gallowpike']])console.log(v,s,JSON.stringify({...find(v,s,n),games:undefined}));
