const OWNER="Golu171",REPO="study-notes",BRANCH="main";
const DEFAULT_FOLDER="HARYANA-GK/HARYANA-CURRENT";
const MAX_FILE_SIZE=20*1024*1024,RETRIES=8;
const WEBHOOK_SECRET="study-notes-webhook-2026";
const TG_TIMEOUT=30000,DL_TIMEOUT=60000,GH_TIMEOUT=45000;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export default{
 async fetch(req,env,ctx){
  const u=new URL(req.url);

  if(req.method==="GET")
   return new Response("Study Notes Bot OK");

  if(req.method!=="POST"||u.pathname!=="/telegram")
   return new Response("Not Found",{status:404});

  if(req.headers.get("X-Telegram-Bot-Api-Secret-Token")!==WEBHOOK_SECRET)
   return new Response("Unauthorized",{status:401});

  try{
   ctx.waitUntil(processUpdate(await req.json(),env));
   return new Response("OK");
  }catch{
   return new Response("Bad Request",{status:400});
  }
 },

 async queue(batch,env){
  for(const msg of batch.messages){
   const j=msg.body;

   try{
    if(await isStopped(env,j.chat_id)&&!j.auto){
     await env.UPLOAD_QUEUE.send(j,{delaySeconds:30});
     msg.ack();
     continue;
    }

    if(j.type==="delete")
     await processDeleteJob(j,env);
    else
     await processUploadJob(j,env);

    msg.ack();

   }catch(e){
    if(e.message==="__PAUSED__"){
     await env.UPLOAD_QUEUE.send(j,{delaySeconds:30});
     msg.ack();

    }else{
     console.error("QUEUE",e);

     if(msg.attempts>3){
      msg.ack();

      const text=
       `❌ Failed: ${j.file_name||j.name}\n`+
       `Reason: Max queue retries reached.`;

      await sendMessage(
       env,
       j.chat_id,
       text,
       {
        reply_to_message_id:j.msg_id,
        disable_notification:true
       }
      );

     }else{
      msg.retry({
       delaySeconds:15*msg.attempts
      });
     }
    }
   }
  }
 }
};

/* =========================================================
   UPDATE HANDLER
   ========================================================= */

async function processUpdate(u,e){
 try{
  if(u.message)
   await handleMessage(u.message,e);
  else if(u.channel_post)
   await handleChannelPost(u.channel_post,e);
 }catch(x){
  console.error(x);
 }
}

/* =========================================================
   TELEGRAM MESSAGE
   ========================================================= */

async function handleMessage(m,e){
 const chat=String(m.chat?.id||"");
 const uid=String(m.from?.id||"");

 if(!chat||!uid)
  return;

 if(m.text?.startsWith("/"))
  return handleCommand(m,e);

 if(!m.document)
  return;

 if(!(await isStaff(e,uid)))
  return sendMessage(
   e,
   chat,
   "❌ Access denied."
  );

 if(await isStopped(e,chat))
  return sendMessage(
   e,
   chat,
   "🛑 Tumhari processing STOPPED hai."
  );

 await enqueueUpload(
  m.document,
  chat,
  uid,
  e,
  false,
  m.message_id
 );
}

async function handleChannelPost(m,e){
 if(await e.BOT_STATE.get("auto")!=="on")
  return;

 const ch=await e.BOT_STATE.get("channel_id");

 if(
  !ch||
  String(ch)!==String(m.chat?.id)||
  !m.document
 )
  return;

 await enqueueUpload(
  m.document,
  String(m.chat.id),
  String(m.sender_chat?.id||m.chat.id),
  e,
  true,
  null
 );
}

/* =========================================================
   COMMANDS
   ========================================================= */

