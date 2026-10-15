import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// 同じ構文木・入力・実行上限で前後を測り、失敗した試行も記録します。
const built = resolve(process.argv[2] ?? 'built');
const { Interpreter } = await import(pathToFileURL(resolve(built, 'v2/interpreter.js')));
const { parse } = await import(pathToFileURL(resolve(built, 'v2/parser/index.js')));
const cases = [
  ...[150000, 200000].map(size => ({ name: 'string-for-of', size, source: 'let out=""; for(const c of s){out=out+c+c;} result(out);', globals: { s: 'a'.repeat(size) }, expected: 'a'.repeat(size * 2) })),
  { name: 'shift-queue', size: 5000, source: 'const q=range(0,5000); let total=0; while(q.length){total+=q.shift();} result([q.length,total]);', globals: {}, expected: [0,12497500] },
  { name: 'unshift-queue', size: 5000, source: 'const q=[]; for(let i=0;i<5000;i++){q.unshift(i);} result(q);', globals: {}, expected: Array.from({length:5000},(_,i)=>4999-i) },
];
for (const item of cases) {
  const ast = parse(item.source).program;
  const runs = [];
  for (let trial=-1; trial<5; trial++) {
    let output, failure=null;
    const vm = new Interpreter({...item.globals,result: value=>{output=value;}}, {maxBusyTime:5000});
    const start=performance.now();
    try { await vm.exec(ast); } catch(error) { failure=error.code ?? String(error); }
    const elapsedMs=performance.now()-start;
    if (failure===null) assert.deepEqual(output,item.expected);
    vm.abort();
    if(trial>=0) runs.push({trial:trial+1,elapsedMs,steps:vm.stepCount,failure,correct:failure===null});
  }
  const sorted=runs.map(x=>x.elapsedMs).sort((a,b)=>a-b);
  console.log(JSON.stringify({runtime:process.version,built,maxBusyTime:5000,name:item.name,size:item.size,warmups:1,trials:5,excluded:0,medianMs:sorted[2],runs}));
}
