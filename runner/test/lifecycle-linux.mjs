// Full runner integration with fake model output and a local Git server; no provider credentials or external network.
// Build runner/Dockerfile as pi-agent-runner:test, then run from the repository root:
// docker run --rm --platform linux/amd64 --network none --memory 512m --cpus 1 -v "$PWD/runner/task-runner.mjs:/runner.mjs:ro" -v "$PWD/runner/test/lifecycle-linux.mjs:/integration.mjs:ro" pi-agent-runner:test node /integration.mjs
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,chmod,writeFile,readFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const root=await mkdtemp('/tmp/runner-flow-'); await chmod(root,0o755);
const work=join(root,'seed'),bare=join(root,'fixture/repo.git'),bin=join(root,'bin');
await mkdir(work);await mkdir(join(root,'fixture'));await mkdir(bin);
const git=(...args)=>execFileSync('git',args,{cwd:work,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git('init','--quiet','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
await writeFile(join(work,'base.txt'),'base');git('add','.');git('commit','--quiet','-m','base');
execFileSync('git',['clone','--quiet','--bare',work,bare]);execFileSync('git',['--git-dir',bare,'update-server-info']);
const fake=`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
if(process.argv.includes('--version')) { console.log('1.19.3');process.exit(0); }
if(process.getuid()!==1000||process.env.GH_TOKEN||process.env.TASK_TOKEN)throw Error('secret or privilege leak');
try{fs.readFileSync('/proc/'+process.ppid+'/environ');throw Error('root environment readable')}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e}
fs.writeFileSync('/work/change.txt','safe');
fs.writeFileSync('/work/fsmonitor', '#!/bin/sh\\nid -u >> /tmp/git-monitor-users\\nprintf \"token\\\\0\"\\n', {mode:0o755});
cp.execFileSync('git',['config','core.fsmonitor','/work/fsmonitor'],{cwd:'/work'});
cp.execFileSync('git',['add','.'],{cwd:'/work'});cp.execFileSync('git',['commit','--quiet','-m','change'],{cwd:'/work'});
console.log(JSON.stringify({type:'step_finish',sessionID:'fixture-session',part:{cost:0.1}}));
for(let i=0;i<10000;i++)console.log(JSON.stringify({type:'tool',part:{text:'tool output '+i}}));
const report={status:'done',summary:'Fixture',changes:['change'],tests:[],risks:[],questions:[],proofs:[{criterionIndex:0,criterion:'works',command:process.argv.at(-1).includes('MUTATE_PROOF')?'echo tampered >> change.txt':'test "$(cat change.txt)" = safe',expect:'safe'}]};
console.log(JSON.stringify({type:'text',part:{text:String.fromCharCode(96).repeat(3)+'json\\n'+JSON.stringify(report)+'\\n'+String.fromCharCode(96).repeat(3)}}));
`;
await writeFile(join(bin,'opencode'),fake,{mode:0o755});
let evidence;
const server=createServer(async(req,res)=>{
 if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;if(req.url==='/api/runner/evidence')evidence=JSON.parse(raw).evidence;res.writeHead(200,{'content-type':'application/json'});return res.end('{}');}
 const file=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));
 if(!file.startsWith(root+'/')){res.writeHead(404);return res.end()}
 try{const data=await readFile(file);res.writeHead(200);res.end(data)}catch{res.writeHead(404);res.end()}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
try{
 for(const mutate of [false,true]){
  evidence=undefined;
  const spec={taskId:'fixture',attempt:1,repo:'fixture/repo',branch:'agent/fixture',base:'main',title:'Fixture',prompt:mutate?'MUTATE_PROOF':'SAFE',verify:'test "$(id -u)" = 1000 && test -z "$GH_TOKEN" && test -f change.txt',model:'fixture',reportSchema:{},callbackUrl:origin,gitBase:origin,opencodeVersion:'1.19.3',attemptMinutes:1,gitName:'Fixture',gitEmail:'fixture@example.invalid'};
  const child=spawn(process.execPath,['/runner.mjs'],{env:{...process.env,PATH:bin+':'+process.env.PATH,TASK_SPEC:Buffer.from(JSON.stringify(spec)).toString('base64'),GH_TOKEN:'fake-read-token',TASK_TOKEN:'fake-callback-token',OPENROUTER_API_KEY:'fake-capped-key'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
  const code=await new Promise((r,j)=>{child.on('error',j);child.on('close',r)});clearTimeout(timer);
  assert.equal(code,0,output);assert.ok(evidence,output);assert.ok(evidence.bundle,output);assert.match(evidence.bundleBase,/^[a-f0-9]{40}$/);
  assert.equal(evidence.costUsd,0.1);assert.match(evidence.verifiedHeadSha,/^[a-f0-9]{40}$/);
  assert.ok((await readFile('/tmp/git-monitor-users','utf8')).trim().split('\n').every(uid=>uid==='1000'),'Repository Git config must never execute as root');assert.equal(evidence.resources.version,1);assert.ok(evidence.resources.outputBytes>500000);
  assert.equal(evidence.verify.exitCode,mutate?1:0,JSON.stringify(evidence));
  if(mutate)assert.ok(evidence.proofs.some(p=>p.criterion==='Tested commit integrity'&&p.exitCode===1));
  else assert.equal(evidence.proofs[0].exitCode,0);
  console.log('PASS '+(mutate?'mutating proof invalidates verification':'uid isolation, incremental parsing, verify, proofs and bundle'));
 }
}finally{await new Promise(r=>server.close(r));}
