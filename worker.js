const OWNER="Golu171",REPO="study-notes",BRANCH="main";
const DEFAULT_FOLDER="HARYANA-GK/HARYANA-CURRENT";
const MAX_FILE_SIZE=20*1024*1024,RETRIES=8;
const WEBHOOK_SECRET="study-notes-webhook-2026";
const TG_TIMEOUT=30000,DL_TIMEOUT=60000,GH_TIMEOUT=45000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// 🔥 IN-MEMORY RAM CACHE (0 KV Writes for Panel)
const MEM_CACHE = {}; 

export default{
 async fetch(req,env,ctx){
  const u=new URL(req.url);
  if(req.method==="GET")return new Response("Study Notes Bot OK");
  if(req.method!=="POST"||u.pathname!=="/telegram")
   return new Response("Not Found",{status:404});
  if(req.headers.get("X-Telegram-Bot-Api-Secret-Token")!==WEBHOOK_SECRET)
   return new Response("Unauthorized",{status:401});
  try{
   ctx.waitUntil(processUpdate(await req.json(),env));
   return new Response("OK")
  }catch(e){
   return new Response("Bad Request",{status:400})
  }
 },

 async queue(batch,env){
  for(const msg of batch.messages){
   const j=msg.body;
   try{
    if(await isStopped(env,j.panel_chat||j.chat_id)&&!j.auto){
     await env.UPLOAD_QUEUE.send(j,{delaySeconds:30});
     msg.ack();
     continue
    }

    if(j.type==="delete") await processDeleteJob(j,env);
    else await processUploadJob(j,env);

    msg.ack()
   }catch(e){
    if(e.message==="__PAUSED__"){
     await env.UPLOAD_QUEUE.send(j,{delaySeconds:30});
     msg.ack()
    }else{
     console.error("QUEUE",e);
     if(msg.attempts > 3){
      msg.ack();
      const text = `❌ Failed: ${j.file_name || j.name}\nReason: Max queue retries reached.`;
      await sendMessage(env, j.panel_chat || j.chat_id, text, { disable_notification: true });
     } else {
      msg.retry({delaySeconds: 15 * msg.attempts});
     }
    }
   }
  }
 }
};

async function processUpdate(u,e){
 try{
  if(!e.BOT_STATE || !e.UPLOAD_QUEUE){
   const chat = u.message?.chat?.id;
   if(chat) await sendMessage(e, chat, "⚠️ ERROR: Cloudflare Bindings (BOT_STATE or UPLOAD_QUEUE) missing hain!");
   return;
  }
  if(u.message) await handleMessage(u.message,e);
  else if(u.channel_post) await handleChannelPost(u.channel_post,e);
 }catch(x){ console.error(x) }
}

async function handleMessage(m,e){
 const chat=String(m.chat?.id||"");
 const uid=String(m.from?.id||"");
 if(!chat||!uid)return;

 if(m.text?.startsWith("/")) return handleCommand(m,e);
 if(!m.document) return;

 if(!(await isStaff(e,uid))) return sendMessage(e,chat,"❌ Access denied.");
 if(await isStopped(e,chat)) return sendMessage(e,chat,"🛑 Tumhari processing STOPPED hai.");

 await enqueueUpload(m.document,chat,uid,e,false,m.message_id);
}

async function handleChannelPost(m,e){
 if(await e.BOT_STATE.get("auto")!=="on")return;
 const ch=await e.BOT_STATE.get("channel_id");
 if(!ch||String(ch)!==String(m.chat?.id)||!m.document) return;

 await enqueueUpload(m.document, String(m.chat.id), String(m.sender_chat?.id||m.chat.id), e, true, m.message_id);
}

