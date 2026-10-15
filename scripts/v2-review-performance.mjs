import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// label=clone を指定します。入力と計測範囲は rv9/hostperf.mjs・perf3.mjs・perf.mjs に合わせます。
const script = fileURLToPath(import.meta.url);
const names = ['hostClass', 'perf3-10000', 'perf3-100000', 'parenChain'];
const failure = error => ({ name: error?.name, message: String(error?.message ?? error), stack: error?.stack });
const sourceFor = name => name === 'parenChain'
	? 'out(' + '('.repeat(255) + Array(20_000).fill('a').join(' + ') + ')'.repeat(255) + ')'
	: Array.from({ length: Number(name.split('-')[1]) }, (_, i) => `if (x${i} > 0) { out(f(x${i}, [1, 2, 3]).map(y => y * 2)); } else { total += x${i}; }`).join('\n');
function checkProgram(program, name) {
	if (name === 'parenChain') {
		assert.equal(program.body.length, 1);
		assert.equal(program.body[0].expression.callee.name, 'out');
		let node = program.body[0].expression.arguments[0], count = 1;
		while (node.type === 'BinaryExpression') {
			assert.equal(node.operator, '+');
			assert.equal(node.right.name, 'a');
			count++; node = node.left;
		}
		assert.equal(node.name, 'a');
		assert.equal(count, 20_000);
		return `plus:${count}`;
	}
	assert.equal(program.body.length, Number(name.split('-')[1]));
	const hash = createHash('sha256');
	for (const [i, statement] of program.body.entries()) {
		assert.equal(statement.type, 'IfStatement');
		assert.equal(statement.test.left.name, `x${i}`);
		assert.equal(statement.consequent.body[0].expression.callee.name, 'out');
		assert.equal(statement.alternate.body[0].expression.operator, '+=');
		// 文ごとに直列化し、長いプログラム全体の文字列を同時に保持しません。
		hash.update(JSON.stringify(statement));
	}
	return hash.digest('hex');
}

