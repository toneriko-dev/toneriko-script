import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Bun で label=clone を指定します。入力と計測範囲は rv6/propperf.ts・parsebig.ts と同じです。
const programs = {
	objRead: ['let o = { a: 1 }; let s = 0; for (let i = 0; i < 100000; i++) { s += o.a; } out(s)', 100000],
	arrRead: ['let a = [1, 2, 3, 4]; let s = 0; for (let i = 0; i < 100000; i++) { s += a[i % 4]; } out(s)', 250000],
	arrForOf: ['let a = []; for (let i = 0; i < 100000; i++) a.push(i); let s = 0; for (const x of a) s += x; out(s)', 4999950000],
	objWrite: ['let o = { a: 1 }; for (let i = 0; i < 100000; i++) { o.a = i; } out(o.a)', 99999],
};
const big = Array.from({ length: 1500 }, (_, i) => `function f${i}(a: number, b: string = "x"): string { let r = []; for (const x of [a, a + 1, a * 2]) { if (x > 3 && b !== "" || x === 0) { r.push(\`\${b}:\${x}\`); } else { r.push(b + x); } } return r.length > 1 ? r[0] : b; }`).join('\n');
const failure = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack });

if (process.argv[2] === '--worker') {
	const root = resolve(process.argv[3]);
	const moduleAt = path => import(pathToFileURL(resolve(root, path)).href);
	const { Interpreter } = await moduleAt('src/v2/interpreter.ts');
	const { parse } = await moduleAt('src/v2/parser/index.ts');
	const records = [];
	for (const [name, [source, expected]] of Object.entries(programs)) {
		for (let trial = 0; trial < 5; trial++) {
			const output = [];
			const interpreter = new Interpreter({ out: value => { output.push(value); } }, { maxBusyTime: 60_000, maxSteps: 1e9 });
			const started = performance.now();
			try {
				await interpreter.exec(parse(source).program);
				const ms = performance.now() - started;
				// 正しさの検査は時間の外で行い、失敗した試行も記録に残します。
				assert.deepEqual(output, [expected]);
				records.push({ name, trial, ms, steps: interpreter.stepCount, output, ok: true });
			} catch (error) { records.push({ name, trial, ms: performance.now() - started, output, ok: false, error: failure(error) }); }
		}
	}
	for (let trial = 0; trial < 9; trial++) {
		const started = performance.now();
		try {
			const result = parse(big);
			const ms = performance.now() - started;
			assert.equal(result.program.body.length, 1500);
			for (let i = 0; i < 1500; i++) {
				const fn = result.program.body[i];
				assert.equal(fn.type, 'FunctionDeclaration');
				assert.equal(fn.id.name, `f${i}`);
				assert.equal(fn.params.length, 2);
				assert.equal(fn.params[0].name, 'a');
				assert.equal(fn.params[1].type, 'AssignmentPattern');
				assert.deepEqual(fn.body.body.map(node => node.type), ['VariableDeclaration', 'ForOfStatement', 'ReturnStatement']);
			}
			const astHash = createHash('sha256').update(JSON.stringify(result)).digest('hex');
			records.push({ name: 'parsebig', trial, ms, characters: big.length, astHash, ok: true });
		} catch (error) { records.push({ name: 'parsebig', trial, ms: performance.now() - started, ok: false, error: failure(error) }); }
	}
	const maxRssKiB = process.resourceUsage().maxRSS;
	console.log(JSON.stringify({ records, maxRssKiB, memoryWithinLimit: maxRssKiB * 1024 < 4 * 1024 ** 3 }));
} else {
	assert.ok(process.versions.bun, 'Bun で実行してください');
	const versions = process.argv.slice(2).map(argument => {
		const separator = argument.indexOf('=');
		assert.ok(separator > 0, 'label=clone の組を指定してください');
		return { label: argument.slice(0, separator), root: resolve(argument.slice(separator + 1)) };
	});
	assert.ok(versions.length > 0);
	const report = { runtime: `Bun ${process.versions.bun}`, warmup: 0, excluded: 0, processesPerVersion: 3, propertyTrialsPerProcess: 5, parserTrialsPerProcess: 9, records: [], failures: [] };
	for (let round = 0; round < report.processesPerVersion; round++) {
		for (let i = 0; i < versions.length; i++) {
			const version = versions[(i + round) % versions.length];
			const started = performance.now();
			const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', version.root], {
				encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
			});
			const elapsedMs = performance.now() - started;
			if (child.status !== 0) {
				report.failures.push({ label: version.label, round, elapsedMs, status: child.status, signal: child.signal, error: String(child.error ?? ''), stdout: child.stdout, stderr: child.stderr });
				continue;
			}
			try {
				const result = JSON.parse(child.stdout);
				report.records.push(...result.records.map(record => ({ label: version.label, round, processMs: elapsedMs, maxRssKiB: result.maxRssKiB, ...record })));
				if (!result.memoryWithinLimit) report.failures.push({ label: version.label, round, error: 'RSS が 4 GiB を超えました' });
			} catch (error) { report.failures.push({ label: version.label, round, elapsedMs, error: failure(error), stdout: child.stdout }); }
		}
	}
	const hashes = [...new Set(report.records.filter(record => record.name === 'parsebig' && record.ok).map(record => record.astHash))];
	report.astAgreement = hashes.length === 1;
	if (!report.astAgreement) report.failures.push({ error: '構文木の比較が一致しませんでした', hashes });
	report.failures.push(...report.records.filter(record => !record.ok));
	const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
	report.summary = versions.flatMap(version => [...Object.keys(programs), 'parsebig'].map(name => {
		const rows = report.records.filter(record => record.label === version.label && record.name === name);
		const values = rows.filter(row => row.ok).map(row => row.ms);
		return { label: version.label, name, attempted: rows.length, passed: values.length, failed: rows.length - values.length,
			medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95), steps: [...new Set(rows.flatMap(row => row.steps === undefined ? [] : [row.steps]))] };
	}));
	console.log(JSON.stringify(report, null, 2));
	if (report.failures.length > 0) process.exitCode = 1;
}
