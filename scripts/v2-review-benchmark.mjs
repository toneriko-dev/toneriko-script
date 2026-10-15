import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [beforePath, afterPath] = process.argv.slice(2);
assert.ok(beforePath && afterPath, 'before/after の bundle を指定します');
const versions = [
	{ label: 'before', ...await import(pathToFileURL(resolve(beforePath)).href) },
	{ label: 'after', ...await import(pathToFileURL(resolve(afterPath)).href) },
];
const warmup = 3, samples = 9;
const records = [];
const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const bundles = [beforePath, afterPath].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
const report = { runtime: process.versions, cpu: cpus()[0]?.model, bundles, warmup, samples, records, summaries: [], excluded: 0, ok: false };
const forms = ['declaration', 'assignment'];
const widths = [15000, 30000];
try {
	for (const form of forms) {
		const programs = new Map();
		for (const version of versions) for (const width of widths) {
			const names = Array.from({ length: width }, (_, i) => `a${i}`);
			const pattern = `{${names.map((name, i) => `${i}:${name}`).join(',')}}`;
			const values = `[${names.map(() => '1').join(',')}]`;
			const source = form === 'declaration' ? `let ${pattern}=${values};` : `let ${names.join(',')};(${pattern}=${values});`;
			programs.set(`${version.label}/${width}`, version.parse(source).program);
		}
		// parse は計測外とし、版と幅の順を交互にして同じ AST の check を比較します。
		for (let iteration = -warmup; iteration < samples; iteration++) {
			for (const version of (iteration % 2 ? versions : [...versions].reverse())) {
				for (const width of (iteration % 2 ? widths : [...widths].reverse())) {
					const started = performance.now();
					const diagnostics = version.check(programs.get(`${version.label}/${width}`));
					const ms = performance.now() - started;
					assert.deepEqual(diagnostics, []);
					records.push({ kind: 'check', form, version: version.label, width, iteration, ms, diagnostics });
				}
			}
		}
	}
	const cases = [
		{ name: 'array-rest-100k', size: 100000, source: 'let [...r]: number[] = h;' },
		{ name: 'argument-rest-100k', size: 100000, source: 'function f(...r: number[]) {} f(...h)' },
		{ name: 'array-rest-200k', size: 200000, source: 'let [...r]: number[] = h;' },
	];
	for (const entry of cases) {
		const programs = versions.map(version => version.parse(entry.source).program);
		for (let iteration = -warmup; iteration < samples; iteration++) for (const index of (iteration % 2 ? [0, 1] : [1, 0])) {
			const version = versions[index];
			const h = Array(entry.size).fill(1);
			const interpreter = new version.Interpreter({ h });
			const started = performance.now();
			let error;
			try { await interpreter.exec(programs[index]); } catch (failure) { error = failure.code ?? String(failure); }
			const ms = performance.now() - started;
			const expectedError = entry.size === 200000 && version.label === 'before' ? 'STEP_LIMIT_EXCEEDED' : undefined;
			assert.equal(error, expectedError);
			let result;
			if (!error && entry.name.startsWith('array-')) {
				const value = interpreter.getGlobal('r');
				assert.deepEqual(value, h);
				result = { length: value.length, first: value[0], last: value.at(-1) };
			}
			records.push({ kind: 'runtime', name: entry.name, version: version.label, iteration, ms, steps: interpreter.stepCount, error, result });
		}
	}
	for (const form of forms) for (const version of versions) for (const width of widths) {
		const rows = records.filter(row => row.kind === 'check' && row.form === form && row.version === version.label && row.width === width && row.iteration >= 0);
		report.summaries.push({ kind: 'check', form, version: version.label, width, count: rows.length, p50: percentile(rows.map(row => row.ms), .5), p95: percentile(rows.map(row => row.ms), .95) });
	}
	for (const entry of cases) for (const version of versions) {
		const rows = records.filter(row => row.kind === 'runtime' && row.name === entry.name && row.version === version.label && row.iteration >= 0);
		report.summaries.push({ kind: 'runtime', name: entry.name, version: version.label, count: rows.length, p50: percentile(rows.map(row => row.ms), .5), p95: percentile(rows.map(row => row.ms), .95), steps: [...new Set(rows.map(row => row.steps))], errors: [...new Set(rows.map(row => row.error ?? null))] });
	}
	// 時計の揺れを許しつつ、幅の倍増で約四倍になる二乗走査を拒否します。
	for (const form of forms) {
		const rows = report.summaries.filter(row => row.kind === 'check' && row.form === form && row.version === 'after');
		const ratio = rows[1].p50 / rows[0].p50;
		report.summaries.push({ kind: 'scaling', form, ratio, limit: 3.2 });
		assert.ok(ratio < 3.2, `${form}: 幅を倍にした時間比 ${ratio}`);
	}
	report.ok = true;
} catch (error) {
	report.error = { message: String(error), stack: error.stack };
	process.exitCode = 1;
} finally {
	console.log(JSON.stringify(report, null, 2));
}
