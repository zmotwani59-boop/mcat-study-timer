const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

app.use(express.json({ limit: '5mb' }));
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, X-ZHQ-Connection');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

const connections = new Map();
const oauthStates = new Map();

function makeOAuth(){
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, `${BASE_URL}/auth/google/callback`);
}
function authForCode(code){
  const tokens=connections.get(code);
  if(!tokens) return null;
  const c=makeOAuth(); c.setCredentials(tokens); return c;
}
function requireConnection(req,res,next){
  const code=req.get('X-ZHQ-Connection')||'';
  const auth=authForCode(code);
  if(!auth) return res.status(401).json({ok:false,error:'not_connected'});
  req.googleAuth=auth; req.connectionCode=code; next();
}
const SCOPES=[
  'openid','email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets.readonly'
];

app.get('/health',(_req,res)=>res.json({ok:true,service:'zahra-hq-google-bridge',googleConfigured:!!(CLIENT_ID&&CLIENT_SECRET)}));

app.get('/auth/google',(req,res)=>{
  if(!CLIENT_ID||!CLIENT_SECRET) return res.status(503).send('Google OAuth is not configured yet.');
  const state=crypto.randomBytes(20).toString('hex');
  oauthStates.set(state,{createdAt:Date.now()});
  const url=makeOAuth().generateAuthUrl({access_type:'offline',prompt:'consent',scope:SCOPES,state});
  res.redirect(url);
});

app.get('/auth/google/callback',async(req,res)=>{
  try{
    const st=oauthStates.get(req.query.state); oauthStates.delete(req.query.state);
    if(!st || Date.now()-st.createdAt>10*60*1000) throw new Error('invalid_oauth_state');
    const client=makeOAuth();
    const {tokens}=await client.getToken(req.query.code);
    const code=crypto.randomBytes(24).toString('hex');
    connections.set(code,tokens);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Zahra HQ connected</title><body style="font:16px system-ui;padding:32px">Google connected to Zahra HQ. This window can close.<script>try{window.opener&&window.opener.postMessage({type:'zhq-google-connected',code:${JSON.stringify(code)}},'*')}catch(e){} setTimeout(()=>window.close(),700);</script></body>`);
  }catch(e){
    console.error(e);
    res.status(400).send('Google connection failed. You can close this window and try again.');
  }
});

app.get('/api/status',(req,res)=>{
  const code=req.get('X-ZHQ-Connection')||'';
  res.json({ok:true,connected:!!authForCode(code),googleConfigured:!!(CLIENT_ID&&CLIENT_SECRET)});
});

app.post('/auth/logout',(req,res)=>{
  const code=req.get('X-ZHQ-Connection')||'';
  if(code) connections.delete(code);
  res.json({ok:true});
});

app.get('/api/calendar',requireConnection,async(req,res)=>{
  try{
    const calendar=google.calendar({version:'v3',auth:req.googleAuth});
    const start=req.query.start||new Date().toISOString();
    const end=req.query.end||new Date(Date.now()+45*86400000).toISOString();
    const r=await calendar.events.list({calendarId:'primary',timeMin:start,timeMax:end,singleEvents:true,orderBy:'startTime',maxResults:500});
    const events=(r.data.items||[]).map(e=>({id:e.id,title:e.summary||'(Untitled)',date:(e.start?.dateTime||e.start?.date||'').slice(0,10),start:e.start?.dateTime||'',end:e.end?.dateTime||'',allDay:!!e.start?.date,location:e.location||'',externalUrl:e.htmlLink||'',source:'gcal'}));
    res.json({ok:true,events});
  }catch(e){console.error(e);res.status(500).json({ok:false,error:'calendar_fetch_failed'});}
});

function terms(s){return String(s||'').toLowerCase().match(/[a-z0-9@._-]{3,}/g)||[];}
app.post('/api/waiting-email-matches',requireConnection,async(req,res)=>{
  try{
    const waiting=Array.isArray(req.body?.waitingOn)?req.body.waitingOn.slice(0,30):[];
    if(!waiting.length)return res.json({ok:true,emails:[]});
    const gmail=google.gmail({version:'v1',auth:req.googleAuth});
    const seen=new Set(),emails=[];
    for(const w of waiting){
      const ts=terms(`${w.who||''} ${w.what||''}`).slice(0,4); if(!ts.length)continue;
      const q=`newer_than:30d -in:spam -in:trash ${ts.slice(0,2).join(' ')}`;
      const list=await gmail.users.messages.list({userId:'me',q,maxResults:5});
      for(const m of list.data.messages||[]){
        if(seen.has(m.id))continue; seen.add(m.id);
        const full=await gmail.users.messages.get({userId:'me',id:m.id,format:'metadata',metadataHeaders:['From','Subject','Date']});
        const h=Object.fromEntries((full.data.payload?.headers||[]).map(x=>[x.name.toLowerCase(),x.value]));
        const hay=`${h.from||''} ${h.subject||''} ${full.data.snippet||''}`.toLowerCase();
        const score=ts.filter(t=>hay.includes(t)).length; if(!score)continue;
        emails.push({id:m.id,from:h.from||'',subject:h.subject||'',snippet:full.data.snippet||'',emailDate:h.date||'',waitingId:w.waitingId||'',projectId:w.projectId||'',taskId:w.taskId||'',url:`https://mail.google.com/mail/u/0/#all/${m.id}`,score});
      }
    }
    emails.sort((a,b)=>b.score-a.score); res.json({ok:true,emails:emails.slice(0,40)});
  }catch(e){console.error(e);res.status(500).json({ok:false,error:'gmail_fetch_failed'});}
});

