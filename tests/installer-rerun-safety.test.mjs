import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {test,summary} from './helpers.mjs';

const template=fs.readFileSync(new URL('../templates/install.sh',import.meta.url),'utf8');
const section=(a,b)=>template.slice(template.indexOf(a),template.indexOf(b,template.indexOf(a)));
const funcs=section('verify_signed_tree() {','\n# END_STARTUP_FUNCTIONS');
const health=section('HEALTH_DEADLINE_SECONDS=','\n# END_STARTUP_FUNCTIONS');
const base='set -Eeuo pipefail\ndie(){ echo "ERROR: $*" >&2; exit 1; }; warn(){ echo "$*" >&2; }; ok(){ echo "$*"; }; say(){ :; }\n';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const exe=(file,body)=>fs.writeFileSync(file,'#!/usr/bin/env bash\nset -eu\n'+body,{mode:0o755});
function fixture(mode='active',version='0.90.135'){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'wh-rerun-proof-'));
 const app=path.join(dir,'app'),bin=path.join(dir,'cmd'),cg=path.join(dir,'cgroup');
 fs.mkdirSync(path.join(app,'bin'),{recursive:true});fs.mkdirSync(path.join(app,'data'));fs.mkdirSync(path.join(app,'scripts'));fs.mkdirSync(bin);
 fs.mkdirSync(path.join(cg,'system.slice','wickhunter.service'),{recursive:true});
 fs.writeFileSync(path.join(cg,'cgroup.controllers'),'cpu memory\n');
 fs.writeFileSync(path.join(cg,'system.slice','wickhunter.service','cgroup.procs'),'');
 fs.writeFileSync(path.join(cg,'system.slice','wickhunter.service','cgroup.events'),'populated 0\nfrozen 0\n');
 fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({version,scripts:{start:'node server.js'}}));
 fs.writeFileSync(path.join(app,'server.js'),'// authenticated server fixture\n');
 exe(path.join(app,'bin/wh-core-linux-amd64'),'echo "wh-core fixture protocol=1 algorithm=1"\n');
 for(const [name,value] of Object.entries({'license.key':'retained-license','install-id':'retained-install','machine-key.json':'{"retained":true}','state.json':'{"position":"preserved"}'}))fs.writeFileSync(path.join(app,'data',name),value);
 const boot=path.join(dir,'boot-id');fs.writeFileSync(boot,'01234567-89ab-cdef-0123-456789abcdef\n');
 // Verbatim existing signed release lock contract; only its Linux boot-id path
 // is calibrated to the owned offline fixture, just as the cgroup root is.
 fs.writeFileSync(path.join(app,'scripts/release-auth.mjs'),`import {mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';
export function acquireReleaseLock(appDir) {
  const data = join(appDir, "data"), lock = join(data, "release-operation.lock");
  mkdirSync(data, { recursive: true });
  try { mkdirSync(lock); } catch { throw new Error("Another release operation is running or needs recovery."); }
  let bootId = null;
  try { bootId = readFileSync(${JSON.stringify(boot)},'utf8').trim(); } catch { /* non-Linux fixtures */ }
  try { writeFileSync(join(lock,'owner.json'), JSON.stringify({pid:process.pid,bootId,at:Date.now()}), {mode:0o600,flag:'wx'}); }
  catch (error) { rmSync(lock,{recursive:true,force:true}); throw error; }
  return () => rmSync(lock, { recursive: true, force: true });
}
`);
 const files=['bin/wh-core-linux-amd64','package.json','scripts/release-auth.mjs','server.js'].map(name=>({path:name,sha256:hash(fs.readFileSync(path.join(app,name)))}));
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
 const doc={schema:'wickhunter.integrity.v1',product:'wickhunter',recoveryProtocol:1,version,buildId:'signed-build',issuedAt:new Date().toISOString(),files};
 doc.signatures=[{kid:'fixture',alg:'Ed25519',sig:crypto.sign(null,Buffer.from(canonical(doc)),privateKey).toString('base64url')}];
 fs.writeFileSync(path.join(app,'integrity.json'),JSON.stringify(doc));
 const keyring=Buffer.from(JSON.stringify({fixture:publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64url')})).toString('base64url');
 const envFile=path.join(dir,'env'),unit=path.join(dir,'wickhunter.service');
 fs.writeFileSync(envFile,'LIQHUNTER_SECRET="preserved private secret"\n');fs.writeFileSync(unit,'preserved unit bytes\n');
 fs.writeFileSync(path.join(bin,'timeout'),'#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const stdio=process.argv[2]==="180s"?["inherit","inherit","inherit",3]:"inherit";const r=spawnSync(process.argv[3],process.argv.slice(4),{stdio,timeout:parseFloat(process.argv[2])*1000});process.exit(r.status??124);\n',{mode:0o755});
 exe(path.join(bin,'id'),'echo 0\n');
 exe(path.join(bin,'systemctl'),`printf '%s\\n' "$*" >> "$OPS"
if [ "$1" = start ]; then
node -e 'const fs=require("node:fs"),p=JSON.parse(fs.readFileSync(process.env.APP_DIR+"/data/release-operation.lock/owner.json","utf8"));process.kill(p.pid,0);fs.writeFileSync(process.env.OWNER_WITNESS,JSON.stringify(p));'
case "$MOCK_MODE" in changed_owner) echo '{"pid":777,"bootId":"foreign"}' > "$APP_DIR/data/release-operation.lock/owner.json";; extra_lock_file) touch "$APP_DIR/data/release-operation.lock/foreign";; changed_inode) mv "$APP_DIR/data/release-operation.lock/owner.json" "$OWNER_WITNESS-original"; cp "$OWNER_WITNESS-original" "$APP_DIR/data/release-operation.lock/owner.json";; changed_directory) mv "$APP_DIR/data/release-operation.lock" "$APP_DIR/data/retained-original-lock"; mkdir "$APP_DIR/data/release-operation.lock"; cp "$APP_DIR/data/retained-original-lock/owner.json" "$APP_DIR/data/release-operation.lock/owner.json";; esac
touch "$STARTED"; exit 0; fi
[ "$1" = show ] || exit 99
case "$*" in
 *LoadState*) printf 'LoadState=loaded\\nFragmentPath=%s\\nWorkingDirectory=%s\\nExecStart={ path=%s ; argv[]=%s server.js ; ignore_errors=no ; }\\nEnvironmentFiles=%s (ignore_errors=no)\\nUser=\\nNeedDaemonReload=no\\nDropInPaths=%s\\nExecStartPre=%s\\nExecStartPost=%s\\nEnvironment=%s\\nExecCondition=%s\\nExecStopPost=%s\\n' "$UNIT_FILE" "$APP_DIR" "$REAL_NODE" "$REAL_NODE" "$ENV_FILE" "\${DROPIN:-}" "\${EXEC_START_PRE:-}" "\${EXEC_START_POST:-}" "\${UNIT_ENV:-}" "\${EXEC_CONDITION:-}" "\${EXEC_STOP_POST:-}" | while IFS= read -r row; do key="\${row%%=*}"; [ "$key" != "\${OMIT_UNIT_PROPERTY:-}" ] || continue; if [ "\${OMIT_EMPTY_HOOKS:-0}" = 1 ]; then case "$row" in ExecStartPre=|ExecStartPost=|ExecCondition=|ExecStopPost=) continue;; esac; fi; printf '%s\\n' "$row"; done;;
 *ControlPID*) count=0; [ ! -f "$CHECKS" ] || count=$(cat "$CHECKS"); count=$((count+1)); echo "$count" > "$CHECKS"; if [ "$count" -gt 1 ]; then case "$MOCK_MODE" in late_lock) touch "$APP_DIR/data/release-operation.lock";; late_transition) touch "$APP_DIR/data/release-transition.json";; late_license) echo changed-license > "$APP_DIR/data/license.key";; esac; fi; pid=0; [ "$MOCK_MODE" != raced ] || [ "$count" -lt 2 ] || pid=77; printf 'ActiveState=inactive\\nSubState=dead\\nMainPID=%s\\nControlPID=0\\nJob=%s\\nControlGroup=/system.slice/wickhunter.service\\n' "$pid" "\${JOB:-}";;
 *) if [ "$MOCK_MODE" = active ] || [ -f "$STARTED" ]; then printf 'ActiveState=active\\nSubState=running\\nResult=success\\nMainPID=42\\nInvocationID=0123456789abcdef0123456789abcdef\\nNRestarts=0\\n'; else printf 'ActiveState=failed\\nSubState=failed\\nResult=exit-code\\nMainPID=0\\nNRestarts=95\\n'; fi;;
esac
`);
 exe(path.join(bin,'curl'),`node -e 'const fs=require("node:fs");const x={ready:true,nonce:null,version:process.env.REL_VERSION,buildId:process.env.REL_BUILD_ID,coreSha256:process.env.REL_CORE_SHA,pid:42,generation:"boot-one",contextKeys:["env:futures"],at:Date.now()};switch(process.env.READINESS){case "missing":process.exit(0);case "stale":x.at-=6000;break;case "future":x.at+=10000;break;case "build":x.buildId="wrong";break;case "core":x.coreSha256="wrong";break;case "pid":x.pid=333;break;case "empty":x.contextKeys=[];break;case "nonce":x.nonce="pending";break;case "false":x.ready=false;break;case "generation":x.generation=crypto.randomUUID();break;}fs.writeFileSync(process.env.APP_DIR+"/data/release-readiness.json",JSON.stringify(x));'
printf '{"ok":true,"version":"%s"}' "$REL_VERSION"
`);
 exe(path.join(bin,'ss'),'printf \'LISTEN 0 100 127.0.0.1:8090 0.0.0.0:* users:(("private",pid=%s,fd=1))\\n\' "${LISTENER_PID:-42}"\n');
 exe(path.join(bin,'journalctl'),'printf "bybit HTTP 403 https://private/?key=never-wh-secret\\n"\n');
 for(const cmd of ['apt-get','rsync','install','tar'])exe(path.join(bin,cmd),`echo "UNSAFE ${cmd}" >> "$OPS"; exit 99\n`);
 const env={...process.env,PATH:bin+':'+process.env.PATH,APP_DIR:app,ENV_FILE:envFile,UNIT_FILE:unit,REAL_NODE:process.execPath,KEY:'retained-license',SERVICE:'wickhunter',PORT:'8090',RELEASE_KEYS_B64U:keyring,REL_VERSION:version,REL_BUILD_ID:doc.buildId,REL_CORE_SHA:files[0].sha256,STARTUP_SINCE:'100',MOCK_MODE:mode,OPS:path.join(dir,'ops'),STARTED:path.join(dir,'started'),OWNER_WITNESS:path.join(dir,'owner-witness'),CHECKS:path.join(dir,'checks')};
 // The Linux cgroup root is substituted only in this offline actual-function
 // fixture; production exposes no environment override for ownership proof.
 const code=funcs.replace('root="/sys/fs/cgroup"','root='+JSON.stringify(cg)).replaceAll("'/proc/sys/kernel/random/boot_id'",JSON.stringify(boot));
 const snapshot=()=>Object.fromEntries([unit,envFile,...['integrity.json',...files.map(x=>x.path),...['license.key','install-id','machine-key.json','state.json'].map(x=>'data/'+x)].map(x=>path.join(app,x))].map(x=>[x,hash(fs.readFileSync(x))]));
 return {dir,app,cg,env,code,snapshot,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
function run(f,script,extra={},accelerate=false,action='recover_existing_install'){return spawnSync('bash',['-c',base+script+(accelerate?'\nsleep(){ SECONDS=$((SECONDS+$1)); };\n':'\n')+action],{env:{...f.env,...extra},encoding:'utf8',timeout:30000});}

await test('the full installer validates an active signed135 installation without any mutation',()=>{
 const f=fixture();try{
  const before=f.snapshot();
  let full=template.replace('APP_DIR=/opt/wickhunter','APP_DIR='+JSON.stringify(f.app)).replace('ENV_FILE=/etc/wickhunter/env','ENV_FILE='+JSON.stringify(f.env.ENV_FILE)).replace('UNIT_FILE=/etc/systemd/system/${SERVICE}.service','UNIT_FILE='+JSON.stringify(f.env.UNIT_FILE)).replace('RELEASE_KEYS_B64U="__RELEASE_KEYS_B64U__"','RELEASE_KEYS_B64U='+JSON.stringify(f.env.RELEASE_KEYS_B64U)).replace('KEY="__LICENSE_KEY__"','KEY="retained-license"').replace('HUB="__HUB_ORIGIN__"','HUB="https://hub.example.test"').replace('CHANNEL_AWARE="__CHANNEL_AWARE__"','CHANNEL_AWARE=0');
  // Accelerate only the deterministic stable-observation interval; actual
  // signatures, filesystem reads, command subprocesses and receipts still run.
  full=full.replace('# END_STARTUP_FUNCTIONS','sleep(){ SECONDS=$((SECONDS+$1)); };\n# END_STARTUP_FUNCTIONS');
  const r=spawnSync('bash',['-c',full],{env:f.env,encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/already installed/);assert.deepEqual(f.snapshot(),before);
  assert.ok(!fs.existsSync(f.env.STARTED));const ops=fs.readFileSync(f.env.OPS,'utf8');assert.doesNotMatch(ops,/restart|stop|start wickhunter|UNSAFE/);assert.ok(ops.split('\n').filter(x=>x.includes('LoadState')).every(x=>x.includes('--all')),'unit scalar properties are requested explicitly');
 }finally{f.cleanup();}
});
await test('a loaded/masked/unknown service cannot take the fresh path merely because all installer paths are absent',()=>{
 for(const state of ['loaded','masked','error','unknown','not-found']){
  const f=fixture();try{
   const dir=path.join(f.dir,'fresh');fs.mkdirSync(dir);
   const beforeApt=template.slice(0,template.indexOf('say "Installing prerequisites"'));
   const code=beforeApt.replace('APP_DIR=/opt/wickhunter','APP_DIR='+JSON.stringify(path.join(dir,'app'))).replace('ENV_FILE=/etc/wickhunter/env','ENV_FILE='+JSON.stringify(path.join(dir,'env'))).replace('UNIT_FILE=/etc/systemd/system/${SERVICE}.service','UNIT_FILE='+JSON.stringify(path.join(dir,'unit'))).replace('RELEASE_KEYS_B64U="__RELEASE_KEYS_B64U__"','RELEASE_KEYS_B64U='+JSON.stringify(f.env.RELEASE_KEYS_B64U)).replace('HUB="__HUB_ORIGIN__"','HUB="https://hub.example.test"').replace('CHANNEL_AWARE="__CHANNEL_AWARE__"','CHANNEL_AWARE=0')+'\necho fresh-preflight-passed';
   exe(path.join(f.dir,'cmd/systemctl'),'echo "LoadState=$LOAD_STATE"\n');
   const r=spawnSync('bash',['-c',code],{env:{...f.env,LOAD_STATE:state},encoding:'utf8',timeout:10000});
   assert.equal(r.status===0,state==='not-found',state+':'+r.stderr);
   if(state==='not-found')assert.match(r.stdout,/fresh-preflight-passed/);
   else assert.doesNotMatch(r.stdout,/fresh-preflight-passed/);
   assert.equal(fs.readdirSync(dir).length,0,'no fresh app/env/unit is created by refusal');
  }finally{f.cleanup();}
 }
});
await test('same-signed-release stopped recovery performs only start and retains every financial/identity file',()=>{
 const f=fixture('inactive','0.90.172');try{const before=f.snapshot();const r=run(f,f.code,{},true);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/existing signed release recovered/);assert.deepEqual(f.snapshot(),before);const ops=fs.readFileSync(f.env.OPS,'utf8');assert.equal(ops.split('\n').filter(x=>x==='start wickhunter').length,1);assert.doesNotMatch(ops,/restart|stop|UNSAFE/);assert.ok(ops.split('\n').filter(x=>x.includes('LoadState')||x.includes('ControlPID')).every(x=>x.includes('--all')),'Job and unit scalar empty fields are requested with --all');}finally{f.cleanup();}
});
await test('systemctl omitted empty command arrays support read-only135 and start-only172 recovery',()=>{
 for(const [mode,version] of [['active','0.90.135'],['inactive','0.90.172']]){
  const f=fixture(mode,version);try{
   const before=f.snapshot();const r=run(f,f.code,{OMIT_EMPTY_HOOKS:'1'},true);
   assert.equal(r.status,0,r.stderr);assert.deepEqual(f.snapshot(),before);
   const ops=fs.readFileSync(f.env.OPS,'utf8');
   assert.equal(ops.split('\n').filter(x=>x==='start wickhunter').length,mode==='inactive'?1:0);
   assert.doesNotMatch(ops,/restart|stop|UNSAFE/);
   assert.ok(ops.split('\n').filter(x=>x.includes('LoadState')).every(x=>x.includes('--all')));
  }finally{f.cleanup();}
 }
});
await test('populated command hooks and omitted scalar identity fields still fail closed without state changes',()=>{
 const hooks=['EXEC_START_PRE','EXEC_START_POST','EXEC_CONDITION','EXEC_STOP_POST'];
 const scalars=['LoadState','FragmentPath','WorkingDirectory','ExecStart','EnvironmentFiles','User','NeedDaemonReload','DropInPaths','Environment'];
 for(const field of [...hooks,...scalars]){
  const f=fixture('inactive');try{
   const before=f.snapshot(),extra={OMIT_EMPTY_HOOKS:'1'};
   if(hooks.includes(field))extra[field]='{ path=/private/hook ; argv[]=/private/hook --secret=never-wh-secret ; ignore_errors=no ; }';
   else extra.OMIT_UNIT_PROPERTY=field;
   const r=run(f,f.code,extra,false,'ENTRY=server.js; verify_existing_unit');
   assert.notEqual(r.status,0,field);assert.deepEqual(f.snapshot(),before,field);
   assert.ok(!fs.existsSync(f.env.STARTED),field);assert.ok(!fs.existsSync(path.join(f.app,'data/release-operation.lock')),field);
   assert.doesNotMatch(r.stderr,/never-wh-secret|private\/hook/);
   assert.doesNotMatch(fs.readFileSync(f.env.OPS,'utf8'),/start wickhunter|UNSAFE/);
  }finally{f.cleanup();}
 }
});
await test('unit secrets travel through a private descriptor rather than the actual verifier child argv',()=>{
 for(const field of ['none','UNIT_ENV','EXEC_START_PRE','EXEC_START_POST','EXEC_CONDITION','EXEC_STOP_POST']){
  const f=fixture('inactive');try{
   const file=path.join(f.dir,'cmd/node'),record=path.join(f.dir,'unit-node-argv');
   exe(file,'printf "%s\\0" "$@" > "$UNIT_ARGV"\nexec "$REAL_NODE_BINARY" "$@"\n');
   const extra={REAL_NODE:file,REAL_NODE_BINARY:process.execPath,UNIT_ARGV:record};
   const secret='never-wh-unit-secret-'+field;
   if(field==='UNIT_ENV')extra[field]='PRIVATE_KEY='+secret+' NODE_OPTIONS=--require=/private/preload';
   else if(field!=='none')extra[field]='{ path=/private/hook ; argv[]=/private/hook --key='+secret+' ; ignore_errors=no ; }';
   const before=f.snapshot(),r=run(f,f.code,extra,false,'ENTRY=server.js; verify_existing_unit');
   assert.equal(r.status===0,field==='none',field+': verifier outcome');
   const args=fs.readFileSync(record,'utf8').split('\0').slice(0,-1);
   assert.ok(args.every(x=>!x.includes(secret)&&!x.includes('LoadState=')&&!x.includes('NODE_OPTIONS')),'raw unit properties never enter child argv');
   assert.deepEqual(args,['-',f.app,f.env.UNIT_FILE,f.env.ENV_FILE,'server.js',file]);
   assert.ok(!r.stdout.includes(secret)&&!r.stderr.includes(secret),'no reflected unit secrets');
   assert.deepEqual(f.snapshot(),before);assert.ok(!fs.existsSync(f.env.STARTED));
  }finally{f.cleanup();}
 }
});
await test('changed files, foreign signing key, partial installation and unsafe unit never start',()=>{
 for(const kind of ['tampered','foreign','partial','dropin','licence','unit_env','preload']){
  const f=fixture('inactive');try{
   const extra={};if(kind==='tampered')fs.appendFileSync(path.join(f.app,'server.js'),'changed');
   if(kind==='foreign')extra.RELEASE_KEYS_B64U=Buffer.from(JSON.stringify({fixture:crypto.randomBytes(32).toString('base64url')})).toString('base64url');
   if(kind==='partial')fs.unlinkSync(path.join(f.app,'integrity.json'));
   if(kind==='unit_env')extra.UNIT_ENV='NODE_OPTIONS=--require=/private';
   if(kind==='preload')fs.appendFileSync(f.env.ENV_FILE,'NODE_OPTIONS=--require=/private\n');
   if(kind==='licence')extra.KEY='different-license';
   if(kind==='dropin')extra.DROPIN='/run/foreign.conf';
   const r=run(f,f.code,extra,true);assert.notEqual(r.status,0,kind);assert.ok(!fs.existsSync(f.env.STARTED),kind);assert.doesNotMatch(r.stderr,/never-wh-secret|https:\/\/private/);
  }finally{f.cleanup();}
 }
});
await test('occupied, malformed, missing and symlink cgroup evidence and pending job refuse recovery',()=>{
 for(const kind of ['process','populated','duplicate','malformed','missing','symlink','nested','job','raced']){
  const f=fixture(kind==='raced'?'raced':'inactive');try{
   const group=path.join(f.cg,'system.slice/wickhunter.service'),extra={};
   if(kind==='process')fs.writeFileSync(path.join(group,'cgroup.procs'),'77\n');
   if(kind==='populated')fs.writeFileSync(path.join(group,'cgroup.events'),'populated 1\n');
   if(kind==='duplicate')fs.writeFileSync(path.join(group,'cgroup.events'),'populated 0\npopulated 0\n');
   if(kind==='malformed')fs.writeFileSync(path.join(group,'cgroup.events'),'populated zero\n');
   if(kind==='missing')fs.unlinkSync(path.join(group,'cgroup.events'));
   if(kind==='symlink'){fs.renameSync(path.join(group,'cgroup.procs'),path.join(group,'other'));fs.symlinkSync('other',path.join(group,'cgroup.procs'));}
   if(kind==='nested'){fs.mkdirSync(path.join(group,'child'));fs.writeFileSync(path.join(group,'child/cgroup.procs'),'77\n');fs.writeFileSync(path.join(group,'child/cgroup.events'),'populated 1\n');}
   if(kind==='job')extra.JOB='123';
   const r=run(f,f.code,extra,true);assert.notEqual(r.status,0,kind);assert.ok(!fs.existsSync(f.env.STARTED),kind);
  }finally{f.cleanup();}
 }
});
await test('durable operation and recovery markers refuse without clearing state or starting',()=>{
 for(const marker of ['release-operation.lock','release-transition.json','revert-state.json']){
  const f=fixture('inactive');try{const file=path.join(f.app,'data',marker);fs.writeFileSync(file,'{"phase":"recovery-required"}');const r=run(f,f.code,{},true);assert.notEqual(r.status,0);assert.equal(fs.readFileSync(file,'utf8'),'{"phase":"recovery-required"}');assert.ok(!fs.existsSync(f.env.STARTED));}finally{f.cleanup();}
 }
});
await test('a release worker marker or changed licence appearing in the final probe prevents the only start',()=>{
 for(const kind of ['late_lock','late_transition','late_license']){
  const f=fixture(kind);try{
   const r=run(f,f.code,{},true);assert.notEqual(r.status,0,kind);assert.ok(!fs.existsSync(f.env.STARTED),kind);
   assert.match(r.stderr,/release operation|licence does not match/);
   if(kind==='late_lock')assert.ok(fs.existsSync(path.join(f.app,'data/release-operation.lock')));
   if(kind==='late_transition')assert.ok(fs.existsSync(path.join(f.app,'data/release-transition.json')));
   if(kind==='late_license')assert.equal(fs.readFileSync(path.join(f.app,'data/license.key'),'utf8'),'changed-license\n');
  }finally{f.cleanup();}
 }
});
await test('matching-version health from another process fails immediately and leaks no raw diagnostics',()=>{
 const f=fixture();try{const r=run(f,f.code,{LISTENER_PID:'333'},true);assert.notEqual(r.status,0);assert.match(r.stderr,/listener is not owned/);assert.match(r.stderr,/Bybit denied/);assert.doesNotMatch(r.stderr+r.stdout,/never-wh-secret|https:\/\/private/);assert.ok(!fs.existsSync(f.env.STARTED));}finally{f.cleanup();}
});
await test('service PID and invocation changes cannot borrow an earlier matching health proof',()=>{
 for(const kind of ['pid','invocation']){
  const f=fixture();try{
   exe(path.join(path.dirname(f.env.OPS),'cmd/systemctl'),`count=0; [ ! -f "$CHECKS" ] || count=$(cat "$CHECKS"); count=$((count+1)); echo "$count" > "$CHECKS"; pid=42; invocation=0123456789abcdef0123456789abcdef
if [ "$count" -gt 1 ]; then if [ "$STATE_VARIANT" = pid ]; then pid=43; else invocation=1123456789abcdef0123456789abcdef; fi; fi
printf 'ActiveState=active\\nSubState=running\\nResult=success\\nMainPID=%s\\nNRestarts=0\\nInvocationID=%s\\n' "$pid" "$invocation"
`);
   const r=run(f,f.code,{STATE_VARIANT:kind},true,'wait_for_signed_version');
   assert.notEqual(r.status,0);assert.match(r.stderr,/process changed|invocation changed/);assert.ok(!fs.existsSync(f.env.STARTED));
  }finally{f.cleanup();}
 }
});
await test('a verified135 start that encounters a real bootstrap refusal stays failed without modifying installation data',()=>{
 const f=fixture('inactive');try{
  const file=path.join(f.dir,'cmd/systemctl'),source=fs.readFileSync(file,'utf8');
  fs.writeFileSync(file,source.replace('if [ "$MOCK_MODE" = active ] || [ -f "$STARTED" ]; then', 'if [ "$MOCK_MODE" = active ]; then'));
  const before=f.snapshot(),r=run(f,f.code,{},true);
  assert.notEqual(r.status,0);assert.match(r.stderr,/Bybit denied/);assert.match(r.stderr,/exited or is restarting/);assert.deepEqual(f.snapshot(),before);
  assert.equal(fs.readFileSync(f.env.OPS,'utf8').split('\n').filter(x=>x==='start wickhunter').length,1);
  assert.doesNotMatch(r.stdout,/passed stable|recovered/);const owner=JSON.parse(fs.readFileSync(path.join(f.app,'data/release-operation.lock/owner.json'),'utf8'));assert.ok(owner.pid>0);assert.equal(owner.bootId,'01234567-89ab-cdef-0123-456789abcdef');
 }finally{f.cleanup();}
});
await test('the guarded child receives private shell input while its recorded argv contains no licence or function text',()=>{
 const f=fixture('inactive');try{
  const argv=path.join(f.dir,'bash-argv'),file=path.join(f.dir,'cmd/bash');
  // Absolute shebang prevents the wrapper recursively selecting itself.
  fs.writeFileSync(file,'#!/bin/bash\ncase "$1" in -s|-c) printf "%s\\n" "$@" > "$GUARD_ARGV";; esac\nexec /bin/bash "$@"\n',{mode:0o755});
  const r=run(f,f.code,{GUARD_ARGV:argv},true);assert.equal(r.status,0,r.stderr);
  const recorded=fs.readFileSync(argv,'utf8');assert.equal(recorded.trim(),'-s');
  assert.doesNotMatch(recorded,/retained-license|declare|verify_signed_tree/);
  assert.match(r.stdout,/existing signed release recovered/,'private-pipe functions/variables executed successfully');
 }finally{f.cleanup();}
});
await test('a missing or invalid Linux boot ID cannot authorize stopped recovery',()=>{
 for(const value of ['', 'not-a-boot-id']){
  const f=fixture('inactive');try{
   fs.writeFileSync(path.join(f.dir,'boot-id'),value);
   const r=run(f,f.code,{},true);assert.notEqual(r.status,0);assert.ok(!fs.existsSync(f.env.STARTED));assert.ok(!fs.existsSync(path.join(f.app,'data/release-operation.lock')),'invalid boot identity is rejected before acquiring/writing ownership');
  }finally{f.cleanup();}
 }
});
await test('the actual signed release lock stays alive through start and excludes a second worker',()=>{
 const f=fixture('inactive');try{
  const file=path.join(f.dir,'cmd/systemctl'),source=fs.readFileSync(file,'utf8');
  fs.writeFileSync(file,source.replace('touch "$STARTED"; exit 0; fi',`node --input-type=module -e 'const {acquireReleaseLock}=await import(process.env.APP_DIR+"/scripts/release-auth.mjs");let refused=false;try{acquireReleaseLock(process.env.APP_DIR)}catch{refused=true};if(!refused)process.exit(99);'
touch "$STARTED"; exit 0; fi`));
  const r=run(f,f.code,{},true);assert.equal(r.status,0,r.stderr);
  const owner=JSON.parse(fs.readFileSync(f.env.OWNER_WITNESS,'utf8'));assert.ok(owner.pid>0);assert.equal(owner.bootId,'01234567-89ab-cdef-0123-456789abcdef');
  assert.ok(!fs.existsSync(path.join(f.app,'data/release-operation.lock')),'only exact owned empty lock is removed after real readiness');
 }finally{f.cleanup();}
});
await test('changed owner bytes or unexpected lock files are never deleted after recovery',()=>{
 for(const kind of ['changed_owner','extra_lock_file','changed_inode','changed_directory']){
  const f=fixture(kind);try{
   const r=run(f,f.code,{},true);assert.notEqual(r.status,0,kind);assert.match(r.stderr,/retained.*ownership|ownership changed/);
   const lock=path.join(f.app,'data/release-operation.lock');assert.ok(fs.existsSync(lock));
   if(kind==='changed_owner')assert.equal(JSON.parse(fs.readFileSync(path.join(lock,'owner.json'),'utf8')).pid,777);
   else if(kind==='extra_lock_file')assert.ok(fs.existsSync(path.join(lock,'foreign')));
   else if(kind==='changed_inode')assert.equal(fs.readFileSync(path.join(lock,'owner.json'),'utf8'),fs.readFileSync(f.env.OWNER_WITNESS+'-original','utf8'));
   else assert.ok(fs.existsSync(path.join(f.app,'data/retained-original-lock/owner.json')));
   assert.doesNotMatch(r.stdout,/existing signed release recovered/);
  }finally{f.cleanup();}
 }
});
await test('minimal135 and172 health cannot bypass absent, stale, foreign or changing native/context proof',()=>{
 for(const version of ['0.90.135','0.90.172'])for(const kind of ['missing','stale','future','build','core','pid','empty','nonce','false','generation']){
  const f=fixture('active',version);try{const deadline=kind==='generation'?12:2,code=f.code.replace('HEALTH_DEADLINE_SECONDS=45','HEALTH_DEADLINE_SECONDS='+deadline);const r=run(f,code,{READINESS:kind},true);assert.notEqual(r.status,0,version+':'+kind);assert.ok(r.stderr.includes('within '+deadline+'s'),r.stderr);assert.ok(!fs.existsSync(f.env.STARTED));}finally{f.cleanup();}
 }
});
summary('installer-rerun-safety');
