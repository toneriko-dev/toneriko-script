import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// CPU プロファイルは外部の --cpu-prof で採り、時間比較とは別の実行にします。
const [root, name = 'loop/typed'] = process.argv.slice(2);
const count = Number(process.env.V2_TYPES_PROFILE_COUNT ?? 200);
assert.ok(root && Number.isSafeInteger(count) && count > 0);
const { Interpreter } = await import(pathToFileURL(resolve(root, 'built/v2/interpreter.js')));
const { parse } = await import(pathToFileURL(resolve(root, 'built/v2/parser/index.js')));
const sources = {
 'loop/plain': ['let s=0;for(let i=0;i<40000;i++)s+=i;out(s);',799980000],
 'loop/typed': ['let s:number=0;for(let i:number=0;i<40000;i++)s+=i;out(s);',799980000],
 'call/plain': ['function f(x){return x+1;}let s=0;for(let i=0;i<20000;i++)s+=f(i);out(s);',200010000],
 'call/typed': ['function f(x:number):number{return x+1;}let s=0;for(let i=0;i<20000;i++)s+=f(i);out(s);',200010000],
 'default/typed': ['function f(x:number=2):number{return x+1;}let s=0;for(let i=0;i<20000;i++)s+=f();out(s);',60000],
 'map/typed': ['const ys=xs.map((x:number):number=>x+1);out(ys[9999]);',10000],
 'prepare/plain': [Array.from({length:10000},(_,i)=>`let x${i}=${i};`).join('\n'),null],
};
assert.ok(sources[name], name);
const [source, expected] = sources[name];
const options={maxSteps:1e9,maxBusyTime:60000,yieldInterval:8};
const program=name.startsWith('prepare/') ? null : parse(source).program;
let verified=0;
async function trial() {
 let output;
 const vm=new Interpreter({out:value=>{output=value;},...(name.startsWith('map/') ? {xs:Array.from({length:10000},(_,i)=>i)} : {})},options);
 if(program) {
  vm.prepareProgram?.(program);
  await vm.exec(program);
  assert.equal(output,expected);
 } else {
  const parsed=parse(source).program;
  vm.prepareProgram?.(parsed);
  assert.equal(parsed.body.length,10000);
 }
 verified++;
}
for(let i=0;i<20;i++)await trial();
const start=performance.now();
for(let i=0;i<count;i++)await trial();
console.log(JSON.stringify({root,name,count,warmup:20,verified,wallMs:performance.now()-start}));