async function handleCommand(m,e){
 const chat=String(m.chat.id);
 const uid=String(m.from.id);
 const parts=(m.text||"").trim().split(/\s+/);
 const cmd=parts[0].split("@")[0].toLowerCase();
 const arg=parts.slice(1).join(" ").trim();

 if(cmd==="/start") return sendMessage(e,chat,`📚 Study Notes Bot\n\n/setfolder PATH\n/mkdir PATH\n/setchannel ID\n/auto on\n/auto off\n/status\n/delete FOLDER\n/delete 1 3 5\n/addadmin USER_ID\n/removeadmin USER_ID\n/admins\n/stop\n/resume\n\n⚡ IN-MEMORY PANEL ACTIVE (0 KV Writes)`);
 if(cmd==="/stop"){
  if(!(await isStaff(e,uid))) return sendMessage(e,chat,"❌ Access denied.");
  await e.BOT_STATE.put(`stop:${chat}`,"1",{expirationTtl:604800});
  return sendMessage(e,chat,"🛑 Processing STOPPED. Pending jobs pause rahenge.");
 }
 if(cmd==="/resume"){
  if(!(await isStaff(e,uid))) return sendMessage(e,chat,"❌ Access denied.");
  await e.BOT_STATE.delete(`stop:${chat}`);
  return sendMessage(e,chat,"▶️ Processing RESUMED. Pending jobs aage badhenge.");
 }

 const owner=await e.BOT_STATE.get("owner_id");
 const own=owner&&String(owner)===uid;
 const admin=!own&&await isAdmin(e,uid);

 if(["/addadmin","/removeadmin","/admins"].includes(cmd)){
  if(!own) return sendMessage(e,chat,"❌ Sirf owner ye command use kar sakta hai.");
  let a=await getAdmins(e);
  if(cmd==="/admins") return sendMessage(e,chat,a.length?`👥 Admins:\n\n${a.map((x,i)=>`${i+1}. ${x}`).join("\n")}`:"👥 Koi admin nahi hai.");
  if(!/^\d+$/.test(arg)) return sendMessage(e,chat,`Use:\n${cmd} USER_ID`);
  if(cmd==="/addadmin"){
   if(!a.includes(arg)) a.push(arg);
   await e.BOT_STATE.put("admins",JSON.stringify(a));
   return sendMessage(e,chat,`✅ Admin added: ${arg}`)
  }
  a=a.filter(x=>x!==arg);
  await e.BOT_STATE.put("admins",JSON.stringify(a));
  return sendMessage(e,chat,`✅ Admin removed: ${arg}`)
 }

 if(!own&&admin===false) return sendMessage(e,chat,"❌ Access denied.");

 if(cmd==="/setfolder"){
  const f=cleanPath(arg);
  if(!f) return sendMessage(e,chat,"❌ Invalid folder path.");
  await e.BOT_STATE.put("folder",f);
  return sendMessage(e,chat,`📁 Folder set:\n${f}`)
 }
 if(cmd==="/mkdir"){
  const f=cleanPath(arg);
  if(!f) return sendMessage(e,chat,"❌ Invalid folder path.");
  const r=await githubPut(e,`${f}/.gitkeep`,"",`Create folder ${f}`);
  return sendMessage(e,chat,r.ok?`✅ Folder ready:\n${f}`:`❌ ${r.message}`)
 }
 if(cmd==="/setchannel"){
  if(!arg) return sendMessage(e,chat,"Use /setchannel CHANNEL_ID");
  await e.BOT_STATE.put("channel_id",arg);
  return sendMessage(e,chat,`📢 Channel set:\n${arg}`)
 }
 if(cmd==="/auto"){
  const v=arg.toLowerCase();
  if(v!=="on"&&v!=="off") return sendMessage(e,chat,"Use /auto on or /auto off");
  await e.BOT_STATE.put("auto",v);
  return sendMessage(e,chat,v==="on"?"🟢 Auto ON":"🔴 Auto OFF")
 }
 if(cmd==="/status") return status(e,chat);
 if(cmd==="/delete") return deleteCommand(e,chat,arg);

 return sendMessage(e,chat,"❌ Unknown command. /start use karo.");
}

/* =========================================================
   ENQUEUE (0 KV Writes)
   ========================================================= */
