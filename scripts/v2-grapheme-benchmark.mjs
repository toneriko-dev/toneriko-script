import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Bun で実行し、label=clone の組を比較する。入力は rv5/perf.ts・perf2.ts と同じ種で作る。
if (process.argv[2] === '--worker') {
	const root = resolve(process.argv[3]);
	const moduleAt = path => import(pathToFileURL(resolve(root, path)).href);
	const { GraphemeCache } = await moduleAt('src/v2/runtime/strings.ts');
	const { Interpreter } = await moduleAt('src/v2/interpreter.ts');
	const { parse } = await moduleAt('src/v2/parser/index.ts');
	const random = initial => {
		let seed = initial;
		return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
	};
	const rnd = random(7);
	const generate = f => { let value = ''; while (value.length < 100_000) value += f(); return value; };
	const inputs = {
		kanji: generate(() => String.fromCodePoint(0x4e00 + Math.floor(rnd() * 20_000))),
		kana: generate(() => String.fromCodePoint(0x3041 + Math.floor(rnd() * 80))),
	};
	const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
	const records = [];
	for (const [name, value] of Object.entries(inputs)) {
		const expected = [...segmenter.segment(value)].length;
		for (let trial = 0; trial < 3; trial++) {
			const output = [];
			const interpreter = new Interpreter({ s: value, out: result => { output.push(result); } }, { maxBusyTime: 60_000 });
			const started = performance.now();
			await interpreter.exec(parse('out(s.length)').program);
			const ms = performance.now() - started;
			assert.deepEqual(output, [expected]);
			records.push({ name, trial, ms, steps: interpreter.stepCount });
		}
	}
	const noteRandom = random(3);
	const kanji = Array.from({ length: 2000 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7919) % 20_000)));
	const notes = Array.from({ length: 100 }, () => {
		let value = '';
		while (value.length < 140) {
			const r = noteRandom();
			value += r < 0.6 ? String.fromCodePoint(0x3041 + Math.floor(noteRandom() * 83))
				: r < 0.9 ? kanji[Math.floor(noteRandom() * 2000)] : 'abc '[Math.floor(noteRandom() * 4)];
		}
		return value;
	});
	const expectedTotal = notes.reduce((sum, value) => sum + [...segmenter.segment(value)].length, 0) * 5;
	for (let trial = 0; trial < 2; trial++) {
		let total = 0;
		const started = performance.now();
		for (let repeat = 0; repeat < 5; repeat++) {
			const cache = new GraphemeCache();
			for (const note of notes) total += cache.info(note).length;
		}
		const ms = (performance.now() - started) / 5;
		assert.equal(total, expectedTotal);
		records.push({ name: 'notes100x140', trial, ms, total });
	}
	assert.ok(process.resourceUsage().maxRSS * 1024 < 4 * 1024 ** 3, 'RSS が 4 GiB を超えました');
	console.log(JSON.stringify({ records, maxRssKiB: process.resourceUsage().maxRSS }));
} else {
	assert.ok(process.versions.bun, 'Bun で実行してください');
	const versions = process.argv.slice(2).map(argument => {
		const separator = argument.indexOf('=');
		assert.ok(separator > 0, 'label=clone の組を指定してください');
		return { label: argument.slice(0, separator), root: resolve(argument.slice(separator + 1)) };
	});
	assert.ok(versions.length > 0);
	const report = { runtime: `Bun ${process.versions.bun}`, warmup: 0, excluded: 0, processesPerVersion: 5, records: [], failures: [] };
	for (let round = 0; round < 5; round++) {
		for (let i = 0; i < versions.length; i++) {
			const version = versions[(i + round) % versions.length];
			const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', version.root], {
				encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
			});
			if (child.status !== 0) {
				report.failures.push({ label: version.label, round, status: child.status, signal: child.signal, error: String(child.error ?? ''), stderr: child.stderr });
				process.exitCode = 1;
			} else {
				const result = JSON.parse(child.stdout);
				report.records.push(...result.records.map(record => ({ label: version.label, round, maxRssKiB: result.maxRssKiB, ...record })));
			}
		}
	}
	const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
	report.summary = versions.flatMap(version => ['kanji', 'kana', 'notes100x140'].map(name => {
		const rows = report.records.filter(record => record.label === version.label && record.name === name);
		return { label: version.label, name, samples: rows.length, medianMs: percentile(rows.map(row => row.ms), 0.5),
			p95Ms: percentile(rows.map(row => row.ms), 0.95), steps: [...new Set(rows.flatMap(row => row.steps === undefined ? [] : [row.steps]))] };
	}));
	console.log(JSON.stringify(report, null, 2));
}
