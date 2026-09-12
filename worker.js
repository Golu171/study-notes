const OWNER="Golu171",REPO="study-notes",BRANCH="main";
const DEFAULT_FOLDER="HARYANA-GK/HARYANA-CURRENT";
const MAX_FILE_SIZE=20*1024*1024,RETRIES=8;
const WEBHOOK_SECRET="study-notes-webhook-2026";
const TG_TIMEOUT=30000,DL_TIMEOUT=60000,GH_TIMEOUT=45000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const MEM_CACHE={};

export default{
 async fetch(req,env,ctx){
  const u=new URL(req.url);
  if(req.method==="GET")return new Response("Study Notes Bot OK");
  if(req.method!=="POST"||u.pathname!=="/telegram")return new Response("Not Found",{status:404});
  if(req.headers.get("X-Telegram-Bot-Api-Secret-Token")!==WEBHOOK_SECRET)return new Response("Unauthorized",{status:401});
  try{ctx.waitUntil(processUpdate(await req.json(),env));return new Response("OK")}
  catch{return new Response("Bad Request",{status:400})}
 },
 async queue(batch,env){
  for(const msg of batch.messages){
   const j=msg.body;
   try{
    if(await isStopped(env,j.chat_id)&&!j.auto){
     await env.UPLOAD_QUEUE.send(j,{delaySeconds:30});msg.ack();continue;
    }
    if(j.type==="delete")await processDeleteJob(j,env);else await processUploadJob(j,env);
    msg.ack();
   }catch(e){
    if(e.message==="__PAUSED__"){
     await env.UPLOAD_QUEUE.send(j,{delaySeconds:30});msg.ack();
    }else{
     console.error("QUEUE",e);
     if(msg.attempts>3){
      msg.ack();
      const targetChat=j.auto?(j.panel_chat_id||j.chat_id):j.chat_id;
      await sendMessage(env,targetChat,
       `❌ Failed: ${j.file_name||j.name}\nReason: ${e?.message||String(e)||"Unknown queue error"}`,
       {reply_to_message_id:j.auto?undefined:j.msg_id,disable_notification:true});
     }else msg.retry({delaySeconds:15*msg.attempts});
    }
   }
  }
 }
};

async function processUpdate(u,e){
 try{
  if(!e.BOT_STATE||!e.UPLOAD_QUEUE){
   const chat=u.message?.chat?.id||u.channel_post?.chat?.id;
   if(chat)await sendMessage(e,chat,"⚠️ ERROR: Cloudflare Bindings (BOT_STATE or UPLOAD_QUEUE) missing hain!");
   return;
  }
  if(u.message)await handleMessage(u.message,e);
  else if(u.channel_post)await handleChannelPost(u.channel_post,e);
 }catch(x){console.error(x)}
}

async function handleMessage(m,e){
 const chat=String(m.chat?.id||""),uid=String(m.from?.id||"");
 if(!chat||!uid)return;
 if(m.text?.startsWith("/"))return handleCommand(m,e);
 if(!m.document)return;
 if(!(await isStaff(e,uid)))return sendMessage(e,chat,"❌ Access denied.");
 if(await isStopped(e,chat))return sendMessage(e,chat,"🛑 Tumhari processing STOPPED hai.");
 await enqueueUpload(m.document,chat,uid,e,false,m.message_id);
}

async function handleChannelPost(m,e){
 if(await e.BOT_STATE.get("auto")!=="on")return;
 const ch=await e.BOT_STATE.get("channel_id");
 if(!ch||String(ch)!==String(m.chat?.id)||!m.document)return;
 // Channel posts are processed from the channel, but the LIVE PANEL must
 // always live in the bot's private chat. Never fall back to the channel.
 const panelChat=await e.BOT_STATE.get("panel_chat_id");
 if(!panelChat)return;
 await enqueueUpload(m.document,String(m.chat.id),String(m.sender_chat?.id||m.chat.id),e,true,m.message_id,String(panelChat));
}