async function enqueueUpload(doc,chat,uid,e,auto,msg_id){
 const name=cleanUploadName(doc.file_name||"");

 if(!name){
  if(!auto) await sendMessage(e,chat,"❌ Sirf .html ya .json file allowed hai.", {reply_to_message_id: msg_id});
  return;
 }
 if((doc.file_size||0)>MAX_FILE_SIZE){
  if(!auto) await sendMessage(e,chat,"❌ Maximum file size 20 MB hai.", {reply_to_message_id: msg_id});
  return;
 }

 const folder = await e.BOT_STATE.get("folder") || DEFAULT_FOLDER;

 // Auto mode me Live Panel Owner ke inbox me jayega
 let panel_chat = chat;
 if (auto) {
  const owner = await e.BOT_STATE.get("owner_id");
  panel_chat = owner ? String(owner) : chat;
 }

 const j = { type: "upload", chat_id: chat, panel_chat, file_id: doc.file_id, file_name: name, folder, auto, msg_id: msg_id };
 await e.UPLOAD_QUEUE.send(j);
}

/* =========================================================
   PROCESS UPLOAD & RAM PANEL
   ========================================================= */
async function processUploadJob(j,e){
 if(await isStopped(e,j.panel_chat)&&!j.auto) throw Error("__PAUSED__");

 const pChat = j.panel_chat;
 const now = Date.now();

 // 1. RAM CACHE LOGIC
 if (!MEM_CACHE[pChat] || (now - MEM_CACHE[pChat].time > 5 * 60 * 1000)) {
  MEM_CACHE[pChat] = { msg_id: null, done: 0, skip: 0, fail: 0, time: now };
 }
 let p = MEM_CACHE[pChat];
 p.time = now;

 // 2. CREATE PANEL
 if (!p.msg_id) {
  const initText = `📊 <b>SMART LIVE PANEL</b> ${j.auto ? "(Channel Auto)" : ""}\n📁 <code>${j.folder}</code>\n\n⏳ <i>Starting process...</i>`;
  const sent = await tgCall(e, "sendMessage", { chat_id: pChat, text: initText, parse_mode: "HTML" });
  if (sent && sent.ok) p.msg_id = sent.result.message_id;
 }

 // 3. SHOW "PROCESSING" FILE
 if (p.msg_id) {
  const procText = `📊 <b>SMART LIVE PANEL</b> ${j.auto ? "(Channel Auto)" : ""}\n📁 <code>${j.folder}</code>\n\n✅ Uploaded : ${p.done}\n🤷 Skipped  : ${p.skip}\n❌ Failed   : ${p.fail}\n\n⚙️ <i>Processing:</i>\n📄 <code>${j.file_name}</code>`;
  await tgCall(e, "editMessageText", { chat_id: pChat, message_id: p.msg_id, text: procText, parse_mode: "HTML" });
 }

 // 4. PROCESS THE FILE
 let r;
 try { r = await processDocument(j,e); } 
 catch(x) {
  if(x.message==="__PAUSED__") throw x;
  r = {ok: false, message: x.message || "Unknown error"};
 }

 // 5. UPDATE COUNTERS
 if (r.ok) {
  if (r.skipped) p.skip++;
  else p.done++;
 } else {
  p.fail++;
 }

 // 6. EMOJI REACTION (No Spam in Chat)
 if (j.msg_id) {
  const emoji = r.ok ? (r.skipped ? "🤷‍♂️" : "👍") : "👎";
  await tgCall(e, "setMessageReaction", { 
   chat_id: j.chat_id, message_id: j.msg_id, 
   reaction: [{ type: "emoji", emoji: emoji }] 
  });
 }

 // 7. UPDATE FINAL PANEL STATE
 if (p.msg_id) {
  const finalText = `📊 <b>SMART LIVE PANEL</b> ${j.auto ? "(Channel Auto)" : ""}\n📁 <code>${j.folder}</code>\n\n✅ Uploaded : ${p.done}\n🤷 Skipped  : ${p.skip}\n❌ Failed   : ${p.fail}\n\n⏳ <i>Waiting for next file...</i>`;
  await tgCall(e, "editMessageText", { chat_id: pChat, message_id: p.msg_id, text: finalText, parse_mode: "HTML" });
 }

 // 8. SEND ERROR TEXT (Only if Failed)
 if (!r.ok) {
  const errText = `❌ Failed: ${j.file_name}\nReason: ${r.message}`;
  if (j.auto) await sendMessage(e, pChat, errText); 
  else await sendMessage(e, j.chat_id, errText, { reply_to_message_id: j.msg_id, disable_notification: true });
 }

 await sleep(1000); 
}

