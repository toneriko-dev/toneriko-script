import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { nodeExecutable } from '../../scripts/v2-node.mjs';
import { Interpreter, type InterpreterOptions } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { arrayDefinitions } from '../../src/v2/stdlib/arrays.js';

async function execute(source: string, globals: Record<string, unknown> = {}, options: InterpreterOptions = {}) {
	const output: unknown[] = [];
	await new Interpreter({ ...globals, out: (value: unknown) => { output.push(structuredClone(value)); } }, options).exec(parse(source).program);
	return output;
}
const expressions: Record<string, string> = {
	push: 'xs.push(row.n)', pop: 'xs.pop()', shift: 'xs.shift()', unshift: 'xs.unshift(row.n, 4)',
	slice: 'xs.slice(row.n, row.end)', splice: 'xs.splice(row.n, row.end, 8, 9)', concat: 'xs.concat([3, 4], row.n)',
	at: 'xs.at(row.n)', indexOf: 'xs.indexOf(row.n, row.end)', includes: 'xs.includes(row.n, row.end)',
	fill: 'xs.fill(7, row.n, row.end)', reverse: 'xs.reverse()', toReversed: 'xs.toReversed()',
	entries: 'Array.from(xs.entries())', map: 'xs.map((v, i, a) => v + i + a.length)',
	filter: 'xs.filter((v, i) => (v + i) % 2 === 0)', find: 'xs.find(v => v > 2)', findIndex: 'xs.findIndex(v => v > 2)',
	some: 'xs.some(v => v > 2)', every: 'xs.every(v => v > 2)', forEach: 'xs.forEach((v, i, a) => { a[i] = v + 1; })',
	flatMap: 'xs.flatMap((v, i) => [v, i])', reduce: 'xs.reduce((acc, v, i, a) => acc + v + i + a.length, 0)',
	flat: '[xs, [xs, [1]]].flat(row.end)', join: 'xs.join("x")',
	'Array.from': 'Array.from(xs, (v, i) => v + i)',
};
describe('配列標準ライブラリ', () => {
	test('すべての定義に差分検査がある', () => {
		for (const definition of arrayDefinitions) expect(expressions[definition.name], definition.name).toBeDefined();
	});
	for (const [name, expression] of Object.entries(expressions)) test(`${name}: 評価器経由で Node と 500 件比較`, async () => {
		const rows = [11, 29, 73, 151, 257].flatMap(seed => fc.sample(fc.record({ xs: fc.array(fc.integer({ min: -8, max: 8 }), { maxLength: 12 }), n: fc.integer({ min: -15, max: 15 }), end: fc.integer({ min: -4, max: 5 }) }), { seed, numRuns: 100 }));
		const source = `for (const row of rows) { const xs = row.xs; reached(); const result = ${expression}; out([result, xs, result === xs]); }`;
		const node = spawnSync(nodeExecutable, ['--input-type=module', '--eval', `const rows=JSON.parse(process.argv[1]); const output=[]; let hits=0; const reached=()=>hits++; const out=x=>output.push(x); ${source} process.stdout.write(JSON.stringify({hits,output}));`, JSON.stringify(rows)], { encoding: 'utf8' });
		expect(node.status, node.stderr).toBe(0);
		const expected = JSON.parse(node.stdout);
		let reached = 0; let completed = 0; let compared = 0; const actual: unknown[] = [];
		const parsed = parse(source); expect(parsed.warnings).toEqual([]);
		await new Interpreter({ rows, reached: () => { reached++; }, out: (value: unknown) => { actual.push(structuredClone(value)); completed++; } }, { maxSteps: 2_000_000 }).exec(parsed.program);
		for (let i = 0; i < rows.length; i++) { expect(actual[i]).toEqual(expected.output[i]); compared++; }
		expect([rows.length, expected.hits, reached, completed, compared]).toEqual([500, 500, 500, 500, 500]);
	});
	test('コールバックを一つずつ待ち、引数と変更を観測する', async () => {
		const trace: unknown[] = []; let active = 0; let maximum = 0;
		const result = await execute('const xs = [4, 5, 6]; out(xs.map((v, i, a) => work(v, i, a))); out(xs);', { work: async (v: number, i: number, a: number[]) => { active++; maximum = Math.max(maximum, active); trace.push([v, i, a.length]); await Promise.resolve(); a[2] = 9; active--; return v + i; } });
		expect(maximum).toBe(1); expect(trace).toEqual([[4, 0, 3], [5, 1, 3], [9, 2, 3]]); expect(result).toEqual([[4, 6, 11], [4, 5, 9]]);
	});
	test('全コールバック系の引数と順序は Node に一致する', async () => {
		for (const method of ['map', 'filter', 'find', 'findIndex', 'some', 'every', 'forEach', 'flatMap', 'reduce']) {
			const callback = method === 'reduce' ? '(acc, v, i, a) => { out([acc, v, i, a.length]); return acc + v; }, 0' : '(v, i, a) => { out([v, i, a.length]); return i < 2; }';
			const source = `const xs=[3,4,5]; out(xs.${method}(${callback}));`;
			const node = spawnSync(nodeExecutable, ['--eval', `const output=[]; const out=x=>output.push(x===undefined?null:x); ${source} process.stdout.write(JSON.stringify(output));`], { encoding: 'utf8' });
			expect(node.status).toBe(0); expect(await execute(source)).toEqual(JSON.parse(node.stdout));
		}
	});
	test('entries は長さの変更を読み、終了後は再開しない', async () => {
		expect(await execute('const a=[1]; const it=a.entries(); out(it.next()); a.push(2); out(it.next()); out(it.next()); a.push(3); out(it.next());')).toEqual([{ value: [0, 1], done: false }, { value: [1, 2], done: false }, { value: null, done: true }, { value: null, done: true }]);
		expect(await execute('const a=[4,5]; out([...a.entries()]); out(Array.from(a.entries())); for (const pair of a.entries()) out(pair);')).toEqual([[[0, 4], [1, 5]], [[0, 4], [1, 5]], [0, 4], [1, 5]]);
	});
	test('Array.from は欠落を null とし、書記素を扱う', async () => {
		const sparse = new Array(3); sparse[1] = 2;
		expect(await execute('out(Array.from(sparse)); out(Array.from({length: 3, 1: 2})); out(Array.from("👩‍💻é\\r\\n")); out(Array.from({length: 2}, (v,i) => i));', { sparse })).toEqual([[null, 2, null], [null, 2, null], ['👩‍💻', 'é', '\r\n'], [0, 1]]);
		await expect(execute('Array.from([1], null);')).rejects.toMatchObject({ name: 'TypeError' });
		await expect(execute('[1].map(v=>v, {});')).rejects.toMatchObject({ name: 'TypeError' });
	});
	test('検索引数の省略は null の検索にならない', async () => {
		expect(await execute('out([null].indexOf()); out([null].includes()); out([null].includes(null));')).toEqual([-1, false, true]);
	});
	test('join は循環を空文字とし、深い配列でホストのスタックを使わない', async () => {
		let nested: unknown = 1; for (let i = 0; i < 10000; i++) nested = [nested];
		expect(await execute('out(nested.join()); const a=[1]; a.push(a); out(a.join());', { nested }, { maxSteps: 100000 })).toEqual(['1', '1,']);
	});
	test('map は共有のステップ上限で停止する', async () => {
		await expect(execute('xs.map(v=>v);', { xs: Array.from({ length: 10000 }, (_, i) => i) }, { maxSteps: 1000 })).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
	});
	test('map とコピー処理の途中でホストへ譲る', async () => {
		for (const expression of ['xs.map(v=>v)', 'xs.slice()', 'xs.reverse()', 'xs.flat()', 'xs.join()']) {
			let clock = 0; let yields = 0; let completed = false; let yieldedBeforeCompletion = false;
			const vm = new Interpreter({ xs: Array.from({ length: 1000 }, (_, i) => i), done: () => { completed = true; } }, { now: () => ++clock, yieldInterval: 1, maxBusyTime: 1000000, yieldToHost: async () => { yields++; if (!completed) yieldedBeforeCompletion = true; } });
			await vm.exec(parse(`${expression}; done();`).program);
			expect(yields).toBeGreaterThan(1); expect(yieldedBeforeCompletion).toBe(true); expect(completed).toBe(true);
		}
	});
});
