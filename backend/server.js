import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
const app = express();
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const APP_ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const adminSessions = new Map();
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map(x => x.trim()).filter(Boolean);

if (!GEMINI_API_KEY) console.error('Missing GEMINI_API_KEY environment secret');
if (!APP_ACCESS_TOKEN) console.error('Missing APP_ACCESS_TOKEN environment secret');
app.disable('x-powered-by');
app.use(cors({origin(origin, cb) { if (!origin || allowed.includes('*') || allowed.includes(origin)) return cb(null, true); return cb(new Error('Origin not allowed')); }, methods:['GET','POST'], allowedHeaders:['Content-Type','x-pq-token','x-pq-admin']}));
app.use(express.json({limit:'180kb'}));
app.use(rateLimit({windowMs:60_000,limit:12,standardHeaders:true,legacyHeaders:false}));
app.use((req,res,next)=>{ if(req.path==='/api/health') return next(); const supplied=req.get('x-pq-token')||''; if(!APP_ACCESS_TOKEN || supplied.length!==APP_ACCESS_TOKEN.length || supplied!==APP_ACCESS_TOKEN) return res.status(401).json({error:'Unauthorised. Check the backend access token in PDF Quest Admin.'}); next(); });
app.post('/api/admin/login',(req,res)=>{
  try {
    const password = String(req.body?.password || '');
    if (!ADMIN_PASSWORD) {
      return res.status(503).json({error:'Admin password is not configured.'});
    }

    const expected = Buffer.from(ADMIN_PASSWORD);
    const supplied = Buffer.from(password);

    if (expected.length !== supplied.length ||
        !crypto.timingSafeEqual(expected, supplied)) {
      return res.status(401).json({error:'Incorrect admin password.'});
    }

    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, Date.now() + 8 * 60 * 60 * 1000);

    return res.json({token, expiresIn:28800});
  } catch (error) {
    return res.status(500).json({error:'Admin login failed.'});
  }
});
app.get('/api/health',(req,res)=>res.json({ok:Boolean(GEMINI_API_KEY&&APP_ACCESS_TOKEN),model:MODEL,service:'PDF Quest UPSC AI'}));

