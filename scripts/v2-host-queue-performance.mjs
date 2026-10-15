import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const built = resolve(process.argv[2] ?? 'built');
const { Interpreter } = await import(pathToFileURL(resolve(built, 'v2/interpreter.js')));
const { parse } = await import(pathToFileURL(resolve(built, 'v2/parser/index.js')));
// 失敗も記録し、出力の件数・順序・最終配列は計測値とは別に照合します。
for (const mode of ['shift-control', 'out', 'console', 'results', 'unshift-control', 'unshift-out']) {
 const size = mode.startsWith('unshift') ? 5000 : 10000;
 const source = mode.startsWith('unshift')
  ? `const st=[]; for(let i=0;i<${size};i++){${mode==='unshift-out'?'out(st);':''}st.unshift(i);} finish(st);`
  : `const q=range(0,${size}); const results=[]; let sum=0; while(q.length>0){const x=q.shift();sum+=x;${mode==='out'?'out(x);':mode==='console'?'console.log(x);':mode==='results'?'out(x);results.push({x});':''}}finish([sum,q.length,results]);`;
 const program = parse(source).program, runs = [];
 for(let trial=-1;trial<5;trial++) {
  const outputs=[]; let final, failure=null;
  const vm=new Interpreter({out:x=>{outputs.push(x);},finish:x=>{final=x;}},{onConsoleLog:values=>{outputs.push(values[0]);}});
  const start=performance.now();
  try { await vm.exec(program); } catch(error) { failure=error.code??String(error); }
  const elapsedMs=performance.now()-start;
  if(failure===null) {
   if(mode.startsWith('unshift')) { assert.deepEqual(final,Array.from({length:size},(_,i)=>size-i-1)); assert.equal(outputs.length,mode==='unshift-out'?size:0); for(const value of outputs)assert.equal(value,final); }
   else { assert.deepEqual(final,[size*(size-1)/2,0,mode==='results'?Array.from({length:size},(_,x)=>Object.assign(Object.create(null),{x})):[]]); assert.deepEqual(outputs,mode==='shift-control'?[]:Array.from({length:size},(_,i)=>i)); }
  }
  vm.abort(); if(trial>=0)runs.push({trial:trial+1,steps:vm.stepCount,elapsedMs,failure,correct:failure===null});
 }
 console.log(JSON.stringify({mode,size,source,runtime:process.version,built,warmups:1,trials:5,excluded:0,medianMs:runs.map(x=>x.elapsedMs).sort((a,b)=>a-b)[2],runs}));
}
