import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus,platform,arch } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [before,after] = process.argv.slice(2).map(path => resolve(path));
assert.ok(before && after,'before-clone after-clone を指定してください');
const require = createRequire(resolve(process.env.PLAYWRIGHT_PACKAGE_JSON ?? join(root,'package.json')));
const playwright = require('playwright');
const config = { warmup:Number(process.env.V2_TYPES_WARMUP ?? 10),pairs:Number(process.env.V2_TYPES_PAIRS ?? 30),rounds:Number(process.env.V2_TYPES_ROUNDS ?? 3),engines:(process.env.ENGINES ?? 'chromium,firefox,webkit').split(',') };
for (const [key,value] of Object.entries(config).filter(([key]) => key !== 'engines')) assert.ok(Number.isSafeInteger(value) && value >= (key === 'warmup' ? 0 : 1),key);
assert.ok(config.engines.every(engine => ['chromium','firefox','webkit'].includes(engine)));
const cases = [
	{ name:'loop/plain',source:'let s=0;for(let i=0;i<40000;i++)s+=i;out(s);',expected:[799980000] },
	{ name:'loop/typed',source:'let s:number=0;for(let i:number=0;i<40000;i++)s+=i;out(s);',expected:[799980000] },
	{ name:'map/plain',source:'const ys=xs.map(x=>x+1);out(ys.length);out(ys[9999]);',expected:[10000,10000],map:true },
	{ name:'map/typed',source:'const ys=xs.map((x:number):number=>x+1);out(ys.length);out(ys[9999]);',expected:[10000,10000],map:true },
	...[100,1000,10000].map(size => ({ name:`prepare${size}/plain`,source:Array.from({length:size},(_,i)=>`let x${i}=${i};`).join('\n'),expected:[],prepareOnly:true,statements:size })),
];
const selected = process.env.V2_TYPES_CASES ? cases.filter(test => process.env.V2_TYPES_CASES.split(',').includes(test.name)) : cases;
assert.ok(selected.length);
const report = { config,before,after,modules:'built browser bundle',headless:true,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,playwright:require('playwright/package.json').version,
	excluded:0,cases:selected,options:{maxSteps:1e9,maxBusyTime:60000,yieldInterval:8},records:[],failures:[] };
const directory = await mkdtemp(join(root,'.git','v2-types-browser-'));
let server;

function browserMain() {
	globalThis.typeTrial = async ({ descriptor,version,options }) => {
		const { Interpreter,parse,defaultYieldToHost } = versions[version];
		const output = [];
		const row = { ok:false };
		try {
			const globals = { out:value => { output.push(value); },...(descriptor.map ? { xs:Array.from({length:10000},(_,i)=>i) } : {}) };
			let yields=0,segmentStart=0,maxSynchronousMs=0;
			const yieldToHost = async () => {
				maxSynchronousMs=Math.max(maxSynchronousMs,performance.now()-segmentStart);
				yields++;
				await defaultYieldToHost();
				segmentStart=performance.now();
			};
			let start=performance.now();
			const vm = new Interpreter(globals,{...options,yieldToHost});
			row.constructMs=performance.now()-start;
			start=performance.now();
			const {program}=parse(descriptor.source);
			row.parseMs=performance.now()-start;
			start=performance.now();
			if(vm.prepareProgram)vm.prepareProgram(program);
			row.prepareMs=vm.prepareProgram ? performance.now()-start : 0;
			row.parsePrepareMs=row.parseMs+row.prepareMs;
			row.prepareAvailable=typeof vm.prepareProgram === 'function';
			if(!descriptor.prepareOnly) {
				start=segmentStart=performance.now();
				await vm.exec(program);
				const end=performance.now();
				row.executeMs=end-start;
				row.maxSynchronousMs=Math.max(maxSynchronousMs,end-segmentStart);
				row.yields=yields;
			}
			row.steps=vm.stepCount;
			row.frames=vm.evaluationFrameCount;
			// 出力比較は実行の時間に含めません。
			if(JSON.stringify(output)!==JSON.stringify(descriptor.expected))throw new Error('Output mismatch');
			if(descriptor.prepareOnly && program.body.length!==descriptor.statements)throw new Error('Statement count mismatch');
			row.ok=true;
		} catch(error) { row.error={name:error.name,message:error.message,stack:error.stack}; }
		row.output=output;
		return row;
	};
}