async function processDocument(j,e){
 const isDirectJson=/\.json$/i.test(j.file_name);
 const targetJson=isDirectJson?j.file_name:j.file_name.replace(/\.(html|htm)$/i,".json");

 const existing=await githubFileExists(e,`${j.folder}/${targetJson}`);
 if(!existing.ok) throw Error("GitHub existing-file check failed: "+existing.message);

 if(existing.exists){
  return{ok:true, skipped:true, questions:0, jsonName:targetJson};
 }

 const f=await telegramGetFile(e,j.file_id);
 if(!f.ok) throw Error("Telegram file lookup failed.");

 const r=await fetchTimeout(`https://api.telegram.org/file/bot${e.BOT_TOKEN}/${f.result.file_path}`,{},DL_TIMEOUT);
 if(!r.ok) throw Error("Telegram download failed.");

 const buf=await r.arrayBuffer();
 if(buf.byteLength>MAX_FILE_SIZE) throw Error("File 20 MB se badi hai.");

 const text=new TextDecoder().decode(buf);

 if(/\.json$/i.test(j.file_name)){
  let data;
  try{ data=JSON.parse(text) }catch{ throw Error("Invalid JSON") }
  if(!Array.isArray(data)) throw Error("JSON root array [...] hona chahiye.");

  const g=await githubPut(e,`${j.folder}/${j.file_name}`,textToBase64(text),`Add JSON ${j.file_name}`);
  if(!g.ok) throw Error(g.message);
  return{ok:true, questions:data.length, jsonName:j.file_name};
 }

 const q=htmlToQuizJson(text);
 if(!q.ok) throw Error(q.message);

 const json=j.file_name.replace(/\.(html|htm)$/i,".json");
 if(await isStopped(e,j.chat_id)&&!j.auto) throw Error("__PAUSED__");

 const g=await githubPut(e,`${j.folder}/${json}`,textToBase64(JSON.stringify(q.questions,null,2)),`Add JSON ${json}`);
 if(!g.ok) throw Error(g.message);

 return{ok:true, questions:q.questions.length, jsonName:json};
}

/* =========================================================
   DELETE SYSTEM
   ========================================================= */
