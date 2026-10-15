import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import * as fc from 'fast-check';
import { nodeExecutable } from '../../scripts/v2-node.mjs';
import { snapshot } from '../../scripts/v2-reference.mjs';
import { Interpreter, RuntimeError } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

async function execute(source: string, globals: Record<string, unknown> = {}) {
	const output: unknown[] = [];
	await new Interpreter({ out: (value: unknown) => { output.push(value); }, ...globals }, { maxSteps: 2_000_000 }).exec(parse(source).program);
	return output;
}
const seeds = [20261015, 17041, 89023, 424242, 314159];
const text = fc.array(fc.constantFrom('a', 'b', 'c', ' ', '"', '\\', '\n', '\t'), { maxLength: 12 }).map(v => v.join(''));
const leaf = fc.oneof(text, fc.integer({ min: -1000, max: 1000 }), fc.boolean(), fc.constant(null));
const json = fc.oneof(leaf, fc.array(leaf, { maxLength: 8 }), fc.dictionary(fc.constantFrom('a', 'b', '1', 'constructor', 'toString'), leaf));
const input = fc.record({ value: json, object: fc.dictionary(fc.constantFrom('a', 'b', '1', 'constructor', 'toString'), json), items: fc.array(fc.integer({ min: -10, max: 10 }), { maxLength: 12 }), space: fc.integer({ min: 0, max: 12 }) });
type Input = fc.ArbitraryValue<typeof input>;
const literal = JSON.stringify;
const groups: Record<string, (value: Input) => string> = {
	'Object.keys': v => `Object.keys(${literal(v.object)})`,
	'Object.values': v => `Object.values(${literal(v.object)})`,
	'Object.entries': v => `Object.entries(${literal(v.object)})`,
	'Object.fromEntries': v => `Object.fromEntries(${literal(Object.entries(v.object))})`,
	'Object.groupBy': v => `Object.groupBy(${literal(v.items)}, x => x % 3)`,
	'JSON.parse': v => `JSON.parse(${literal(literal(v.value))})`,
	'JSON.parse reviver': v => `JSON.parse(${literal(literal(v.value))}, (key, value) => typeof value === "number" ? value * 2 : value)`,
	'JSON.stringify': v => `JSON.stringify(${literal(v.value)}, null, ${v.space})`,
	'JSON.stringify replacer': v => `JSON.stringify(${literal(v.value)}, (key, value) => typeof value === "number" ? value * 2 : value)`,
	'JSON.stringify property list': v => `JSON.stringify(${literal(v.object)}, ["b", "a", 1, "constructor", "b"], ${v.space})`,
	'structuredClone': v => `structuredClone(${literal(v.value)})`,
};
const referenceCode = `import vm from 'node:vm'; import {readFileSync} from 'node:fs'; import {snapshot} from ${JSON.stringify(new URL('../../scripts/v2-reference.mjs', import.meta.url).href)}; const sources = JSON.parse(readFileSync(0, 'utf8')); const result = []; for (const source of sources) { const output = []; let reached = 0; let error = null; try { vm.runInNewContext(source, { structuredClone, out: v => output.push(snapshot(v)), reach: () => reached++ }); } catch (e) {error = e.name;} result.push({output, reached, error}); } process.stdout.write(JSON.stringify(result));`;

