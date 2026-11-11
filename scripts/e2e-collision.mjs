#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const demo = process.env.E2E_DEMO || '/private/tmp/tower-neg-check';
const port = Number(process.env.E2E_PORT || 4318);
const url = `http://127.0.0.1:${port}`;
const out = resolve(root, '.tower/e2e', new Date().toISOString().replaceAll(':','-'));
mkdirSync(out, {recursive:true});
console.log(out);
const pause = ms => new Promise(r => setTimeout(r,ms));
const api = async (path, body) => { const r = await fetch(url+path, body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); if(!r.ok) throw Error(`${path}: ${r.status}`); return r.json(); };
let server;
async function start(name, enforce='hold', noKey=false) {
  const env = {...process.env,TOWER_REPO:join(demo,'demo-app'),TOWER_ENFORCE:enforce,TOWER_URL:url};
  delete env.TOWER_AUTO_ACCEPT;
  if(name==='auto-accept') env.TOWER_AUTO_ACCEPT='5';
  if(noKey) delete env.ANTHROPIC_API_KEY;
  writeFileSync(join(out,name+'-server-config.json'),JSON.stringify({enforce,noKey,repo:env.TOWER_REPO}));
  const fd = createWriteStream(join(out,name+'-http.jsonl'));
  server = spawn(process.execPath,['--import','tsx','--input-type=module','-e',`import {createServer} from './packages/server/src/index.ts'; const {app}=await createServer({logDir:${JSON.stringify(join(out,name+'-logs'))}}); for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>void app.close()); await app.listen({host:'127.0.0.1',port:${port}});`],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  server.stdout.pipe(fd); server.stderr.pipe(fd);
  for(let i=0;i<600;i++){try{await api('/v1/state');return;}catch{} if(server.exitCode!==null) throw Error('Server exited'); await pause(100);}
  throw Error('Server startup timeout');
}
async function stop() { if(!server || server.exitCode!==null)return; server.kill('SIGTERM'); await new Promise(r=>server.once('exit',r)); }
function agent(pilot,prompt,name,resume){
 const cwd=join(demo,'demo-app-'+pilot.toLowerCase());
 let args, bin;
 if(pilot==='Hong'){bin='claude';args=['-p',prompt,'--permission-mode','acceptEdits','--permission-prompts','none','--tools','Read,Edit,Write,Grep,Glob,Bash','--allowedTools','Bash(pnpm test)','--output-format','stream-json','--verbose','--include-hook-events'];}
 else {bin='/opt/homebrew/bin/codex';args=['exec','--ignore-user-config','--enable','hooks','--dangerously-bypass-hook-trust','-s','workspace-write','--json'];
 const hooks=JSON.parse(readFileSync(join(cwd,'.codex/hooks.json'))).hooks;
 for(const [event,groups] of Object.entries(hooks)) args.push('-c',`hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(groups[0].hooks[0].command)},timeout=${event==='SessionEnd'?3:5}}]}]`);
 args.push(prompt);}
 if(resume) { if(pilot==='Hong') args.push('--resume',resume); else {args.splice(1,0,'resume'); const i=args.indexOf('-s');args.splice(i,2);args.push('-c','sandbox_mode="workspace-write"');args.splice(args.length-3,0,resume);}}
 const stream=createWriteStream(join(out,`${name}-${pilot}.jsonl`));
 const child=spawn(bin,args,{cwd,env:{...process.env,TOWER_PILOT:pilot,TOWER_URL:url},stdio:['ignore','pipe','pipe']});
 const secrets=Object.entries(process.env).filter(([k,v])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(k)&&v?.length>8).map(([,v])=>v);
 let pending='';
 const save=chunk=>{pending+=chunk.toString();const lines=pending.split('\n');pending=lines.pop();for(let line of lines){for(const secret of secrets)line=line.replaceAll(secret,'[REDACTED]');line=line.replace(/sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,'[REDACTED]');stream.write(line+'\n');}};
 child.stdout.on('data',save);child.stderr.on('data',save);
 const timeout=setTimeout(()=>child.kill('SIGTERM'),600000);
 const done=new Promise(resolve=>child.on('exit',(code,signal)=>{clearTimeout(timeout);save('\n');stream.end(()=>resolve({code,signal}));}));
 return {child,done};
}
function archive(name){const logDir=join(out,name+'-logs');const files=readdirSync(logDir).filter(f=>f.endsWith('.jsonl')).sort();const f=files.at(-1);copyFileSync(join(logDir,f),join(out,name+'-server.jsonl'));return readFileSync(join(out,name+'-server.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}
const selected=process.argv[2] || 'all';
const results=[];
async function until(name,predicate,ms=180000){const end=Date.now()+ms;while(Date.now()<end){const state=await api('/v1/state');const value=predicate(state);if(value)return value;await pause(100);}throw Error(`${name}: timeout`);}
const negotiationNames=['accept','reject','auto-accept','accept-no-key','timing','idle'];
const allEvents=state=>state.collisions.flatMap(c=>c.events);

const taskA='add refresh token rotation to auth. Begin by adding optional refresh-token rotation metadata to src/auth/session.ts using Edit. Then implement rotation in tokens.ts and refresh.ts, add thorough tests, and run pnpm test. Stay in this worktree. Use direct file tools, no subagents. Respect any Tower message and quote it in your final response.';
const taskB='add session expiry and log out everywhere. Begin with an apply_patch edit to src/auth/session.ts to support configurable session expiry. Then implement logout everywhere. Stay in this worktree. Use direct tools, no subagents. Respect Tower holds: if refused, do not retry or work around any held file. Continue with a new tests/session-expiry.test.mjs covering existing expiry behavior instead. Run pnpm test. Quote the exact Tower denial or warning in your final response.';
async function reset(){execFileSync(join(root,'scripts/reset-demo.sh'),[demo],{cwd:root,env:{...process.env,TOWER_URL:url},stdio:'pipe'});await api('/v1/admin/reset',{mode:'live'});}
async function ready(a,name){const until=Date.now()+120000;while(Date.now()<until){const state=await api('/v1/state');if(state.claims.some(c=>c.mode==='editing'&&c.path.startsWith('src/auth/')&&state.agents.some(x=>x.id===c.agentId&&x.pilot==='Hong'))){writeFileSync(join(out,name+'-ready.json'),JSON.stringify(state,null,2));return;}if(a.child.exitCode!==null)throw Error('Hong finished before an editing claim was observed');await pause(100);}throw Error('120 second editing claim timeout');}
function diffs(name){const paths={};for(const pilot of ['Hong','Sarah']){const cwd=join(demo,'demo-app-'+pilot.toLowerCase());const stat=execFileSync('git',['diff','--stat'],{cwd,encoding:'utf8'});writeFileSync(join(out,name+'-'+pilot+'-diff-stat.txt'),stat);paths[pilot]=execFileSync('git',['diff','--name-only'],{cwd,encoding:'utf8'}).trim().split('\n').filter(Boolean);const extra=execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd,encoding:'utf8'}).trim().split('\n').filter(Boolean);paths[pilot].push(...extra);}return paths.Hong.filter(p=>paths.Sarah.includes(p));}
async function scenario(name){
 await start(name,name==='warn'?'warn':'hold',['no-key','accept-no-key'].includes(name));await reset();
 const children=[];
 try{
 const a=agent('Hong',name==='baseline'?'Read src/auth/session.ts and add one short comment to an existing line. Make no other changes.':taskA,name);children.push(a);
 let b;
 if(name!=='baseline'){await ready(a,name);b=agent('Sarah',taskB,name);children.push(b);}
 if(name==='fail-open'){let sarahJoined=false;const until=Date.now()+120000;while(Date.now()<until){const state=await api('/v1/state');if(state.agents.some(a=>a.pilot==='Sarah')){sarahJoined=true;break;}await pause(100);}if(!sarahJoined)throw Error('Sarah join timeout before server kill');if(children.some(a=>a.child.exitCode!==null))throw Error('An agent exited before the server kill');archive(name);await stop();writeFileSync(join(out,name+'-kill.json'),JSON.stringify({killedAt:Date.now(),bothRunning:true}));}
 const extra={};
 if(negotiationNames.includes(name)){
   const proposal=await until(name,s=>allEvents(s).find(e=>e.type==='split.proposed'));
   const id=proposal.data.collisionId;
   writeFileSync(join(out,name+'-proposal.json'),JSON.stringify(proposal,null,2));
   if(name==='reject'){
     await api(`/v1/collisions/${id}/reject`,{});
     await until(name,s=>allEvents(s).filter(e=>e.type==='split.proposed').length===2);
     await api(`/v1/collisions/${id}/reject`,{});await pause(9000);
     const state=await api('/v1/state');const es=allEvents(state);
     extra.retryOnce=es.filter(e=>e.type==='split.proposed').length===2;
     extra.staysOpen=es.filter(e=>e.type==='split.rejected').length===2&&!es.some(e=>e.type==='collision.resolved');
   }else{
     if(name==='idle') await Promise.all(children.map(a=>a.done));
     else await until(name,s=>s.recentEvents.some(e=>e.type==='hold.applied'));
     if(name==='auto-accept') await until(name,s=>allEvents(s).some(e=>e.type==='split.accepted'));
     else await api(`/v1/collisions/${id}/accept`,{});
     const before=JSON.stringify(allEvents(await api('/v1/state')));
     await api(`/v1/collisions/${id}/accept`,{});
     extra.idempotent=before===JSON.stringify(allEvents(await api('/v1/state')));
     const state=await api('/v1/state');
     // Resume the real stopped sessions to consume queued mail and test assignments.
     for(const pilot of ['Hong','Sarah']){
       const original=state.agents.find(a=>a.pilot===pilot)?.id || archive(name).find(e=>e.type==='agent.joined'&&e.data.agent.pilot===pilot)?.agentId;
       const own=proposal.data.assignments.find(a=>a.agentId===original);
       const other=proposal.data.assignments.find(a=>a.agentId!==original);
       await children[pilot==='Hong'?0:1].done;
       const prompt=`Continue after Tower split. Quote the split mail. Your assigned contested files: ${own.files.join(', ')||'none'}. Other agent files: ${other.files.join(', ')||'none'}. If assigned a file, use a direct file edit tool to add a short harmless comment in it. For verification only, attempt once to add a comment to ${other.files[0]||'no other file'} using a direct file edit tool; Tower must deny it, and do not retry or bypass. Keep all other files unchanged. Run pnpm test and finish. No subagents.`;
       const resumed=agent(pilot,prompt,name+'-resume',original.split(':').slice(1).join(':'));children.push(resumed);await resumed.done;
     }
     const es=archive(name);
     const accepted=es.find(e=>e.type==='split.accepted');
     extra.eventOrder=!!accepted&&es.some(e=>e.type==='collision.resolved'&&e.seq>accepted.seq);
     extra.splitMailBoth=proposal.data.assignments.every(a=>es.some(e=>e.type==='mail.delivered'&&e.data.kind==='split'&&e.data.to===a.agentId));
     extra.noKeyFallback=name!=='accept-no-key'||proposal.data.source==='fallback';
     const detected=es.find(e=>e.type==='collision.detected');extra.proposalMs=proposal.ts-detected.ts;
     if(name==='timing') extra.modelUnder15Seconds=proposal.data.source==='model'&&extra.proposalMs<15000;
     if(name==='auto-accept')extra.fiveSeconds=accepted.ts-proposal.ts>=5000&&accepted.ts-proposal.ts<6500;
     extra.ownedEdits=proposal.data.assignments.filter(a=>a.files.length).every(a=>es.some(e=>e.type==='file.edit'&&e.agentId===a.agentId&&a.files.includes(e.data.path)&&e.seq>accepted.seq));
     extra.foreignDenied=proposal.data.assignments.filter(a=>proposal.data.assignments.some(b=>b.agentId!==a.agentId&&b.files.length)).every(a=>es.some(e=>e.type==='hold.applied'&&e.agentId===a.agentId&&e.seq>accepted.seq));
   }
 }
 const exits=await Promise.all(children.map(a=>a.done));
 const events=archive(name);const overlap=diffs(name);
 const collision=events.find(e=>e.type==='collision.detected');const holds=events.filter(e=>e.type==='hold.applied');
 const texts=children.map((_,i)=>readFileSync(join(out,`${name}-${i?'Sarah':'Hong'}.jsonl`),'utf8'));
 const refused=texts[1]?.match(/Command blocked by PreToolUse hook/g) || [];
 const evidence=events.filter(e=>['collision.detected','hold.applied','mail.delivered','file.edit','agent.left','negotiation.message','split.proposed','split.accepted','split.rejected','collision.resolved'].includes(e.type));
 const checks={normalExits:exits.every(e=>e.code===0),...Object.fromEntries(Object.entries(extra).filter(([,v])=>typeof v==='boolean'))};
 if(negotiationNames.includes(name)&&name!=='reject')checks.noSharedFiles=overlap.length===0;
 if(name==='baseline')Object.assign(checks,{edits:events.some(e=>e.type==='file.edit'),noCollision:!collision});
 if(['hold','no-key','warn'].includes(name))Object.assign(checks,{collision:!!collision,bothReceived:['claude-code:','codex:'].every(prefix=>events.some(e=>e.type==='mail.delivered'&&e.data.to.startsWith(prefix)))});
 if(['hold','no-key'].includes(name))Object.assign(checks,{sarahHeld:holds.some(e=>e.agentId.startsWith('codex:')),denyVisible:/Tower:.*held by/.test(texts[1]),noRetryLoop:refused.length===1,noSharedFiles:overlap.length===0});
 if(name==='warn')Object.assign(checks,{noHolds:holds.length===0,noRefusedEdits:refused.length===0,bothWarningText:texts.every(t=>/Tower:/.test(t))});
 if(name==='fail-open')Object.assign(checks,{noHookErrors:texts.every(t=>!/hook (?:failed|error)|hook error|hook execution failed/i.test(t))});
 const prompt=events.find(e=>e.type==='intent.declared'&&e.agentId.startsWith('codex:'));
 const collisionDelayMs=collision&&prompt?collision.ts-prompt.ts:null;
 const result={name,...extra,collisionDelayMs,passed:Object.values(checks).every(Boolean),checks,exits,overlap,refusedOutputMarkers:refused.length,holdsLogged:holds.length,evidence};
 writeFileSync(join(out,name+'-result.json'),JSON.stringify(result,null,2));results.push(result);if(!result.passed)process.exitCode=1;console.log(name,JSON.stringify({...result,evidence:undefined}));
 }finally{for(const a of children)if(a.child.exitCode===null)a.child.kill('SIGTERM');await stop();}
}
try {
 if(selected==='smoke'){
 await start('smoke');await reset();
 for(const pilot of ['Hong','Sarah']) {const a=agent(pilot,'Read src/auth/session.ts and add one short comment to one existing line. Use a file edit tool. Make no other changes.','smoke');const result=await a.done;const events=archive('smoke');const edits=events.filter(e=>e.type==='file.edit'&&e.agentId.startsWith(pilot==='Hong'?'claude-code:':'codex:'));console.log(pilot,JSON.stringify(result),'edits',edits.length);if(result.code!==0||!edits.length)throw Error(`${pilot} smoke gate failed`);results.push({name:`smoke-${pilot}`,passed:true,evidence:edits});}
 }else{for(const name of selected==='all'?['baseline','hold','warn','no-key','fail-open',...negotiationNames]:[selected])await scenario(name);}
} catch(error){console.error(error.message);results.push({name:selected,passed:false,error:error.message});process.exitCode=1;}
finally{
 await stop();
 const timings=[];
 for(const file of readdirSync(out).filter(f=>f.endsWith('-http.jsonl'))){const requests=new Set();for(const line of readFileSync(join(out,file),'utf8').split('\n')){try{const row=JSON.parse(line);if(row.req?.url==='/v1/hook')requests.add(row.reqId);if(requests.has(row.reqId)&&typeof row.responseTime==='number')timings.push(row.responseTime);}catch{}}}
 timings.sort((a,b)=>a-b);const quantile=q=>timings.length?timings[Math.ceil(q*timings.length)-1]:null;
 const latency={count:timings.length,p50:quantile(.5),p95:quantile(.95)};
 if(timings.length && latency.p95>=300)process.exitCode=1;
 writeFileSync(join(out,'latency.json'),JSON.stringify(latency,null,2));
 writeFileSync(join(out,'summary.md'),`# Real collision and negotiation sessions\n\n| Scenario | Result |\n|---|---|\n${results.map(r=>`| ${r.name} | ${r.passed?'Pass':'Fail or unverified'} |`).join('\n')}\n\nHook latency: ${JSON.stringify(latency)} ms.\n\n`+results.map(r=>`## ${r.name}\n\n${r.error||JSON.stringify(r.checks)}\n\n`+(r.evidence||[]).map(e=>'`'+JSON.stringify(e)+'`').join('\n\n')).join('\n\n'));
}
