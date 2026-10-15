import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import inspector from 'node:inspector';
import assert from 'node:assert/strict';

const args = new Map(process.argv.slice(2).map(arg => { const [key,...value] = arg.replace(/^--/,'').split('='); return [key,value.join('=')]; }));
const built = resolve(args.get('built') ?? 'built'), output = resolve(args.get('output') ?? '.git/sort-profile');
const size = Number(args.get('size') ?? 100000);
assert.ok(Number.isSafeInteger(size) && size > 0);
await mkdir(output,{recursive:true});
const { Interpreter } = await import(pathToFileURL(resolve(built,'v2/interpreter.js')).href);
const { parse } = await import(pathToFileURL(resolve(built,'v2/parser/index.js')).href);
const make = () => { let seed=0x12345678; return Array.from({length:size},()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)%size;}); };
const program = parse('out(items.sort((a,b)=>a-b));').program;
for(let i=0;i<2;i++) { const vm=new Interpreter({items:make(),out:()=>{}},{maxBusyTime:Infinity}); await vm.exec(program); vm.abort(); }
const items=make(), expected=[...items].sort((a,b)=>a-b); let actual;
const vm=new Interpreter({items,out:value=>{actual=value;}},{maxBusyTime:Infinity});
global.gc?.();
const session=new inspector.Session();session.connect();
const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(error,value)=>error?reject(error):resolve(value)));
await post('Profiler.enable'); await post('Profiler.setSamplingInterval',{interval:100});
// 準備と検証を除いた一試行だけを記録し、通常の中央値とは別に報告します。
await post('Profiler.start'); const started=performance.now(); await vm.exec(program); const elapsedMs=performance.now()-started;
const {profile}=await post('Profiler.stop');session.disconnect();vm.abort();assert.deepEqual(actual,expected);
await writeFile(resolve(output,'sort.cpuprofile'),JSON.stringify(profile));
const nodes=new Map(profile.nodes.map(node=>[node.id,node])), self=new Map();
for(let i=0;i<profile.samples.length;i++) {
 const frame=nodes.get(profile.samples[i]).callFrame, key=JSON.stringify(frame);
 if(!self.has(key))self.set(key,{frame,microseconds:0,samples:0});
 const row=self.get(key);row.microseconds+=profile.timeDeltas[i];row.samples++;
}
const report={size,elapsedMs,steps:vm.stepCount,evaluationFrames:vm.evaluationFrameCount,verifiedCount:actual.length,node:process.versions.node,flags:process.execArgv,self:[...self.values()].sort((a,b)=>b.microseconds-a.microseconds),note:'サンプル間隔で重み付けした自己時間。インライン化・サンプリング誤差があるため厳密な関数別CPU時間ではない。'};
await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({size,elapsedMs,steps:vm.stepCount,verifiedCount:actual.length}));
