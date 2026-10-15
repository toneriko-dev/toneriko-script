import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, mkdir, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=')]; }));
const integer = (key, fallback) => { const value = Number(args.get(key) ?? fallback); if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid --${key}`); return value; };
const config = { built: args.has('built') ? resolve(args.get('built')) : null, sizes: (args.get('sizes') ?? '100000,1000000').split(',').map(Number), warmup: integer('warmup', 2), repeats: integer('repeats', 5), heapMiB: integer('heap-mib', 1024), cpuProfile: args.get('cpu-profile') !== 'false', timeoutMs: integer('timeout-ms', 180000), outputDirectory: resolve(args.get('output-dir') ?? '.git/v2-sort-trace') };
if (!config.repeats || !config.sizes.every(n => Number.isSafeInteger(n) && n > 0) || config.heapMiB > 1536) throw new Error('Invalid measurement configuration');
const require = createRequire(resolve(process.env.PLAYWRIGHT_PACKAGE_JSON ?? join(root, 'package.json')));
const { chromium } = require('playwright');
await mkdir(config.outputDirectory, { recursive: true });
const temporary = await mkdtemp(join(root, '.git', 'sort-trace-bundle-'));
const report = { config, limitations: ['Non-GC wall time includes OS descheduling; a trace without scheduler events cannot identify it as interpreter CPU time.', 'Tracing and UserTiming marks add overhead; use the separate Node benchmark for throughput.', 'Renderer heap is capped, but the parent must monitor total process-tree RSS against 3 GB (3,000,000,000 bytes).', 'GC times are unions of main-thread GC intervals; nested GC events are not counted twice.', 'Thread CPU is reported only when both UserTiming boundaries carry tts. Missing tts remains unknown. Wall-minus-thread-CPU is non-running time, not proof of a particular scheduler cause.', 'CPU profiles sample stacks every 1 ms. Sample counts support attribution but cannot establish exact CPU durations or identify OS descheduling.'], trials: [], failures: [] };

function browserMain() {
	globalThis.traceSort = async ({ size, prefix }) => {
		let seed = 123456789;
		const input = Array.from({ length: size }, () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) % size; });
		const expected = [...input].sort((a,b) => a-b);
		let segment = 0, active = false, result, started, ended;
		const intervals = [];
		const mark = suffix => { const name = `${prefix}:${suffix}`; performance.mark(name); return performance.now(); };
		let segmentStart;
		const openSegment = () => { segmentStart = mark(`sync:${segment}:start`); };
		const closeSegment = () => { const end = mark(`sync:${segment}:end`); intervals.push({ index: segment, start: segmentStart, end }); segment++; };
		const vm = new Interpreter({ items: input, start: () => { active = true; started = mark('start'); openSegment(); }, emit: value => { result = value; } }, {
			maxBusyTime: Infinity,
			yieldToHost: async () => { if (active) closeSegment(); await defaultYieldToHost(); if (active) openSegment(); },
		});
		let error = null;
		try { await vm.exec(parse('start(); emit(items.sort((a,b)=>a-b));').program); }
		catch (caught) { error = { name: caught.name, message: caught.message, code: caught.code }; }
		if (active) { closeSegment(); ended = mark('end'); active = false; }
		const correctness = !error && Array.isArray(result) && result.length === expected.length && result.every((value, i) => value === expected[i]);
		return { elapsedMs: ended-started, intervals, maxSynchronousMs: Math.max(0,...intervals.map(x => x.end-x.start)), correctness, error, foreground: document.visibilityState === 'visible' && document.hasFocus(), steps: vm.stepCount };
	};
}

function unionLength(intervals, start, end) {
	const parts = intervals.filter(x => x.end > start && x.start < end).map(x => [Math.max(start,x.start), Math.min(end,x.end)]).sort((a,b) => a[0]-b[0]);
	let total = 0, until = start;
	for (const [left,right] of parts) { if (right > until) total += right-Math.max(until,left); until = Math.max(until,right); }
	return total;
}
function completeEvents(events) {
	const result = [], stacks = new Map();
	for (const event of [...events].sort((a,b) => a.ts-b.ts)) {
		if (event.ph === 'X' && event.dur >= 0) result.push({ ...event, start: event.ts/1000, end: (event.ts+event.dur)/1000 });
		if (event.ph === 'B') { const key = `${event.pid}/${event.tid}`; if (!stacks.has(key)) stacks.set(key,[]); stacks.get(key).push(event); }
		if (event.ph === 'E') { const begin = stacks.get(`${event.pid}/${event.tid}`)?.pop(); if (begin) result.push({ ...begin, start: begin.ts/1000, end: event.ts/1000 }); }
	}
	return result;
}
function profileSamples(profile) {
	if (!profile) return [];
	const nodes = new Map(profile.nodes.map(node => [node.id,node]));
	let timestamp = profile.startTime;
	return profile.samples.map((id,index) => { timestamp += profile.timeDeltas[index]; const frame = nodes.get(id)?.callFrame; return { timestamp:timestamp/1000, functionName:frame?.functionName ?? '(unknown)', url:frame?.url ?? '', lineNumber:frame?.lineNumber ?? -1 }; });
}
function sampleSummary(samples, start, end) {
	const selected = samples.filter(sample => sample.timestamp >= start && sample.timestamp < end);
	const counts = new Map();
	for (const sample of selected) { const key = `${sample.functionName} @ ${sample.url}:${sample.lineNumber+1}`; counts.set(key,(counts.get(key) ?? 0)+1); }
	return { samples:selected.length, gcSamples:selected.filter(x=>x.functionName === '(garbage collector)').length, idleSamples:selected.filter(x=>x.functionName === '(idle)').length, topFunctions:[...counts].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([frame,count])=>({frame,count})) };
}
function analyze(events, prefix, browserResult, profile) {
	const marks = events.filter(e => e.name?.startsWith(`${prefix}:`) && e.cat?.includes('user_timing'));
	const byName = new Map(marks.map(e => [e.name,e]));
	const start = byName.get(`${prefix}:start`), end = byName.get(`${prefix}:end`);
	if (!start || !end) throw new Error('UserTiming boundary markers missing from trace');
	const complete = completeEvents(events.filter(e => e.pid === start.pid && e.tid === start.tid));
	const gc = complete.filter(e => /(^|[.:_])(GC|GCScavenger|GCCompactor)|MinorGC|MajorGC|Scavenge|MarkCompact/i.test(e.name) && !/Concurrent|Background/i.test(e.name));
	const samples = profileSamples(profile);
	const sync = browserResult.intervals.map(({ index }) => {
		const left = byName.get(`${prefix}:sync:${index}:start`), right = byName.get(`${prefix}:sync:${index}:end`);
		if (!left || !right) throw new Error(`Missing synchronous interval ${index}`);
		const begin = left.ts/1000, finish = right.ts/1000, durationMs = finish-begin;
		const gcMs = unionLength(gc,begin,finish), nonGcMs = durationMs-gcMs;
		const hasThreadClock = Number.isFinite(left.tts) && Number.isFinite(right.tts) && right.tts >= left.tts;
		const threadCpuMs = hasThreadClock ? (right.tts-left.tts)/1000 : null;
		const nonRunningMs = hasThreadClock ? Math.max(0,durationMs-threadCpuMs) : null;
		const classification = durationMs <= 16 ? 'within-16ms' : nonGcMs > 16 ? (gcMs > 0 ? 'non-gc-wall-and-gc-cause-unresolved' : 'non-gc-wall-cause-unresolved') : 'gc-wall-caused-threshold-crossing';
		return { index, traceStartMs: begin, durationMs, gcMs, nonGcMs, threadCpuMs, nonRunningMs, classification, cpuSamples:durationMs > 16 ? sampleSummary(samples,begin,finish) : undefined, gcEvents: [...new Set(gc.filter(e => e.end > begin && e.start < finish).map(e => e.name))] };
	});
	const over16 = sync.filter(x => x.durationMs > 16);
	const otherTasks = complete.filter(e => /(^|\.)RunTask$/.test(e.name) && e.end-e.start > 16 && e.end > start.ts/1000 && e.start < end.ts/1000).map(e => ({ traceStartMs:e.start, durationMs:e.end-e.start, gcMs:unionLength(gc,e.start,e.end), synchronousOverlapMs:unionLength(sync.map(x => ({ start:x.traceStartMs,end:x.traceStartMs+x.durationMs })),e.start,e.end) })).filter(e => e.durationMs-e.synchronousOverlapMs > 16);
	return { rendererPid:start.pid, rendererMainThread:start.tid, threadClockIntervals:sync.filter(x=>x.threadCpuMs!==null).length, profileClockOverlap:profile ? { profileStartMs:profile.startTime/1000, profileEndMs:profile.endTime/1000, traceStartMs:start.ts/1000, traceEndMs:end.ts/1000, boundariesEnclosed:profile.startTime<=start.ts&&profile.endTime>=end.ts } : null, cpuSamples:sampleSummary(samples,start.ts/1000,end.ts/1000), traceSyncCount:sync.length, browserSyncCount:browserResult.intervals.length, maxSynchronousMs:Math.max(0,...sync.map(x => x.durationMs)), maxNonGcMs:Math.max(0,...sync.map(x => x.nonGcMs)), totalGcMs:unionLength(gc,start.ts/1000,end.ts/1000), over16, otherTasks, classifications:Object.fromEntries([...new Set(over16.map(x => x.classification))].map(key => [key,over16.filter(x => x.classification === key).length])) };
}

let server, browser;
try {
	const entry = join(temporary,'entry.ts');
	const implementationRoot = config.built ?? join(root,'src');
	const extension = config.built ? 'js' : 'ts';
	await writeFile(entry, `import { Interpreter } from ${JSON.stringify(join(implementationRoot,`v2/interpreter.${extension}`))};\nimport { parse } from ${JSON.stringify(join(implementationRoot,`v2/parser/index.${extension}`))};\nimport { defaultYieldToHost } from ${JSON.stringify(join(implementationRoot,`interpreter/host-yield.${extension}`))};\n(${browserMain.toString()})();`);
	const built = spawnSync(process.env.BUN ?? 'bun', ['build',entry,'--target=browser',`--outdir=${temporary}`], { cwd:root,encoding:'utf8' });
	if (built.status !== 0) throw new Error(built.stdout+built.stderr);
	const bundle = await readFile(join(temporary,'entry.js'));
	server = createServer((request,response) => { response.setHeader('Content-Type',request.url === '/bundle.js' ? 'text/javascript' : 'text/html'); response.end(request.url === '/bundle.js' ? bundle : '<!doctype html><meta charset="utf-8"><title>sort trace</title><body tabindex="0"><script src="/bundle.js"></script>'); });
	await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
	browser = await chromium.launch({ headless:false,args:[`--js-flags=--max-old-space-size=${config.heapMiB} --expose-gc`,'--disable-background-timer-throttling','--disable-renderer-backgrounding'] });
	report.browser = browser.version();
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${server.address().port}`); await page.bringToFront(); await page.locator('body').focus();
	const cdp = await page.context().newCDPSession(page);
	for (const size of config.sizes) for (let run=0;run<config.warmup+config.repeats;run++) {
		const phase = run < config.warmup ? 'warmup' : 'measure', prefix = `sort-${size}-${run}`;
		await page.evaluate(() => { globalThis.gc?.(); performance.clearMarks(); });
		let tracePath = null, traceDone, cpuProfilePath = null, cpuProfile = null;
		if (phase === 'measure') {
			if (config.cpuProfile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval',{ interval:1000 }); await cdp.send('Profiler.start'); }
			traceDone = new Promise(resolve => cdp.once('Tracing.tracingComplete',resolve));
			await cdp.send('Tracing.start',{ categories:'v8,v8.gc,disabled-by-default-v8.gc,devtools.timeline,blink.user_timing,toplevel', transferMode:'ReturnAsStream', options:'record-as-much-as-possible' });
		}
		let timeout;
		const result = await Promise.race([page.evaluate(input => globalThis.traceSort(input),{size,prefix}),new Promise((_,reject) => { timeout = setTimeout(() => reject(new Error('Browser trial timeout')),config.timeoutMs); })]).finally(() => clearTimeout(timeout));
		let analysis = null;
		if (phase === 'measure') {
			if (config.cpuProfile) { ({ profile:cpuProfile } = await cdp.send('Profiler.stop')); cpuProfilePath = join(config.outputDirectory,`${prefix}.cpuprofile`); await writeFile(cpuProfilePath,JSON.stringify(cpuProfile)); }
			await cdp.send('Tracing.end');
			const { stream } = await traceDone;
			tracePath = join(config.outputDirectory,`${prefix}.trace.json`);
			const file = await open(tracePath,'w');
			try { for (;;) { const chunk = await cdp.send('IO.read',{handle:stream,size:1024*1024}); await file.write(chunk.base64Encoded ? Buffer.from(chunk.data,'base64') : chunk.data); if (chunk.eof) break; } }
			finally { await file.close(); await cdp.send('IO.close',{handle:stream}); }
			const raw = JSON.parse(await readFile(tracePath,'utf8'));
			analysis = analyze(raw.traceEvents ?? raw,prefix,result,cpuProfile);
		}
		const { intervals,...measurement } = result;
		const trial = {size,run,phase,...measurement,tracePath,cpuProfilePath,analysis};
		report.trials.push(trial);
		await writeFile(join(config.outputDirectory,'summary.json'),JSON.stringify(report,null,2)+'\n');
		process.stderr.write(JSON.stringify({size,run,phase,elapsedMs:result.elapsedMs,maxSynchronousMs:analysis?.maxSynchronousMs??result.maxSynchronousMs,over16:analysis?.over16.length,correctness:result.correctness})+'\n');
	}
} catch (error) { report.failures.push(String(error.stack ?? error)); process.exitCode=1; }
finally {
	await browser?.close().catch(()=>{});
	await new Promise(resolve => server ? server.close(resolve) : resolve());
	await rm(temporary,{recursive:true,force:true});
	const measured = report.trials.filter(x => x.phase === 'measure');
	report.summary = config.sizes.map(size => { const rows=measured.filter(x=>x.size===size),times=rows.filter(x=>x.correctness).map(x=>x.elapsedMs).sort((a,b)=>a-b);return {size,attempts:rows.length,planned:config.repeats,successful:times.length,medianMs:times.length?times[Math.floor(times.length/2)]:null,maxSynchronousMs:Math.max(0,...rows.map(x=>x.analysis?.maxSynchronousMs??0)),over16:rows.reduce((n,x)=>n+(x.analysis?.over16.length??0),0)}; });
	report.measurementValid = report.failures.length===0 && measured.length === config.repeats*config.sizes.length && measured.every(x=>x.correctness&&x.foreground&&x.analysis.traceSyncCount===x.analysis.browserSyncCount);
	if (!report.passed) process.exitCode=1;
	await writeFile(join(config.outputDirectory,'summary.json'),JSON.stringify(report,null,2)+'\n');
	process.stdout.write(JSON.stringify(report,null,2)+'\n');
}
