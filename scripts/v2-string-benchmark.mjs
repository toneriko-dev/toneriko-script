import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Interpreter } from '../built/v2/interpreter.js';
import { parse } from '../built/v2/parser/index.js';
import { defaultYieldToHost } from '../built/interpreter/host-yield.js';

const sizes = [20_000, 100_000];
const units = ['a', 'あ', '👍🏽'];
const repeats = 5;
const memoryLimitBytes = 4 * 1024 ** 3;
if (process.argv[2] === '--worker') {
	const size = Number(process.argv[3]);
	assert.ok(sizes.includes(size));
	const unit = process.argv[4];
	assert.ok(units.includes(unit));
	const source = `let s = ""; while (s.length < ${size}) { s += ${JSON.stringify(unit)}; } out(s.length);`;
	const program = parse(source).program;
	const output = [];
	const rssBeforeBytes = process.memoryUsage().rss;
	let sampledRssPeakBytes = rssBeforeBytes;
	let yields = 0;
	const started = performance.now();
	const interpreter = new Interpreter({ out: value => { output.push(value); } }, {
		yieldInterval: 8,
		yieldToHost: async () => {
			yields++;
			sampledRssPeakBytes = Math.max(sampledRssPeakBytes, process.memoryUsage().rss);
			await defaultYieldToHost();
		},
	});
	await interpreter.exec(program);
	const executionMs = performance.now() - started;
	const rssAfterBytes = process.memoryUsage().rss;
	// 最後の長さだけでなく、ホストから読んだ文字列の全内容も確かめます。
	assert.deepEqual(output, [size]);
	assert.equal(interpreter.getGlobal('s'), unit.repeat(size));
	const maxRssKiB = process.resourceUsage().maxRSS;
	assert.ok(maxRssKiB * 1024 < memoryLimitBytes, 'RSS が 4 GiB を超えました');
	console.log(JSON.stringify({ unit, size, executionMs, steps: interpreter.stepCount, yields,
		rssBeforeBytes, rssAfterBytes, rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
		sampledRssPeakBytes: Math.max(sampledRssPeakBytes, rssAfterBytes), maxRssKiB,
		output, fullStringMatched: true }));
} else {
	const report = {
		runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
		warmup: 0, independentProcessesPerCase: repeats, excluded: 0, yieldIntervalMs: 8,
		memoryLimitBytes, records: [], failures: [],
	};
	// 大きさを交互に実行し、全試行を新しいプロセスにします。
	for (let iteration = 0; iteration < repeats; iteration++) for (const unit of iteration % 2 ? [...units].reverse() : units) for (const size of iteration % 2 ? [...sizes].reverse() : sizes) {
		const child = spawnSync(process.execPath, [...(process.versions.bun ? [] : ['--max-old-space-size=1024']), fileURLToPath(import.meta.url), '--worker', String(size), unit], {
			encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
		});
		if (child.status !== 0) {
			report.failures.push({ unit, size, iteration, status: child.status, signal: child.signal, error: String(child.error ?? ''), stderr: child.stderr });
			process.exitCode = 1;
		} else report.records.push({ iteration, ...JSON.parse(child.stdout) });
	}
	const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
	report.summary = units.flatMap(unit => sizes.map(size => {
		const rows = report.records.filter(row => row.unit === unit && row.size === size);
		return { unit, size, successes: rows.length, failures: report.failures.filter(row => row.unit === unit && row.size === size).length,
			p50Ms: rows.length ? quantile(rows.map(row => row.executionMs), 0.5) : null,
			p95Ms: rows.length ? quantile(rows.map(row => row.executionMs), 0.95) : null,
			steps: [...new Set(rows.map(row => row.steps))],
			rssDeltaP50Bytes: rows.length ? quantile(rows.map(row => row.rssDeltaBytes), 0.5) : null,
			maxRssKiB: rows.length ? Math.max(...rows.map(row => row.maxRssKiB)) : null };
	}));
	console.log(JSON.stringify(report, null, 2));
}
