import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Parser, Interpreter as Legacy } from '../built/index.js';
import { NUM, STR, ARR, OBJ, FN_NATIVE, NULL } from '../built/interpreter/value.js';
import { Interpreter } from '../built/v2/interpreter.js';
import { parse } from '../built/v2/parser/index.js';
import { defaultYieldToHost } from '../built/interpreter/host-yield.js';

// 各試行は同じ種から入力を作り直し、検証の時間を実行の時間に含めません。
const config = {
	processes: Number(process.env.ROUNDS ?? 3), trials: Number(process.env.TRIALS ?? 5), warmups: Number(process.env.WARMUP ?? 2),
	size: process.env.SIZE === undefined ? null : Number(process.env.SIZE), timeoutMs: Number(process.env.TIMEOUT_MS ?? 600000),
	relaxedBusyMs: Number(process.env.RELAXED_BUSY_MS ?? 300000),
};
for (const [key, value] of Object.entries(config)) if (value !== null) assert.ok(Number.isSafeInteger(value) && value >= (key === 'warmups' ? 0 : 1), `Invalid ${key}`);
const workloads = [
	...['sort', 'sortBy'].flatMap(operation => ['random', 'sorted', 'reverse', 'duplicates'].map(order => ({ name: `${operation}-${order}`, operation, order, size: 1000000 }))),
	{ name: 'map', operation: 'map', size: 100000 },
	...['ascii', 'unicode'].flatMap(alphabet => ['cold', 'warm'].flatMap(cache => [1, 2, 4].map(scale => ({ name: `indexOf-${alphabet}-${cache}-${scale}x`, operation: 'indexOf', alphabet, cache, scale, size: 100000 * scale })))),
];
const selected = process.env.CASES ? workloads.filter(item => process.env.CASES.split(',').some(pattern => item.name === pattern || item.name.startsWith(`${pattern}-`))) : workloads;
assert.ok(selected.length, 'No selected workloads');
function inputFor(workload) {
	const size = config.size === null ? workload.size : config.size * (workload.scale ?? 1);
	if (workload.operation === 'indexOf') {
		const letter = workload.alphabet === 'ascii' ? 'a' : 'あ';
		return { size, text: letter.repeat(size) + 'b', needle: letter.repeat(Math.min(4096, Math.max(1, Math.floor(size / 2)))) + 'c', expected: -1 };
	}
	let state = 0x12345678;
	const values = Array.from({ length: size }, (_, i) => {
		state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
		return workload.order === 'sorted' ? i : workload.order === 'reverse' ? size - i : workload.order === 'duplicates' ? (state >>> 0) % 16 : (state >>> 0) % Math.max(1, size);
	});
	const input = workload.operation === 'sortBy' ? values.map((key, index) => ({ key, index })) : values;
	const expected = workload.operation === 'map' ? values.map(value => value + 1) : workload.operation === 'sortBy' ? [...input].sort((a, b) => a.key - b.key) : [...values].sort((a, b) => a - b);
	return { size, input, expected };
}
function sources(workload) {
	if (workload.operation === 'sort') return { v1: 'mark()\n<: input.sort(@(a,b){ count()\na-b })', v2: 'mark();out(input.sort((a,b)=>{count();return a-b;}));' };
	if (workload.operation === 'sortBy') return { v1: 'mark()\n<: input.map(@(x){keyCount()\n[x.key,x]}).sort(@(a,b){count()\na[0]-b[0]}).map(@(x){x[1]})', v2: 'mark();out(input.sortBy(v=>{keyCount();return v.key;}));' };
	if (workload.operation === 'map') return { v1: 'mark()\n<: input.map(@(v){ count()\nv+1 })', v2: 'mark();out(input.map(v=>{count();return v+1;}));' };
	return { v1: `${workload.cache === 'warm' ? 'text.index_of(needle)\n' : ''}mark()\n<: text.index_of(needle)`, v2: `${workload.cache === 'warm' ? 'text.indexOf(needle);' : ''}mark();out(text.indexOf(needle));` };
}
function legacyValue(value) {
	if (typeof value === 'number') return NUM(value);
	if (typeof value === 'string') return STR(value);
	if (Array.isArray(value)) return ARR(value.map(legacyValue));
	return OBJ(new Map(Object.entries(value).map(([key, child]) => [key, legacyValue(child)])));
}
function plain(value) {
	if (value.type === 'arr') return value.value.map(plain);
	if (value.type === 'obj') return Object.fromEntries([...value.value].map(([key, child]) => [key, plain(child)]));
	return value.value ?? null;
}
async function run(workload, version, mode, iteration, warmup) {
	const row = { workload: workload.name, version, mode, iteration, warmup, status: 'failed', outputVerified: false, excluded: false };
	const setupStarted = performance.now(); let vm; let timer; let started; let operationStarted;
	let yields = 0; let calls = 0; let keyCalls = 0; let timerDelayMs = 0;
	let peakRss = process.memoryUsage().rss;
	try {
		const input = inputFor(workload); row.size = input.size;
		const outputs = [];
		const mark = () => { operationStarted = performance.now(); };
		const count = () => { calls++; };
		const keyCount = () => { keyCalls++; };
		const globals = workload.operation === 'indexOf' ? { text: input.text, needle: input.needle } : { input: input.input };
		const yieldToHost = async () => { yields++; peakRss = Math.max(peakRss, process.memoryUsage().rss); await defaultYieldToHost(); };
		const options = { yieldInterval: 8, yieldToHost, maxBusyTime: mode === 'default' ? 5000 : config.relaxedBusyMs };
		vm = version === 'v2' ? new Interpreter({ ...globals, mark, count, keyCount, out: value => { outputs.push(value); } }, options)
			: new Legacy({ ...Object.fromEntries(Object.entries(globals).map(([key, value]) => [key, legacyValue(value)])), mark: FN_NATIVE(() => { mark(); return NULL; }), count: FN_NATIVE(() => { count(); return NULL; }), keyCount: FN_NATIVE(() => { keyCount(); return NULL; }) }, { ...options, out: value => { outputs.push(value); }, err: error => { throw error; } });
		row.setupMs = performance.now() - setupStarted;
		const parseStarted = performance.now();
		const source = sources(workload)[version];
		const ast = version === 'v2' ? parse(source).program : Parser.parse(source);
		row.parseMs = performance.now() - parseStarted;
		row.rssBeforeBytes = process.memoryUsage().rss;
		let lastTimer = performance.now();
		timer = setInterval(() => { const now = performance.now(); timerDelayMs = Math.max(timerDelayMs, now - lastTimer - 1); lastTimer = now; peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 1);
		started = performance.now();
		await vm.exec(ast);
		row.executionMs = performance.now() - started;
		row.operationMs = operationStarted === undefined ? null : performance.now() - operationStarted;
		row.preparationWithinExecMs = operationStarted === undefined ? null : operationStarted - started;
		row.includingParseMs = row.executionMs + row.parseMs;
		await defaultYieldToHost();
		const verifyStarted = performance.now();
		assert.equal(outputs.length, 1, 'Output count');
		const actual = version === 'v1' ? plain(outputs[0]) : outputs[0];
		assert.deepEqual(actual, input.expected, 'Output values, order, count and stable ties');
		if (version === 'v2' && (workload.operation === 'sort' || workload.operation === 'sortBy')) assert.equal(outputs[0], input.input, 'In-place identity');
		if (version === 'v2' && workload.operation === 'sortBy') assert.equal(keyCalls, input.size, 'One key call per item');
		row.verificationMs = performance.now() - verifyStarted;
		row.outputCount = Array.isArray(actual) ? actual.length : 1;
		row.outputVerified = true; row.status = 'passed';
	} catch (error) {
		row.error = { name: error?.name ?? typeof error, code: error?.code ?? null, message: String(error?.message ?? error) };
		row.failureStage = started === undefined ? 'setup-or-parse' : row.executionMs === undefined ? 'execution' : 'verification';
		if (started !== undefined && row.executionMs === undefined) row.executionMs = performance.now() - started;
	} finally {
		clearInterval(timer); vm?.abort();
		row.steps = vm?.stepCount ?? null; row.yields = yields; row.comparisonCalls = workload.operation === 'sort' || (workload.operation === 'sortBy' && version === 'v1') ? calls : null;
		row.callbackCalls = workload.operation === 'map' ? calls : null; row.keyCalls = keyCalls;
		row.maxTimerDelayMs = timerDelayMs; row.rssAfterBytes = process.memoryUsage().rss; row.sampledRssPeakBytes = Math.max(peakRss, row.rssAfterBytes); row.maxRssKiB = process.resourceUsage().maxRSS;
	}
	return row;
}
function quantile(values, p) { if (!values.length) return null; const xs = [...values].sort((a, b) => a - b); return xs[Math.ceil(xs.length * p) - 1]; }
if (process.argv[2] === '--worker') {
	const workload = workloads.find(item => item.name === process.argv[3]); assert.ok(workload);
	const mode = process.argv[4], round = Number(process.argv[5]);
	for (let i = -config.warmups; i < config.trials; i++) {
		for (const version of (i + round) % 2 === 0 ? ['v1', 'v2'] : ['v2', 'v1']) {
			const row = await run(workload, version, mode, i, i < 0);
			process.stdout.write(JSON.stringify({ ...row, processRound: round }) + '\n');
		}
	}
} else {
	const records = []; const failures = [];
	for (const workload of selected) for (const mode of ['default', 'relaxed']) for (let round = 0; round < config.processes; round++) {
		const launched = performance.now();
		const child = spawnSync(process.execPath, ['--max-old-space-size=2048', fileURLToPath(import.meta.url), '--worker', workload.name, mode, String(round)], { encoding: 'utf8', timeout: config.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
		process.stderr.write(`${workload.name} ${mode} process ${round + 1}/${config.processes}: exit ${child.status}, ${Math.round(performance.now() - launched)}ms\n`);
		const received = [];
		for (const line of (child.stdout ?? '').trim().split('\n').filter(Boolean)) {
			try { const row = JSON.parse(line); if (!['passed', 'failed'].includes(row.status)) throw new Error('Invalid record'); received.push(row); } catch (error) { failures.push({ workload: workload.name, mode, round, kind: 'invalid-worker-output', text: line, error: String(error) }); }
		}
		records.push(...received);
		// プロセスが落ちても、未出力の試行を失敗として同じ分母に残します。
		for (let iteration = -config.warmups; iteration < config.trials; iteration++) for (const version of ['v1', 'v2']) if (!received.some(row => row.version === version && row.iteration === iteration)) records.push({ workload: workload.name, mode, processRound: round, iteration, version, warmup: iteration < 0, status: 'failed', outputVerified: false, excluded: false, failureStage: 'worker', error: { message: String(child.error ?? child.stderr ?? `exit ${child.status}`) } });
		failures.push(...(child.status !== 0 ? [{ workload: workload.name, mode, round, kind: 'worker-exit', status: child.status, signal: child.signal, stderr: child.stderr, elapsedMs: performance.now() - launched }] : []));
	}
	const summaries = [];
	for (const workload of selected) for (const mode of ['default', 'relaxed']) for (const version of ['v1', 'v2']) {
		const rows = records.filter(row => row.workload === workload.name && row.mode === mode && row.version === version && !row.warmup);
		const valid = rows.filter(row => row.status === 'passed' && row.outputVerified);
		summaries.push({ workload: workload.name, mode, version, planned: config.processes * config.trials, recorded: rows.length, passed: valid.length, failed: rows.length - valid.length, excluded: 0,
			executionMedianMs: quantile(valid.map(row => row.executionMs), 0.5), executionP95Ms: quantile(valid.map(row => row.executionMs), 0.95), executionMaxMs: valid.length ? Math.max(...valid.map(row => row.executionMs)) : null,
			operationMedianMs: quantile(valid.map(row => row.operationMs), 0.5), parseMedianMs: quantile(valid.map(row => row.parseMs), 0.5), maxTimerDelayMs: valid.length ? Math.max(...valid.map(row => row.maxTimerDelayMs)) : null });
	}
	console.log(JSON.stringify({ runtime: process.versions, platform: process.platform, architecture: process.arch, config, excluded: 0, yieldIntervalMs: 8, defaultBusyMs: 5000, sources: selected.map(item => ({ name: item.name, ...sources(item) })),
		measured: ['parseMs', 'executionMs', 'operationMs', 'preparationWithinExecMs', 'steps', 'yields', 'comparisonCalls', 'callbackCalls', 'keyCalls', 'outputVerified', 'outputCount', 'rssBeforeBytes', 'rssAfterBytes', 'sampledRssPeakBytes', 'maxRssKiB', 'maxTimerDelayMs'],
		notMeasured: ['Browser frame duration', 'Exact GC pause attribution', 'Internal sortBy key comparisons', 'Grapheme-cache segmentation count'], summaries, failures, records }, null, 2));
}
