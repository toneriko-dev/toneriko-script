import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// 前後で同じ入力・実行上限を使い、失敗も試行数に含めます。
const built = resolve(process.argv[2] ?? 'built');
const { Interpreter } = await import(pathToFileURL(resolve(built,'v2/interpreter.js')));
const { parse } = await import(pathToFileURL(resolve(built,'v2/parser/index.js')));
const cases = [
 {name:'indexOf-crlf',size:5000,source:'const s="a\\r\\n".repeat(5000); let i=-1; let hits=0; do{i=s.indexOf("a",i+1);if(i!==-1)hits++;}while(i!==-1); out(hits);',expected:5000},
 {name:'startsWith-crlf',size:2000,source:'const s="ab\\r\\n".repeat(2000); let hits=0; for(let i=0;i<s.length;i++){if(s.startsWith("ab",i))hits++;} out(hits);',expected:2000},
 {name:'startsWith-emoji',size:4000,source:'const s="😀,".repeat(4000); let hits=0; for(let i=0;i<s.length;i++){if(s.startsWith(",",i))hits++;} out(hits);',expected:4000},
 ...['script','host'].flatMap(origin=>[
  {name:`shift-${origin}`,size:5000,source:`const q=${origin==='script'?'range(0,5000)':'make()'}; let sum=0; while(q.length){sum+=q.shift();} out([q.length,sum]);`,expected:[0,12497500]},
  {name:`alternate-${origin}`,size:20000,source:`const q=${origin==='script'?'range(0,5000)':'make()'}; for(let i=0;i<20000;i++){const x=q.shift();q.unshift(x);} out(q);`,expected:Array.from({length:5000},(_,i)=>i)},
 ]),
];
for(const item of cases){
 const ast=parse(item.source).program,runs=[];
 for(let trial=-1;trial<5;trial++){
  let output,failure=null;const vm=new Interpreter({make:()=>Array.from({length:5000},(_,i)=>i),out:x=>{output=x;}});
  const start=performance.now();try{await vm.exec(ast);}catch(error){failure=error.code??String(error);}
  const elapsedMs=performance.now()-start;
  if(failure===null)assert.deepEqual(output,item.expected);
  vm.abort();if(trial>=0)runs.push({trial:trial+1,steps:vm.stepCount,elapsedMs,failure,correct:failure===null});
 }
 console.log(JSON.stringify({runtime:process.version,built,name:item.name,size:item.size,source:item.source,maxBusyTime:5000,warmups:1,trials:5,excluded:0,medianMs:runs.map(x=>x.elapsedMs).sort((a,b)=>a-b)[2],runs}));
}
