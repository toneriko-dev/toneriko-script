import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = new Map(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=')]; }));
const number = (key, fallback) => { const value = Number(arguments_.get(key) ?? fallback); if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid --${key}`); return value; };
const config = { processes: number('processes', 3), warmup: number('warmup', 2), repeats: number('repeats', 5), sortSize: number('sort-size', 1_000_000), mapSize: number('map-size', 100_000), stringSize: number('string-size', 1_000_000), timeoutMs: number('timeout-ms', 180_000), idleMs: number('idle-ms', 500), versions: (arguments_.get('versions') ?? 'v2,v1').split(','), limits: (arguments_.get('limits') ?? 'default,relaxed').split(','), cases: arguments_.get('cases')?.split(',') };
const require = createRequire(resolve(process.env.PLAYWRIGHT_PACKAGE_JSON ?? join(root, 'package.json')));
const { chromium } = require('playwright');
const directory = await mkdtemp(join(root, '.git', 'v2-stdlib-browser-'));
const goldenSource = await readFile(join(root, 'test/v2/stdlib-numbers.ts'), 'utf8');
const golden = JSON.parse(goldenSource.match(/const golden = (\[[\s\S]*?\n\]);/)[1]);
const cases = [];
for (const operation of ['sort', 'sortBy']) for (const pattern of ['random', 'sorted', 'reverse', 'duplicates']) cases.push({ name: `${operation}-${pattern}`, operation, pattern });
cases.push({ name: 'map', operation: 'map' });
for (const alphabet of ['ascii', 'nonascii']) for (const cache of ['cold', 'warm']) cases.push({ name: `indexOf-${alphabet}-${cache}`, operation: 'indexOf', alphabet, cache });
const selected = cases.filter(item => !config.cases || config.cases.includes(item.name));
if (!selected.length || !config.processes || !config.repeats || !config.versions.every(v => ['v1','v2'].includes(v)) || !config.limits.every(v => ['default','relaxed'].includes(v))) throw new Error('Invalid benchmark selection');
const report = { config, instrumentation: '1 GiB renderer heap; explicit GC before each trial, outside measurement. Bundle-only comparison counters; performance.now and the original defaultYieldToHost; no busy-clock reset. Input events originate in an external CDP client.', observations: ['parseMs','elapsedMs','outerMs','maxSynchronousMs','rafMaxGapMs','inputMaxLagMs','inputEvents','inputRequests','inputRoundTripMaxMs','steps','comparisons','keyCalls','yields','heapBeforeBytes','heapAfterBytes','heapPeakBytes','correctness','length','hash'], unobserved: ['OS scheduling and GC cannot be separated from synchronous intervals.', 'v1 has no sortBy: its baseline decorates keys, sorts, and extracts values.', 'Input lag uses Chromium event timestamps and the local wall clock; round-trip latency also includes protocol overhead.'], excluded: 0, idle: [], random: [], trials: [], startupFailures: [] };

function browserMain() {
	const state = { active: false, rafLast: 0, rafMax: 0, inputMax: 0, inputEvents: 0 };
	function frame(now) { if (state.active) { state.rafMax = Math.max(state.rafMax, now - state.rafLast); state.rafLast = now; } requestAnimationFrame(frame); }
	requestAnimationFrame(frame);
	addEventListener('keydown', event => { if (state.active) { state.inputEvents++; state.inputMax = Math.max(state.inputMax, Date.now() - (performance.timeOrigin + event.timeStamp)); } });
	function begin() { const now = performance.now(); state.active = true; state.rafLast = now; state.rafMax = 0; state.inputMax = 0; state.inputEvents = 0; return now; }
	function finish() { const now = performance.now(); state.rafMax = Math.max(state.rafMax, now-state.rafLast); state.active = false; return { rafMaxGapMs: state.rafMax, inputMaxLagMs: state.inputMax, inputEvents: state.inputEvents }; }
	const heap = () => performance.memory?.usedJSHeapSize ?? null;
	globalThis.stdlibIdle = async ms => { begin(); await new Promise(resolve => setTimeout(resolve, ms)); return finish(); };
	globalThis.stdlibRandom = async () => {
		const seeds = ['', 0, -0, 1, -42, 1.5, '日本語', '👩‍💻', '2026-10-15:user-id'];
		const result = [];
		for (let i = 0; i < seeds.length; i++) {
			const values = []; const vm = new Interpreter({ seed: seeds[i], emit: x => values.push(x) });
			await vm.exec(parse('const rng=Math.seededRandom(seed); for(let i=0;i<4096;i++) emit(rng());').program);
			const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values))))].map(b => b.toString(16).padStart(2,'0')).join('');
			result.push({ seed: Object.is(seeds[i], -0) ? '-0' : seeds[i], length: values.length, digest, passed: digest === golden[i].digest && JSON.stringify(values.slice(0,32)) === JSON.stringify(golden[i].first) });
		}
		return result;
	};
	globalThis.stdlibTrial = async ({ descriptor, version, limit, config }) => {
		let seed = 123456789;
		const rand = () => { seed = Math.imul(seed,1664525)+1013904223|0; return seed>>>0; };
		const size = descriptor.operation === 'map' ? config.mapSize : config.sortSize;
		let input, needle, expected;
		if (descriptor.operation === 'indexOf') {
			const unit = descriptor.alphabet === 'ascii' ? 'a' : 'e\u0301';
			input = unit.repeat(config.stringSize) + 'z'; needle = unit.repeat(128) + 'b'; expected = -1;
		} else {
			input = Array.from({ length: size }, (_, i) => descriptor.pattern === 'random' ? rand()%Math.max(1,size) : descriptor.pattern === 'reverse' ? size-i : descriptor.pattern === 'duplicates' ? i%17 : i);
			if (descriptor.operation === 'sortBy') input = input.map((key,id) => ({key,id}));
			expected = descriptor.operation === 'map' ? input.map(value => value+1) : [...input].sort(descriptor.operation === 'sortBy' ? (a,b)=>a.key-b.key : (a,b)=>a-b);
		}
		let source, output, outputCalls = 0, keyCalls = 0;
		if (version === 'v2') {
			const expression = descriptor.operation === 'sort' ? 'items.sort((a,b)=>a-b)' : descriptor.operation === 'sortBy' ? 'items.sortBy(x=>{keyCalled(); return x.key;})' : descriptor.operation === 'map' ? 'items.map(x=>x+1)' : 'items.indexOf(needle)';
			source = (descriptor.cache === 'warm' ? `${expression};` : '') + `start(); emit(${expression});`;
		} else {
			const expression = descriptor.operation === 'sort' ? 'items.sort(@(a,b){a-b})' : descriptor.operation === 'sortBy' ? 'items.map(@(x){keyCalled()\n[x.key,x]}).sort(@(a,b){a[0]-b[0]}).map(@(x){x[1]})' : descriptor.operation === 'map' ? 'items.map(@(x){x+1})' : 'items.index_of(needle)';
			source = (descriptor.cache === 'warm' ? `${expression}\n` : '') + `start()\nemit(${expression})`;
		}
		let started = 0, segmentStart = 0, maxSynchronousMs = 0, yields = 0, heapBeforeBytes = null, heapPeakBytes = 0, stepStart = 0, vm;
		const start = () => { started = begin(); segmentStart = started; heapBeforeBytes = heap(); heapPeakBytes = heapBeforeBytes ?? 0; globalThis.__stdlibComparisons = 0; stepStart = vm.stepCount; keyCalls = 0; };
		const yieldToHost = async () => {
			if (started) { maxSynchronousMs = Math.max(maxSynchronousMs,performance.now()-segmentStart); yields++; heapPeakBytes = Math.max(heapPeakBytes,heap() ?? 0); }
			await defaultYieldToHost();
			if (started) segmentStart = performance.now();
		};
		const options = { yieldToHost, maxBusyTime: limit === 'default' ? 5000 : Infinity };
		let parseMs = 0, error = null, elapsedMs = null;
		const outerStart = performance.now();
		try {
			if (version === 'v2') {
				vm = new Interpreter({ items: input, needle: needle ?? '', start, keyCalled: () => { keyCalls++; }, emit: value => { output = value; outputCalls++; } }, options);
				const before = performance.now(); const program = parse(source).program; parseMs = performance.now()-before;
				await vm.exec(program);
			} else {
				vm = new LegacyInterpreter({ items: legacyUtils.jsToVal(input), needle: legacyValues.STR(needle ?? ''), start: legacyValues.FN_NATIVE(() => { start(); return legacyValues.NULL; }), keyCalled: legacyValues.FN_NATIVE(() => { keyCalls++; return legacyValues.NULL; }), emit: legacyValues.FN_NATIVE(([value]) => { output = value; outputCalls++; return legacyValues.NULL; }) }, options);
				const before = performance.now(); const program = LegacyParser.parse(source); parseMs = performance.now()-before;
				await vm.exec(program);
			}
		} catch (caught) { error = { name: caught.name, message: caught.message, code: caught.code ?? null }; }
		const ended = performance.now();
		if (started) { elapsedMs = ended-started; maxSynchronousMs = Math.max(maxSynchronousMs,ended-segmentStart); }
		const responsiveness = finish();
		const measured = { parseMs, elapsedMs, outerMs: ended-outerStart, maxSynchronousMs, ...responsiveness, yields, heapBeforeBytes, heapAfterBytes: heap(), heapPeakBytes, comparisons: globalThis.__stdlibComparisons ?? 0, keyCalls, steps: vm ? vm.stepCount-stepStart : null };
		if (version === 'v1' && output !== undefined) output = legacyUtils.valToJs(output);
		const verificationStart = performance.now();
		let correctness = !error && started !== 0 && outputCalls === 1;
		let hash = 2166136261, length = null;
		if (Array.isArray(expected)) {
			length = Array.isArray(output) ? output.length : null;
			correctness &&= Array.isArray(output) && output.length === expected.length;
			if (correctness) for (let i = 0; i < output.length; i++) {
				const actual = descriptor.operation === 'sortBy' ? output[i].key : output[i];
				const wanted = descriptor.operation === 'sortBy' ? expected[i].key : expected[i];
				if (actual !== wanted || (descriptor.operation === 'sortBy' && output[i].id !== expected[i].id)) correctness = false;
				hash = Math.imul(hash ^ actual, 16777619)>>>0;
				if (descriptor.operation === 'sortBy') hash = Math.imul(hash ^ output[i].id, 16777619)>>>0;
			}
		} else { correctness &&= output === expected; hash = output; }
		return { ...measured, length, hash, correctness, outputCalls, verificationMs: performance.now()-verificationStart, error, gate16ms: correctness && maxSynchronousMs <= 16, foreground: document.visibilityState === 'visible' && document.hasFocus() };
	};
}

let server;
try {
	const entry = join(directory, 'entry.ts');
	await writeFile(entry, `import { parse } from ${JSON.stringify(join(root,'src/v2/parser/index.ts'))};\nimport { Interpreter } from ${JSON.stringify(join(root,'src/v2/interpreter.ts'))};\nimport { defaultYieldToHost } from ${JSON.stringify(join(root,'src/interpreter/host-yield.ts'))};\nimport { Interpreter as LegacyInterpreter, Parser as LegacyParser, utils as legacyUtils, values as legacyValues } from ${JSON.stringify(join(root,'src/index.ts'))};\nconst golden=${JSON.stringify(golden)};\n(${browserMain.toString()})();`);
	const builder = join(directory, 'build.mjs');
	await writeFile(builder, `import { readFile } from 'node:fs/promises';\nconst result=await Bun.build({entrypoints:[${JSON.stringify(entry)}],outdir:${JSON.stringify(directory)},target:'browser',plugins:[{name:'comparison-observer',setup(build){build.onLoad({filter:/collections\\.ts$/},async({path})=>{let contents=await readFile(path,'utf8');const before='const compared = compare(source[left]!, source[right]!);';if(contents.split(before).length!==2)throw new Error('comparison observer anchor');return {contents:contents.replace(before,'(globalThis as any).__stdlibComparisons++; '+before),loader:'ts'};});build.onLoad({filter:/primitive-props\\.ts$/},async({path})=>{let contents=await readFile(path,'utf8');const before='const compValue = await opts.call(comp, [l, r]);';if(contents.split(before).length!==2)throw new Error('legacy comparison observer anchor');return {contents:contents.replace(before,'(globalThis as any).__stdlibComparisons++; '+before),loader:'ts'};});}}]});if(!result.success)throw new Error(result.logs.join('\\n'));`);
	const build = spawnSync(process.env.BUN ?? 'bun', [builder], { cwd: root, encoding: 'utf8' });
	if (build.status !== 0) throw new Error(build.stdout+build.stderr);
	const bundle = await readFile(join(directory, 'entry.js'), 'utf8');
	server = createServer((request,response) => { response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html'); response.end(request.url === '/bundle.js' ? bundle : '<!doctype html><meta charset="utf-8"><title>標準ライブラリ計測</title><body tabindex="0">標準ライブラリ計測<script src="/bundle.js"></script>'); });
	await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
	const url = `http://127.0.0.1:${server.address().port}`;
	for (let processIndex = 0; processIndex < config.processes; processIndex++) {
		let browser, page, cdp, alive = true;
		try {
			browser = await chromium.launch({ headless: false, args: ['--js-flags=--max-old-space-size=1024 --expose-gc','--disable-background-timer-throttling','--disable-renderer-backgrounding'] });
			page = await browser.newPage(); await page.goto(url); await page.bringToFront(); await page.locator('body').focus();
			cdp = await page.context().newCDPSession(page);
			report.random.push({ processIndex, browser: browser.version(), results: await page.evaluate(() => globalThis.stdlibRandom()) });
		} catch (error) { alive = false; report.startupFailures.push({ processIndex, error: String(error) }); }
		async function observe(action) {
			let inflight = false, requests = 0, maximumRtt = 0, stopped = false, pending = Promise.resolve();
			const timer = setInterval(() => {
				if (inflight || stopped) return;
				inflight = true; requests++; const began = performance.now();
				pending = (async () => { try { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', timestamp: Date.now()/1000 }); maximumRtt = Math.max(maximumRtt,performance.now()-began); await cdp.send('Input.dispatchKeyEvent', { type:'keyUp',key:'a',code:'KeyA' }); } catch {} finally { inflight = false; } })();
			}, 25);
			let timeout;
			try { const value = await Promise.race([action(), new Promise((_,reject) => { timeout = setTimeout(() => reject(new Error('Browser trial wall timeout')),config.timeoutMs); })]); stopped = true; clearInterval(timer); await pending; return {...value,inputRequests:requests,inputRoundTripMaxMs:maximumRtt}; }
			finally { stopped = true; clearInterval(timer); clearTimeout(timeout); }
		}
		if (alive) try { report.idle.push({ processIndex,...await observe(() => page.evaluate(ms => globalThis.stdlibIdle(ms),config.idleMs)) }); } catch (error) { report.idle.push({processIndex,error:String(error)}); }
		const schedule = [];
		for (const descriptor of selected) for (const limit of config.limits) for (let run = 0; run < config.warmup+config.repeats; run++) {
			const versions = (run+processIndex)%2 ? [...config.versions].reverse() : config.versions;
			for (const version of versions) schedule.push({ processIndex,descriptor,version,limit,run,phase:run<config.warmup?'warmup':'measure' });
		}
		try {
			for (const trial of schedule) {
				let result;
				if (!alive) result = { error: 'Browser unavailable after launch failure or timeout', correctness: false, gate16ms: false };
				else try { await page.evaluate(() => globalThis.gc?.()); result = await observe(() => page.evaluate(input => globalThis.stdlibTrial(input), { ...trial,config })); }
				catch (error) { result = { error:String(error),correctness:false,gate16ms:false }; alive = false; await browser?.close().catch(()=>{}); }
				report.trials.push({ ...trial,...result });
				process.stderr.write(JSON.stringify({processIndex,case:trial.descriptor.name,version:trial.version,limit:trial.limit,phase:trial.phase,run:trial.run,elapsedMs:result.elapsedMs,maxSynchronousMs:result.maxSynchronousMs,correctness:result.correctness,error:result.error})+'\n');
			}
		} finally { await browser?.close().catch(()=>{}); }
	}
} catch (error) { report.startupFailures.push({ processIndex:null,error:String(error) }); process.exitCode = 1; }
finally {
	await new Promise(resolve => server ? server.close(resolve) : resolve());
	// 起動やビルドに失敗しても、予定した試行を失敗として分母に残します。
	const recorded = new Set(report.trials.map(row => [row.processIndex,row.descriptor.name,row.limit,row.version,row.run].join('/')));
	for (let processIndex=0;processIndex<config.processes;processIndex++) for (const descriptor of selected) for (const limit of config.limits) for (const version of config.versions) for(let run=0;run<config.warmup+config.repeats;run++) {
		const key=[processIndex,descriptor.name,limit,version,run].join('/');
		if(!recorded.has(key)) report.trials.push({processIndex,descriptor,limit,version,run,phase:run<config.warmup?'warmup':'measure',error:'Trial unavailable because setup failed',correctness:false,gate16ms:false});
	}
	const measured = report.trials.filter(row => row.phase === 'measure');
	const groups = new Map();
	for (const row of measured) { const key = `${row.version}/${row.limit}/${row.descriptor.name}`; if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(row); }
	report.summary = [...groups].map(([name,rows]) => { const times=rows.filter(r=>r.correctness).map(r=>r.elapsedMs).sort((a,b)=>a-b);return {name,attempts:rows.length,successful:times.length,failed:rows.length-times.length,gate16msPassed:rows.filter(r=>r.gate16ms&&r.foreground).length,medianMs:times.length?times[Math.floor(times.length/2)]:null,p95Ms:times.length?times[Math.ceil(times.length*0.95)-1]:null,maxMs:times.at(-1)??null,maxSynchronousMs:rows.reduce((max,r)=>Math.max(max,r.maxSynchronousMs??0),0)}; });
	report.expectedMeasuredTrials = config.processes*config.repeats*selected.length*config.versions.length*config.limits.length;
	report.recordedMeasuredTrials = measured.length;
	const complete = measured.length === report.expectedMeasuredTrials;
	report.passed = complete && report.startupFailures.length===0 && report.random.length===config.processes && report.random.every(r=>r.results.length===9&&r.results.every(x=>x.passed)) && measured.every(r=>r.correctness&&r.foreground&&(r.version!=='v2'||r.gate16ms));
	if (!report.passed) process.exitCode = 1;
	const json = JSON.stringify(report,null,2)+'\n';
	if (arguments_.has('output')) await writeFile(resolve(arguments_.get('output')),json);
	process.stdout.write(json);
	await rm(directory,{recursive:true,force:true});
}
