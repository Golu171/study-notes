const OWNER="Golu171",REPO="study-notes",BRANCH="main";
const DEFAULT_FOLDER="HARYANA-GK/HARYANA-CURRENT";
const MAX_FILE_SIZE=20*1024*1024,RETRIES=8;
const WEBHOOK_SECRET="study-notes-webhook-2026";
const JOB_PREFIX="job:",DELETE_PREFIX="deletejob:";
const SESSION_MS=30*60*1000;
const TG_TIMEOUT=30000,DL_TIMEOUT=60000,GH_TIMEOUT=45000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

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
    if(await isStopped(env,j.chat_id)&&!j.auto){
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
      if(j.type === "delete"){
       await updateDeleteJob(env, j.id, {status:"failed", result: {error: "Max retries reached"}, finished_at:Date.now()});
       await updateDeletePanels(env, j.session, j.name, "❌ Failed: Max retries", j.folder);
      } else {
       await updateUploadJob(env, j.id, {status:"failed", result: {error: "Max retries reached"}, finished_at:Date.now()});
       await updateUploadPanels(env, j.session, j.file_name, "❌ Failed: Max retries", j.folder);
      }
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
  if(u.message)
   await handleMessage(u.message,e);
  else if(u.channel_post)
   await handleChannelPost(u.channel_post,e);
 }catch(x){
  console.error(x)
 }
}

async function handleMessage(m,e){
 const chat=String(m.chat?.id||"");
 const uid=String(m.from?.id||"");
 if(!chat||!uid)return;

 if(m.text?.startsWith("/"))
  return handleCommand(m,e);

 if(!m.document)return;

 if(!(await isStaff(e,uid)))
  return sendMessage(e,chat,"❌ Access denied.");

 if(await isStopped(e,chat))
  return sendMessage(e,chat,"🛑 Tumhari processing STOPPED hai.");

 await enqueueUpload(m.document,chat,uid,e,false);
}

async function handleChannelPost(m,e){
 if(await e.BOT_STATE.get("auto")!=="on")return;

 const ch=await e.BOT_STATE.get("channel_id");

 if(!ch||String(ch)!==String(m.chat?.id)||!m.document)
  return;

 await enqueueUpload(
  m.document,
  String(m.chat.id),
  String(m.sender_chat?.id||m.chat.id),
  e,
  true
 );
}

