import crypto from 'node:crypto';
export default async function handler(req,res){
  const r=await fetch('https://dominaweb3-analytics.vercel.app/reel-factory-deploy/data/scripts-b64-08.json',{cache:'no-store'});
  const j=await r.json(); const s=String(j.data||''); const out=[];
  for(let n=2000;n<=2500;n+=25) out.push([n,crypto.createHash('sha256').update(s.slice(0,n)).digest('hex').slice(0,10)]);
  res.status(200).json({len:s.length,out,slice:s.slice(1950,2550)});
}