async function handleCommand(m,e){
 const chat=String(m.chat.id),uid=String(m.from.id);
 const parts=(m.text||"").trim().split(/\s+/);
 const cmd=parts[0].split("@")[0].toLowerCase(),arg=parts.slice(1).join(" ").trim();

 if(cmd==="/start")return sendMessage(e,chat,`📚 Study Notes Bot

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
⚡ Uploads do NOT write to KV`);

 if(cmd==="/stop"){
  if(!(await isStaff(e,uid)))return sendMessage(e,chat,"❌ Access denied.");
  await e.BOT_STATE.put(`stop:${chat}`,"1",{expirationTtl:604800});
  return sendMessage(e,chat,"🛑 Processing STOPPED. Pending jobs pause rahenge.");
 }

 if(cmd==="/resume"){
  if(!(await isStaff(e,uid)))return sendMessage(e,chat,"❌ Access denied.");
  // Keep the KV key instead of deleting it; this avoids unnecessary KV delete operations.
  await e.BOT_STATE.put(`stop:${chat}`,"0",{expirationTtl:604800});
  return sendMessage(e,chat,"▶️ Processing RESUMED. Pending jobs aage badhenge.");
 }

 const owner=await e.BOT_STATE.get("owner_id");
 const own=owner&&String(owner)===uid;
 const admin=!own&&await isAdmin(e,uid);

 if(["/addadmin","/removeadmin","/admins"].includes(cmd)){
  if(!own)return sendMessage(e,chat,"❌ Sirf owner ye command use kar sakta hai.");
  let a=await getAdmins(e);
  if(cmd==="/admins")return sendMessage(e,chat,a.length?`👥 Admins:\n\n${a.map((x,i)=>`${i+1}. ${x}`).join("\n")}`:"👥 Koi admin nahi hai.");
  if(!/^\d+$/.test(arg))return sendMessage(e,chat,`Use:\n${cmd} USER_ID`);
  if(cmd==="/addadmin"){
   if(!a.includes(arg))a.push(arg);
   await e.BOT_STATE.put("admins",JSON.stringify(a));
   return sendMessage(e,chat,`✅ Admin added: ${arg}`);
  }
  a=a.filter(x=>x!==arg);
  await e.BOT_STATE.put("admins",JSON.stringify(a));
  return sendMessage(e,chat,`✅ Admin removed: ${arg}`);
 }

 if(!own&&admin===false)return sendMessage(e,chat,"❌ Access denied.");

 if(cmd==="/setfolder"){
  const f=cleanPath(arg);
  if(!f)return sendMessage(e,chat,"❌ Invalid folder path.");
  await e.BOT_STATE.put("folder",f);
  const pc=await e.BOT_STATE.get("panel_chat_id");
  const ch=await e.BOT_STATE.get("channel_id");
  const ps=await e.BOT_STATE.get("panel_state");
  if(pc&&ch&&ps){
   try{
    const x=JSON.parse(ps);
    if(String(x.channel)===String(ch)&&String(x.chat)===String(pc)&&x.msg){
     const pt=`📊 <b>SMART LIVE PANEL</b> (Channel Auto)\n📢 <code>${escapeHtml(ch)}</code>\n📁 <code>${escapeHtml(f)}</code>\n\n⏳ <i>Waiting for next file...</i>`;
     await tgCall(e,"editMessageText",{chat_id:pc,message_id:Number(x.msg),text:pt,parse_mode:"HTML"});
     const k=`${String(ch)}|${String(pc)}`;
     if(MEM_CACHE[k])MEM_CACHE[k].folder=f;
    }
   }catch{}
  }
  return sendMessage(e,chat,`📁 Current folder set:\n${f}\n\nℹ️ Ab se HTML/JSON uploads isi folder me jayenge.`);
 }

 if(cmd==="/mkdir"){
  const f=cleanPath(arg);
  if(!f)return sendMessage(e,chat,"❌ Invalid folder path.");
  const r=await githubPut(e,`${f}/.gitkeep`,"",`Create folder ${f}`);
  return sendMessage(e,chat,r.ok?`✅ Folder ready:\n${f}`:`❌ ${r.message}`);
 }

 if(cmd==="/setchannel"){
  if(!arg)return sendMessage(e,chat,"Use /setchannel CHANNEL_ID");
  const oldChannel=await e.BOT_STATE.get("channel_id");
  await e.BOT_STATE.put("channel_id",arg);
  // NEW channel = NEW panel. Same channel keeps the existing panel.
  if(String(oldChannel||"")!==String(arg)){
   const pc=await e.BOT_STATE.get("panel_chat_id");
   if(pc)delete MEM_CACHE[String(pc)];
  }
  return sendMessage(e,chat,`📢 Channel set:\n${arg}`);
 }

 if(cmd==="/auto"){
  const v=arg.toLowerCase();
  if(v!=="on"&&v!=="off")return sendMessage(e,chat,"Use /auto on or /auto off");
  await e.BOT_STATE.put("auto",v);
  if(v==="on"){
   // Live Panel is always anchored to the PRIVATE BOT CHAT.
   // Never overwrite it from a group/channel chat.
   if(m.chat?.type!=="private"){
    return sendMessage(e,chat,"⚠️ /auto on sirf bot ke PRIVATE chat me run karo.\n📊 Live Panel wahi bot chat me aayega.");
   }
   // Remove an old panel that a previous version may have created in the
   // channel, then anchor the single live panel to this private bot chat.
   const oldState=await e.BOT_STATE.get("panel_state");
   try{
    const old=JSON.parse(oldState||"{}");
    if(old.msg&&old.chat&&String(old.chat)!==String(chat)){
     await tgCall(e,"deleteMessage",{chat_id:old.chat,message_id:Number(old.msg)});
    }
   }catch{}
   await e.BOT_STATE.put("panel_chat_id",chat);
   const activeChannel=await e.BOT_STATE.get("channel_id")||"";
   if(activeChannel)await ensureLivePanel(e,activeChannel,chat);
  }
  return sendMessage(e,chat,v==="on"
   ?"🟢 Auto ON\n📊 Live Panel: isi bot chat me aayega."
   :"🔴 Auto OFF");
 }

 if(cmd==="/status")return status(e,chat);
 if(cmd==="/delete")return deleteCommand(e,chat,arg);
 return sendMessage(e,chat,"❌ Unknown command. /start use karo.");
}