async function deleteCommand(e,chat,arg){
 const folder = await e.BOT_STATE.get("folder") || DEFAULT_FOLDER;
 const tokens = arg.split(/[\s,]+/).filter(Boolean);
 const isNumbers = tokens.length && tokens.every(x => /^\d+$/.test(x));

 if(isNumbers){
  const r = await githubList(e, folder);
  if(!r.ok) return sendMessage(e,chat,`❌ Folder nahi mila:\n${folder}`);
  const files = r.items.filter(x=>x.type==="file"&&/\.(html?|json)$/i.test(x.name)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"}));

  const sel = [...new Set(tokens.map(Number))];
  if(sel.some(n=>n<1||n>files.length)) return sendMessage(e,chat,`❌ Number 1-${files.length} ke beech hona chahiye.`);

  const jobs = sel.map(n=>({ type:"delete", chat_id:chat, path:files[n-1].path, name:files[n-1].name, folder }));
  for(const j of jobs) await e.UPLOAD_QUEUE.send(j);
  return sendMessage(e,chat,`📥 Delete Queue me ${jobs.length} files add ho gayi.`);
 }

 const listFolder = cleanPath(arg) || folder;
 const r = await githubList(e, listFolder);
 if(!r.ok) return sendMessage(e,chat,`❌ Folder nahi mila:\n${listFolder}`);

 const files = r.items.filter(x=>x.type==="file"&&/\.(html?|json)$/i.test(x.name)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"}));
 if(!files.length) return sendMessage(e,chat,`📁 Is folder me HTML/JSON file nahi mili.\n\n${listFolder}`);

 const listStr = files.map((x,i)=>`${i+1}. ${x.name}`).join("\n");
 let footer = `🗑️ Delete selected:\n/delete 1 3 5`;
 if (listFolder !== folder) footer = `⚠️ Pehle isko set karo:\n/setfolder ${listFolder}\nFir delete karo:\n/delete 1 3 5`;

 return sendMessage(e,chat,`📁 Folder:\n${listFolder}\n\n${listStr}\n\n${footer}`);
}

async function processDeleteJob(j,e){
 if(await isStopped(e,j.chat_id)) throw Error("__PAUSED__");
 let r;
 try { r=await githubDelete(e,j.path,`Delete ${j.name}`) } 
 catch(x) { r={ok:false, message:x.message} }

 const text = r.ok ? `🗑️ Deleted: ${j.name}` : `❌ Delete Failed: ${j.name}\nReason: ${r.message}`;
 await sendMessage(e, j.chat_id, text, { disable_notification: true });
 await sleep(1000);
}

/* =========================================================
   UTILITIES
   ========================================================= */
async function status(e,chat){
 const[f,a,ch,s,admins]=await Promise.all([
  e.BOT_STATE.get("folder"), e.BOT_STATE.get("auto"), e.BOT_STATE.get("channel_id"),
  isStopped(e,chat), getAdmins(e)
 ]);
 return sendMessage(e,chat,`📊 STATUS\n\nOperations : ${s?"🛑 STOPPED":"🟢 RUNNING"}\nAuto       : ${(a||"off").toUpperCase()}\nFolder     : ${f||DEFAULT_FOLDER}\nChannel    : ${ch||"Not set"}\nAdmins     : ${admins.length}\nQueue      : RAM Panel Active (0 KV Writes) 🚀`);
}

async function getAdmins(e){
 try{ const a=JSON.parse(await e.BOT_STATE.get("admins")||"[]"); return Array.isArray(a)?a.map(String):[]; }
 catch{ return[] }
}

async function isAdmin(e,id){ return (await getAdmins(e)).includes(String(id)); }
async function isStaff(e,id){ const o=await e.BOT_STATE.get("owner_id"); return !!o&&(String(o)===String(id)||await isAdmin(e,id)); }
async function isStopped(e,id){ return (await e.BOT_STATE.get(`stop:${id}`))==="1"; }

/* =========================================================
   🔥 ULTRA-PRO HTML PARSER (FIXED BACKTICKS & MINIFIED JS)
   ========================================================= */
function sanitizeJS(str) {
 return str
  .replace(/\/\*[\s\S]*?\*\//g, '') 
  .replace(/\/\/.*$/gm, '') 
  .replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":') 
  .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (m, p1) => `"${p1.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) 
  .replace(/`([^`\\]*(?:\\.[^`\\]*)*)`/g, (m, p1) => `"${p1.replace(/\\`/g, "`").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '')}"`) 
  .replace(/:\s*undefined\b/g, ': null') 
  .replace(/:\s*!0\b/g, ': true') 
  .replace(/:\s*!1\b/g, ': false') 
  .replace(/,\s*([\]}])/g, '$1'); 
}

function htmlToQuizJson(s){
 const m = s.match(/(?:const|let|var)\s+Qs\s*=\s*/i);
 if(m){
  const a = extractBalanced(s, m.index + m[0].length, "[", "]");
  if(!a) return {ok: false, message: "Qs array complete nahi mili."};
  try {
   const q = JSON.parse(sanitizeJS(a));
   if(!Array.isArray(q) || !q.length) throw new Error("Empty array");
   return {ok: true, questions: q};
  } catch (err) { 
   return {ok: false, message: "JSON Error (Qs): " + err.message}; 
  }
 }

 const d = s.match(/(?:const|let|var)\s+Q_DATA\s*=\s*/i);
 if(!d) return {ok: false, message: "Qs / Q_DATA nahi mila."};
 const a = extractBalanced(s, d.index + d[0].length, "[", "]");
 if(!a) return {ok: false, message: "Q_DATA array complete nahi mili."};
 try {
  const q = JSON.parse(sanitizeJS(a));
  if(Array.isArray(q) && q.length) return {ok: true, questions: q};
  return {ok: false, message: "Q_DATA empty hai."};
 } catch (err) { 
  return {ok: false, message: "JSON Error (Q_DATA): " + err.message}; 
 }
}