try {
	const imports=[];
	for(const [index,clone] of [before,after].entries()) {
		imports.push(`import {Interpreter as Interpreter${index}} from ${JSON.stringify(join(clone,'built/v2/interpreter.js'))};`);
		imports.push(`import {parse as parse${index}} from ${JSON.stringify(join(clone,'built/v2/parser/index.js'))};`);
		imports.push(`import {defaultYieldToHost as yield${index}} from ${JSON.stringify(join(clone,'built/interpreter/host-yield.js'))};`);
	}
	const entry=join(directory,'entry.js');
	await writeFile(entry,`${imports.join('\n')}\nconst versions={before:{Interpreter:Interpreter0,parse:parse0,defaultYieldToHost:yield0},after:{Interpreter:Interpreter1,parse:parse1,defaultYieldToHost:yield1}};\n(${browserMain.toString()})();`);
	const builder=join(directory,'build.mjs');
	await writeFile(builder,`const result=await Bun.build({entrypoints:[${JSON.stringify(entry)}],outdir:${JSON.stringify(join(directory,'bundle'))},target:'browser'});if(!result.success)throw new Error(result.logs.join('\\n'));`);
	const build=spawnSync(process.env.BUN ?? 'bun',[builder],{encoding:'utf8'});
	assert.equal(build.status,0,build.stdout+build.stderr);
	const bundle=await readFile(join(directory,'bundle/entry.js'));
	server=createServer((request,response)=>{
		response.setHeader('Content-Type',request.url==='/bundle.js' ? 'text/javascript' : 'text/html');
		response.end(request.url==='/bundle.js' ? bundle : '<!doctype html><meta charset="utf-8"><script src="/bundle.js"></script>');
	});
	await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
	const url=`http://127.0.0.1:${server.address().port}`;
	for(const engine of config.engines)for(let round=0;round<config.rounds;round++) {
		let browser;
		try {
			browser=await playwright[engine].launch({headless:true});
			const page=await browser.newPage();
			page.setDefaultTimeout(60000);
			await page.goto(url);
			for(const descriptor of selected) {
				for(let trial=-config.warmup;trial<config.pairs;trial++)for(let order=0;order<2;order++) {
					const version=['before','after'][(trial+config.warmup+round+order)%2];
					let timeout;
					try {
						const result=await Promise.race([page.evaluate(input=>globalThis.typeTrial(input),{descriptor,version,options:report.options}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Browser trial wall timeout')),60000);})]);
						report.records.push({engine,browserVersion:browser.version(),round,name:descriptor.name,label:version,trial,warmup:trial<0,order,...result});
					} finally { clearTimeout(timeout); }
				}
				console.error(JSON.stringify({engine,round,name:descriptor.name,status:'measured'}));
			}
		} catch(error) { report.failures.push({engine,round,error:String(error)}); }
		finally { await browser?.close().catch(()=>{}); }
	}
} catch(error) { report.failures.push({error:String(error)}); }
finally {
	await new Promise(resolve=>server ? server.close(resolve) : resolve());
	await rm(directory,{recursive:true,force:true});
	// 起動失敗とタイムアウトの後も予定した試行を失敗として残します。
	const recorded=new Set(report.records.map(row=>[row.engine,row.round,row.name,row.label,row.trial].join('|')));
	for(const engine of config.engines)for(let round=0;round<config.rounds;round++)for(const descriptor of selected)for(const label of ['before','after'])for(let trial=-config.warmup;trial<config.pairs;trial++) {
		if(!recorded.has([engine,round,descriptor.name,label,trial].join('|')))report.records.push({engine,round,name:descriptor.name,label,trial,warmup:trial<0,ok:false,error:'Trial unavailable after setup failure or timeout'});
	}
	const percentile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1] ?? null;
	report.summary=config.engines.flatMap(engine=>selected.flatMap(descriptor=>['before','after'].map(label=>{
		const rows=report.records.filter(row=>row.engine===engine && row.name===descriptor.name && row.label===label && !row.warmup);
		const valid=rows.length===config.rounds*config.pairs && rows.every(row=>row.ok);
		const metrics=Object.fromEntries(['constructMs','parseMs','prepareMs','parsePrepareMs','executeMs','maxSynchronousMs','yields'].map(metric=>{
			const values=rows.map(row=>row[metric]).filter(value=>value!==undefined);
			return [metric,{p50:valid?percentile(values,.5):null,p95:valid?percentile(values,.95):null}];
		}));
		return {engine,name:descriptor.name,label,attempted:rows.length,passed:rows.filter(row=>row.ok).length,valid,...metrics,steps:[...new Set(rows.map(row=>row.steps))],frames:[...new Set(rows.map(row=>row.frames))]};
	})));
	report.valid=report.failures.length===0 && report.records.every(row=>row.ok) && report.summary.every(row=>row.valid);
	console.log(JSON.stringify(report,null,2));
	if(!report.valid)process.exitCode=1;
}