const STATE_NAME='Zahra HQ State.json';
async function stateFile(drive){const r=await drive.files.list({q:`name='${STATE_NAME}' and trashed=false`,fields:'files(id,name,modifiedTime)',pageSize:10});return (r.data.files||[])[0]||null;}
app.get('/api/state',requireConnection,async(req,res)=>{
  try{const drive=google.drive({version:'v3',auth:req.googleAuth});const f=await stateFile(drive);if(!f)return res.json({ok:true,state:null});const r=await drive.files.get({fileId:f.id,alt:'media'},{responseType:'text'});res.json({ok:true,state:typeof r.data==='string'?JSON.parse(r.data):r.data,modifiedTime:f.modifiedTime});}catch(e){console.error(e);res.status(500).json({ok:false,error:'state_load_failed'});}
});
app.post('/api/state',requireConnection,async(req,res)=>{
  try{const drive=google.drive({version:'v3',auth:req.googleAuth});const f=await stateFile(drive);const media={mimeType:'application/json',body:JSON.stringify(req.body?.state||{},null,2)};let id;if(f){await drive.files.update({fileId:f.id,media});id=f.id;}else{const c=await drive.files.create({requestBody:{name:STATE_NAME,mimeType:'application/json'},media,fields:'id'});id=c.data.id;}res.json({ok:true,id});}catch(e){console.error(e);res.status(500).json({ok:false,error:'state_save_failed'});}
});

function googleId(url){const s=String(url||'');for(const p of [/\/d\/([A-Za-z0-9_-]+)/,/[?&]id=([A-Za-z0-9_-]+)/,/spreadsheets\/d\/([A-Za-z0-9_-]+)/]){const m=s.match(p);if(m)return m[1];}return '';}
app.post('/api/drive/read',requireConnection,async(req,res)=>{
  try{const id=googleId(req.body?.url);if(!id)return res.status(400).json({ok:false,error:'invalid_google_url'});const drive=google.drive({version:'v3',auth:req.googleAuth});const meta=await drive.files.get({fileId:id,fields:'id,name,mimeType,webViewLink'});let preview='';if(meta.data.mimeType==='application/vnd.google-apps.document'){const r=await drive.files.export({fileId:id,mimeType:'text/plain'},{responseType:'text'});preview=String(r.data||'');}else if(meta.data.mimeType==='application/vnd.google-apps.spreadsheet'){return res.json({ok:true,type:'Sheets',name:meta.data.name,url:meta.data.webViewLink||req.body.url,spreadsheetId:id,preview:'Open with the Sheets importer for a bounded preview.'});}else if(String(meta.data.mimeType||'').startsWith('text/')||meta.data.mimeType==='application/json'){const r=await drive.files.get({fileId:id,alt:'media'},{responseType:'text'});preview=String(r.data||'');}else preview=`File type: ${meta.data.mimeType||'unknown'}`;res.json({ok:true,type:'Drive',name:meta.data.name,url:meta.data.webViewLink||req.body.url,preview:preview.slice(0,12000)});}catch(e){console.error(e);res.status(500).json({ok:false,error:'drive_read_failed'});}
});
app.post('/api/sheets/read',requireConnection,async(req,res)=>{
  try{const id=googleId(req.body?.url);if(!id)return res.status(400).json({ok:false,error:'invalid_sheet_url'});const sheets=google.sheets({version:'v4',auth:req.googleAuth});const meta=await sheets.spreadsheets.get({spreadsheetId:id,fields:'properties.title,sheets.properties.title'});const first=meta.data.sheets?.[0]?.properties?.title||'Sheet1';const range=req.body?.range||`'${first.replace(/'/g,"''")}'!A1:Z50`;const r=await sheets.spreadsheets.values.get({spreadsheetId:id,range});const preview=(r.data.values||[]).map(row=>row.join('\t')).join('\n').slice(0,12000);res.json({ok:true,type:'Sheets',name:meta.data.properties?.title||'Google Sheet',url:req.body.url,preview,range});}catch(e){console.error(e);res.status(500).json({ok:false,error:'sheets_read_failed'});}
});

app.listen(PORT,()=>console.log(`Zahra HQ Google bridge listening on ${PORT}`));