async function handleCommand(m,e){
 const chat=String(m.chat.id);
 const uid=String(m.from.id);

 const parts=(m.text||"")
  .trim()
  .split(/\s+/);

 const cmd=
  parts[0]
   .split("@")[0]
   .toLowerCase();

 const arg=
  parts
   .slice(1)
   .join(" ")
   .trim();

 /* ---------------------------------------------------------
    START
    --------------------------------------------------------- */

 if(cmd==="/start"){
  return sendMessage(
   e,
   chat,
`📚 Study Notes Bot

/setfolder PATH
/mkdir PATH
/setchannel ID
/auto on
/auto off
/status
/delete
/delete FOLDER
/delete 1 3 5
/addadmin USER_ID
/removeadmin USER_ID
/admins
/stop
/resume

📌 Upload folder: KV current folder
⚡ Uploads do NOT write to KV`
  );
 }

 /* ---------------------------------------------------------
    STOP
    --------------------------------------------------------- */

 if(cmd==="/stop"){
  if(!(await isStaff(e,uid)))
   return sendMessage(
    e,
    chat,
    "❌ Access denied."
   );

  await e.BOT_STATE.put(
   `stop:${chat}`,
   "1",
   {expirationTtl:604800}
  );

  return sendMessage(
   e,
   chat,
   "🛑 Processing STOPPED. Pending jobs pause rahenge."
  );
 }

 /* ---------------------------------------------------------
    RESUME
    --------------------------------------------------------- */

 if(cmd==="/resume"){
  if(!(await isStaff(e,uid)))
   return sendMessage(
    e,
    chat,
    "❌ Access denied."
   );

  await e.BOT_STATE.delete(
   `stop:${chat}`
  );

  return sendMessage(
   e,
   chat,
   "▶️ Processing RESUMED. Pending jobs aage badhenge."
  );
 }

 /* ---------------------------------------------------------
    OWNER / ADMIN
    --------------------------------------------------------- */

 const owner=
  await e.BOT_STATE.get("owner_id");

 const own=
  owner&&String(owner)===uid;

 const admin=
  !own&&await isAdmin(e,uid);

 if([
  "/addadmin",
  "/removeadmin",
  "/admins"
 ].includes(cmd)){

  if(!own){
   return sendMessage(
    e,
    chat,
    "❌ Sirf owner ye command use kar sakta hai."
   );
  }

  let a=await getAdmins(e);

  if(cmd==="/admins"){
   return sendMessage(
    e,
    chat,
    a.length
     ?`👥 Admins:\n\n${
       a.map(
        (x,i)=>`${i+1}. ${x}`
       ).join("\n")
      }`
     :"👥 Koi admin nahi hai."
   );
  }

  if(!/^\d+$/.test(arg)){
   return sendMessage(
    e,
    chat,
    `Use:\n${cmd} USER_ID`
   );
  }

  if(cmd==="/addadmin"){
   if(!a.includes(arg))
    a.push(arg);

   await e.BOT_STATE.put(
    "admins",
    JSON.stringify(a)
   );

   return sendMessage(
    e,
    chat,
    `✅ Admin added: ${arg}`
   );
  }

  a=a.filter(
   x=>x!==arg
  );

  await e.BOT_STATE.put(
   "admins",
   JSON.stringify(a)
  );

  return sendMessage(
   e,
   chat,
   `✅ Admin removed: ${arg}`
  );
 }

 if(!own&&admin===false)
  return sendMessage(
   e,
   chat,
   "❌ Access denied."
  );

 /* ---------------------------------------------------------
    SET FOLDER

    IMPORTANT:
    Ye hi folder KV me WRITE hota hai.

    Upload ke time:
    KV READ only.
    --------------------------------------------------------- */

 if(cmd==="/setfolder"){
  const f=cleanPath(arg);

  if(!f)
   return sendMessage(
    e,
    chat,
    "❌ Invalid folder path."
   );

  await e.BOT_STATE.put(
   "folder",
   f
  );

  return sendMessage(
   e,
   chat,
   `📁 Current folder set:\n${f}\n\n`+
   `ℹ️ Ab se HTML/JSON uploads isi folder me jayenge.`
  );
 }

 /* ---------------------------------------------------------
    MKDIR
    --------------------------------------------------------- */

 if(cmd==="/mkdir"){
  const f=cleanPath(arg);

  if(!f)
   return sendMessage(
    e,
    chat,
    "❌ Invalid folder path."
   );

  const r=await githubPut(
   e,
   `${f}/.gitkeep`,
   "",
   `Create folder ${f}`
  );

  return sendMessage(
   e,
   chat,
   r.ok
    ?`✅ Folder ready:\n${f}`
    :`❌ ${r.message}`
  );
 }

 /* ---------------------------------------------------------
    CHANNEL
    --------------------------------------------------------- */

 if(cmd==="/setchannel"){
  if(!arg)
   return sendMessage(
    e,
    chat,
    "Use /setchannel CHANNEL_ID"
   );

  await e.BOT_STATE.put(
   "channel_id",
   arg
  );

  return sendMessage(
   e,
   chat,
   `📢 Channel set:\n${arg}`
  );
 }

 /* ---------------------------------------------------------
    AUTO
    --------------------------------------------------------- */

 if(cmd==="/auto"){
  const v=arg.toLowerCase();

  if(v!=="on"&&v!=="off")
   return sendMessage(
    e,
    chat,
    "Use /auto on or /auto off"
   );

  await e.BOT_STATE.put(
   "auto",
   v
  );

  return sendMessage(
   e,
   chat,
   v==="on"
    ?"🟢 Auto ON"
    :"🔴 Auto OFF"
  );
 }

 /* ---------------------------------------------------------
    STATUS
    --------------------------------------------------------- */

 if(cmd==="/status")
  return status(e,chat);

 /* ---------------------------------------------------------
    DELETE
    --------------------------------------------------------- */

 if(cmd==="/delete")
  return deleteCommand(
   e,
   chat,
   arg
  );

 return sendMessage(
  e,
  chat,
  "❌ Unknown command. /start use karo."
 );
}

