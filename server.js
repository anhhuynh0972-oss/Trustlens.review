const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const port = Number(process.env.PORT || 3000);
const mime = {'.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.md':'text/markdown; charset=utf-8'};
function send(res,status,body,type='text/plain; charset=utf-8'){res.writeHead(status,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(body);}
function readBody(req,limit=2_000_000){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>limit){reject(new Error('Request too large'));req.destroy();}});req.on('end',()=>resolve(b));req.on('error',reject);});}
async function handleAnalyze(req,res){
 if(!process.env.GEMINI_API_KEY){return send(res,404,JSON.stringify({error:'Gemini is not configured; local analysis is available in the browser.'}),'application/json; charset=utf-8');}
 try{
  const body=JSON.parse(await readBody(req));const reviews=Array.isArray(body.reviews)?body.reviews:[];
  if(!reviews.length||reviews.length>500) return send(res,400,JSON.stringify({error:'Provide between 1 and 500 reviews.'}),'application/json; charset=utf-8');
  const safeReviews=reviews.map(r=>({id:String(r.id||'').slice(0,100),text:String(r.text||'').slice(0,4000)})).filter(r=>r.id&&r.text);
  const prompt=`You are TrustLens, an evidence-grounded review interpretation assistant. Return ONLY valid JSON with keys: summary (string), strengths (array of objects {title, evidence_review_ids}), weaknesses (array of objects {title, evidence_review_ids}), potential_concerns (array of objects {title, rationale, evidence_review_ids}), limitations (array of strings). Use only the supplied reviews. Do not invent text, counts, citations, seller details, or facts. Use cautious neutral language; repeated complaints are signals, not proof of fraud or safety hazards. Every evidence_review_ids value must exactly match a supplied review ID and directly support the claim. Do not calculate or report percentages. Mention uncertainty. Reviews JSON:\n${JSON.stringify(safeReviews)}`;
  const endpoint='https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='+encodeURIComponent(process.env.GEMINI_API_KEY);
  const upstream=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:0.1}})});
  if(!upstream.ok){const t=await upstream.text();return send(res,502,JSON.stringify({error:'Gemini provider returned an error',detail:t.slice(0,500)}),'application/json; charset=utf-8');}
  const data=await upstream.json();const text=data.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';
  let ai;try{ai=JSON.parse(text);}catch{return send(res,502,JSON.stringify({error:'Gemini returned invalid JSON'}),'application/json; charset=utf-8');}
  if(typeof ai.summary!=='string'||!Array.isArray(ai.strengths)||!Array.isArray(ai.potential_concerns)||!Array.isArray(ai.limitations))return send(res,502,JSON.stringify({error:'Gemini response failed schema validation'}),'application/json; charset=utf-8');
  const ids=new Set(safeReviews.map(r=>r.id));
  for(const key of ['strengths','weaknesses','potential_concerns']){if(!Array.isArray(ai[key]))ai[key]=[];ai[key]=ai[key].map(x=>({...x,evidence_review_ids:Array.isArray(x.evidence_review_ids)?x.evidence_review_ids.filter(id=>ids.has(id)):[]})).filter(x=>x.evidence_review_ids.length);}
  return send(res,200,JSON.stringify({ai}),'application/json; charset=utf-8');
 }catch(e){return send(res,500,JSON.stringify({error:'Analysis failed',detail:e.message}),'application/json; charset=utf-8');}
}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(req.method==='POST'&&url.pathname==='/api/analyze')return handleAnalyze(req,res);
 if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,'Method not allowed');
 let pathname=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
 const full=path.normalize(path.join(root,pathname));
 if(!full.startsWith(root))return send(res,403,'Forbidden');
 fs.readFile(full,(err,buf)=>{if(err)return send(res,404,'Not found');res.writeHead(200,{'Content-Type':mime[path.extname(full)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:buf);});
});
server.listen(port,'0.0.0.0',()=>console.log(`TrustLens running at http://localhost:${port}`));