/* UPLOAD QUEUE: folder = ONE KV READ, then carried in job. */
async function enqueueUpload(doc,chat,uid,e,auto,msg_id,panelChat=null){
 const name=cleanUploadName(doc.file_name||"");
 if(!name){
  if(!auto)await sendMessage(e,chat,"❌ Sirf .html ya .json file allowed hai.",{reply_to_message_id:msg_id});
  return;
 }
 if((doc.file_size||0)>MAX_FILE_SIZE){
  if(!auto)await sendMessage(e,chat,"❌ Maximum file size 20 MB hai.",{reply_to_message_id:msg_id});
  return;
 }
 const folder=await e.BOT_STATE.get("folder")||DEFAULT_FOLDER;
 const j={type:"upload",chat_id:chat,panel_chat_id:panelChat||chat,file_id:doc.file_id,file_name:name,folder,auto,msg_id};
 await e.UPLOAD_QUEUE.send(j);
}

async function ensureLivePanel(e,channel,panelChat){
 const key=`${String(channel)}|${String(panelChat)}`;
 let p=MEM_CACHE[key];
 if(p?.msg_id)return p.msg_id;
 let saved={};
 try{saved=JSON.parse(await e.BOT_STATE.get("panel_state")||"{}")}catch{}
 if(String(saved.channel||"")===String(channel)&&String(saved.chat||"")===String(panelChat)&&saved.msg){
  MEM_CACHE[key]={msg_id:Number(saved.msg),done:0,skip:0,fail:0,time:Date.now()};
  return Number(saved.msg);
 }
 const folder=await e.BOT_STATE.get("folder")||DEFAULT_FOLDER;
 const sent=await tgCall(e,"sendMessage",{chat_id:panelChat,text:`📊 <b>SMART LIVE PANEL</b> (Channel Auto)\n📢 <code>${escapeHtml(channel)}</code>\n📁 <code>${escapeHtml(folder)}</code>\n\n⏳ <i>Waiting for next file...</i>`,parse_mode:"HTML"});
 if(!sent?.ok)return null;
 const msg=sent.result.message_id;
 MEM_CACHE[key]={msg_id:msg,done:0,skip:0,fail:0,time:Date.now()};
 await e.BOT_STATE.put("panel_state",JSON.stringify({channel:String(channel),chat:String(panelChat),msg:String(msg)}));
 return msg;
}

async function processUploadJob(j,e){
 if(await isStopped(e,j.chat_id)&&!j.auto)throw Error("__PAUSED__");
 const panelChat=String(j.panel_chat_id||j.chat_id);
 const now=Date.now();
 const activeChannel=await e.BOT_STATE.get("channel_id")||"";
 const key=`${String(activeChannel)}|${String(panelChat)}`;
 let p=MEM_CACHE[key];
 if(!p){p={msg_id:null,done:0,skip:0,fail:0,time:now};MEM_CACHE[key]=p;}
 p.time=now;
 if(j.auto&&activeChannel){const mid=await ensureLivePanel(e,activeChannel,panelChat);if(mid)p.msg_id=mid;}

 await updatePanel(e,j,p,`⚙️ <i>Processing:</i>\n📄 <code>${escapeHtml(j.file_name)}</code>`);
 let r;
 try{r=await processDocument(j,e)}
 catch(x){
  if(x.message==="__PAUSED__")throw x;
  r={ok:false,message:x.message||"Unknown error"};
 }
 if(r.ok){if(r.skipped)p.skip++;else p.done++;}else p.fail++;

 // Keep the reaction on the original channel post.
 if(j.msg_id){
  const emoji=r.ok?(r.skipped?"🤷‍♂️":"👍"):"👎";
  await tgCall(e,"setMessageReaction",{chat_id:j.chat_id,message_id:j.msg_id,reaction:[{type:"emoji",emoji}]});
 }

 await updatePanel(e,j,p,"⏳ <i>Waiting for next file...</i>");

 if(!r.ok){
  await sendMessage(e,panelChat,`❌ Failed: ${j.file_name}\nReason: ${r.message}`,{reply_to_message_id:p.msg_id,disable_notification:true});
 }
 await sleep(1000);
}

