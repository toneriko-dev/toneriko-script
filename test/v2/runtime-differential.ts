import { nodeExecutable } from '../../scripts/v2-node.mjs';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { test } from 'vitest';
import * as fc from 'fast-check';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { snapshot } from '../../scripts/v2-reference.mjs';

const seeds = [20261015, 17041, 89023, 424242, 314159];
const integer = fc.integer({ min: -20, max: 20 });
function numeric(depth: number): fc.Arbitrary<string> {
	const leaf = integer.map(String);
	if (depth === 0) return leaf;
	return fc.oneof({ weight: 3, arbitrary: leaf }, {
		weight: 1,
		arbitrary: fc.tuple(numeric(depth - 1), fc.constantFrom('+', '-', '*'), numeric(depth - 1))
			.map(([a, op, b]) => `(${a} ${op} ${b})`),
	});
}
const input = fc.record({
	a: integer, b: integer, n: fc.integer({ min: 1, max: 5 }),
	choice: fc.integer({ min: 0, max: 3 }), expression: numeric(4),
	items: fc.array(integer, { minLength: 2, maxLength: 6 }),
});
const groups = [
	{ name: '演算', error: false, make: ({ a, b, expression, choice }: Input) =>
		`let a = ${a}; let b = ${b}; reach(); out(${expression}); out(a ${['+', '-', '*', '**'][choice]} ${choice === 3 ? 2 : 'b'}); out(a < b); out(a === b); out(a && b); out(a || b); out(-0); out(0 / 0); out(1 / 0); out(-1 / 0); out("x" + a);` },
	{ name: 'オブジェクト', error: false, make: ({ a, b, choice }: Input) =>
		`let o = { z: ${a}, "2": ${b}, "1": 1, a: 3 }; reach(); o["k" + ${choice}] = ${b}; delete o.a; o.a = ${a}; let p = { ...o, z: ${b} }; out(p); out("a" in p); out(p === o); out(o === o);` },
	{ name: '関数とスコープ', error: false, make: ({ a, b, n, choice }: Input) =>
		`reach(); out(f(${n})); function f(x) { if (x <= 0) return ${a}; return f(x - 1) + 1; } function make(x = ${b}) { return (y) => x + y; } let g = make(${a}); { let x = ${b}; out(g(x)); } out(make()(${n})); ${choice % 2 ? 'out(h()); function h() { return 9; }' : 'out(f(0));'}` },
	{ name: 'ループ', error: false, make: ({ n, choice }: Input) =>
		`let fs = []; let total = 0; reach(); outer: for (let i = 0; i < ${n}; i++) { fs[fs.length] = () => i; for (let j = 0; j < 3; j++) { if (j === ${choice}) continue; total += i + j; if (total > 20) break outer; } } for (let f of fs) out(f()); let k = 0; do { k++; } while (k < ${n}); while (k > 0) k--; out(k); out(total);` },
	{ name: '例外と制御移動', error: false, make: ({ a, b, choice }: Input) =>
		`let trace = []; reach(); function f() { try { if (${choice} < 2) throw ${a}; return ${a}; } catch (e) { trace[trace.length] = e; return ${b}; } finally { trace[trace.length] = 7; ${choice % 2 ? `return ${b};` : ''} } } out(f()); stop: { try { trace[trace.length] = 8; break stop; } finally { trace[trace.length] = 9; } } switch (${choice}) { case 0: trace[trace.length] = 0; case 1: trace[trace.length] = 1; break; default: trace[trace.length] = 2; case 3: trace[trace.length] = 3; } out(trace);` },
	{ name: '分割代入とスプレッド', error: false, make: ({ a, b, items }: Input) =>
		`let xs = ${JSON.stringify(items)}; reach(); let [a,,...rest] = [...xs, ${a}]; let {x, y = ${b}, ...other} = {x: ${a}, z: ${b}}; let target = 0; [target] = xs; function f(first, ...tail) { return [first, tail]; } out(a); out(rest); out(x); out(y); out(other); out(target); out(f(...xs));` },
	{ name: '短絡', error: false, make: ({ a, b, choice }: Input) =>
		`let count = 0; function tick() { count++; return "x"; } let o = ${choice % 2 ? `{x: ${a}}` : 'null'}; reach(); out(o?.[tick()] == null); let f = null; out(f?.(tick()) == null); out(${a} && ${b}); out(${a} || ${b}); out(${a} ?? ${b}); out(null ?? ${b}); out(count);` },
	{ name: '代入と評価順', error: false, make: ({ a, b, choice }: Input) =>
		`let trace = []; let o = { x: ${a} }; function obj() { trace[trace.length] = "object"; return o; } function key() { trace[trace.length] = "key"; return "x"; } function rhs() { trace[trace.length] = "rhs"; return ${b}; } reach(); obj()[key()] ${['+=', '-=', '*=', '='][choice]} rhs(); out(o); out(trace); o.x++; out(o.x); ++o.x; out(o.x); o.x ??= rhs(); out(trace);` },
	{ name: 'TDZ例外', error: true, make: ({ a, choice }: Input) =>
		`let x = ${a}; { reach(); ${choice % 2 ? 'out(typeof x);' : 'out(x);'} let x = 1; }` },
	{ name: 'TypeError例外', error: true, make: ({ a, choice }: Input) =>
		`let x = null; let y = ${a}; reach(); ${['x();', 'out(x.value);', 'const {z} = x; out(z);', 'y();'][choice]}` },
];
type Input = fc.ArbitraryValue<typeof input>;
type Result = { output: unknown[]; reached: number; error: string | null };

