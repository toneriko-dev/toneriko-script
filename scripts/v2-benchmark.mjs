import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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
	const yieldToHost = async () => { yields++; await defaultYieldToHost(); };
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
		return { executionMs, includingParseMs: executionMs + parseMs, steps: interpreter.stepCount, yields, maxTimerDelayMs };
	} finally { clearInterval(timer); }
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
report.memory = process.memoryUsage();
report.maxRssKiB = process.resourceUsage().maxRSS;
assert.ok(report.maxRssKiB * 1024 < report.memoryLimitBytes, '計測プロセスの RSS が 4 GiB を超えました');
console.log(JSON.stringify(report, null, 2));
