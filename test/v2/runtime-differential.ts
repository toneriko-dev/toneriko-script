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

const structuralProfiles = ['ラベル付き入れ子ループ', '中央 default と fallthrough', 'finally の制御移動', 'ループの閉包', '複合代入', 'nullish と optional chain', '既定値と rest 分割代入', '関数の巻き上げ'] as const;
type StructuralContext = { loops: string[]; inFunction: boolean };

// 選択列から文と式を再帰的に組み立て、制御構造そのものを変化させます。
function structuralProgram(choices: readonly number[], profile: number): string {
	let offset = 0;
	let identifier = 0;
	const choose = (count: number): number => choices[offset++ % choices.length]! % count;
	const pick = <T,>(items: readonly T[]): T => items[choose(items.length)]!;
	const fresh = (prefix: string): string => `${prefix}${identifier++}`;
	const variables = ['a', 'b', 'c'];
	const number = (depth: number): string => {
		if (depth === 0 || choose(4) === 0) return pick([String(choose(17) - 4), ...variables, 'arr[0]', 'arr.length', 'o.x', '(o.y ?? 2)']);
		switch (choose(6)) {
			case 0: return `(${number(depth - 1)} ${pick(['+', '-', '*', '%'])} ${number(depth - 1)})`;
			case 1: return `(${boolean(depth - 1)} ? ${number(depth - 1)} : ${number(depth - 1)})`;
			case 2: return `(${number(depth - 1)} ${pick(['&&', '||'])} ${number(depth - 1)})`;
			case 3: return `g(${number(depth - 1)})`;
			case 4: return `f1(${number(depth - 1)})`;
			default: return `(-(${number(depth - 1)}))`;
		}
	};
	const boolean = (depth: number): string => depth === 0 || choose(3) === 0
		? `(${number(0)} ${pick(['<', '<=', '>', '>=', '===', '!=='])} ${number(0)})`
		: choose(3) === 0 ? `!(${boolean(depth - 1)})` : `(${boolean(depth - 1)} ${pick(['&&', '||'])} ${boolean(depth - 1)})`;
	const lhs = (): string => pick([...variables, 'o.x', 'o["x"]', 'arr[0]']);
	const abrupt = (ctx: StructuralContext): string => {
		const candidates = [`throw ${number(1)};`];
		if (ctx.inFunction) candidates.push(`return ${number(1)};`);
		if (ctx.loops.length) candidates.push(`break ${pick(ctx.loops)};`, `continue ${pick(ctx.loops)};`);
		return pick(candidates);
	};
	const simple = (ctx: StructuralContext): string => {
		switch (choose(7)) {
			case 0: return `${lhs()} ${pick(['=', '+=', '-=', '*=', '%='])} ${number(3)};`;
			case 1: return `out(${number(2)});`;
			case 2: return `trace.push(${number(1)});`;
			case 3: return `o.y ??= ${number(2)};`;
			case 4: return `if (${boolean(1)}) { ${abrupt(ctx)} }`;
			case 5: return `fs.push(() => ${number(1)});`;
			default: return `${pick(variables)}++;`;
		}
	};
	const block = (depth: number, ctx: StructuralContext): string => `{ ${statements(depth, ctx)} }`;
	const statements = (depth: number, ctx: StructuralContext): string => Array.from({ length: 1 + choose(2) }, () => statement(depth, ctx)).join(' ');
	const loop = (depth: number, ctx: StructuralContext, nested = false): string => {
		const label = fresh('L');
		const index = fresh('i');
		const next = { ...ctx, loops: [...ctx.loops, label] };
		const body = nested ? loop(depth - 1, next) : statements(Math.max(0, depth - 1), next);
		const closure = `fs.push(() => ${index});`;
		const limit = 1 + choose(3);
		switch (choose(4)) {
			case 0: return `${label}: for (let ${index} = 0; ${index} < ${limit}; ${index}++) { ${closure} ${body} }`;
			case 1: return `${label}: for (const ${index} of [${number(0)}, ${number(0)}]) { ${closure} ${body} }`;
			case 2: return `{ let ${index} = 0; ${label}: while (${index} < ${limit}) { ${index}++; ${closure} ${body} } }`;
			default: return `{ let ${index} = 0; ${label}: do { ${index}++; ${closure} ${body} } while (${index} < ${limit}); }`;
		}
	};
	const switchStatement = (depth: number, ctx: StructuralContext): string => `switch (${number(1)} % 3) {
		case 0: ${statements(depth - 1, ctx)} ${choose(2) ? 'break;' : ''}
		default: ${statements(depth - 1, ctx)}
		case 1: ${statements(depth - 1, ctx)} ${choose(2) ? 'break;' : ''}
		case 2: ${statements(depth - 1, ctx)}
	}`;
	const tryStatement = (depth: number, ctx: StructuralContext): string => {
		const caught = fresh('caught');
		return `try { ${statements(depth - 1, ctx)} ${choose(2) ? abrupt(ctx) : ''} }
			${choose(2) ? `catch (${caught}) { out(${caught}); ${statements(depth - 1, ctx)} }` : ''}
			finally { ${statements(depth - 1, ctx)} ${choose(2) ? abrupt(ctx) : ''} }`;
	};
	const patterns = (): string => {
		const x = fresh('x'), y = fresh('y'), tail = fresh('tail'), rest = fresh('rest');
		return `{ const [${x} = ${number(1)}, ...${tail}] = ${choose(2) ? '[]' : `[${number(1)}, ${number(1)}]`};
			const {x: ${y} = ${number(1)}, ...${rest}} = ${choose(2) ? 'o' : '{z: 3}'};
			out(${x}); out(${tail}); out(${y}); out(${rest}); }`;
	};
	const nullish = (): string => {
		const value = fresh('optional');
		return `{ let ${value} = ${choose(2) ? 'null' : '{x: 1}'}; o.y ??= ${number(2)};
			out(${value}?.[mark("x")] ?? ${number(1)}); out(${value}?.x ?? ${number(1)}); }`;
	};
	const hoisted = (depth: number, ctx: StructuralContext): string => {
		const fn = fresh('hoisted'), param = fresh('p'), rest = fresh('args');
		return `{ out(${fn}(${number(1)})); function ${fn}(${param} = ${number(1)}, ...${rest}) {
			${statements(depth - 1, { loops: [], inFunction: true })} return ${param} + ${rest}.length;
		} ${choose(2) ? statement(depth - 1, ctx) : ''} }`;
	};
	const statement = (depth: number, ctx: StructuralContext): string => {
		if (depth <= 0) return simple(ctx);
		switch (choose(10)) {
			case 0: return simple(ctx);
			case 1: return `if (${boolean(2)}) ${block(depth - 1, ctx)} else ${block(depth - 1, ctx)}`;
			case 2: return loop(depth, ctx);
			case 3: return switchStatement(depth, ctx);
			case 4: return tryStatement(depth, ctx);
			case 5: return patterns();
			case 6: return nullish();
			case 7: return hoisted(depth, ctx);
			case 8: { const label = fresh('block'); return `${label}: { ${statements(depth - 1, ctx)} if (${boolean(1)}) break ${label}; ${statements(depth - 1, ctx)} }`; }
			default: return block(depth - 1, ctx);
		}
	};
	const context = { loops: [], inFunction: true };
	const required = (() => {
		switch (profile) {
			case 0: return loop(3, context, true);
			case 1: return switchStatement(3, context);
			case 2: return tryStatement(3, context);
			case 3: return loop(3, context);
			case 4: return `${lhs()} ${pick(['+=', '-=', '*=', '%='])} ${number(3)}; ${statement(3, context)}`;
			case 5: return `${nullish()} ${statement(3, context)}`;
			case 6: return `${patterns()} ${statement(3, context)}`;
			default: return hoisted(3, context);
		}
	})();
	return `let a = 1; let b = 2; let c = 3; const arr = [5, 6]; const o = {x: 1}; const trace = []; const fs = [];
		function g(n) { return n % 7; }
		function f1(p, q = p + 1) { return q; }
		function mark(key) { trace.push(9); return key; }
		function scenario() { reach(); ${required} ${statements(2, context)} return 0; }
		try { out(scenario()); } catch (caught) { out(caught); }
		out([a, b, c, o.x, o.y ?? 0, arr[0], trace.length]); out(trace); for (const fn of fs) out(fn());`;
}

