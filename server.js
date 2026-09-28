const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = String(process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.ZHQ_SESSION_SECRET || '';
const CONFIGURED = !!(CLIENT_ID && CLIENT_SECRET && SESSION_SECRET);
const REDIRECT_URI = `${BASE_URL}/auth/google/callback`;
const CONNECTION_KEY = 'zhq-google-connection';

function sessionKey(){
  if(!SESSION_SECRET) return null;
  return crypto.createHash('sha256').update(SESSION_SECRET).digest();
}
function seal(payload){
  const key=sessionKey(); if(!key) throw new Error('session_secret_missing');
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const body=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return ['v1',iv.toString('base64url'),tag.toString('base64url'),body.toString('base64url')].join('.');
}
function unseal(token){
  try{
    const [v,ivB64,tagB64,bodyB64]=String(token||'').split('.');
    if(v!=='v1') return null;
    const key=sessionKey(); if(!key) return null;
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(ivB64,'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64,'base64url'));
    const plain=Buffer.concat([decipher.update(Buffer.from(bodyB64,'base64url')),decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  }catch(_e){ return null; }
}
function makeOAuthState(){
  const ts=Date.now().toString();
  const nonce=crypto.randomBytes(16).toString('hex');
  const payload=`${ts}.${nonce}`;
  const sig=crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function validOAuthState(state){
  if(!SESSION_SECRET) return false;
  const parts=String(state||'').split('.'); if(parts.length!==3) return false;
  const [ts,nonce,sig]=parts;
  const age=Date.now()-Number(ts); if(!Number.isFinite(age)||age<0||age>10*60*1000) return false;
  const expected=crypto.createHmac('sha256',SESSION_SECRET).update(`${ts}.${nonce}`).digest();
  const actual=Buffer.from(sig,'base64url');
  return actual.length===expected.length && crypto.timingSafeEqual(actual,expected);
}

app.use(express.json({ limit: '10mb' }));
app.use((req,res,next)=>{
  if(req.get('Origin') === new URL(BASE_URL).origin) res.setHeader('Access-Control-Allow-Origin', BASE_URL);
  res.setHeader('Access-Control-Allow-Headers','Content-Type, X-ZHQ-Connection');
  res.setHeader('Access-Control-Expose-Headers','X-ZHQ-Connection-Refresh');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(/^\/(api|auth)\//.test(req.path)) res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

// Frontend and backend are one Node/Express service on Render (same-origin).
// index.html lives next to server.js at the project root — there is no build
// step and no /public folder, so `express.static('public', ...)` was serving
// nothing and GET / was falling through to Express's default 404. That is
// almost certainly the root cause of the "blank / not rendering" reports:
// depending on caching, some requests would show a stale prior deploy while
// fresh ones hit an empty response. Serve the single HTML file explicitly.
const INDEX_HTML = path.join(__dirname, 'index.html');
app.get(['/', '/index.html'], (_req,res)=>res.sendFile(INDEX_HTML));
app.use(express.static(path.join(__dirname,'public')));

const SCOPES=[
  'openid','email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets.readonly'
];
const has=(tokens,scope)=>String(tokens?.scope||'').split(/\s+/).includes(scope);
function scopeMap(tokens){
  return {
    gcal:has(tokens,'https://www.googleapis.com/auth/calendar.readonly'),
    gmail:has(tokens,'https://www.googleapis.com/auth/gmail.readonly'),
    drive:has(tokens,'https://www.googleapis.com/auth/drive.readonly'),
    sheets:has(tokens,'https://www.googleapis.com/auth/spreadsheets.readonly'),
    cloud:has(tokens,'https://www.googleapis.com/auth/drive.file')
  };
}
function makeOAuth(){ return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI); }
function requireConnection(req,res,next){
  const tokens=unseal(req.get('X-ZHQ-Connection')||'');
  if(!tokens) return res.status(401).json({ok:false,error:'not_connected'});
  const c=makeOAuth(); c.setCredentials(tokens);
  c.on('tokens',t=>{ req.newTokens={...tokens,...t,refresh_token:t.refresh_token||tokens.refresh_token}; });
  const json=res.json.bind(res);
  res.json=body=>{
    if(req.newTokens){ try{res.setHeader('X-ZHQ-Connection-Refresh',seal(req.newTokens));}catch(_e){} }
    return json(body);
  };
  req.googleAuth=c; req.tokens=tokens; next();
}
function fail(res,e,code){
  console.error(code,e?.response?.data?.error||e?.message||e);
  const st=e?.code||e?.status||e?.response?.status;
  const msg=JSON.stringify(e?.response?.data||'')+String(e?.message||'');
  if(st===401||/invalid_grant|invalid_credentials|unauthorized_client/i.test(msg)) return res.status(401).json({ok:false,error:'not_connected'});
  if(st===403&&/insufficient|scope|accessNotConfigured|has not been used|disabled/i.test(msg)) return res.status(403).json({ok:false,error:'scope_or_api_disabled'});
  if(st===404) return res.status(404).json({ok:false,error:'not_found_or_not_shared'});
  return res.status(500).json({ok:false,error:code});
}

app.get('/health',(_req,res)=>res.json({ok:true,service:'zahra-hq-google-bridge',googleConfigured:CONFIGURED,redirectUri:REDIRECT_URI}));

app.get('/api/status',(req,res)=>{
  const tokens=unseal(req.get('X-ZHQ-Connection')||'');
  res.json({ok:true,connected:!!tokens,googleConfigured:CONFIGURED,scopes:tokens?scopeMap(tokens):{}});
});

app.get('/auth/google',(_req,res)=>{
  if(!CONFIGURED) return res.status(503).send('Google OAuth is not configured yet (missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or ZHQ_SESSION_SECRET).');
  res.redirect(makeOAuth().generateAuthUrl({access_type:'offline',prompt:'consent',scope:SCOPES,state:makeOAuthState()}));
});

function authPage(msg){ return `<!doctype html><meta charset="utf-8"><title>Zahra HQ</title><body style="font:16px system-ui;padding:32px">${msg}</body>`; }
app.get('/auth/google/callback',async(req,res)=>{
  try{
    if(req.query.error) return res.status(400).type('html').send(authPage('Google connection was cancelled. You can close this window.'));
    if(!validOAuthState(req.query.state)) throw new Error('invalid_oauth_state');
    if(!req.query.code) throw new Error('missing_code');
    const {tokens}=await makeOAuth().getToken(req.query.code);
    if(!tokens.refresh_token) return res.status(400).type('html').send(authPage('Google did not return a refresh token. Remove Zahra HQ from your Google account permissions, then connect again.'));
    const code=JSON.stringify(seal(tokens)).replace(/</g,'\\u003c');
    res.type('html').send(authPage(`Google connected to Zahra HQ. This window can close.<script>(function(){var c=${code},K=${JSON.stringify(CONNECTION_KEY)};
try{localStorage.setItem(K,c)}catch(e){}
try{var b=new BroadcastChannel('zhq-google');b.postMessage({type:'zhq-google-connected',code:c});b.close()}catch(e){}
try{if(window.opener)window.opener.postMessage({type:'zhq-google-connected',code:c},location.origin)}catch(e){}
setTimeout(function(){window.close()},900)})();</script>`));
  }catch(e){
    console.error('oauth callback',e?.response?.data||e?.message||e);
    res.status(400).type('html').send(authPage('Google connection failed. You can close this window and try again.'));
  }
});

app.post('/auth/logout',(_req,res)=>{ res.json({ok:true}); });

const hhmm=x=>(/T(\d{2}:\d{2})/.exec(x||'')||[])[1]||'';
const addDay=(iso,n)=>{const d=new Date(iso+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
function toEvents(e){
  const base={title:e.summary||'(Untitled)',location:e.location||'',externalUrl:e.htmlLink||'',source:'gcal'};
  if(e.start?.date){
    const out=[],last=e.end?.date?addDay(e.end.date,-1):e.start.date;
    for(let d=e.start.date,i=0;d<=last&&i<14;d=addDay(d,1),i++)out.push({...base,id:i?`${e.id}:${d}`:e.id,date:d,start:'',end:'',allDay:true});
    return out;
  }
  return [{...base,id:e.id,date:(e.start?.dateTime||'').slice(0,10),start:hhmm(e.start?.dateTime),end:hhmm(e.end?.dateTime),allDay:false}];
}
const validDate=x=>x&&!isNaN(Date.parse(x));
app.get('/api/calendar',requireConnection,async(req,res)=>{
  try{
    const calendar=google.calendar({version:'v3',auth:req.googleAuth});
    const start=validDate(req.query.start)?new Date(req.query.start).toISOString():new Date().toISOString();
    const end=validDate(req.query.end)?new Date(req.query.end).toISOString():new Date(Date.now()+45*86400000).toISOString();
    const r=await calendar.events.list({calendarId:'primary',timeMin:start,timeMax:end,singleEvents:true,orderBy:'startTime',maxResults:500});
    res.json({ok:true,events:(r.data.items||[]).filter(e=>e.status!=='cancelled').flatMap(toEvents).filter(e=>e.date)});
  }catch(e){fail(res,e,'calendar_fetch_failed');}
});

const STOP=new Set(['the','and','for','with','from','that','this','about','have','has','will','are','was','not','you','your','our','waiting','wait','still','need','needs','get','got','confirm','confirmed','reply','replied','date','room','meeting']);
const terms=x=>(String(x||'').toLowerCase().match(/[a-z0-9@._-]{3,}/g)||[]).filter(t=>!STOP.has(t));
app.post('/api/waiting-email-matches',requireConnection,async(req,res)=>{
  try{
    const waiting=Array.isArray(req.body?.waitingOn)?req.body.waitingOn.slice(0,12):[];
    if(!waiting.length)return res.json({ok:true,emails:[]});
    const gmail=google.gmail({version:'v1',auth:req.googleAuth});
    const seen=new Set(),emails=[];
    for(const w of waiting){
      const who=terms(w.who),what=terms(w.what),ts=[...new Set([...who,...what])].slice(0,5);
      if(!ts.length)continue;
      const need=Math.min(2,ts.length);
      const q=`newer_than:30d -in:spam -in:trash -from:me ${(who.length?who:ts).slice(0,2).join(' ')}`;
      const list=await gmail.users.messages.list({userId:'me',q,maxResults:4});
      for(const m of list.data.messages||[]){
        if(seen.has(m.id+w.waitingId))continue; seen.add(m.id+w.waitingId);
        const full=await gmail.users.messages.get({userId:'me',id:m.id,format:'metadata',metadataHeaders:['From','Subject','Date']});
        const h=Object.fromEntries((full.data.payload?.headers||[]).map(x=>[x.name.toLowerCase(),x.value]));
        const hay=`${h.from||''} ${h.subject||''} ${full.data.snippet||''}`.toLowerCase();
        const score=ts.filter(t=>hay.includes(t)).length;
        if(score<need||(who.length&&!who.some(t=>hay.includes(t))))continue;
        emails.push({id:m.id,from:h.from||'',subject:h.subject||'',snippet:(full.data.snippet||'').slice(0,200),emailDate:h.date||'',waitingId:w.waitingId||'',projectId:w.projectId||'',taskId:w.taskId||'',url:`https://mail.google.com/mail/u/0/#all/${m.id}`,score});
      }
    }
    emails.sort((a,b)=>b.score-a.score);res.json({ok:true,emails:emails.slice(0,40)});
  }catch(e){fail(res,e,'gmail_fetch_failed');}
});

const STATE_NAME='Zahra HQ State.json';
async function stateFile(drive){const r=await drive.files.list({q:`name='${STATE_NAME}' and trashed=false`,fields:'files(id,name,modifiedTime)',pageSize:10});return (r.data.files||[])[0]||null;}
app.get('/api/state',requireConnection,async(req,res)=>{
  try{
    const drive=google.drive({version:'v3',auth:req.googleAuth});
    const f=await stateFile(drive);
    if(!f)return res.json({ok:true,state:null});
    const r=await drive.files.get({fileId:f.id,alt:'media'},{responseType:'text'});
    res.json({ok:true,state:typeof r.data==='string'?JSON.parse(r.data):r.data,modifiedTime:f.modifiedTime});
  }catch(e){console.error(e);res.status(500).json({ok:false,error:'state_load_failed'});}
});
app.post('/api/state',requireConnection,async(req,res)=>{
  try{
    const incoming=req.body?.state;
    if(!incoming||typeof incoming!=='object'||!Array.isArray(incoming.tasks))return res.status(400).json({ok:false,error:'invalid_state'});
    const drive=google.drive({version:'v3',auth:req.googleAuth});
    const f=await stateFile(drive);
    if(f){
      const r=await drive.files.get({fileId:f.id,alt:'media'},{responseType:'text'});
      const current=typeof r.data==='string'?JSON.parse(r.data):r.data;
      const inT=Date.parse(incoming.updatedAt||0)||0,curT=Date.parse(current?.updatedAt||0)||0;
      if(curT>inT)return res.status(409).json({ok:false,error:'stale_state',remoteUpdatedAt:current.updatedAt||''});
    }
    const media={mimeType:'application/json',body:JSON.stringify(incoming,null,2)};
    let id;
    if(f){await drive.files.update({fileId:f.id,media});id=f.id;}
    else{id=(await drive.files.create({requestBody:{name:STATE_NAME,mimeType:'application/json'},media,fields:'id'})).data.id;}
    res.json({ok:true,id});
  }catch(e){fail(res,e,'state_save_failed');}
});

function googleId(url){
  const s=String(url||'');
  for(const p of [/\/d\/([A-Za-z0-9_-]+)/,/[?&]id=([A-Za-z0-9_-]+)/,/spreadsheets\/d\/([A-Za-z0-9_-]+)/]){
    const m=s.match(p);if(m)return m[1];
  }
  return '';
}
app.post('/api/drive/read',requireConnection,async(req,res)=>{
  try{
    const id=googleId(req.body?.url);
    if(!id)return res.status(400).json({ok:false,error:'invalid_google_url'});
    const drive=google.drive({version:'v3',auth:req.googleAuth});
    const meta=await drive.files.get({fileId:id,fields:'id,name,mimeType,webViewLink'});
    let preview='';
    if(meta.data.mimeType==='application/vnd.google-apps.document'){
      const r=await drive.files.export({fileId:id,mimeType:'text/plain'},{responseType:'text'});
      preview=String(r.data||'');
    }else if(meta.data.mimeType==='application/vnd.google-apps.spreadsheet'){
      return res.json({ok:true,type:'Sheets',name:meta.data.name,url:meta.data.webViewLink||req.body.url,spreadsheetId:id,preview:'Open with the Sheets importer for a bounded preview.'});
    }else if(String(meta.data.mimeType||'').startsWith('text/')||meta.data.mimeType==='application/json'){
      const r=await drive.files.get({fileId:id,alt:'media'},{responseType:'text'});
      preview=String(r.data||'');
    }else preview=`File type: ${meta.data.mimeType||'unknown'}`;
    res.json({ok:true,type:'Drive',name:meta.data.name,url:meta.data.webViewLink||req.body.url,preview:preview.slice(0,12000)});
  }catch(e){console.error(e);res.status(500).json({ok:false,error:'drive_read_failed'});}
});
app.post('/api/sheets/read',requireConnection,async(req,res)=>{
  try{
    const id=googleId(req.body?.url);
    if(!id)return res.status(400).json({ok:false,error:'invalid_sheet_url'});
    const sheets=google.sheets({version:'v4',auth:req.googleAuth});
    const meta=await sheets.spreadsheets.get({spreadsheetId:id,fields:'properties.title,sheets.properties.title'});
    const first=meta.data.sheets?.[0]?.properties?.title||'Sheet1';
    const range=req.body?.range||`'${first.replace(/'/g,"''")}'!A1:Z50`;
    const r=await sheets.spreadsheets.values.get({spreadsheetId:id,range});
    const preview=(r.data.values||[]).map(row=>row.join('\t')).join('\n').slice(0,12000);
    res.json({ok:true,type:'Sheets',name:meta.data.properties?.title||'Google Sheet',url:req.body.url,preview,range});
  }catch(e){console.error(e);res.status(500).json({ok:false,error:'sheets_read_failed'});}
});

// Fallback: any other GET (e.g. a stray refresh, a trailing slash, a Render
// health probe on an unexpected path) still gets the app shell instead of a
// bare 404. Never swallow the real API/auth/health routes above this line.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path === '/health') {
    return res.status(404).json({ ok:false, error:'not_found' });
  }
  res.sendFile(INDEX_HTML);
});

app.listen(PORT,()=>console.log(`Zahra HQ listening on ${PORT} (base ${BASE_URL}, google ${CONFIGURED?'configured':'NOT configured'})`));