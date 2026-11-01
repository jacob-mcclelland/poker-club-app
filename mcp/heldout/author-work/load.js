const fs=require('fs'),path=require('path');
const D='/home/user/poker-club-app/demo/fixtures';
const L=n=>JSON.parse(fs.readFileSync(path.join(D,n+'.json'),'utf8'));
const pd=s=>{const [m,d,y]=s.split('/').map(Number);return new Date(y,m-1,d);};
module.exports={players:L('players'),seasons:L('seasons'),schedule:L('schedule'),checkins:L('checkins'),elims:L('eliminations'),bounties:L('bounties'),rsvps:L('rsvps'),champ:L('champ_overrides'),contacts:L('playerContacts'),pd};