/* =========================================================
   UPLOAD QUEUE

   IMPORTANT:
   Every HTML/JSON upload:
   - 1 KV READ
   - 0 KV WRITE

   Folder is copied into queue job.
   ========================================================= */

async function enqueueUpload(
 doc,
 chat,
 uid,
 e,
 auto,
 msg_id
){
 const name=
  cleanUploadName(
   doc.file_name||""
  );

 if(!name){
  if(!auto){
   await sendMessage(
    e,
    chat,
    "❌ Sirf .html ya .json file allowed hai.",
    {
     reply_to_message_id:msg_id
    }
   );
  }

  return;
 }

 if((doc.file_size||0)>MAX_FILE_SIZE){
  if(!auto){
   await sendMessage(
    e,
    chat,
    "❌ Maximum file size 20 MB hai.",
    {
     reply_to_message_id:msg_id
    }
   );
  }

  return;
 }

 /*
  ONE KV READ.

  Folder is resolved NOW and stored
  inside queue job.

  Therefore if user changes folder later,
  this queued file still goes to the
  folder selected when it was received.
 */
 const folder=
  await e.BOT_STATE.get("folder")||
  DEFAULT_FOLDER;

 const j={
  type:"upload",
  chat_id:chat,
  file_id:doc.file_id,
  file_name:name,
  folder,
  auto,
  msg_id
 };

 await e.UPLOAD_QUEUE.send(j);
}

/* =========================================================
   PROCESS UPLOAD
   ========================================================= */

async function processUploadJob(j,e){
 if(
  await isStopped(e,j.chat_id)&&
  !j.auto
 )
  throw Error("__PAUSED__");

 let r;

 try{
  r=await processDocument(
   j,
   e
  );
 }catch(x){
  if(x.message==="__PAUSED__")
   throw x;

  r={
   ok:false,
   message:x.message||
   "Unknown error"
  };
 }

 if(!j.auto){

  const text=
   r.ok
    ?(
      r.skipped
       ?`⏭️ Skipped (Already Exists)\n📁 ${j.folder}/${r.jsonName}`
       :`✅ Uploaded Successfully\n📁 ${j.folder}/${r.jsonName}`
     )
    :`❌ Failed\nReason: ${r.message}`;

  await sendMessage(
   e,
   j.chat_id,
   text,
   {
    reply_to_message_id:j.msg_id,
    disable_notification:true
   }
  );
 }

 await sleep(1000);
}

/* =========================================================
   DOCUMENT PROCESSING
   ========================================================= */

