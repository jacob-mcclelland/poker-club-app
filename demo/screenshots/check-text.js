'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'../..');
const seed=fs.readFileSync(path.join(root,'demo/seed.js'),'utf8');
const lastBlock=seed.match(/const LAST = \[([\s\S]*?)\];/);
if(!lastBlock) throw Error('Cannot locate LAST in demo/seed.js');
const surnames=new Set([...lastBlock[1].matchAll(/'([^']+)'/g)].map(m=>m[1]));
const allowedPath=path.join(__dirname,'allowed-phrases.txt');
const allowed=new Set(fs.readFileSync(allowedPath,'utf8').split(/\r?\n/).map(x=>x.trim()).filter(Boolean));
const firstBlock=seed.match(/const FIRST = \[([\s\S]*?)\];/);
const firstNames=new Set([...firstBlock[1].matchAll(/'([^']+)'/g)].map(m=>m[1]));
for(const phrase of allowed) {
  const words=phrase.split(/\s+/);
  if(words.length===2&&firstNames.has(words[0])&&surnames.has(words[1])) throw Error('Person name in allowed-phrases.txt: '+phrase);
}
const files=fs.readdirSync(path.join(__dirname,'out')).filter(x=>x.endsWith('.txt')).sort();
if(files.length!==10) throw Error('Expected 10 captured text files, got '+files.length);
const errors=[];
for(const file of files) {
  const content=fs.readFileSync(path.join(__dirname,'out',file),'utf8');
  for(const m of content.matchAll(/\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/gi)) {
    const domain=m[0].split('@')[1].toLowerCase();
    if(!(/^(?:example\.(?:com|org|net)|(?:.+\.)?test|(?:.+\.)?example)$/.test(domain))) errors.push(`${file}: unexpected email ${m[0]}`);
  }
  for(const m of content.matchAll(/(?<!\d)(?:\+1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?!\d)/g)) {
    if(m[2]!=='555') errors.push(`${file}: unexpected phone ${m[0]}`);
  }
  if(file!=='10-sample-invoice.txt'&&/\$\s*\d[\d,]*(?:\.\d{2})?/.test(content)) errors.push(`${file}: dollar amount`);
  for(const line of content.split(/\r?\n/)) {
    for(const m of line.matchAll(/\b([A-Z][a-z]+) ([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\b/g)) {
      const phrase=m[0];
      if(!surnames.has(m[2])&&![...allowed].some(label=>label.includes(phrase))) errors.push(`${file}: unapproved phrase ${phrase}`);
    }
  }
}
if(errors.length) { console.error([...new Set(errors)].join('\n')); process.exitCode=1; }
else console.log(`Text check passed: ${files.length} pages, ${allowed.size} allowed UI phrases`);