test('Node モジュールとの差分: 固定 seed 5 個・本体到達 5000 件・成功比較 4000 件', async () => {
	const started = performance.now();
	let reached = 0;
	let compared = 0;
	let exceptions = 0;
	for (const group of groups) {
		const cases = seeds.flatMap(seed => fc.sample(input, { seed, numRuns: 100 })
			.map((value, index) => ({ seed, index, source: group.make(value) })));
		const reference = spawnSync(nodeExecutable, ['--max-old-space-size=768', '--experimental-vm-modules', fileURLToPath(new URL('../../scripts/v2-reference.mjs', import.meta.url))], {
			input: JSON.stringify(cases.map(item => item.source)), encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
		});
		assert.equal(reference.status, 0, `${group.name}: Node 参照実行失敗 ${reference.error ?? reference.stderr}`);
		const expected = JSON.parse(reference.stdout) as Result[];
		assert.equal(expected.length, cases.length);
		let groupReached = 0;
		for (const [index, item] of cases.entries()) {
			const context = `${group.name} seed=${item.seed} sample=${item.index}\n${item.source}`;
			const output: unknown[] = [];
			let hits = 0;
			let error: unknown;
			// パース失敗も v2 の予想外の例外も、試行の除外にはしません。
			const program = parse(item.source).program;
			try {
				await new Interpreter({ out: (value: unknown) => { output.push(snapshot(value)); }, reach: () => { hits++; } }, { maxSteps: 1_000_000 }).exec(program);
			} catch (caught) { error = caught; }
			const node = expected[index]!;
			assert.equal(node.reached, 1, context);
			assert.equal(hits, 1, context);
			reached++;
			groupReached++;
			if (group.error) {
				assert.notEqual(node.error, null, context);
				assert.ok(error, context);
				assert.equal((error as Error).name, node.error, context);
				exceptions++;
			} else {
				assert.equal(node.error, null, context);
				assert.equal(error, undefined, `${context}\n${String(error)}`);
				assert.deepEqual(output, node.output, context);
				compared++;
			}
		}
		assert.equal(groupReached, 500, group.name);
	}
	assert.ok(reached >= 5000, `到達 ${reached}`);
	assert.ok(compared >= 4000, `成功比較 ${compared}`);
	assert.ok(exceptions >= 1000, `例外 ${exceptions}`);
	console.info(`v2 差分: 到達=${reached} 成功比較=${compared} 例外=${exceptions} 秒=${((performance.now() - started) / 1000).toFixed(2)}`);
}, 120_000);

const mutationWitnesses = [
	{ name: '周回ごとの束縛', source: 'let fs = []; for (let i = 0; i < 3; i++) fs[fs.length] = () => i; out(fs[0]()); out(fs[1]()); out(fs[2]());', expected: [0, 1, 2] },
	{ name: 'finally の return 上書き', source: 'function f() { try { return 1; } finally { return 2; } } out(f());', expected: [2] },
	{ name: 'finally の break 上書き', source: 'let n = 0; outer: for (let i = 0; i < 2; i++) { try { break outer; } finally { n++; continue; } } out(n);', expected: [2] },
	{ name: '論理積の値', source: 'out(3 && 7); out(0 && 9); out("x" && "y");', expected: [7, 0, 'y'] },
	{ name: 'optional chain の副作用', source: 'let n = 0; function tick() { n++; return "x"; } let o = null; o?.[tick()]; o?.(tick()); out(n);', expected: [0] },
	{ name: '複合代入の左辺', source: 'let n = 0; let o = {x: 1}; function obj() { n++; return o; } obj().x += 3; out(n); out(o.x);', expected: [1, 4] },
	{ name: '整数キーの列挙', source: 'let {...rest} = {z: 1, "2": 2, "1": 3, a: 4}; out(rest);', expected: [{ '1': 3, '2': 2, z: 1, a: 4 }] },
];
test.each(mutationWitnesses)('変異検出: $name', async ({ source, expected }) => {
	const output: unknown[] = [];
	await new Interpreter({ out: (value: unknown) => { output.push(snapshot(value)); } }).exec(parse(source).program);
	assert.deepEqual(output, expected.map(snapshot));
});
test('変異検出: TDZ の読み', async () => {
	await assert.rejects(new Interpreter({ out: () => {} }).exec(parse('{ out(x); let x = 1; }').program), { name: 'ReferenceError' });
});

test('変異検出: 即時 Promise で時間をリセットしない', async () => {
	let clock = 0;
	const interpreter = new Interpreter({ wait: () => Promise.resolve(null) }, {
		now: () => ++clock, maxBusyTime: 100, yieldInterval: 0,
	});
	await assert.rejects(interpreter.exec(parse('for (let i = 0; i < 1000; i++) wait();').program), { code: 'BUSY_TIME_EXCEEDED' });
});