async function updatePanel(e,j,p,extra){
 const panelChat=String(j.panel_chat_id||j.chat_id);
 const text=`📊 <b>SMART LIVE PANEL</b> ${j.auto?"(Channel Auto)":""}\n📁 <code>${escapeHtml(j.folder)}</code>\n\n✅ Uploaded : ${p.done}\n🤷 Skipped  : ${p.skip}\n❌ Failed   : ${p.fail}\n\n${extra}`;
 if(!p.msg_id)return;
 const r=await tgCall(e,"editMessageText",{chat_id:panelChat,message_id:p.msg_id,text,parse_mode:"HTML"});
 if(r?.ok)return;
 // If the old panel was deleted, recreate it once for this channel/chat.
 if(j.auto&&String(r?.description||"").toLowerCase().includes("message to edit not found")){
  const channel=await e.BOT_STATE.get("channel_id")||"";
  const mid=await ensureLivePanel(e,channel,panelChat);
  if(mid){p.msg_id=mid;await tgCall(e,"editMessageText",{chat_id:panelChat,message_id:p.msg_id,text,parse_mode:"HTML"});}
 }
}

function escapeHtml(s){
 return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

async function processDocument(j,e){
 if(await isStopped(e,j.chat_id)&&!j.auto)throw Error("__PAUSED__");
 const isDirectJson=/\.json$/i.test(j.file_name);
 const targetJson=isDirectJson?j.file_name:j.file_name.replace(/\.(html|htm)$/i,".json");

 const existing=await githubFileExists(e,`${j.folder}/${targetJson}`);
 if(!existing.ok)throw Error("GitHub existing-file check failed: "+existing.message);

 if(existing.exists)return{ok:true,skipped:true,questions:0,jsonName:targetJson};

 const f=await telegramGetFile(e,j.file_id);
 if(!f.ok)throw Error("Telegram file lookup failed.");
 const r=await fetchTimeout(`https://api.telegram.org/file/bot${e.BOT_TOKEN}/${f.result.file_path}`,{},DL_TIMEOUT);
 if(!r.ok)throw Error("Telegram download failed.");
 const buf=await r.arrayBuffer();
 if(buf.byteLength>MAX_FILE_SIZE)throw Error("File 20 MB se badi hai.");
 const text=new TextDecoder().decode(buf);

 if(isDirectJson){
  let raw;
  try{raw=parseAnyQuestionData(text)}catch(x){throw Error("Question data parse failed: "+x.message)}
  const norm=normalizeQuestionSet(raw);
  if(!norm.length)throw Error("Question data nahi mila.");
  const out=j.file_name.replace(/\.json$/i,".json");
  const g=await githubPut(e,`${j.folder}/${out}`,textToBase64(JSON.stringify(norm,null,2)),`Add normalized JSON ${out}`);
  if(!g.ok)throw Error(g.message);
  return{ok:true,questions:norm.length,jsonName:out};
 }

 const q=htmlToQuizJson(text);
 if(!q.ok)throw Error(q.message);
 if(await isStopped(e,j.chat_id)&&!j.auto)throw Error("__PAUSED__");
 const json=j.file_name.replace(/\.(html|htm)$/i,".json");
 const g=await githubPut(e,`${j.folder}/${json}`,textToBase64(JSON.stringify(q.questions,null,2)),`Add JSON ${json}`);
 if(!g.ok)throw Error(g.message);
 return{ok:true,questions:q.questions.length,jsonName:json};
}

/* UNIVERSAL QUESTION JSON NORMALIZER */
function parseAnyQuestionData(text){
 const src=String(text||"").replace(/^\uFEFF/,"").trim();
 if(!src)throw Error("Empty file");
 try{return JSON.parse(src)}catch{}
 try{const p=new JSLiteralParser(src),v=p.parseValue();p.skipSpaceAndComments();if(p.i<src.length)throw Error(`Unexpected token at position ${p.i}`);return v}catch(x){
  for(const pair of [["[","]"],["{","}"]]){const at=src.indexOf(pair[0]);if(at>=0){const part=extractBalanced(src,at,pair[0],pair[1]);if(part){try{const p=new JSLiteralParser(part),v=p.parseValue();p.skipSpaceAndComments();if(p.i===part.length)return v}catch{}}}}
  throw x;
 }
}
function normalizeQuestionSet(raw){const list=findQuestionList(raw);return (Array.isArray(list)?list:[]).map((x,i)=>normalizeQuestion(x,i)).filter(x=>x.question||x.options.some(Boolean)||x.solution)}
function findQuestionList(v){
 if(Array.isArray(v))return v;if(!v||typeof v!=="object")return [];
 const preferred=["questions","question","data","quiz","items","mcqs","mcq","results","tests","exam","q_data","Q_DATA","Qs"];
 for(const k of preferred)if(Array.isArray(v[k]))return v[k];
 for(const k of Object.keys(v))if(Array.isArray(v[k])&&v[k].some(x=>x&&typeof x==="object"))return v[k];
 return getAny(v,["question","questionText","ques","q","text"])?[v]:[];
}
function getAny(o,keys){
 if(!o||typeof o!=="object")return undefined;const lower={};for(const k of Object.keys(o))lower[k.toLowerCase()]=o[k];
 for(const k of keys){if(o[k]!==undefined&&o[k]!==null)return o[k];const x=lower[String(k).toLowerCase()];if(x!==undefined&&x!==null)return x}return undefined;
}
function cleanText(v){
 if(v===undefined||v===null)return "";if(typeof v==="string")return v.trim();if(typeof v==="number"||typeof v==="boolean")return String(v);
 if(Array.isArray(v))return v.map(cleanText).filter(Boolean).join("\n");
 if(typeof v==="object"){const x=getAny(v,["text","value","content","html","description","explanation","solution"]);if(x!==undefined)return cleanText(x);return Object.entries(v).map(([k,val])=>`${k}: ${cleanText(val)}`).join("\n").trim()}
 return String(v);
}
function normalizeQuestion(x,index){
 x=(x&&typeof x==="object")?x:{question:x};
 const question=cleanText(getAny(x,["question","questionText","question_text","ques","q","text","title","problem","statement"]))||`Question ${index+1}`;
 const rawOpt=getAny(x,["options","option","choices","choice","answers","alternatives"]);let opts=[];
 if(Array.isArray(rawOpt))opts=rawOpt.map(cleanText);else if(rawOpt&&typeof rawOpt==="object")opts=["A","B","C","D"].map(k=>cleanText(getAny(rawOpt,[k,k.toLowerCase(),({A:"1",B:"2",C:"3",D:"4"})[k],"option"+k,"option"+({A:1,B:2,C:3,D:4}[k])] )));
 const more=["A","B","C","D"].map((k,i)=>getAny(x,[k,k.toLowerCase(),`option${i+1}`,`option_${i+1}`,`option${k}`,`opt${i+1}`,`opt${k}`])).map(cleanText);
 for(const z of more)if(z&&!opts.includes(z))opts.push(z);opts=opts.slice(0,4);while(opts.length<4)opts.push("");
 const solution=cleanText(getAny(x,["solution","explanation","explain","solutionText","solution_text","detailedSolution","analysis","description","reason","trick","note","notes"]));
 const answer=cleanText(getAny(x,["answer","correctAnswer","correct_answer","correct","ans","answerIndex","correctOption"]));
 const out={question,options:opts,answer,solution};
 for(const k of ["hindi","english","questionHindi","questionEnglish","subject","topic","exam","year"]){const v=getAny(x,[k]);if(v!==undefined&&v!==null&&cleanText(v))out[k]=v}return out;
}

/* DELETE SYSTEM */
async function deleteCommand(e,chat,arg){
 const folder=await e.BOT_STATE.get("folder")||DEFAULT_FOLDER;
 const tokens=arg.split(/[\s,]+/).filter(Boolean);
 const isNumbers=tokens.length&&tokens.every(x=>/^\d+$/.test(x));

 if(isNumbers){
  const r=await githubList(e,folder);
  if(!r.ok)return sendMessage(e,chat,`❌ Folder nahi mila:\n${folder}`);
  const files=r.items.filter(x=>x.type==="file"&&/\.(html?|json)$/i.test(x.name)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"}));
  const sel=[...new Set(tokens.map(Number))];
  if(sel.some(n=>n<1||n>files.length))return sendMessage(e,chat,`❌ Number 1-${files.length} ke beech hona chahiye.`);
  const jobs=sel.map(n=>({type:"delete",chat_id:chat,path:files[n-1].path,name:files[n-1].name,folder}));
  for(const j of jobs)await e.UPLOAD_QUEUE.send(j);
  return sendMessage(e,chat,`📥 Delete Queue me ${jobs.length} files add ho gayi.`);
 }

 const listFolder=cleanPath(arg)||folder;
 const r=await githubList(e,listFolder);
 if(!r.ok)return sendMessage(e,chat,`❌ Folder nahi mila:\n${listFolder}`);
 const files=r.items.filter(x=>x.type==="file"&&/\.(html?|json)$/i.test(x.name)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"}));
 if(!files.length)return sendMessage(e,chat,`📁 Is folder me HTML/JSON file nahi mili.\n\n${listFolder}`);

 const listStr=files.map((x,i)=>`${i+1}. ${x.name}`).join("\n");
 let footer=`🗑️ Delete selected (from current folder):\n/delete 1 3 5`;
 if(listFolder!==folder)footer=`⚠️ Ye current active folder nahi hai.\nPehle isko set karo:\n/setfolder ${listFolder}\n\nFir delete karo:\n/delete 1 3 5`;
 return sendMessage(e,chat,`📁 Folder:\n${listFolder}\n\n${listStr}\n\n${footer}`);
}

async function processDeleteJob(j,e){
 if(await isStopped(e,j.chat_id))throw Error("__PAUSED__");
 let r;
 try{r=await githubDelete(e,j.path,`Delete ${j.name}`)}catch(x){r={ok:false,message:x.message}}
 await sendMessage(e,j.chat_id,r.ok?`🗑️ Deleted: ${j.name}`:`❌ Delete Failed: ${j.name}\nReason: ${r.message}`,{disable_notification:true});
 await sleep(1000);
}

async function status(e,chat){
 const[f,a,ch,pc,s,admins]=await Promise.all([
  e.BOT_STATE.get("folder"),e.BOT_STATE.get("auto"),e.BOT_STATE.get("channel_id"),
  e.BOT_STATE.get("panel_chat_id"),isStopped(e,chat),getAdmins(e)
 ]);
 return sendMessage(e,chat,`📊 STATUS

Operations : ${s?"🛑 STOPPED":"🟢 RUNNING"}
Auto       : ${(a||"off").toUpperCase()}
Folder     : ${f||DEFAULT_FOLDER}
Channel    : ${ch||"Not set"}
Live Panel : ${pc||"Not set (use /auto on in bot chat)"}
Admins     : ${admins.length}

KV:
• Normal upload = 1 READ, 0 WRITE
• New panel = 1 WRITE (only once)
• Folder change = 1 WRITE
• Same channel = same panel 🚀`);
}

async function getAdmins(e){
 try{const a=JSON.parse(await e.BOT_STATE.get("admins")||"[]");return Array.isArray(a)?a.map(String):[]}catch{return[]}
}
async function isAdmin(e,id){return(await getAdmins(e)).includes(String(id))}
async function isStaff(e,id){const o=await e.BOT_STATE.get("owner_id");return!!o&&(String(o)===String(id)||await isAdmin(e,id))}
async function isStopped(e,id){return(await e.BOT_STATE.get(`stop:${id}`))==="1"}

/* ROBUST Qs / Q_DATA PARSER */
function htmlToQuizJson(s){
 const keys=[/const\s+Qs\s*=/i,/let\s+Qs\s*=/i,/var\s+Qs\s*=/i,/const\s+Q_DATA\s*=/i,/let\s+Q_DATA\s*=/i,/var\s+Q_DATA\s*=/i];
 for(const re of keys){
  const m=s.match(re);
  if(!m)continue;
  const a=extractBalanced(s,m.index+m[0].length,"[","]");
  if(!a)return{ok:false,message:"Question array complete nahi mili."};
  try{
   const q=parseJSArray(a);
   if(Array.isArray(q)&&q.length)return{ok:true,questions:q};
   return{ok:false,message:"Question array empty hai."};
  }catch(err){
   return{ok:false,message:`JSON Error: ${err.message}`};
  }
 }
 return{ok:false,message:"Qs / Q_DATA nahi mila."};
}

/*
  JS-literal parser for the study HTML format.
  It deliberately does NOT use JSON.parse() on the raw JS. This makes
  harmless HTML/JS formatting differences safe: single quotes, trailing
  commas, unquoted object keys, comments, escaped quotes/newlines,
  template strings, !0/!1, and nested arrays/objects are supported.
*/
function parseJSArray(src){
 const p=new JSLiteralParser(src);
 const value=p.parseValue();
 p.skipSpaceAndComments();
 if(p.i<p.s.length)throw Error(`Unexpected token at position ${p.i}`);
 return value;
}

class JSLiteralParser{
 constructor(s){this.s=s;this.i=0}
 error(msg){throw Error(`${msg} at position ${this.i}`)}
 skipSpaceAndComments(){
  for(;;){
   while(this.i<this.s.length&&/\s/.test(this.s[this.i]))this.i++;
   if(this.s.startsWith("//",this.i)){
    this.i+=2;while(this.i<this.s.length&&this.s[this.i]!=="\n")this.i++;continue;
   }
   if(this.s.startsWith("/*",this.i)){
    const e=this.s.indexOf("*/",this.i+2);if(e<0)this.error("Unterminated comment");this.i=e+2;continue;
   }
   break;
  }
 }
 parseValue(){
  this.skipSpaceAndComments();
  const c=this.s[this.i];
  if(c==="[")return this.parseArray();
  if(c==="{")return this.parseObject();
  if(c==='"'||c==="'")return this.parseString(c);
  if(c==="`")return this.parseTemplate();
  if(c==="!"){
   this.i++;this.skipSpaceAndComments();
   if(this.s.startsWith("0",this.i)){this.i++;return true}
   if(this.s.startsWith("1",this.i)){this.i++;return false}
   this.error("Unsupported ! expression");
  }
  if(c==="-"||c==="+"||/[0-9.]/.test(c))return this.parseNumber();
  if(/[A-Za-z_$]/.test(c)){
   const id=this.parseIdentifier();
   if(id==="true")return true;
   if(id==="false")return false;
   if(id==="null")return null;
   if(id==="undefined")return null;
   /* Bare values are uncommon, but treating them as strings is safer
      than rejecting an otherwise valid question file. */
   return id;
  }
  this.error(`Unexpected token '${c||"EOF"}'`);
 }
 parseArray(){
  this.i++;const a=[];this.skipSpaceAndComments();
  if(this.s[this.i]==="]"){this.i++;return a}
  for(;;){
   a.push(this.parseValue());
   this.skipSpaceAndComments();
   if(this.s[this.i]===","){this.i++;this.skipSpaceAndComments();if(this.s[this.i]==="]"){this.i++;return a}continue}
   if(this.s[this.i]==="]"){this.i++;return a}
   this.error("Expected ',' or ']' in array");
  }
 }
 parseObject(){
  this.i++;const o={};this.skipSpaceAndComments();
  if(this.s[this.i]==="}"){this.i++;return o}
  for(;;){
   this.skipSpaceAndComments();
   let key;
   const c=this.s[this.i];
   if(c==='"'||c==="'")key=this.parseString(c);
   else if(/[A-Za-z_$]/.test(c))key=this.parseIdentifier();
   else if(/[0-9]/.test(c))key=String(this.parseNumber());
   else this.error("Invalid object key");
   this.skipSpaceAndComments();
   if(this.s[this.i]!==":")this.error("Expected ':' after object key");
   this.i++;
   o[key]=this.parseValue();
   this.skipSpaceAndComments();
   if(this.s[this.i]===","){this.i++;this.skipSpaceAndComments();if(this.s[this.i]==="}"){this.i++;return o}continue}
   if(this.s[this.i]==="}"){this.i++;return o}
   this.error("Expected ',' or '}' after property value");
  }
 }
 parseIdentifier(){
  const st=this.i;this.i++;
  while(this.i<this.s.length&&/[A-Za-z0-9_$]/.test(this.s[this.i]))this.i++;
  return this.s.slice(st,this.i);
 }
 parseNumber(){
  const st=this.i;
  const m=this.s.slice(this.i).match(/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/);
  if(!m)this.error("Invalid number");
  this.i+=m[0].length;const n=Number(m[0]);
  if(!Number.isFinite(n))this.error("Invalid number");
  return n;
 }
 parseString(q){
  this.i++;let v="";
  while(this.i<this.s.length){
   const c=this.s[this.i++];
   if(c===q)return v;
   if(c!=="\\"){v+=c;continue}
   if(this.i>=this.s.length)this.error("Unterminated string");
   const n=this.s[this.i++];
   const map={n:"\n",r:"\r",t:"\t",b:"\b",f:"\f",v:"\v",0:"\0"};
   if(map[n]!==undefined){v+=map[n];continue}
   if(n==="u"){
    const h=this.s.slice(this.i,this.i+4);
    if(!/^[0-9a-fA-F]{4}$/.test(h))this.error("Invalid \\u escape");
    v+=String.fromCharCode(parseInt(h,16));this.i+=4;continue;
   }
   if(n==="x"){
    const h=this.s.slice(this.i,this.i+2);
    if(!/^[0-9a-fA-F]{2}$/.test(h))this.error("Invalid \\x escape");
    v+=String.fromCharCode(parseInt(h,16));this.i+=2;continue;
   }
   /* JS line continuation: backslash + physical newline */
   if(n==="\n")continue;
   if(n==="\r"){if(this.s[this.i]==="\n")this.i++;continue}
   v+=n;
  }
  this.error("Unterminated string");
 }
 parseTemplate(){
  /* Study files use template literals mainly as plain text. Preserve their
     contents and safely ignore ${...} interpolation instead of generating
     executable code. */
  this.i++;let v="";
  while(this.i<this.s.length){
   const c=this.s[this.i++];
   if(c==='`')return v;
   if(c!=="\\"){v+=c;continue}
   if(this.i>=this.s.length)this.error("Unterminated template string");
   const n=this.s[this.i++];
   if(n==="n")v+="\n";else if(n==="r")v+="\r";else if(n==="t")v+="\t";else v+=n;
  }
  this.error("Unterminated template string");
 }
}

function extractBalanced(s,start,open,close){
 let d=0,str="",esc=false;
 for(let i=start;i<s.length;i++){
  const c=s[i];
  if(str){
   if(esc)esc=false;
   else if(c==="\\")esc=true;
   else if(c===str)str="";
   continue;
  }
  if(c==='"'||c==="'"||c==="`"){str=c;continue}
  if(c===open)d++;
  else if(c===close&&--d===0)return s.slice(start,i+1);
 }
 return null;
}

function cleanPath(p){
 const v=String(p||"").trim().replace(/^\/|\/$/g,"");
 return(v&&!v.includes("..")&&!v.includes("\\")&&!v.includes("//")&&!/[<>:"|?*]/.test(v))?v:null;
}
function cleanUploadName(n){
 const v=String(n||"").trim();
 return(v&&!v.includes("/")&&!v.includes("\\")&&!v.includes("..")&&/\.(html?|json)$/i.test(v))?v:null;
}

function textToBase64(t){
 const bytes=new TextEncoder().encode(t);
 let base64="",chars="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
 let i=0;
 while(i<bytes.length-2){
  const chunk=(bytes[i++]<<16)|(bytes[i++]<<8)|bytes[i++];
  base64+=chars[(chunk>>18)&63]+chars[(chunk>>12)&63]+chars[(chunk>>6)&63]+chars[chunk&63];
 }
 if(i<bytes.length){
  let chunk=bytes[i++];
  if(i<bytes.length){chunk=(chunk<<8)|bytes[i];base64+=chars[(chunk>>10)&63]+chars[(chunk>>4)&63]+chars[(chunk<<2)&63]+"="}
  else base64+=chars[(chunk>>2)&63]+chars[(chunk<<4)&63]+"==";
 }
 return base64;
}

function gh(e){
 return{Authorization:`Bearer ${e.GITHUB_TOKEN}`,Accept:"application/vnd.github+json","Content-Type":"application/json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"study-notes-bot"};
}
function ghUrl(p){return`https://api.github.com/repos/${OWNER}/${REPO}/contents/${p.split("/").map(encodeURIComponent).join("/")}`}

async function githubFileExists(e,path){
 const u=ghUrl(path);
 for(let i=1;i<=RETRIES;i++){
  try{
   const r=await fetchTimeout(`${u}?ref=${encodeURIComponent(BRANCH)}`,{headers:gh(e)},GH_TIMEOUT);
   if(r.status===200)return{ok:true,exists:true};
   if(r.status===404)return{ok:true,exists:false};
   if(r.status===429||r.status>=500){
    if(i===RETRIES)return{ok:false,exists:false,message:`GitHub check failed (${r.status})`};
    await sleep(i*1000);continue;
   }
   return{ok:false,exists:false,message:(await r.text()).slice(0,300)};
  }catch(x){
   if(i===RETRIES)return{ok:false,exists:false,message:x.message};
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
   if(x.ok)sha=(await x.json()).sha;
   else if(x.status!==404)return{ok:false,message:(await x.text()).slice(0,300)};
   const body={message,content,branch:BRANCH};
   if(sha)body.sha=sha;
   const r=await fetchTimeout(u,{method:"PUT",headers:gh(e),body:JSON.stringify(body)},GH_TIMEOUT);
   if(r.ok)return{ok:true};
   if(![409,422].includes(r.status)||i===RETRIES)return{ok:false,message:(await r.text()).slice(0,300)};
  }catch(x){if(i===RETRIES)return{ok:false,message:x.message}}
  await sleep(i*700);
 }
 return{ok:false,message:"GitHub retry limit reached."};
}

async function githubList(e,path){
 const r=await fetchTimeout(`${ghUrl(path)}?ref=${encodeURIComponent(BRANCH)}`,{headers:gh(e)},GH_TIMEOUT);
 if(!r.ok)return{ok:false,items:[]};
 const d=await r.json();
 return{ok:true,items:Array.isArray(d)?d:[]};
}

async function githubDelete(e,path,message){
 const u=ghUrl(path);
 for(let i=1;i<=RETRIES;i++){
  try{
   const x=await fetchTimeout(`${u}?ref=${encodeURIComponent(BRANCH)}`,{headers:gh(e)},GH_TIMEOUT);
   if(x.status===404)return{ok:false,message:"File GitHub par nahi mila."};
   if(!x.ok)throw Error("GitHub file lookup failed");
   const d=await x.json();
   const r=await fetchTimeout(u,{method:"DELETE",headers:gh(e),body:JSON.stringify({message,sha:d.sha,branch:BRANCH})},GH_TIMEOUT);
   if(r.ok)return{ok:true};
   if(![409,422].includes(r.status)||i===RETRIES)return{ok:false,message:(await r.text()).slice(0,300)};
  }catch(x){if(i===RETRIES)return{ok:false,message:x.message}}
  await sleep(i*700);
 }
 return{ok:false,message:"GitHub delete retry limit reached."};
}

async function telegramGetFile(e,id){
 for(let i=1;i<=3;i++){
  try{
   const r=await fetchTimeout(`https://api.telegram.org/bot${e.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(id)}`,{},TG_TIMEOUT);
   const d=await r.json();
   if(d.ok)return d;
   if(r.status===429){await sleep(2000*i);continue}
   if(i===3)return{ok:false};
  }catch{if(i===3)return{ok:false}}
 }
 return{ok:false};
}

async function tgCall(e,method,body){
 for(let i=1;i<=4;i++){
  try{
   const r=await fetchTimeout(`https://api.telegram.org/bot${e.BOT_TOKEN}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},TG_TIMEOUT);
   const d=await r.json();
   if(d.ok)return d;
   if(r.status===429){await sleep(2000*i);continue}
   return d;
  }catch(x){if(i===4)throw x;await sleep(500*i)}
 }
}

async function sendMessage(e,chat,text,options={}){
 try{await tgCall(e,"sendMessage",{chat_id:chat,text,...options})}catch(x){console.error("TG SEND",x)}
}

async function fetchTimeout(url,opt,ms){
 const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);
 try{return await fetch(url,{...opt,signal:c.signal})}
 catch(x){if(x.name==="AbortError")throw Error(`Request timeout (${ms/1000}s)`);throw x}
 finally{clearTimeout(t)}
}