async function processDocument(j,e){

 if(
  await isStopped(e,j.chat_id)&&
  !j.auto
 )
  throw Error("__PAUSED__");

 const isDirectJson=
  /\.json$/i.test(
   j.file_name
  );

 const targetJson=
  isDirectJson
   ?j.file_name
   :j.file_name.replace(
     /\.(html|htm)$/i,
     ".json"
    );

 const existing=
  await githubFileExists(
   e,
   `${j.folder}/${targetJson}`
  );

 if(!existing.ok)
  throw Error(
   "GitHub existing-file check failed: "+
   existing.message
  );

 if(existing.exists){
  return{
   ok:true,
   skipped:true,
   questions:0,
   jsonName:targetJson
  };
 }

 /* Telegram file information */

 const f=
  await telegramGetFile(
   e,
   j.file_id
  );

 if(!f.ok)
  throw Error(
   "Telegram file lookup failed."
  );

 /* Download */

 const r=
  await fetchTimeout(
   `https://api.telegram.org/file/bot${e.BOT_TOKEN}/${f.result.file_path}`,
   {},
   DL_TIMEOUT
  );

 if(!r.ok)
  throw Error(
   "Telegram download failed."
  );

 const buf=
  await r.arrayBuffer();

 if(buf.byteLength>MAX_FILE_SIZE)
  throw Error(
   "File 20 MB se badi hai."
  );

 const text=
  new TextDecoder().decode(buf);

 /* -------------------------------------------------------
    DIRECT JSON
    ------------------------------------------------------- */

 if(isDirectJson){

  let data;

  try{
   data=JSON.parse(text);
  }catch{
   throw Error(
    "Invalid JSON"
   );
  }

  if(!Array.isArray(data))
   throw Error(
    "JSON root array [...] hona chahiye."
   );

  const g=
   await githubPut(
    e,
    `${j.folder}/${j.file_name}`,
    textToBase64(text),
    `Add JSON ${j.file_name}`
   );

  if(!g.ok)
   throw Error(g.message);

  return{
   ok:true,
   questions:data.length,
   jsonName:j.file_name
  };
 }

 /* -------------------------------------------------------
    HTML -> JSON
    ------------------------------------------------------- */

 const q=
  htmlToQuizJson(text);

 if(!q.ok)
  throw Error(q.message);

 if(
  await isStopped(e,j.chat_id)&&
  !j.auto
 )
  throw Error("__PAUSED__");

 const json=
  j.file_name.replace(
   /\.(html|htm)$/i,
   ".json"
  );

 const g=
  await githubPut(
   e,
   `${j.folder}/${json}`,
   textToBase64(
    JSON.stringify(
     q.questions,
     null,
     2
    )
   ),
   `Add JSON ${json}`
  );

 if(!g.ok)
  throw Error(g.message);

 return{
  ok:true,
  questions:q.questions.length,
  jsonName:json
 };
}

/* =========================================================
   DELETE
   ========================================================= */

