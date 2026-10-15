import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 構築費用は実行から分離し、既存の遅延コンパイルは両版とも実行時間に含めます。
const cases = [];
const pair = (name, plain, annotated, expected, globals = () => ({})) => {
	cases.push({ name: `${name}/plain`, source: plain, expected, globals });
	cases.push({ name: `${name}/typed`, source: annotated, expected, globals });
};
pair('loop', 'let s=0; for(let i=0;i<40000;i++)s+=i; out(s);', 'let s:number=0; for(let i:number=0;i<40000;i++)s+=i; out(s);', [799980000]);
pair('call', 'function f(x){return x+1;} let s=0; for(let i=0;i<20000;i++)s+=f(i);out(s);', 'function f(x:number):number{return x+1;} let s=0; for(let i=0;i<20000;i++)s+=f(i);out(s);', [200010000]);
pair('default', 'function f(x=2){return x+1;} let s=0;for(let i=0;i<20000;i++)s+=f();out(s);', 'function f(x:number=2):number{return x+1;} let s=0;for(let i=0;i<20000;i++)s+=f();out(s);', [60000]);
pair('map', 'const ys=xs.map(x=>x+1);out(ys.length);out(ys[9999]);', 'const ys=xs.map((x:number):number=>x+1);out(ys.length);out(ys[9999]);', [10000,10000], () => ({ xs: Array.from({ length: 10000 }, (_, i) => i) }));
pair('object', 'function f(x){return x.n;}let s=0;for(let i=0;i<20000;i++)s+=f(obj);out(s);', 'function f(x:{n:number,items:number[]}):number{return x.n;}let s=0;for(let i=0;i<20000;i++)s+=f(obj);out(s);', [60000], () => ({ obj: { n: 3, items: [1,2] } }));
for (const length of [0,10,1000,100000]) {
	pair(`array${length}`, 'const a=xs;out(a.length);', 'const a:number[]=xs;out(a.length);', [length], () => ({ xs: Array.from({ length }, (_, i) => i) }));
}
cases.push({ name: 'fib/plain', source: 'function fib(n){return n<2?n:fib(n-1)+fib(n-2);}out(fib(18));', expected: [2584] });
cases.push({ name: 'closure/plain', source: 'let n=0;function f(){n++;}for(let i=0;i<20000;i++)f();out(n);', expected: [20000] });
for (const size of [100,1000,10000]) {
	cases.push({ name: `prepare${size}/plain`, source: Array.from({ length:size }, (_, i) => `let x${i}=${i};`).join('\n'), expected: [], prepareOnly: true, statements: size });
}
const failure = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack });
const percentile = (values, q) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*q)-1] ?? null;
const countNodes = value => {
	if (!value || typeof value !== 'object') return 0;
	if (Array.isArray(value)) return value.reduce((sum,item) => sum+countNodes(item),0);
	return (typeof value.type === 'string' ? 1 : 0) + Object.entries(value).reduce((sum,[key,item]) => sum+(key === 'loc' ? 0 : countNodes(item)),0);
};
const options = { maxSteps: 1e9, maxBusyTime: 60000, yieldInterval: 8 };
const warmup = Number(process.env.V2_TYPES_WARMUP ?? 10);
const pairs = Number(process.env.V2_TYPES_PAIRS ?? 30);
const rounds = Number(process.env.V2_TYPES_ROUNDS ?? 3);
for (const [key,value] of Object.entries({ warmup,pairs,rounds })) assert.ok(Number.isSafeInteger(value) && value >= (key === 'warmup' ? 0 : 1), key);

