import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map(value => { const [name, ...tail] = value.replace(/^--/, '').split('='); return [name, tail.join('=')]; }));
const config = {
	sizes: (args.get('sizes') ?? '10000,100000,1000000').split(',').map(Number),
	versions: (args.get('versions') ?? 'v1,v2').split(','),
	operations: (args.get('operations') ?? 'sort,sortBy,stringSort').split(','),
	warmups: Number(args.get('warmups') ?? 2), trials: Number(args.get('trials') ?? 5),
	heapMb: Number(args.get('heap-mb') ?? 768), timeoutMs: Number(args.get('timeout-ms') ?? 600000),
	built: resolve(root, args.get('built') ?? 'built'),
	profile: args.get('profile') === 'true', directory: resolve(root, args.get('directory') ?? '.git/sort-diagnosis'),
};
assert.ok(config.sizes.every(n => Number.isSafeInteger(n) && n > 0));
assert.ok(config.versions.every(v => ['v1', 'v2'].includes(v)));
assert.ok(config.operations.every(v => ['sort', 'sortBy', 'stringSort'].includes(v)));
assert.ok(Number.isInteger(config.trials) && config.trials > 0 && Number.isInteger(config.warmups) && config.warmups >= 0);
assert.ok(config.heapMb > 0 && config.heapMb <= 1536);
const median = xs => { const sorted = [...xs].sort((a,b) => a-b); return sorted.length ? sorted[Math.floor(sorted.length/2)] : null; };
function source(version, operation, counting) {
	const count = counting && operation === 'sortBy' ? 'count();' : '';
	if (version === 'v2') {
		const expression = operation === 'sort' ? 'input.sort((a,b)=>a-b)' : operation === 'sortBy' ? counting ? `input.sortBy(x=>{${count}return x.key;})` : 'input.sortBy(x=>x.key)' : 'input.sort()';
		return `mark();out(${expression});`;
	}
	const counter = counting && operation === 'sortBy' ? 'count()\n' : '';
	const expression = operation === 'sort' ? `input.sort(@(a,b){${counter}a-b})` : operation === 'sortBy' ? `input.map(@(x){${counter}[x.key,x]}).sort(@(a,b){a[0]-b[0]}).map(@(x){x[1]})` : 'input.sort(Str:lt)';
	return `mark()\n<: ${expression}`;
}
function inputFor(size, operation) {
	let seed = 0x12345678;
	const values = Array.from({length:size}, (_,id) => { seed ^= seed<<13; seed ^= seed>>>17; seed ^= seed<<5; const key = (seed>>>0)%size; return operation === 'sortBy' ? {key,id} : operation === 'stringSort' ? String(key).padStart(8,'0') : key; });
	const expected = [...values].sort(operation === 'sortBy' ? (a,b)=>a.key-b.key : operation === 'sort' ? (a,b)=>a-b : undefined);
	return {values,expected};
}
async function worker() {
	const version = args.get('version'), operation = args.get('operation'), size = Number(args.get('size'));
	const counting = args.get('counting') === 'true';
	const builtImport = path => import(pathToFileURL(resolve(config.built,path)).href);
	const module = args.get('module') ? await import(pathToFileURL(args.get('module')).href) : {
		...await builtImport('index.js'), Legacy: (await builtImport('index.js')).Interpreter,
		Interpreter: (await builtImport('v2/interpreter.js')).Interpreter,
		parse: (await builtImport('v2/parser/index.js')).parse,
		...await builtImport('interpreter/value.js'), ...await builtImport('interpreter/host-yield.js'),
	};
	const { Legacy, Parser, Interpreter, parse, NUM, STR, ARR, OBJ, FN_NATIVE, NULL, defaultYieldToHost } = module;
	const legacyValue = value => typeof value === 'number' ? NUM(value) : typeof value === 'string' ? STR(value) : Array.isArray(value) ? ARR(value.map(legacyValue)) : OBJ(new Map(Object.entries(value).map(([k,v])=>[k,legacyValue(v)])));
	const plain = value => value.type === 'arr' ? value.value.map(plain) : value.type === 'obj' ? Object.fromEntries([...value.value].map(([k,v])=>[k,plain(v)])) : value.value;
	const code = source(version, operation, counting);
	const ast = version === 'v2' ? parse(code).program : Parser.parse(code);
	const trials = counting ? 1 : config.trials, warmups = counting ? 0 : config.warmups;
	for (let trial = -warmups; trial < trials; trial++) {
		const {values,expected} = inputFor(size, operation);
		let result, calls = 0, comparisons = 0, started = 0, ended = 0, yields = 0, segmentStart = 0, maxSyncMs = 0;
		globalThis.__sortComparisons = 0;
		const mark = () => { started = segmentStart = performance.now(); };
		const out = value => { ended = performance.now(); maxSyncMs = Math.max(maxSyncMs,ended-segmentStart); result=value; };
		const count = () => { calls++; };
		const compareCount = () => { comparisons++; };
		// 実行の前に GC を済ませ、測定中は標準のホスト譲渡をそのまま使います。
		const options = {maxBusyTime:300000, yieldInterval:8, yieldToHost:async()=>{ if(started) { yields++; maxSyncMs=Math.max(maxSyncMs,performance.now()-segmentStart); } await defaultYieldToHost(); segmentStart=performance.now(); }};
		const vm = version === 'v2' ? new Interpreter({input:values,mark,out,count,compareCount},options) : new Legacy({input:legacyValue(values),mark:FN_NATIVE(()=>{mark();return NULL;}),count:FN_NATIVE(()=>{count();return NULL;}),compareCount:FN_NATIVE(()=>{compareCount();return NULL;})},{...options,out,err:error=>{throw error;}});
		global.gc?.();
		const rssBeforeBytes=process.memoryUsage().rss;
		try {
			await vm.exec(ast);
			assert.ok(started > 0 && ended >= started);
			assert.deepEqual(version==='v1'?plain(result):result,expected,'全件の値・順序・同一キーの安定順');
			if (counting && operation === 'sortBy') assert.equal(calls,size,'キーは一度ずつ');
			const comparisonCalls = counting ? globalThis.__sortComparisons : null;
			if(counting && size>1) assert.ok(comparisonCalls>0,'内部比較の計数が有効');
			console.log(JSON.stringify({version,operation,size,trial,warmup:trial<0,counting,status:'passed',operationMs:ended-started,comparisonCalls,keyCalls:counting&&operation==='sortBy'?calls:null,steps:vm.stepCount,yields,maxSyncMs,rssBeforeBytes,rssAfterBytes:process.memoryUsage().rss,maxRssKiB:process.resourceUsage().maxRSS,verifiedCount:size,stableVerified:operation==='sortBy'}));
		} catch(error) { console.log(JSON.stringify({version,operation,size,trial,warmup:trial<0,counting,status:'failed',error:String(error.stack??error)})); process.exitCode=1; }
		finally {vm.abort();}
	}
}
async function countingBundle() {
	const entry=resolve(config.directory,'count-entry.ts'), builder=resolve(config.directory,'count-build.mjs'), output=resolve(config.directory,'count-module.mjs');
	await writeFile(entry,`export { Parser, Interpreter as Legacy } from '${root}/src/index.ts';\nexport { Interpreter } from '${root}/src/v2/interpreter.ts';\nexport { parse } from '${root}/src/v2/parser/index.ts';\nexport * from '${root}/src/interpreter/value.ts';\nexport { defaultYieldToHost } from '${root}/src/interpreter/host-yield.ts';\n`);
	// 計数用 bundle だけを加工し、時間用の built とリポジトリの実装は変えません。
	await writeFile(builder, `import {readFile} from 'node:fs/promises';
const result=await Bun.build({entrypoints:[${JSON.stringify(entry)}],target:'node',format:'esm',naming:'count-module.mjs',outdir:${JSON.stringify(config.directory)},plugins:[{name:'count',setup(build){
 build.onLoad({filter:/stdlib\\/collections\\.ts$/},async({path})=>{
  let contents=await readFile(path,'utf8');
  const expression=/function \\*compareKeys\\([^\\n]+\\{\\n/;
  if(!expression.test(contents))throw Error('compareKeys counting anchor missing');
  contents=contents.replace(expression,match=>match+'globalThis.__sortComparisons++;\\n');
  const callback=/ctx\\.call\\(fn, \\[left\\.value, right\\.value\\]\\)/g;
  if(!callback.test(contents))throw Error('sort callback counting anchor missing');
  contents=contents.replace(callback,match=>'(globalThis.__sortComparisons++, '+match+')');
  return {contents,loader:'ts'};
 });
 build.onLoad({filter:/interpreter\\/primitive-props\\.ts$/},async({path})=>{
  let contents=await readFile(path,'utf8');const expression=/opts\\.call\\(comp, \\[l, r\\]\\)/g;
  if((contents.match(expression)??[]).length!==2)throw Error('legacy sort counting anchors missing');
  contents=contents.replace(expression,match=>'(globalThis.__sortComparisons++, '+match+')');return {contents,loader:'ts'};
 });
}}]});if(!result.success)throw Error(result.logs.join('\\n'));`);
	const result=spawnSync('bun',[builder],{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return output;
}
if(args.has('worker')) await worker();
else {
	await mkdir(config.directory,{recursive:true});
	const bundle=await countingBundle(), records=[],failures=[];
	for(const size of config.sizes)for(const operation of config.operations)for(const version of config.versions){
		// 100 万件の 1.x は再帰的な並列マージで大量のメモリを使うため別途指定します。
		if(size>=1000000&&version==='v1'&&args.get('million-v1')!=='true')continue;
		for(const counting of [false,true]){
			const parameters=[`--max-old-space-size=${config.heapMb}`,'--expose-gc'];
			if(config.profile&&!counting&&version==='v2')parameters.push('--cpu-prof',`--cpu-prof-dir=${config.directory}`,`--cpu-prof-name=${operation}-${size}.cpuprofile`,'--cpu-prof-interval=1000');
			parameters.push(fileURLToPath(import.meta.url),'--worker',`--version=${version}`,`--operation=${operation}`,`--size=${size}`,`--trials=${config.trials}`,`--warmups=${config.warmups}`,`--counting=${counting}`,`--built=${config.built}`);
			if(counting)parameters.push(`--module=${bundle}`);
			const result=spawnSync(process.execPath,parameters,{cwd:root,encoding:'utf8',timeout:config.timeoutMs,maxBuffer:16*1024*1024});
			process.stderr.write(`${version} ${operation} n=${size} ${counting?'count':'timing'} exit=${result.status}\n`);
			const rows=[];for(const line of (result.stdout??'').split('\n').filter(Boolean)){try{rows.push(JSON.parse(line));}catch{failures.push({version,operation,size,counting,invalidOutput:line});}}
			records.push(...rows);
			const expectedRows=counting?1:config.warmups+config.trials;
			if(result.status!==0||rows.length!==expectedRows)failures.push({version,operation,size,counting,exit:result.status,signal:result.signal,error:String(result.error??''),stderr:result.stderr,planned:expectedRows,received:rows.length});
			await writeFile(resolve(config.directory,'partial.json'),JSON.stringify({config,records,failures},null,2));
		}
	}
	const summaries=[];
	for(const size of config.sizes)for(const operation of config.operations)for(const version of config.versions){
		const rows=records.filter(row=>row.size===size&&row.operation===operation&&row.version===version&&!row.counting&&!row.warmup);
		if(!rows.length)continue;
		const valid=rows.filter(row=>row.status==='passed');const count=records.find(row=>row.size===size&&row.operation===operation&&row.version===version&&row.counting&&row.status==='passed');
		const time=median(valid.map(row=>row.operationMs));
		summaries.push({version,operation,size,planned:config.trials,passed:valid.length,medianMs:time,comparisonCalls:count?.comparisonCalls??null,keyCalls:count?.keyCalls??null,amortizedMicrosecondsPerComparison:count&&time!==null?time*1000/count.comparisonCalls:null,maxSyncMs:valid.length?Math.max(...valid.map(row=>row.maxSyncMs)):null,maxRssMiB:valid.length?Math.max(...valid.map(row=>row.maxRssKiB))/1024:null});
	}
	const report={runtime:process.versions,config,notes:['時間用ソースにホストの比較・キー計数関数を含めない。計数は同じ入力の別試行で行う。','比較一回あたりはソート全体時間÷比較回数であり、比較関数単体の実行時間ではない。','1.x に sortBy はないため decorate-sort-extract。1.x の文字列 sort は比較関数必須なので標準 Str:lt を使用。','比較数は同じ seed とアルゴリズムの別試行。sortBy は id により安定性を全件確認し、数値と文字列の同値は区別できない。','RSS の上限は外部監視も併用する。heap 制限だけではプロセス合計の 3 GB 制約を保証しない。'],sources:Object.fromEntries(config.versions.map(version=>[version,Object.fromEntries(config.operations.map(operation=>[operation,source(version,operation,false)]))])),summaries,failures,records};
	await writeFile(resolve(config.directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
	if(failures.length||records.some(row=>row.status!=='passed'))process.exitCode=1;
}