const schema={type:'OBJECT',properties:{questions:{type:'ARRAY',items:{type:'OBJECT',properties:{question:{type:'STRING'},options:{type:'ARRAY',items:{type:'STRING'}},answer:{type:'INTEGER'},explanation:{type:'STRING'},topic:{type:'STRING'},difficulty:{type:'STRING',enum:['basic','moderate','advanced']},questionType:{type:'STRING',enum:['statement-based','conceptual','chronology','match-the-following','assertion-reason','factual']},sourcePage:{type:'INTEGER'},sourceEvidence:{type:'STRING'}},required:['question','options','answer','explanation','topic','difficulty','questionType','sourcePage','sourceEvidence']}}},required:['questions']};
const systemPrompt=`You are an expert UPSC Civil Services Examination question setter and a rigorous source-bound examiner. Create high-quality UPSC CSE Prelims General Studies Paper-I MCQs using ONLY the supplied PDF page text. Do not create generic, trivia, fill-in-the-blank, or sentence-deletion questions. Questions must test meaningful concepts, relationships, chronology, institutions, causes/consequences, constitutional/legal provisions, historical interpretation, geography/ecology/economy/science as relevant to the PDF. Use authentic UPSC style: often 2-3 numbered statements and combinations such as 'Which of the statements given above are correct?'. Vary formats naturally: statement-based, conceptual/application, chronology, match-the-following, assertion-reason and factual only when the source supports them. Four plausible, parallel options exactly; one unambiguously correct answer. Distractors must be plausible but decisively wrong. Never use outside knowledge to fill gaps. If the source text is insufficient to establish an answer, omit that question. Do not invent names, dates, page references, quotations or facts. Each question must cite the exact source page number and a short verbatim evidence excerpt from that page. Explanations should state why the correct option is correct and briefly clarify the key trap in incorrect statements/options. Avoid duplicate/rephrased questions. No answer ambiguity. Return only schema-conforming JSON.`;
function requireAdmin(req,res,next) {
  const token = req.get('x-pq-admin') || '';
  const expires = adminSessions.get(token);

  if (!expires || expires < Date.now()) {
    adminSessions.delete(token);
    return res.status(403).json({error:'Admin login required or session expired.'});
  }

  next();
}
app.post('/api/generate', requireAdmin, async (req,res)=>{
 try {
  if(!GEMINI_API_KEY) return res.status(503).json({error:'Gemini key is not configured on the backend.'});
  const {pages,source,subject='UPSC General Studies',style='balanced',difficulty='moderate',count=5}=req.body||{};
  if(!Array.isArray(pages)||pages.length<1||pages.length>20) return res.status(400).json({error:'Provide 1–20 PDF pages per request.'});
  if(pages.some(p=>!Number.isInteger(p.page)||typeof p.text!=='string'||p.text.length>14000)) return res.status(400).json({error:'Invalid page text payload.'});
  const text=pages.map(p=>`[PDF PAGE ${p.page}]\n${p.text}`).join('\n\n');
  if(text.trim().length<180) return res.status(422).json({error:'Not enough readable text in this batch to create reliable questions.'});
  const n=Math.max(1,Math.min(8,Number(count)||5));
  const prompt=`Source PDF: ${String(source||'Uploaded PDF').slice(0,160)}\nUPSC subject context: ${String(subject).slice(0,100)}\nQuestion style: ${style}. Difficulty: ${difficulty}. Target count: ${n}.\nCreate up to ${n} non-repetitive, high-quality UPSC Prelims MCQs from this source batch. Prefer statement-based and conceptual questions. Only produce questions that can be answered from the provided text. sourcePage must exactly match one of the page numbers below. sourceEvidence must be a short verbatim excerpt from that same page.\n\nSOURCE TEXT:\n${text}`;
  
   let upstream;
   let payload;
   for (let attempt = 0; attempt < 4; attempt++) {
     upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'x-goog-api-key': GEMINI_API_KEY
       },
       body: JSON.stringify({
         systemInstruction: { parts: [{ text: systemPrompt }] },
         contents: [{ role: 'user', parts: [{ text: prompt }] }],
         generationConfig: {
           temperature: 0.25,
           topP: 0.85,
           maxOutputTokens: 7000,
           responseMimeType: 'application/json',
           responseSchema: schema
         }
       })
     });
     payload = await upstream.json();
     if (upstream.ok || ![429, 500, 502, 503, 504].includes(upstream.status) || attempt === 3) break;
     const waitMs = 2000 * (2 ** attempt);
     console.log(`Gemini temporarily unavailable. Retrying in ${waitMs / 1000}s...`);
     await new Promise(resolve => setTimeout(resolve, waitMs));
   }

  if(!upstream.ok){const msg=payload?.error?.message||`Gemini request failed (${upstream.status})`;return res.status(502).json({error:msg.slice(0,500)});}
  const raw=payload?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';
  let parsed;try{parsed=JSON.parse(raw)}catch{return res.status(502).json({error:'Gemini returned malformed structured output. Please retry this batch.'});}
  const pageSet=new Set(pages.map(p=>p.page));
  const questions=(parsed.questions||[]).filter(q=>{
    if(typeof q.question!=='string'||q.question.length<25||!Array.isArray(q.options)||q.options.length!==4||q.options.some(x=>typeof x!=='string'||!x.trim())||new Set(q.options.map(x=>x.trim().toLowerCase())).size!==4)return false;
    if(!Number.isInteger(q.answer)||q.answer<0||q.answer>3||!pageSet.has(q.sourcePage))return false;
    const page=pages.find(p=>p.page===q.sourcePage);const ev=String(q.sourceEvidence||'').trim();
    return ev.length>=12 && page.text.toLowerCase().includes(ev.toLowerCase());
  }).slice(0,n);
  return res.json({questions,model:MODEL,received:parsed.questions?.length||0,rejected:(parsed.questions?.length||0)-questions.length});
 } catch(e){console.error('Generation error:',e);return res.status(500).json({error:'Unexpected backend error. Check server logs and try again.'});}
});
app.get('/',(req,res)=>res.json({service:'PDF Quest UPSC AI backend',status:'running'}));
app.listen(PORT,()=>console.log(`PDF Quest AI backend listening on ${PORT}`));