async function handleCommand(m,e){
 const chat=String(m.chat.id);
 const uid=String(m.from.id);
 const parts=(m.text||"").trim().split(/\s+/);
 const cmd=parts[0].split("@")[0].toLowerCase();
 const arg=parts.slice(1).join(" ").trim();

 if(cmd==="/start")
  return sendMessage(e,chat,`📚 Study Notes Bot\n\n/setfolder PATH\n/mkdir PATH\n/setchannel ID\n/auto on\n/auto off\n/status\n/delete FOLDER\n/delete 1 3 5\n/addadmin USER_ID\n/removeadmin USER_ID\n/admins\n/stop\n/resume\n\nHTML → JSON\nJSON → Direct Upload\nQueue → 1 file at a time`);

 if(cmd==="/stop"){
  if(!(await isStaff(e,uid))) return sendMessage(e,chat,"❌ Access denied.");
  await e.BOT_STATE.put(`stop:${chat}`,"1",{expirationTtl:604800});
  await stopPanels(e,chat);
  return sendMessage(e,chat,"🛑 Processing STOPPED. Tumhare pending upload/delete jobs pause rahenge.");
 }

 if(cmd==="/resume"){
  if(!(await isStaff(e,uid))) return sendMessage(e,chat,"❌ Access denied.");
  await e.BOT_STATE.delete(`stop:${chat}`);
  return sendMessage(e,chat,"▶️ Processing RESUMED. Tumhare pending jobs ab aage badhenge.");
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

async function enqueueUpload(doc,chat,uid,e,auto){
 const name=cleanUploadName(doc.file_name||"");

 if(!name){
  if(!auto) await sendMessage(e,chat,"❌ Sirf .html ya .json file allowed hai.");
  return
 }
 if((doc.file_size||0)>MAX_FILE_SIZE){
  if(!auto) await sendMessage(e,chat,"❌ Maximum file size 20 MB hai.");
  return
 }

 const folder=await e.BOT_STATE.get("folder")||DEFAULT_FOLDER;
 const session=`${Math.floor(Date.now()/SESSION_MS)}:${auto?"AUTO":uid}`;
 const id=crypto.randomUUID();

 const j={
  type:"upload", id, chat_id:chat, user_id:uid, file_id:doc.file_id,
  file_name:name, file_size:doc.file_size||0, folder, session, auto,
  status:"queued", created_at:Date.now()
 };

 await e.BOT_STATE.put(JOB_PREFIX+id,JSON.stringify(j),{expirationTtl:86400});
 await envQueueSend(e,j);
 await ensureUploadPanel(e,session,folder,auto?null:chat);
}

async function envQueueSend(e,j){
 await e.UPLOAD_QUEUE.send(j)
}

async function processUploadJob(j,e){
 if(await isStopped(e,j.chat_id)&&!j.auto) throw Error("__PAUSED__");

 await updateUploadJob(e,j.id,{status:"processing"});
 await updateUploadPanels(e,j.session,j.file_name,"⚙️ Processing",j.folder);

 let r;
 try{
  r=await processDocument(j,e)
 }catch(x){
  if(x.message==="__PAUSED__") throw x;
  r={ok:false, message:x.message||"Unknown error"}
 }

 await updateUploadJob(e,j.id,{
   status:r.ok?"success":"failed",
   result:r.ok?
    {questions:r.questions||0, jsonName:r.jsonName||"", skipped:!!r.skipped}:
    {error:r.message},
   finished_at:Date.now()
 });

 await sleep(1000);

 await updateUploadPanels(
  e, j.session, j.file_name,
  r.ok?(r.skipped?"⏭️ Already Exists — Skipped ✅":"☁️ GitHub Upload ✅"):"❌ Failed: "+r.message,
  j.folder
 );
}

async function processDocument(j,e){
 if(await isStopped(e,j.chat_id)&&!j.auto) throw Error("__PAUSED__");

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

async function updateUploadJob(e,id,patch){
 const j=await getJob(e,id);
 if(j){
  Object.assign(j,patch);
  await e.BOT_STATE.put(JOB_PREFIX+id,JSON.stringify(j),{expirationTtl:86400});
 }
}

async function getJob(e,id){
 try{ return JSON.parse(await e.BOT_STATE.get(JOB_PREFIX+id)||"null") }catch{ return null }
}

async function getSessionJobs(e,session){
 const keys=[];
 let cursor;
 do{
  const r=await e.BOT_STATE.list({prefix:JOB_PREFIX,limit:100,...(cursor?{cursor}:{})});
  for(const k of r.keys) keys.push(k.name);
  cursor=r.list_complete?undefined:r.cursor;
 }while(cursor);

 const out=[];
 for(const k of keys){
  const j=await getJob(e,k.slice(JOB_PREFIX.length));
  if(j?.session===session) out.push(j);
 }
 return out.sort((a,b)=>a.created_at-b.created_at);
}

async function ensureUploadPanel(e,session,folder,chatOnly){
 const ids=chatOnly?[String(chatOnly)]:await getStaffIds(e);
 for(const id of ids){
  const key=`panel:upload:${id}`;
  let p;
  try{ p=JSON.parse(await e.BOT_STATE.get(key)||"null") }catch{}
  if(p?.session===session&&p.message_id) continue;

  const jobs=await getSessionJobs(e,session);
  const text=uploadPanelText(jobs,folder,"Waiting...","⏳ Waiting");
  const r=await sendMessageGetId(e,id,text);

  if(r.ok) await e.BOT_STATE.put(key,JSON.stringify({session,message_id:r.message_id,folder}),{expirationTtl:86400});
  await sleep(1100);
 }
}

async function updateUploadPanels(e,session,current,stage,folder){
 const jobs=await getSessionJobs(e,session);
 const ids=await getStaffIds(e);
 const text=uploadPanelText(jobs,folder,current,stage);

 await Promise.all(
  ids.map(async id=>{
   let p;
   try{ p=JSON.parse(await e.BOT_STATE.get(`panel:upload:${id}`)||"null") }catch{}
   if(p?.session===session&&p.message_id) await editMessage(e,id,p.message_id,text)
  })
 );

 if(jobs.length&&jobs.every(x=>x.status==="success"||x.status==="failed")){
  const failed=jobs.filter(x=>x.status==="failed");
  const final=text+`\n\n🏁 QUEUE COMPLETE\n`+(failed.length?`\n❌ Failed Files:\n`+failed.map(x=>`• ${x.file_name}\n  Reason: ${x.result?.error||"Unknown error"}`).join("\n"):"\n✅ All files completed successfully.");

  await Promise.all(
   ids.map(async id=>{
    let p;
    try{ p=JSON.parse(await e.BOT_STATE.get(`panel:upload:${id}`)||"null") }catch{}
    if(p?.session===session&&p.message_id) await editMessage(e,id,p.message_id,final)
   })
  );
 }
}

function uploadPanelText(jobs,folder,current,stage){
 const total=jobs.length;
 const done=jobs.filter(x=>x.status==="success").length;
 const fail=jobs.filter(x=>x.status==="failed").length;
 const finished=done+fail;
 const pct=total?Math.round(finished*100/total):0;

 return`📦 Total Files : ${total}\n✅ Completed   : ${done}\n❌ Failed      : ${fail}\n\n📊 Progress : ${finished} / ${total}\n${bar(finished,total)} ${pct}%\n\n⚙️ Processing\n${current||"Waiting..."}\n\n${stage||"⏳ Waiting"}\n\n📁 Folder\n${folder}`;
}

function bar(done,total){
 const n=total?Math.round(done*20/total):0;
 return "█".repeat(n)+"░".repeat(20-n);
}

async function deleteCommand(e,chat,arg){
 const nums=arg.split(/[\s,]+/).filter(Boolean);

 if(nums.length&&nums.every(x=>/^\d+$/.test(x))){
  let list;
  try{ list=JSON.parse(await e.BOT_STATE.get(`delete_list:${chat}`)||"null") }catch{}

  if(!Array.isArray(list)||!list.length) return sendMessage(e,chat,"❌ Pehle /delete FOLDER bhejo.");

  const sel=[...new Set(nums.map(Number))];
  if(sel.some(n=>n<1||n>list.length)) return sendMessage(e,chat,`❌ Number 1-${list.length} ke beech hona chahiye.`);

  const session=`${Date.now()}:${chat}`;
  const jobs=sel.map(n=>({
   type:"delete", id:crypto.randomUUID(), chat_id:chat, path:list[n-1].path,
   name:list[n-1].name, folder:list[n-1].path.split("/").slice(0,-1).join("/"),
   session, status:"queued", created_at:Date.now()
  }));

  for(const j of jobs){
   await e.BOT_STATE.put(DELETE_PREFIX+j.id,JSON.stringify(j),{expirationTtl:86400});
   await e.UPLOAD_QUEUE.send(j);
  }

  await ensureDeletePanel(e,session,jobs[0].folder,chat);
  return sendMessage(e,chat,`📥 Delete Queue me ${jobs.length} files add ho gayi.`);
 }

 const folder=cleanPath(arg||await e.BOT_STATE.get("folder")||DEFAULT_FOLDER);
 if(!folder) return sendMessage(e,chat,"❌ Invalid folder path.");

 const r=await githubList(e,folder);
 if(!r.ok) return sendMessage(e,chat,`❌ Folder nahi mila:\n${folder}`);

 const files=r.items.filter(x=>x.type==="file"&&/\.(html?|json)$/i.test(x.name)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"}));
 if(!files.length) return sendMessage(e,chat,`📁 Is folder me HTML/JSON file nahi mili.\n\n${folder}`);

 const list=files.map((x,i)=>({n:i+1,name:x.name,path:x.path}));
 await e.BOT_STATE.put(`delete_list:${chat}`,JSON.stringify(list),{expirationTtl:1800});

 return sendMessage(e,chat,`📁 Folder:\n${folder}\n\n${list.map(x=>`${x.n}. ${x.name}`).join("\n")}\n\n🗑️ Delete selected:\n /delete 1 3 5`);
}

async function ensureDeletePanel(e,session,folder,chat){
 const key=`panel:delete:${chat}`;
 let p;
 try{ p=JSON.parse(await e.BOT_STATE.get(key)||"null") }catch{}
 if(p?.session===session) return;

 const r=await sendMessageGetId(e,chat,deletePanelText([],folder,"Waiting...","⏳ Waiting"));
 if(r.ok) await e.BOT_STATE.put(key,JSON.stringify({session,message_id:r.message_id,folder}),{expirationTtl:86400});
}

async function processDeleteJob(j,e){
 if(await isStopped(e,j.chat_id)) throw Error("__PAUSED__");

 await updateDeleteJob(e,j.id,{status:"processing"});
 await updateDeletePanels(e,j.session,j.name,"☁️ GitHub Delete ⏳",j.folder);

 let r;
 try{
  r=await githubDelete(e,j.path,`Delete ${j.name}`)
 }catch(x){
  r={ok:false, message:x.message}
 }

 await updateDeleteJob(e,j.id,{status:r.ok?"success":"failed",result:r.ok?{}:{error:r.message},finished_at:Date.now()});
 await updateDeletePanels(e,j.session,j.name,r.ok?"☁️ GitHub Delete ✅":"❌ Failed: "+r.message,j.folder);
}

async function getDeleteJob(e,id){
 try{ return JSON.parse(await e.BOT_STATE.get(DELETE_PREFIX+id)||"null") }catch{ return null }
}

async function updateDeleteJob(e,id,patch){
 const j=await getDeleteJob(e,id);
 if(j){
  Object.assign(j,patch);
  await e.BOT_STATE.put(DELETE_PREFIX+id,JSON.stringify(j),{expirationTtl:86400});
 }
}

async function getDeleteSessionJobs(e,session){
 const keys=[];
 let cursor;
 do{
  const r=await e.BOT_STATE.list({prefix:DELETE_PREFIX,limit:100,...(cursor?{cursor}:{})});
  for(const k of r.keys) keys.push(k.name);
  cursor=r.list_complete?undefined:r.cursor;
 }while(cursor);

 const out=[];
 for(const k of keys){
  const j=await getDeleteJob(e,k.slice(DELETE_PREFIX.length));
  if(j?.session===session) out.push(j);
 }
 return out.sort((a,b)=>a.created_at-b.created_at);
}

async function updateDeletePanels(e,session,current,stage,folder){
 const jobs=await getDeleteSessionJobs(e,session);
 const text=deletePanelText(jobs,folder,current,stage);
 const p=await getDeletePanel(e,session);
 if(p?.message_id) await editMessage(e,p.chat_id,p.message_id,text);

 if(jobs.length&&jobs.every(x=>x.status==="success"||x.status==="failed")){
  const fail=jobs.filter(x=>x.status==="failed");
  const final=text+`\n\n🏁 DELETE COMPLETE\n`+(fail.length?`\n❌ Failed Files:\n`+fail.map(x=>`• ${x.name}\n  Reason: ${x.result?.error||"Unknown error"}`).join("\n"):"\n✅ All selected files deleted.");
  if(p?.message_id) await editMessage(e,p.chat_id,p.message_id,final);
 }
}

async function getDeletePanel(e,session){
 const ids=await getStaffIds(e);
 for(const id of ids){
  let p;
  try{ p=JSON.parse(await e.BOT_STATE.get(`panel:delete:${id}`)||"null") }catch{}
  if(p?.session===session) return{...p,chat_id:String(id)};
 }
 return null
}

function deletePanelText(jobs,folder,current,stage){
 const total=jobs.length;
 const done=jobs.filter(x=>x.status==="success").length;
 const fail=jobs.filter(x=>x.status==="failed").length;
 const finished=done+fail;

 return`🗑️ DELETE QUEUE\n\n📦 Total Files : ${total}\n✅ Completed   : ${done}\n❌ Failed      : ${fail}\n\n📊 Progress : ${finished} / ${total}\n${bar(finished,total)}\n\n⚙️ Processing\n${current||"Waiting..."}\n\n${stage}\n\n📁 Folder\n${folder}`;
}

async function status(e,chat){
 const[f,a,ch,s,admins]=await Promise.all([
  e.BOT_STATE.get("folder"), e.BOT_STATE.get("auto"), e.BOT_STATE.get("channel_id"),
  isStopped(e,chat), getAdmins(e)
 ]);
 return sendMessage(e,chat,`📊 STATUS\n\nOperations : ${s?"🛑 STOPPED":"🟢 RUNNING"}\nAuto       : ${(a||"off").toUpperCase()}\nFolder     : ${f||DEFAULT_FOLDER}\nChannel    : ${ch||"Not set"}\nAdmins     : ${admins.length}\nQueue      : 1 file at a time`);
}

async function stopPanels(e,chat){
 for(const k of [`panel:upload:${chat}`,`panel:delete:${chat}`]){
  let p;
  try{ p=JSON.parse(await e.BOT_STATE.get(k)||"null") }catch{}
  if(p?.message_id) await editMessage(e,chat,p.message_id,"🛑 PROCESSING STOPPED\n\nTumhare pending jobs pause hain.");
 }
}

async function getAdmins(e){
 try{
  const a=JSON.parse(await e.BOT_STATE.get("admins")||"[]");
  return Array.isArray(a)?a.map(String):[];
 }catch{ return[] }
}

async function isAdmin(e,id){
 return(await getAdmins(e)).includes(String(id))
}

async function isStaff(e,id){
 const o=await e.BOT_STATE.get("owner_id");
 return!!o&&(String(o)===String(id)||await isAdmin(e,id));
}

async function getStaffIds(e){
 const a=await getAdmins(e);
 const o=await e.BOT_STATE.get("owner_id");
 return[...new Set([o,...a].filter(Boolean).map(String))];
}

async function isStopped(e,id){
 return(await e.BOT_STATE.get(`stop:${id}`))==="1";
}

function sanitizeJS(str) {
 return str
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')
  .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
  .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (m, p1) => `"${p1.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`)
  .replace(/,\s*([\]}])/g, '$1');
}

function htmlToQuizJson(s){
 const m=s.match(/(?:const|let|var)\s+Qs\s*=\s*/i);
 if(m){
  const a=extractBalanced(s,m.index+m[0].length,"[","]");
  if(!a) return{ok:false,message:"Qs array complete nahi mili."};
  try{
   const q=JSON.parse(sanitizeJS(a));
   if(!Array.isArray(q)||!q.length) throw 0;
   return{ok:true,questions:q};
  }catch{ return{ok:false,message:"Qs valid JSON format me nahi hai."}; }
 }

 const d=s.match(/(?:const|let|var)\s+Q_DATA\s*=\s*/i);
 if(!d) return{ok:false,message:"Qs / Q_DATA nahi mila."};
 const a=extractBalanced(s,d.index+d[0].length,"[","]");
 if(!a) return{ok:false,message:"Q_DATA array complete nahi mili."};
 try{
  const q=JSON.parse(sanitizeJS(a));
  if(Array.isArray(q)&&q.length) return{ok:true,questions:q};
  return{ok:false,message:"Q_DATA empty hai."};
 }catch{ return{ok:false,message:"Q_DATA valid JSON format me nahi hai."}; }
}

function extractBalanced(s,start,open,close){
 let d=0,str="",esc=false;
 for(let i=start;i<s.length;i++){
  const c=s[i];
  if(str){
   if(esc) esc=false;
   else if(c==="\\") esc=true;
   else if(c===str) str="";
   continue
  }
  if(c==='"'||c==="'"){ str=c; continue }
  if(c===open) d++;
  else if(c===close&&--d===0) return s.slice(start,i+1);
 }
 return null
}

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
    await sleep(i*1000);
    continue;
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

async function telegramGetFile(e,id){
 for(let i=1;i<=3;i++){
  try{
   const r=await fetchTimeout(`https://api.telegram.org/bot${e.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(id)}`,{},TG_TIMEOUT);
   const d=await r.json();
   if(d.ok) return d;
   if(r.status===429){ await sleep(2000*i); continue }
   if(i===3) return{ok:false};
  }catch(x){
   if(i===3) return{ok:false};
  }
 }
 return{ok:false}
}

async function tgCall(e,method,body){
 for(let i=1;i<=4;i++){
  try{
   const r=await fetchTimeout(`https://api.telegram.org/bot${e.BOT_TOKEN}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},TG_TIMEOUT);
   const d=await r.json();
   if(d.ok) return d;
   if(r.status===429){ await sleep(2000*i); continue }
   return d;
  }catch(x){
   if(i===4) throw x;
   await sleep(500*i)
  }
 }
}

async function sendMessage(e,chat,text){
 try{ await tgCall(e,"sendMessage",{chat_id:chat,text}) }catch(x){ console.error("TG SEND",x) }
}

async function sendMessageGetId(e,chat,text){
 try{
  const d=await tgCall(e,"sendMessage",{chat_id:chat,text});
  return{ok:!!d?.ok,message_id:d?.result?.message_id};
 }catch{ return{ok:false}; }
}

async function editMessage(e,chat,id,text){
 try{
  const d=await tgCall(e,"editMessageText",{chat_id:chat,message_id:id,text});
  return!!d?.ok
 }catch{ return false }
}

async function fetchTimeout(url,opt,ms){
 const c=new AbortController();
 const t=setTimeout(()=>c.abort(),ms);
 try{
  return await fetch(url,{...opt,signal:c.signal})
 }catch(x){
  if(x.name==="AbortError") throw Error(`Request timeout (${ms/1000}s)`);
  throw x
 }finally{ clearTimeout(t) }
}
// Cloudflare deployment
