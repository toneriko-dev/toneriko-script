import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Parser, Interpreter as Legacy } from '../built/index.js';
import { Interpreter } from '../built/v2/interpreter.js';
import { parse } from '../built/v2/parser/index.js';
import { defaultYieldToHost } from '../built/interpreter/host-yield.js';

const workloads = [
	{ name: 'loop40000', expected: 40000,
		legacy: 'var s = 0\nfor (let i, 40000) { s += 1 }\n<: s',
		v2: 'let s = 0; for (let i = 0; i < 40000; i++) { s += 1; } out(s);' },
	{ name: 'fib20', expected: 6765,
		legacy: '@fib(n) {\nif (n <= 1) { return n }\nreturn fib(n - 1) + fib(n - 2)\n}\n<: fib(20)',
		v2: 'function fib(n) { if (n <= 1) return n; return fib(n - 1) + fib(n - 2); } out(fib(20));' },
];
function quantile(values, q) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * q) - 1];
}
async function run(workload, version) {
	const output = [];
	const rssBeforeBytes = process.memoryUsage().rss;
	let sampledRssPeakBytes = rssBeforeBytes;
	let yields = 0;
	let maxTimerDelayMs = 0;
	let lastTimer = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		maxTimerDelayMs = Math.max(maxTimerDelayMs, now - lastTimer - 1);
		lastTimer = now;
	}, 1);
	const parseStarted = performance.now();
	const ast = version === 'v1' ? Parser.parse(workload.legacy) : parse(workload.v2).program;
	const parseMs = performance.now() - parseStarted;
	const yieldToHost = async () => {
		yields++;
		sampledRssPeakBytes = Math.max(sampledRssPeakBytes, process.memoryUsage().rss);
		await defaultYieldToHost();
	};
	const started = performance.now();
	const interpreter = version === 'v1'
		? new Legacy({}, { out: value => { assert.equal(value.type, 'num'); output.push(value.value); }, yieldInterval: 8, yieldToHost })
		: new Interpreter({ out: value => { output.push(value); } }, { yieldInterval: 8, yieldToHost });
	try {
		await interpreter.exec(ast);
		const executionMs = performance.now() - started;
		// 出力の一致は速度の集計とは別に確認し、失敗した試行を捨てません。
		assert.deepEqual(output, [workload.expected], `${workload.name} ${version}`);
		await defaultYieldToHost();
		const rssAfterBytes = process.memoryUsage().rss;
		return { executionMs, includingParseMs: executionMs + parseMs, steps: interpreter.stepCount, yields, maxTimerDelayMs,
			rssBeforeBytes, rssAfterBytes, rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
			sampledRssPeakBytes: Math.max(sampledRssPeakBytes, rssAfterBytes), maxRssKiB: process.resourceUsage().maxRSS };
	} finally { clearInterval(timer); }
}
if (process.argv[2] === '--rss-worker') {
	const workload = workloads.find(item => item.name === process.argv[3]);
	assert.ok(workload, '未知の測定課題です');
	assert.ok(['v1', 'v2'].includes(process.argv[4]), '未知の版です');
	const result = await run(workload, process.argv[4]);
	assert.ok(result.maxRssKiB * 1024 < 4 * 1024 ** 3, 'RSS が 4 GiB を超えました');
	console.log(JSON.stringify({ workload: workload.name, version: process.argv[4], warmup: 0, runs: 1, excluded: 0, expectedOutput: [workload.expected], ...result }));
	process.exit(0);
}
const report = {
	runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
	warmup: 10, pairs: 30, excluded: 0, yieldIntervalMs: 8,
	memoryLimitBytes: 4 * 1024 ** 3,
	workloads: [],
};
for (const workload of workloads) {
	for (let i = 0; i < report.warmup; i++) {
		await run(workload, 'v1');
		await run(workload, 'v2');
	}
	const records = { v1: [], v2: [] };
	for (let i = 0; i < report.pairs; i++) {
		for (const version of i % 2 === 0 ? ['v1', 'v2'] : ['v2', 'v1']) records[version].push(await run(workload, version));
	}
	const summarize = rows => ({
		p50Ms: quantile(rows.map(row => row.executionMs), 0.5),
		p95Ms: quantile(rows.map(row => row.executionMs), 0.95),
		includingParseP50Ms: quantile(rows.map(row => row.includingParseMs), 0.5),
		includingParseP95Ms: quantile(rows.map(row => row.includingParseMs), 0.95),
		steps: [...new Set(rows.map(row => row.steps))],
		yields: rows.map(row => row.yields),
		maxTimerDelayMs: Math.max(...rows.map(row => row.maxTimerDelayMs)),
		rssDeltaP50Bytes: quantile(rows.map(row => row.rssDeltaBytes), 0.5),
		rssDeltaP95Bytes: quantile(rows.map(row => row.rssDeltaBytes), 0.95),
		sampledRssPeakBytes: Math.max(...rows.map(row => row.sampledRssPeakBytes)),
	});
	report.workloads.push({ name: workload.name, expectedOutput: [workload.expected], v1: summarize(records.v1), v2: summarize(records.v2), records });
}
// 約 10 万ステップの処理を、同じ出力を保つ v2 の数え方に対応づけます。
report.stepCalibration = [];
for (const workload of [
	{ name: 'loop33330', expected: 33330,
		legacy: workloads[0].legacy.replaceAll('40000', '33330'),
		v2: workloads[0].v2.replaceAll('40000', '33330') },
	{ name: 'fib18', expected: 2584,
		legacy: workloads[1].legacy.replace('fib(20)', 'fib(18)'),
		v2: workloads[1].v2.replace('fib(20)', 'fib(18)') },
]) {
	const v1 = await run(workload, 'v1');
	const v2 = await run(workload, 'v2');
	report.stepCalibration.push({ name: workload.name, expectedOutput: [workload.expected], runs: 1, v1Steps: v1.steps, v2Steps: v2.steps });
}
// 単独プロセスの RSS も残し、他方の版の割り当てや GC の影響と区別します。
report.rssColdRuns = [];
for (const workload of workloads) for (const version of ['v1', 'v2']) {
	const child = spawnSync(process.execPath, [...(process.versions.bun ? [] : ['--max-old-space-size=1024']), fileURLToPath(import.meta.url), '--rss-worker', workload.name, version], {
		encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
	});
	assert.equal(child.status, 0, `${workload.name} ${version}: ${child.error ?? child.stderr}`);
	report.rssColdRuns.push(JSON.parse(child.stdout));
}
report.memory = process.memoryUsage();
report.maxRssKiB = process.resourceUsage().maxRSS;
assert.ok(report.maxRssKiB * 1024 < report.memoryLimitBytes, '計測プロセスの RSS が 4 GiB を超えました');
console.log(JSON.stringify(report, null, 2));