if (process.argv[2] === '--worker') {
	const { parse, Interpreter } = await import(pathToFileURL(process.argv[3]).href);
	const name = process.argv[4];
	const records = [];
	if (name === 'hostClass') {
		class H { constructor() { this.x = 1; this.child = { y: 2 }; } }
		const { program } = parse('let s = 0; for (let i = 0; i < 100000; i++) { s += h.x; } out(s);');
		for (let trial = 0; trial < 5; trial++) {
			const output = [];
			globalThis.gc?.();
			const interpreter = new Interpreter({ h: new H(), out: value => { output.push(value); } }, { maxBusyTime: 60_000, maxSteps: 1e8 });
			const started = performance.now();
			try {
				await interpreter.exec(program);
				const ms = performance.now() - started;
				assert.deepEqual(output, [100000]);
				records.push({ trial, ms, output, steps: interpreter.stepCount, ok: true });
			} catch (error) { records.push({ trial, ms: performance.now() - started, output, ok: false, error: failure(error) }); }
		}
	} else {
		const source = sourceFor(name);
		// 構文木の寿命をこの呼び出し内に限定し、次の試行の GC に前の木を残しません。
		function measuredParse() {
			const started = performance.now();
			const { program } = parse(source);
			const ms = performance.now() - started;
			const astHash = checkProgram(program, name);
			return { ms, astHash, statements: program.body.length };
		}
		const warmup = name.startsWith('perf3-') ? 1 : 0;
		const count = name.startsWith('perf3-') ? 2 : 5;
		for (let trial = -warmup; trial < count; trial++) {
			globalThis.gc?.();
			const started = performance.now();
			try {
				// 全試行の構文木を時間外で確かめ、失敗した準備試行も記録に残します。
				const { ms, astHash, statements } = measuredParse();
				records.push({ trial, warmup: trial < 0, ms, characters: source.length, statements, astHash, ok: true });
			} catch (error) { records.push({ trial, warmup: trial < 0, ms: performance.now() - started, ok: false, error: failure(error) }); }
		}
	}
	console.log(JSON.stringify({ runtime: `Node ${process.versions.node}`, records, maxRssKiB: process.resourceUsage().maxRSS }));
} else {
	const root = resolve(dirname(script), '..');
	const directory = await mkdtemp(join(root, '.git', 'v2-review-performance-'));
	const versions = process.argv.slice(2).map(argument => {
		const at = argument.indexOf('=');
		assert.ok(at > 0, 'label=clone の組を指定してください');
		return { label: argument.slice(0, at), root: resolve(argument.slice(at + 1)) };
	});
	assert.ok(versions.length > 0);
	const report = { runtime: 'Node', processesPerCasePerVersion: 3, measuredTrialsPerProcess: { hostClass: 5, perf3: 2, parenChain: 5 }, warmupPerProcess: { perf3: 1 }, excluded: 0, records: [], failures: [] };
	try {
		for (const [index, version] of versions.entries()) {
			const entry = join(directory, `entry-${index}.ts`);
			await writeFile(entry, `export { parse } from ${JSON.stringify(join(version.root, 'src/v2/parser/index.ts'))};\nexport { Interpreter } from ${JSON.stringify(join(version.root, 'src/v2/interpreter.ts'))};\n`);
			version.bundle = join(directory, `bundle-${index}.mjs`);
			const built = spawnSync('bun', ['build', entry, '--target=node', '--format=esm', '--outfile', version.bundle], { encoding: 'utf8' });
			assert.equal(built.status, 0, built.stderr);
		}
		for (let round = 0; round < report.processesPerCasePerVersion; round++) {
			for (const name of names) {
				for (let i = 0; i < versions.length; i++) {
					const version = versions[(i + round) % versions.length];
					const started = performance.now();
					const child = spawnSync(process.env.NODE_EXECUTABLE ?? 'node', ['--expose-gc', '--max-old-space-size=3072', script, '--worker', version.bundle, name], { encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
					const elapsedMs = performance.now() - started;
					if (child.status !== 0) {
						report.failures.push({ label: version.label, name, round, elapsedMs, status: child.status, signal: child.signal, error: String(child.error ?? ''), stdout: child.stdout, stderr: child.stderr });
						continue;
					}
					try {
						const result = JSON.parse(child.stdout);
						report.runtime = result.runtime;
						report.records.push(...result.records.map(record => ({ label: version.label, name, round, processMs: elapsedMs, maxRssKiB: result.maxRssKiB, ...record })));
						if (result.maxRssKiB * 1024 >= 4 * 1024 ** 3) report.failures.push({ label: version.label, name, round, error: 'RSS が 4 GiB を超えました' });
					} catch (error) { report.failures.push({ label: version.label, name, round, elapsedMs, error: failure(error), stdout: child.stdout }); }
				}
			}
		}
	} finally { await rm(directory, { recursive: true, force: true }); }
	for (const name of names) {
		const rows = report.records.filter(row => row.name === name && row.ok);
		const signatures = [...new Set(rows.map(row => name === 'hostClass' ? JSON.stringify([row.output, row.steps]) : row.astHash))];
		if (signatures.length !== 1) report.failures.push({ name, error: '出力・ステップ数または構文木が一致しませんでした', signatures });
	}
	report.failures.push(...report.records.filter(record => !record.ok));
	const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
	report.summary = versions.flatMap(version => names.map(name => {
		const rows = report.records.filter(row => row.label === version.label && row.name === name && !row.warmup);
		const values = rows.filter(row => row.ok).map(row => row.ms);
		return { label: version.label, name, attempted: rows.length, passed: values.length, failed: rows.length - values.length, medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
	}));
	console.log(JSON.stringify(report, null, 2));
	if (report.failures.length) process.exitCode = 1;
}