async function deleteCommand(
 e,
 chat,
 arg
){
 const folder=
  await e.BOT_STATE.get("folder")||
  DEFAULT_FOLDER;

 const tokens=
  arg
   .split(/[\s,]+/)
   .filter(Boolean);

 const isNumbers=
  tokens.length&&
  tokens.every(
   x=>/^\d+$/.test(x)
  );

 /* -------------------------------------------------------
    /delete 1 3 5
    ------------------------------------------------------- */

 if(isNumbers){

  const r=
   await githubList(
    e,
    folder
   );

  if(!r.ok)
   return sendMessage(
    e,
    chat,
    `❌ Folder nahi mila:\n${folder}`
   );

  const files=
   r.items
    .filter(
     x=>
      x.type==="file"&&
      /\.(html?|json)$/i.test(
       x.name
      )
    )
    .sort(
     (a,b)=>
      a.name.localeCompare(
       b.name,
       undefined,
       {
        numeric:true,
        sensitivity:"base"
       }
      )
    );

  const sel=[
   ...new Set(
    tokens.map(Number)
   )
  ];

  if(
   sel.some(
    n=>n<1||n>files.length
   )
  ){
   return sendMessage(
    e,
    chat,
    `❌ Number 1-${files.length} ke beech hona chahiye.`
   );
  }

  const jobs=
   sel.map(
    n=>({
     type:"delete",
     chat_id:chat,
     path:files[n-1].path,
     name:files[n-1].name,
     folder
    })
   );

  for(const j of jobs)
   await e.UPLOAD_QUEUE.send(j);

  return sendMessage(
   e,
   chat,
   `📥 Delete Queue me ${jobs.length} files add ho gayi.`
  );
 }

 /* -------------------------------------------------------
    /delete
    /delete FOLDER
    ------------------------------------------------------- */

 const listFolder=
  cleanPath(arg)||folder;

 const r=
  await githubList(
   e,
   listFolder
  );

 if(!r.ok)
  return sendMessage(
   e,
   chat,
   `❌ Folder nahi mila:\n${listFolder}`
  );

 const files=
  r.items
   .filter(
    x=>
     x.type==="file"&&
     /\.(html?|json)$/i.test(
      x.name
     )
   )
   .sort(
    (a,b)=>
     a.name.localeCompare(
      b.name,
      undefined,
      {
       numeric:true,
       sensitivity:"base"
      }
     )
   );

 if(!files.length){
  return sendMessage(
   e,
   chat,
   `📁 Is folder me HTML/JSON file nahi mili.\n\n${listFolder}`
  );
 }

 const listStr=
  files
   .map(
    (x,i)=>
     `${i+1}. ${x.name}`
   )
   .join("\n");

 let footer=
`🗑️ Delete selected (from current folder):
/delete 1 3 5`;

 if(listFolder!==folder){
  footer=
`⚠️ Ye current active folder nahi hai.
Pehle isko set karo:
/setfolder ${listFolder}

Fir delete karo:
/delete 1 3 5`;
 }

 return sendMessage(
  e,
  chat,
`📁 Folder:
${listFolder}

${listStr}

${footer}`
 );
}

/* =========================================================
   DELETE JOB
   ========================================================= */

async function processDeleteJob(
 j,
 e
){
 if(await isStopped(e,j.chat_id))
  throw Error("__PAUSED__");

 let r;

 try{
  r=
   await githubDelete(
    e,
    j.path,
    `Delete ${j.name}`
   );
 }catch(x){
  r={
   ok:false,
   message:x.message
  };
 }

 const text=
  r.ok
   ?`🗑️ Deleted: ${j.name}`
   :`❌ Delete Failed: ${j.name}\nReason: ${r.message}`;

 await sendMessage(
  e,
  j.chat_id,
  text,
  {
   disable_notification:true
  }
 );

 await sleep(1000);
}

/* =========================================================
   STATUS
   ========================================================= */

async function status(
 e,
 chat
){
 const[
  f,
  a,
  ch,
  s,
  admins
 ]=
  await Promise.all([
   e.BOT_STATE.get("folder"),
   e.BOT_STATE.get("auto"),
   e.BOT_STATE.get("channel_id"),
   isStopped(e,chat),
   getAdmins(e)
  ]);

 return sendMessage(
  e,
  chat,
`📊 STATUS

Operations : ${s?"🛑 STOPPED":"🟢 RUNNING"}
Auto       : ${(a||"off").toUpperCase()}
Folder     : ${f||DEFAULT_FOLDER}
Channel    : ${ch||"Not set"}
Admins     : ${admins.length}

KV:
• Upload = 1 READ, 0 WRITE
• Folder change = 1 WRITE
• No per-upload KV write 🚀`
 );
}

/* =========================================================
   ADMINS
   ========================================================= */

async function getAdmins(e){
 try{
  const a=
   JSON.parse(
    await e.BOT_STATE.get("admins")||
    "[]"
   );

  return Array.isArray(a)
   ?a.map(String)
   :[];

 }catch{
  return[];
 }
}

async function isAdmin(
 e,
 id
){
 return(
  await getAdmins(e)
 ).includes(
  String(id)
 );
}

async function isStaff(
 e,
 id
){
 const o=
  await e.BOT_STATE.get(
   "owner_id"
  );

 return!!o&&(
  String(o)===String(id)||
  await isAdmin(e,id)
 );
}

