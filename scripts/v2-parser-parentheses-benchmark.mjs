import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// label=clone を指定します。計測範囲と入力は rv7/quad.mjs・quad2.mjs と同じです。
const script = fileURLToPath(import.meta.url);
const cases = [20_000, 200_000].flatMap(terms => [0, 255].map(depth => ({ terms, depth })));
const failure = error => ({ name: error?.name, message: String(error?.message ?? error), stack: error?.stack });
if (process.argv[2] === '--worker') {
	const { parse } = await import(pathToFileURL(process.argv[3]).href);
	const records = [];
	const offset = Number(process.argv[4]);
	for (let trial = 0; trial < 5; trial++) {
		for (let i = 0; i < cases.length; i++) {
			const { terms, depth } = cases[(i + trial + offset) % cases.length];
			const source = 'out(' + '('.repeat(depth) + Array(terms).fill('a').join(terms === 20_000 ? ' + ' : '+') + ')'.repeat(depth) + ')';
			globalThis.gc?.();
			const started = performance.now();
			try {
				const { program } = parse(source);
				const ms = performance.now() - started;
				// 時間の外で全項と演算子を確認し、部分的な解析を速い結果に数えません。
				assert.equal(program.body.length, 1);
				const call = program.body[0].expression;
				assert.equal(call.type, 'CallExpression');
				assert.equal(call.callee.name, 'out');
				assert.equal(call.arguments.length, 1);
				let node = call.arguments[0], count = 1;
				while (node.type === 'BinaryExpression') {
					assert.equal(node.operator, '+');
					assert.equal(node.right.type, 'Identifier');
					assert.equal(node.right.name, 'a');
					count++; node = node.left;
				}
				assert.equal(node.type, 'Identifier');
				assert.equal(node.name, 'a');
				assert.equal(count, terms);
				records.push({ terms, depth, trial, characters: source.length, ms, checkedTerms: count, ok: true });
			} catch (error) { records.push({ terms, depth, trial, ms: performance.now() - started, ok: false, error: failure(error) }); }
		}
	}
	console.log(JSON.stringify({ runtime: `Node ${process.versions.node}`, records, maxRssKiB: process.resourceUsage().maxRSS }));
} else {
	const root = resolve(dirname(script), '..');
	const directory = await mkdtemp(join(root, '.git', 'v2-parentheses-benchmark-'));
	const versions = process.argv.slice(2).map(value => {
		const at = value.indexOf('=');
		assert.ok(at > 0, 'label=clone の組を指定してください');
		return { label: value.slice(0, at), root: resolve(value.slice(at + 1)) };
	});
	assert.ok(versions.length > 0);
	const report = { runtime: 'Node', warmup: 0, excluded: 0, processesPerVersion: 3, trialsPerCasePerProcess: 5, records: [], failures: [] };
	try {
		for (const [index, version] of versions.entries()) {
			version.bundle = join(directory, `parser-${index}.mjs`);
			const built = spawnSync('bun', ['build', join(version.root, 'src/v2/parser/index.ts'), '--target=node', '--format=esm', '--outfile', version.bundle], { encoding: 'utf8' });
			assert.equal(built.status, 0, built.stderr);
		}
		for (let round = 0; round < report.processesPerVersion; round++) {
			for (let i = 0; i < versions.length; i++) {
				const version = versions[(i + round) % versions.length];
				const started = performance.now();
				const child = spawnSync(process.env.NODE_EXECUTABLE ?? 'node', ['--expose-gc', script, '--worker', version.bundle, String(round)], {
					encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
				});
				const elapsedMs = performance.now() - started;
				if (child.status !== 0) {
					report.failures.push({ label: version.label, round, elapsedMs, status: child.status, signal: child.signal, error: String(child.error ?? ''), stdout: child.stdout, stderr: child.stderr });
					continue;
				}
				try {
					const result = JSON.parse(child.stdout);
					report.runtime = result.runtime;
					report.records.push(...result.records.map(record => ({ label: version.label, round, maxRssKiB: result.maxRssKiB, ...record })));
					if (result.maxRssKiB * 1024 >= 4 * 1024 ** 3) report.failures.push({ label: version.label, round, error: 'RSS が 4 GiB を超えました' });
				} catch (error) { report.failures.push({ label: version.label, round, elapsedMs, error: failure(error), stdout: child.stdout }); }
			}
		}
	} finally { await rm(directory, { recursive: true, force: true }); }
	report.failures.push(...report.records.filter(record => !record.ok));
	const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
	report.summary = versions.flatMap(version => cases.map(({ terms, depth }) => {
		const rows = report.records.filter(row => row.label === version.label && row.terms === terms && row.depth === depth);
		const passed = rows.filter(row => row.ok);
		return { label: version.label, terms, depth, attempted: rows.length, passed: passed.length, failed: rows.length - passed.length, medianMs: median(passed.map(row => row.ms)) };
	}));
	console.log(JSON.stringify(report, null, 2));
	if (report.failures.length) process.exitCode = 1;
}