const structuralChoices = fc.array(fc.integer({ min: 0, max: 65535 }), { minLength: 256, maxLength: 512 });
test('構造を組み合わせた Node 差分: 8 群・本体到達と成功比較 3200 件', async () => {
	const started = performance.now();
	let reached = 0;
	let compared = 0;
	for (const [profile, name] of structuralProfiles.entries()) {
		const cases = seeds.slice(0, 4).flatMap(seed => fc.sample(structuralChoices, { seed: seed + profile, numRuns: 100 })
			.map((choices, index) => ({ seed: seed + profile, index, source: structuralProgram(choices, profile) })));
		const child = spawnSync(nodeExecutable, ['--max-old-space-size=768', '--experimental-vm-modules', fileURLToPath(new URL('../../scripts/v2-reference.mjs', import.meta.url))], {
			input: JSON.stringify(cases.map(item => item.source)), encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
		});
		assert.equal(child.status, 0, `${name}: ${child.error ?? child.stderr}`);
		const references = JSON.parse(child.stdout) as Result[];
		assert.equal(references.length, 400);
		let groupReached = 0;
		let groupCompared = 0;
		for (const [index, item] of cases.entries()) {
			const context = `${name} seed=${item.seed} sample=${item.index}\n${item.source}`;
			const reference = references[index]!;
			assert.equal(reference.error, null, context);
			assert.equal(reference.reached, 1, context);
			const output: unknown[] = [];
			let hits = 0;
			const interpreter = new Interpreter({ out: (value: unknown) => { output.push(snapshot(value)); }, reach: () => { hits++; } }, { maxSteps: 1_000_000 });
			try { await interpreter.exec(parse(item.source).program); }
			catch (error) { assert.fail(`${context}\n${String(error)}`); }
			assert.equal(hits, 1, context);
			groupReached++;
			assert.deepEqual(output, reference.output, context);
			groupCompared++;
		}
		assert.equal(groupReached, 400, name);
		assert.equal(groupCompared, 400, name);
		reached += groupReached;
		compared += groupCompared;
	}
	assert.ok(reached >= 3200, `構造の本体到達 ${reached}`);
	assert.ok(compared >= 3200, `構造の成功比較 ${compared}`);
	console.info(`v2 構造差分: 到達=${reached} 成功比較=${compared} 秒=${((performance.now() - started) / 1000).toFixed(2)}`);
}, 60_000);