async function isStopped(
 e,
 id
){
 return(
  await e.BOT_STATE.get(
   `stop:${id}`
  )
 )==="1";
}

/* =========================================================
   HTML -> QUIZ JSON
   ========================================================= */

function sanitizeJS(str){
 return str
  .replace(
   /\/\*[\s\S]*?\*\//g,
   ''
  )
  .replace(
   /\/\/.*$/gm,
   ''
  )
  .replace(
   /([{,]\s*)([a-zA-Z0-9_]+)\s*:/g,
   '$1"$2":'
  )
  .replace(
   /'([^'\\]*(?:\\.[^'\\]*)*)'/g,
   (m,p1)=>
    `"${p1
      .replace(/\\'/g,"'")
      .replace(/"/g,'\\"')
    }"`
  )
  .replace(
   /,\s*([\]}])/g,
   '$1'
  );
}

function htmlToQuizJson(s){

 const m=
  s.match(
   /(?:const|let|var)\s+Qs\s*=\s*/i
  );

 if(m){

  const a=
   extractBalanced(
    s,
    m.index+m[0].length,
    "[",
    "]"
   );

  if(!a)
   return{
    ok:false,
    message:"Qs array complete nahi mili."
   };

  try{

   const q=
    JSON.parse(
     sanitizeJS(a)
    );

   if(
    !Array.isArray(q)||
    !q.length
   )
    throw 0;

   return{
    ok:true,
    questions:q
   };

  }catch{
   return{
    ok:false,
    message:"Qs valid JSON format me nahi hai."
   };
  }
 }

 const d=
  s.match(
   /(?:const|let|var)\s+Q_DATA\s*=\s*/i
  );

 if(!d)
  return{
   ok:false,
   message:"Qs / Q_DATA nahi mila."
  };

 const a=
  extractBalanced(
   s,
   d.index+d[0].length,
   "[",
   "]"
  );

 if(!a)
  return{
   ok:false,
   message:"Q_DATA array complete nahi mili."
  };

 try{

  const q=
   JSON.parse(
    sanitizeJS(a)
   );

  if(
   Array.isArray(q)&&
   q.length
  ){
   return{
    ok:true,
    questions:q
   };
  }

  return{
   ok:false,
   message:"Q_DATA empty hai."
  };

 }catch{
  return{
   ok:false,
   message:"Q_DATA valid JSON format me nahi hai."
  };
 }
}

/* =========================================================
   BALANCED ARRAY
   ========================================================= */

function extractBalanced(
 s,
 start,
 open,
 close
){
 let d=0;
 let str="";
 let esc=false;

 for(
  let i=start;
  i<s.length;
  i++
 ){

  const c=s[i];

  if(str){

   if(esc)
    esc=false;

   else if(c==="\\")
    esc=true;

   else if(c===str)
    str="";

   continue;
  }

  if(c==='"'||c==="'"){
   str=c;
   continue;
  }

  if(c===open)
   d++;

  else if(
   c===close&&
   --d===0
  ){
   return s.slice(
    start,
    i+1
   );
  }
 }

 return null;
}

/* =========================================================
   PATH VALIDATION
   ========================================================= */