if (process.argv[2] === '--worker') {
	const [name, roundText, before, after] = process.argv.slice(3);
	const round = Number(roundText);
	const test = cases.find(item => item.name === name);
	assert.ok(test, name);
	const versions = [];
	const imports = round % 2 === 0 ? [['before',before],['after',after]] : [['after',after],['before',before]];
	for (const [label,root] of imports) {
		const base = resolve(root, process.env.V2_TYPES_SOURCE === '1' ? 'src' : 'built', 'v2');
		const extension = process.env.V2_TYPES_SOURCE === '1' ? 'ts' : 'js';
		const { Interpreter } = await import(pathToFileURL(resolve(base,`interpreter.${extension}`)).href);
		const { parse } = await import(pathToFileURL(resolve(base,`parser/index.${extension}`)).href);
		const { defaultYieldToHost } = await import(pathToFileURL(resolve(base,`../interpreter/host-yield.${extension}`)).href);
		versions.push({ label,Interpreter,parse,defaultYieldToHost });
	}
	const records = [];
	for (let trial = -warmup; trial < pairs; trial++) {
		for (let order = 0; order < 2; order++) {
			const version = versions[(trial+warmup+round+order)%2];
			const output = [];
			const row = { name, label:version.label, round, trial, warmup:trial<0, order, importOrder:imports.map(item => item[0]), ok:false };
			const started = performance.now();
			try {
				const globals = { ...test.globals?.(), out: value => { output.push(value); } };
				const constructStart = performance.now();
				let yields = 0, segmentStart = 0, maxSynchronousMs = 0;
				const yieldToHost = async () => {
					maxSynchronousMs = Math.max(maxSynchronousMs,performance.now()-segmentStart);
					yields++;
					await version.defaultYieldToHost();
					segmentStart = performance.now();
				};
				const interpreter = new version.Interpreter(globals,{ ...options,yieldToHost });
				row.constructMs = performance.now()-constructStart;
				const parseStart = performance.now();
				const { program } = version.parse(test.source);
				row.parseMs = performance.now()-parseStart;
				const prepareStart = performance.now();
				if (interpreter.prepareProgram) interpreter.prepareProgram(program);
				row.prepareMs = interpreter.prepareProgram ? performance.now()-prepareStart : 0;
				row.parsePrepareMs = row.parseMs+row.prepareMs;
				row.prepareAvailable = typeof interpreter.prepareProgram === 'function';
				if (!test.prepareOnly) {
					const executeStart = performance.now();
					segmentStart = executeStart;
					await interpreter.exec(program);
					const executeEnd = performance.now();
					row.executeMs = executeEnd-executeStart;
					row.maxSynchronousMs = Math.max(maxSynchronousMs,executeEnd-segmentStart);
					row.yields = yields;
				}
				row.steps = interpreter.stepCount;
				row.frames = interpreter.evaluationFrameCount;
				row.nodes = countNodes(program);
				// 出力照合と構文木の確認は計測した時間の外に置きます。
				assert.deepEqual(output,test.expected);
				if (test.prepareOnly) assert.equal(program.body.length,test.statements);
				row.ok = true;
			} catch (error) { row.error = failure(error); }
			row.output = output;
			row.totalMs = performance.now()-started;
			row.rssBytes = process.memoryUsage().rss;
			records.push(row);
		}
	}
	console.log(JSON.stringify({ records, maxRssKiB:process.resourceUsage().maxRSS }));
	if (records.some(row => !row.ok)) process.exitCode = 1;
} else {
	const [before,after] = process.argv.slice(2).map(root => resolve(root));
	assert.ok(before && after,'before-clone after-clone を指定してください');
	const selected = process.env.V2_TYPES_CASES ? cases.filter(test => process.env.V2_TYPES_CASES.split(',').includes(test.name)) : cases;
	assert.ok(selected.length > 0,'対象ケースがありません');
	const report = { runtime:process.versions, platform:platform(), arch:arch(), cpu:cpus()[0]?.model, logicalCpus:cpus().length,
		before,after,modules:process.env.V2_TYPES_SOURCE === '1' ? 'source' : 'built', options,warmup,pairs,rounds,excluded:0,
		cases:selected.map(({ name,source,expected,prepareOnly }) => ({ name,source,sourceHash:createHash('sha256').update(source).digest('hex'),characters:source.length,expected,prepareOnly:!!prepareOnly })),
		records:[],failures:[],workers:[] };
	for (let round = 0; round < rounds; round++) {
		for (const test of selected) {
			const start = performance.now();
			const child = spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--worker',test.name,String(round),before,after],{ encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024 });
			const worker = { name:test.name,round,wallMs:performance.now()-start,status:child.status,signal:child.signal };
			try {
				const result = JSON.parse(child.stdout);
				report.records.push(...result.records);
				worker.maxRssKiB = result.maxRssKiB;
				assert.equal(result.records.length,2*(warmup+pairs));
			} catch (error) { report.failures.push({ ...worker,error:failure(error),stdout:child.stdout,stderr:child.stderr }); }
			if (child.status !== 0) report.failures.push({ ...worker,error:String(child.error ?? 'worker failed'),stderr:child.stderr });
			report.workers.push(worker);
			console.error(JSON.stringify({ progress:report.workers.length,total:rounds*selected.length,...worker }));
		}
	}
	report.failures.push(...report.records.filter(row => !row.ok));
	report.summary = selected.flatMap(test => ['before','after'].map(label => {
		const rows = report.records.filter(row => row.name === test.name && row.label === label && !row.warmup);
		const passed = rows.filter(row => row.ok);
		const complete = rows.length === rounds*pairs && passed.length === rows.length;
		const metrics = Object.fromEntries(['constructMs','parseMs','prepareMs','parsePrepareMs','executeMs','maxSynchronousMs','yields','rssBytes'].map(metric => {
			const values = passed.map(row => row[metric]).filter(value => value !== undefined);
			return [metric,{ p50:complete ? percentile(values,.5) : null,p95:complete ? percentile(values,.95) : null }];
		}));
		return { name:test.name,label,expected:rounds*pairs,attempted:rows.length,passed:passed.length,valid:complete,...metrics,
			steps:[...new Set(rows.map(row => row.steps))],frames:[...new Set(rows.map(row => row.frames))],nodes:[...new Set(rows.map(row => row.nodes))] };
	}));
	report.valid = report.failures.length === 0 && report.summary.every(row => row.valid);
	console.log(JSON.stringify(report,null,2));
	if (!report.valid) process.exitCode = 1;
}