describe('オブジェクトと JSON の標準関数', () => {
	for (const [name, expression] of Object.entries(groups)) test(`${name}: Node 差分 5 seed × 100 件`, async () => {
		const sources = seeds.flatMap(seed => fc.sample(input, { seed, numRuns: 100 })).map(v => `reach(); out(${expression(v)});`);
		const reference = spawnSync(nodeExecutable, ['--input-type=module', '-e', referenceCode], { input: JSON.stringify(sources), encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
		expect(reference.status, reference.stderr).toBe(0);
		const expected = JSON.parse(reference.stdout); let reached = 0, completed = 0, compared = 0;
		for (let i = 0; i < sources.length; i++) {
			const output = await execute(sources[i]!, { reach: () => { reached++; } }); completed++;
			expect(expected[i].reached).toBe(1); expect(expected[i].error, sources[i]).toBe(null);
			expect(output.map(snapshot), sources[i]).toEqual(expected[i].output); compared++;
		}
		expect(reached).toBe(500); expect(completed).toBe(500); expect(compared).toBe(500);
	}, 60_000);

	test('作成する辞書は全て原型がない', async () => {
		const values = await execute('out(JSON.parse("{\\"x\\":[{\\"y\\":1}]}")); out(Object.fromEntries([["x", 1]])); out(Object.groupBy([1], x => "x")); out(structuredClone({x: {y: 1}}));');
		const pending: unknown[] = [...values];
		while (pending.length) { const value = pending.pop(); if (value !== null && typeof value === 'object') { if (!Array.isArray(value)) expect(Object.getPrototypeOf(value)).toBe(null); pending.push(...Object.values(value)); } }
	});
	test('__proto__ は解析のどの深さでも拒否し、上書きでも消せない', async () => {
		for (const text of ['{"__proto__":1}', '{"a":[{"__proto__":{}}]}', '{"__proto__":1,"__proto__":2}']) {
			try { await execute(`out(JSON.parse(${literal(text)}));`); throw new Error('must reject'); } catch (error) { expect(error).toBeInstanceOf(RuntimeError); expect((error as RuntimeError).code).toBe('STDLIB_FORBIDDEN_KEY'); expect((error as RuntimeError).hint).toContain('JSON.stringify'); }
		}
		for (const source of ['Object.fromEntries([["__proto__", 1]])', 'Object.groupBy([1], x => "__proto__")', 'structuredClone(bad)']) await expect(execute(`out(${source});`, { bad: JSON.parse('{"a":{"__proto__":1}}') })).rejects.toMatchObject({ code: 'STDLIB_FORBIDDEN_KEY' });
	});
	test('関数の stringify と循環・共有参照', async () => {
		expect(await execute('let fn = () => 1; out([JSON.stringify(fn), JSON.stringify({a: fn, b: 1}), JSON.stringify([fn])]); let a = {x: 1}; out(JSON.stringify([a, a])); let b = {}; b.self = b; try { JSON.stringify(b); } catch (e) { out([e.name, e.code]); }')).toEqual([[null, '{"b":1}', '[null]'], '[{"x":1},{"x":1}]', ['TypeError', 'STDLIB_JSON_CYCLE']]);
		for (const source of ['() => 1', '{x: [() => 1]}', '{x: Math.abs}', '{x: host}']) await expect(execute(`out(structuredClone(${source}));`, { host: () => 1 })).rejects.toMatchObject({ name: 'DataCloneError', code: 'STDLIB_CLONE_FUNCTION' });
		expect(await execute('let a = {x: 1}; let root = {a: a, b: a}; root.self = root; let copy = structuredClone(root); out([copy !== root, copy.self === copy, copy.a === copy.b, copy.a !== a, deepEqual(root, copy)]);')).toEqual([[true, true, true, true, true]]);
	});
	test('JSON の reviver は後順、null は削除せず source を渡す', async () => {
		const calls: unknown[] = [];
		const values = await execute('out(JSON.parse("{\\"a\\":[1.0,true],\\"b\\":null}", (key, value, context) => observe(key, value, context)));', { observe: async (key: string, value: unknown, context: object) => { calls.push([key, (context as { source?: string }).source ?? null]); return value; } });
		expect(values).toEqual([{ a: [1, true], b: null }]); expect(calls).toEqual([['0', '1.0'], ['1', 'true'], ['a', null], ['b', 'null'], ['', null]]);
		expect(await execute('out(JSON.parse("{\\"a\\":1}", (key, value) => key === "a" ? null : value));')).toEqual([{ a: null }]);
	});
	test('toJSON と replacer は待機して順に呼ぶ', async () => {
		const trace: string[] = [];
		const output = await execute('let a = {toJSON: key => wait("json:" + key, {x: 2})}; out(JSON.stringify({a: a}, (key, value) => wait("replace:" + key, value)));', { wait: async (label: string, value: unknown) => { trace.push('start:' + label); await new Promise(resolve => setTimeout(resolve, 1)); trace.push('end:' + label); return value; } });
		expect(output).toEqual(['{"a":{"x":2}}']); expect(trace).toEqual(['start:replace:', 'end:replace:', 'start:json:a', 'end:json:a', 'start:replace:a', 'end:replace:a', 'start:replace:x', 'end:replace:x']);
	});
	test('groupBy は入力の変更を反映しコールバックを順に待つ', async () => {
		const trace: number[] = [];
		expect(await execute('let a = [1]; out(Object.groupBy(a, (value, index) => { if (index === 0) a.push(2); return wait(value); }));', { wait: async (value: number) => { trace.push(value); return value; } })).toEqual([{ 1: [1], 2: [2] }]); expect(trace).toEqual([1, 2]);
	});
	test('JSON の不正文法は SyntaxError', async () => {
		for (const input of ['', '01', '+1', '1.', '.1', 'NaN', '[1,]', '{"a":1,}', 'true false', '"\\x41"', '"\n"', '{a:1}', '[', '"\\u00xz"']) await expect(execute(`JSON.parse(${literal(input)});`)).rejects.toMatchObject({ name: 'SyntaxError', code: 'STDLIB_JSON_SYNTAX' });
	});
	test('数とエスケープ・キー順・重複キーを保存', async () => {
		for (const text of ['-0', '1e400', '"\\ud800"', '"\\udc00"', '"\\ud83d\\ude00"', '{"b":1,"a":2,"b":3,"2":4,"1":5}', '["\\b\\f\\n\\r\\t\\\\\\\"/"]']) {
			const output = await execute(`out(JSON.stringify(JSON.parse(${literal(text)})));`);
			expect(output).toEqual([JSON.stringify(JSON.parse(text))]);
		}
	});
	test('深い JSON と複製でホストの再帰スタックを使わない', async () => {
		const depth = 2000, json = '['.repeat(depth) + '0' + ']'.repeat(depth);
		expect(await execute('let x = JSON.parse(input); out(JSON.stringify(structuredClone(x)) === input); out(deepEqual(x, structuredClone(x)));', { input: json })).toEqual([true, true]);
	});
	test('例外内部情報は列挙と stringify と clone で漏らさない', async () => {
		const error = new Error('secret');
		expect(await execute('out([Object.keys(err), JSON.stringify(err)]); let e = structuredClone(err); out([e.name, e.message, e.stack, Object.keys(e)]);', { err: error })).toEqual([[[], '{}'], ['Error', 'secret', null, []]]);
	});

	test('疎なホスト配列の clone は拒否し、比較は長さを区別する', async () => {
		await expect(execute('structuredClone(sparse);', { sparse: new Array(3) })).rejects.toMatchObject({ code: 'SPARSE_ARRAY' });
		expect(await execute('out(deepEqual(short, long));', { short: new Array(1), long: new Array(2) })).toEqual([false]);
	});
	test('例外の追加プロパティも禁止値を深く検査する', async () => {
		const fn = Object.assign(new Error('x'), { extra: { child: () => 1 } });
		const proto = Object.assign(new Error('x'), { extra: JSON.parse('{"nested":{"__proto__":1}}') });
		await expect(execute('structuredClone(err);', { err: fn })).rejects.toMatchObject({ code: 'STDLIB_CLONE_FUNCTION' });
		await expect(execute('structuredClone(err);', { err: proto })).rejects.toMatchObject({ code: 'STDLIB_FORBIDDEN_KEY' });
		expect(await execute('let e = structuredClone(err); out([e.message, e.extra, e.cause.message, Object.keys(e)]);', { err: Object.assign(new Error('x', { cause: new Error('y') }), { extra: { a: 1 } }) })).toEqual([['x', null, 'y', []]]);
	});
	test('replacer と toJSON は後続値の変更・削除・配列短縮を反映する', async () => {
		const sources = [
			'let data = {a: 1, b: 2}; reach(); out(JSON.stringify(data, (key, value) => { if (key === "a") data.b = 9; return value; }));',
			'let data = {a: {toJSON: () => { delete data.b; return 1; }}, b: 2}; reach(); out(JSON.stringify(data));',
			'let data = [1, 2, 3]; data[0] = {toJSON: () => { data.length = 1; return 7; }}; reach(); out(JSON.stringify(data));',
			'let data = {a: {toJSON: () => { data.b = 8; data.c = 9; return 1; }}, b: 2}; reach(); out(JSON.stringify(data));',
		];
		const reference = spawnSync(nodeExecutable, ['--input-type=module', '-e', referenceCode], { input: JSON.stringify(sources), encoding: 'utf8' });
		expect(reference.status, reference.stderr).toBe(0);
		const expected = JSON.parse(reference.stdout);
		for (let i = 0; i < sources.length; i++) { const output = await execute(sources[i]!, { reach: () => {} }); expect(expected[i].error).toBe(null); expect(output.map(snapshot)).toEqual(expected[i].output); }
	});

	test('例外の clone は標準名へ正規化して message を文字列にする', async () => {
		for (const name of ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'ReferenceError', 'URIError', 'CustomError', 'AggregateError']) {
			const error = new Error('x'); error.name = name;
			const expectedName = ['CustomError', 'AggregateError'].includes(name) ? 'Error' : name;
			expect(await execute('let e = structuredClone(err); out([e.name, e.message]);', { err: error })).toEqual([[expectedName, 'x']]);
		}
		for (const message of [3, false, null]) {
			const error = new Error(); Object.defineProperty(error, 'message', { value: message, configurable: true, writable: true });
			expect(await execute('out(structuredClone(err).message);', { err: error })).toEqual([String(message)]);
		}
		expect(await execute('out(JSON.stringify(new Error("x"), ["name", "message"]));')).toEqual(['{"name":"Error","message":"x"}']);
	});
	test('deepEqual はキー順を無視し配列順序と関数同一性を区別する', async () => {
		expect(await execute('let fn = () => 1; out([deepEqual({a: 1, b: 2}, {b: 2, a: 1}), deepEqual([1, 2], [2, 1]), deepEqual(0, -0), deepEqual(0/0, 0/0), deepEqual(fn, fn), deepEqual(fn, () => 1)]);')).toEqual([[true, false, false, true, true, false]]);
		for (const value of fc.sample(json, { seed: 424242, numRuns: 100 })) expect(await execute(`let x = ${literal(value)}; out(deepEqual(x, structuredClone(x))); out(deepEqual(x, x));`)).toEqual([true, true]);
	});
});