function cleanPath(p){

 const v=
  String(p||"")
   .trim()
   .replace(
    /^\/|\/$/g,
    ""
   );

 return(
  v&&
  !v.includes("..")&&
  !v.includes("\\")&&
  !v.includes("//")&&
  !/[<>:"|?*]/.test(v)
 )
  ?v
  :null;
}

function cleanUploadName(n){

 const v=
  String(n||"")
   .trim();

 return(
  v&&
  !v.includes("/")&&
  !v.includes("\\")&&
  !v.includes("..")&&
  /\.(html?|json)$/i.test(v)
 )
  ?v
  :null;
}

/* =========================================================
   TEXT -> BASE64
   ========================================================= */

function textToBase64(t){

 const bytes=
  new TextEncoder().encode(t);

 let base64="";

 const chars=
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

 const len=
  bytes.byteLength;

 let i=0;

 while(i<len-2){

  const chunk=
   (bytes[i++]<<16)|
   (bytes[i++]<<8)|
   bytes[i++];

  base64+=
   chars[(chunk>>18)&63]+
   chars[(chunk>>12)&63]+
   chars[(chunk>>6)&63]+
   chars[chunk&63];
 }

 if(i<len){

  let chunk=
   bytes[i++];

  if(i<len){

   chunk=
    (chunk<<8)|
    bytes[i];

   base64+=
    chars[(chunk>>10)&63]+
    chars[(chunk>>4)&63]+
    chars[(chunk<<2)&63]+
    "=";

  }else{

   base64+=
    chars[(chunk>>2)&63]+
    chars[(chunk<<4)&63]+
    "==";
  }
 }

 return base64;
}

/* =========================================================
   GITHUB AUTH
   ========================================================= */

function gh(e){
 return{
  Authorization:
   `Bearer ${e.GITHUB_TOKEN}`,

  Accept:
   "application/vnd.github+json",

  "Content-Type":
   "application/json",

  "X-GitHub-Api-Version":
   "2022-11-28",

  "User-Agent":
   "study-notes-bot"
 };
}

function ghUrl(p){

 return`https://api.github.com/repos/${OWNER}/${REPO}/contents/${p
  .split("/")
  .map(
   encodeURIComponent
  )
  .join("/")}`;
}

/* =========================================================
   GITHUB EXISTS
   ========================================================= */

async function githubFileExists(
 e,
 path
){
 const u=
  ghUrl(path);

 for(
  let i=1;
  i<=RETRIES;
  i++
 ){

  try{

   const r=
    await fetchTimeout(
     `${u}?ref=${encodeURIComponent(BRANCH)}`,
     {
      headers:gh(e)
     },
     GH_TIMEOUT
    );

   if(r.status===200)
    return{
     ok:true,
     exists:true
    };

   if(r.status===404)
    return{
     ok:true,
     exists:false
    };

   if(
    r.status===429||
    r.status>=500
   ){

    if(i===RETRIES){
     return{
      ok:false,
      exists:false,
      message:
       `GitHub check failed (${r.status})`
     };
    }

    await sleep(
     i*1000
    );

    continue;
   }

   return{
    ok:false,
    exists:false,
    message:
     (await r.text())
      .slice(0,300)
   };

  }catch(x){

   if(i===RETRIES){
    return{
     ok:false,
     exists:false,
     message:x.message
    };
   }

   await sleep(
    i*1000
   );
  }
 }

 return{
  ok:false,
  exists:false,
  message:
   "GitHub file check failed."
 };
}

/* =========================================================
   GITHUB PUT
   ========================================================= */

async function githubPut(
 e,
 path,
 content,
 message
){

 const u=
  ghUrl(path);

 for(
  let i=1;
  i<=RETRIES;
  i++
 ){

  try{

   let sha;

   const x=
    await fetchTimeout(
     `${u}?ref=${encodeURIComponent(BRANCH)}`,
     {
      headers:gh(e)
     },
     GH_TIMEOUT
    );

   if(x.ok)
    sha=
     (await x.json()).sha;

   else if(x.status!==404)
    return{
     ok:false,
     message:
      (await x.text())
       .slice(0,300)
    };

   const body={
    message,
    content,
    branch:BRANCH
   };

   if(sha)
    body.sha=sha;

   const r=
    await fetchTimeout(
     u,
     {
      method:"PUT",
      headers:gh(e),
      body:JSON.stringify(body)
     },
     GH_TIMEOUT
    );

   if(r.ok)
    return{
     ok:true
    };

   if(
    ![409,422].includes(
     r.status
    )||
    i===RETRIES
   ){
    return{
     ok:false,
     message:
      (await r.text())
       .slice(0,300)
    };
   }

  }catch(x){

   if(i===RETRIES)
    return{
     ok:false,
     message:x.message
    };
  }

  await sleep(
   i*700
  );
 }

 return{
  ok:false,
  message:
   "GitHub retry limit reached."
 };
}

/* =========================================================
   GITHUB LIST
   ========================================================= */

async function githubList(
 e,
 path
){

 const r=
  await fetchTimeout(
   `${ghUrl(path)}?ref=${encodeURIComponent(BRANCH)}`,
   {
    headers:gh(e)
   },
   GH_TIMEOUT
  );

 if(!r.ok)
  return{
   ok:false,
   items:[]
  };

 const d=
  await r.json();

 return{
  ok:true,
  items:
   Array.isArray(d)
    ?d
    :[]
 };
}

/* =========================================================
   GITHUB DELETE
   ========================================================= */

async function githubDelete(
 e,
 path,
 message
){

 const u=
  ghUrl(path);

 for(
  let i=1;
  i<=RETRIES;
  i++
 ){

  try{

   const x=
    await fetchTimeout(
     `${u}?ref=${encodeURIComponent(BRANCH)}`,
     {
      headers:gh(e)
     },
     GH_TIMEOUT
    );

   if(x.status===404)
    return{
     ok:false,
     message:
      "File GitHub par nahi mila."
    };

   if(!x.ok)
    throw Error(
     "GitHub file lookup failed"
    );

   const d=
    await x.json();

   const r=
    await fetchTimeout(
     u,
     {
      method:"DELETE",
      headers:gh(e),
      body:JSON.stringify({
       message,
       sha:d.sha,
       branch:BRANCH
      })
     },
     GH_TIMEOUT
    );

   if(r.ok)
    return{
     ok:true
    };

   if(
    ![409,422].includes(
     r.status
    )||
    i===RETRIES
   ){
    return{
     ok:false,
     message:
      (await r.text())
       .slice(0,300)
    };
   }

  }catch(x){

   if(i===RETRIES)
    return{
     ok:false,
     message:x.message
    };
  }

  await sleep(
   i*700
  );
 }

 return{
  ok:false,
  message:
   "GitHub delete retry limit reached."
 };
}

/* =========================================================
   TELEGRAM GET FILE
   ========================================================= */

async function telegramGetFile(
 e,
 id
){

 for(
  let i=1;
  i<=3;
  i++
 ){

  try{

   const r=
    await fetchTimeout(
     `https://api.telegram.org/bot${e.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(id)}`,
     {},
     TG_TIMEOUT
    );

   const d=
    await r.json();

   if(d.ok)
    return d;

   if(r.status===429){
    await sleep(
     2000*i
    );
    continue;
   }

   if(i===3)
    return{
     ok:false
    };

  }catch{

   if(i===3)
    return{
     ok:false
    };
  }
 }

 return{
  ok:false
 };
}

/* =========================================================
   TELEGRAM CALL
   ========================================================= */

async function tgCall(
 e,
 method,
 body
){

 for(
  let i=1;
  i<=4;
  i++
 ){

  try{

   const r=
    await fetchTimeout(
     `https://api.telegram.org/bot${e.BOT_TOKEN}/${method}`,
     {
      method:"POST",
      headers:{
       "Content-Type":
        "application/json"
      },
      body:
       JSON.stringify(body)
     },
     TG_TIMEOUT
    );

   const d=
    await r.json();

   if(d.ok)
    return d;

   if(r.status===429){
    await sleep(
     2000*i
    );
    continue;
   }

   return d;

  }catch(x){

   if(i===4)
    throw x;

   await sleep(
    500*i
   );
  }
 }
}

/* =========================================================
   SEND MESSAGE
   ========================================================= */

async function sendMessage(
 e,
 chat,
 text,
 options={}
){
 try{

  await tgCall(
   e,
   "sendMessage",
   {
    chat_id:chat,
    text,
    ...options
   }
  );

 }catch(x){
  console.error(
   "TG SEND",
   x
  );
 }
}

/* =========================================================
   FETCH TIMEOUT
   ========================================================= */

async function fetchTimeout(
 url,
 opt,
 ms
){

 const c=
  new AbortController();

 const t=
  setTimeout(
   ()=>c.abort(),
   ms
  );

 try{

  return await fetch(
   url,
   {
    ...opt,
    signal:c.signal
   }
  );

 }catch(x){

  if(x.name==="AbortError")
   throw Error(
    `Request timeout (${ms/1000}s)`
   );

  throw x;

 }finally{

  clearTimeout(t);
 }
    }
// Cloudflare deployment