function extractBalanced(s, start, open, close){
 let d = 0, str = "", esc = false;
 for(let i = start; i < s.length; i++){
  const c = s[i];
  if(str){
   if(esc) esc = false;
   else if(c === "\\") esc = true;
   else if(c === str) str = "";
   continue;
  }
  if(c === '"' || c === "'" || c === "`"){ 
   str = c; continue;
  }
  if(c === open) d++;
  else if(c === close && --d === 0) return s.slice(start, i + 1);
 }
 return null;
}

/* =========================================================
   PATH VALIDATION & BASE64
   ========================================================= */
function cleanPath(p){
 const v=String(p||"").trim().replace(/^\/|\/$/g,"");
 return(v&&!v.includes("..")&&!v.includes("\\")&&!v.includes("//")&&!/[<>:"|?*]/.test(v))?v:null;
}
function cleanUploadName(n){
 const v=String(n||"").trim();
 return(v&&!v.includes("/")&&!v.includes("\\")&&!v.includes("..")&&/\.(html?|json)$/i.test(v))?v:null;
}

function textToBase64(t) {
 const bytes = new TextEncoder().encode(t);
 let base64 = "";
 const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
 const len = bytes.byteLength;
 let i = 0;
 while (i < len - 2) {
  const chunk = (bytes[i++] << 16) | (bytes[i++] << 8) | bytes[i++];
  base64 += chars[(chunk >> 18) & 63] + chars[(chunk >> 12) & 63] + chars[(chunk >> 6) & 63] + chars[chunk & 63];
 }
 if (i < len) {
  let chunk = bytes[i++];
  if (i < len) {
   chunk = (chunk << 8) | bytes[i];
   base64 += chars[(chunk >> 10) & 63] + chars[(chunk >> 4) & 63] + chars[(chunk << 2) & 63] + "=";
  } else {
   base64 += chars[(chunk >> 2) & 63] + chars[(chunk << 4) & 63] + "==";
  }
 }
 return base64;
}

/* =========================================================
   GITHUB API
   ========================================================= */
function gh(e){
 return{
  Authorization:`Bearer ${e.GITHUB_TOKEN}`,
  Accept:"application/vnd.github+json",
  "Content-Type":"application/json",
  "X-GitHub-Api-Version":"2022-11-28",
  "User-Agent":"study-notes-bot"
 };
}

function ghUrl(p){
 return`https://api.github.com/repos/${OWNER}/${REPO}/contents/${p.split("/").map(encodeURIComponent).join("/")}`;
}

async function githubFileExists(e,path){
 const u=ghUrl(path);
 for(let i=1;i<=RETRIES;i++){
  try{
   const r=await fetchTimeout(`${u}?ref=${encodeURIComponent(BRANCH)}`,{headers:gh(e)},GH_TIMEOUT);
   if(r.status===200) return{ok:true,exists:true};
   if(r.status===404) return{ok:true,exists:false};
   if(r.status===429||r.status>=500){
    if(i===RETRIES) return{ok:false,exists:false,message:`GitHub check failed (${r.status})`};
    await sleep(i*1000); continue;
   }
   return{ok:false,exists:false,message:(await r.text()).slice(0,300)};
  }catch(x){
   if(i===RETRIES) return{ok:false,exists:false,message:x.message};
   await sleep(i*1000);
  }
 }
 return{ok:false,exists:false,message:"GitHub file check failed."};
}

async function githubPut(e,path,content,message){
 const u=ghUrl(path);
 for(let i=1;i<=RETRIES;i++){
  try{
   let sha;
   const x=await fetchTimeout(`${u}?ref=${encodeURIComponent(BRANCH)}`,{headers:gh(e)},GH_TIMEOUT);
   if(x.ok) sha=(await x.json()).sha;
   else if(x.status!==404) return{ok:false,message:(await x.text()).slice(0,300)};

   const body={message,content,branch:BRANCH};
   if(sha) body.sha=sha;

   const r=await fetchTimeout(u,{method:"PUT",headers:gh(e),body:JSON.stringify(body)},GH_TIMEOUT);
   if(r.ok) return{ok:true};
   if(![409,422].includes(r.status)||i===RETRIES) return{ok:false,message:(await r.text()).slice(0,300)};
  }catch(x){
   if(i===RETRIES) return{ok:false,message:x.message};
  }
  await sleep(i*700)
 }
 return{ok:false,message:"GitHub retry limit reached."};
}

async function githubList(e,path){
 const r=await fetchTimeout(`${ghUrl(path)}?ref=${encodeURIComponent(BRANCH)}`,{headers:gh(e)},GH_TIMEOUT);
 if(!r.ok) return{ok:false,items:[]};
 const d=await r.json();
 return{ok:true,items:Array.isArray(d)?d:[]};
}

async function githubDelete(e,path,message){
 const u=ghUrl(path);
 for(let i=1;i<=RETRIES;i++){
  try{
   const x=await fetchTimeout(`${u}?ref=${encodeURIComponent(BRANCH)}`,{headers:gh(e)},GH_TIMEOUT);
   if(x.status===404) return{ok:false,message:"File GitHub par nahi mila."};
   if(!x.ok) throw Error("GitHub file lookup failed");
   const d=await x.json();

   const r=await fetchTimeout(u,{method:"DELETE",headers:gh(e),body:JSON.stringify({message,sha:d.sha,branch:BRANCH})},GH_TIMEOUT);
   if(r.ok) return{ok:true};
   if(![409,422].includes(r.status)||i===RETRIES) return{ok:false,message:(await r.text()).slice(0,300)};
  }catch(x){
   if(i===RETRIES) return{ok:false,message:x.message};
  }
  await sleep(i*700)
 }
 return{ok:false,message:"GitHub delete retry limit reached."};
}

/* =========================================================
   TELEGRAM & NETWORK
   ========================================================= */
async function telegramGetFile(e,id){
 for(let i=1;i<=3;i++){
  try{
   const r=await fetchTimeout(`https://api.telegram.org/bot${e.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(id)}`,{},TG_TIMEOUT);
   const d=await r.json();
   if(d.ok) return d;
   if(r.status===429){ await sleep(2000*i); continue; }
   if(i===3) return{ok:false};
  }catch{ if(i===3) return{ok:false}; }
 }
 return{ok:false};
}

async function tgCall(e,method,body){
 for(let i=1;i<=4;i++){
  try{
   const r=await fetchTimeout(`https://api.telegram.org/bot${e.BOT_TOKEN}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},TG_TIMEOUT);
   const d=await r.json();
   if(d.ok) return d;
   if(r.status===429){ await sleep(2000*i); continue; }
   return d;
  }catch(x){
   if(i===4) throw x;
   await sleep(500*i);
  }
 }
}

async function sendMessage(e,chat,text,options={}){
 try{ await tgCall(e,"sendMessage",{chat_id:chat,text,...options}) }catch(x){ console.error("TG SEND",x) }
}

async function fetchTimeout(url,opt,ms){
 const c=new AbortController();
 const t=setTimeout(()=>c.abort(),ms);
 try{ return await fetch(url,{...opt,signal:c.signal}) }
 catch(x){ if(x.name==="AbortError") throw Error(`Request timeout (${ms/1000}s)`); throw x; }
 finally{ clearTimeout(t); }
}

/* =========================================================
   ☁️ CLOUDFLARE DEPLOYMENT
   =========================================================
   File name: worker.js

   Required Cloudflare bindings:
   1. KV Namespace binding:
      BOT_STATE

   2. Queue producer binding:
      UPLOAD_QUEUE

   3. Queue consumer:
      Attach the same UPLOAD_QUEUE to this Worker as a consumer.

   Required Worker secrets / variables:
      BOT_TOKEN
      GITHUB_TOKEN

   After deployment:
      - Set Telegram webhook to:
        https://YOUR-WORKER-DOMAIN/telegram
      - Use the same secret:
        study-notes-webhook-2026

   IMPORTANT:
      Do not rename BOT_STATE or UPLOAD_QUEUE unless the code is
      changed accordingly.

   KV optimization:
      - Upload enqueue itself does NOT write panel data to KV.
      - Live panel uses in-memory RAM cache.
      - Existing GitHub JSON is checked first and skipped.
      - Configuration commands such as /setfolder, /setchannel,
        /auto, admin changes and stop/resume still use KV as required.
   ========================================================= */
