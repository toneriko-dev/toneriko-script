import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { nodeExecutable } from '../../scripts/v2-node.mjs';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

const keyCases = [
	['分割代入の宣言', 'const {[key]: x} = source;'],
	['分割代入の代入', 'let x; ({[key]: x} = source);'],
	['オブジェクトリテラル', 'const o = {[key]: rhs()};'],
	['in', 'out(key in source);'],
	['delete', 'delete source[key];'],
] as const;

describe('計算するキーは原型の変換処理を呼ばずに検査する', () => {
	for (const [name, source] of keyCases) {
		test(name, async () => {
			let getterCalls = 0;
			let methodCalls = 0;
			let valueCalls = 0;
			const prototype = Object.defineProperty({}, 'toString', {
				get() { getterCalls++; return () => { methodCalls++; return 'x'; }; },
			});
			const interpreter = new Interpreter({ key: Object.create(prototype), source: { x: 7 }, out: () => {}, rhs: () => { valueCalls++; return 1; } });
			await expect(interpreter.exec(parse(source).program)).rejects.toMatchObject({ code: 'INVALID_PROPERTY_KEY' });
			expect(getterCalls).toBe(0);
			expect(methodCalls).toBe(0);
			expect(valueCalls).toBe(0);
		});
	}
});

const causeCases = [
	['数', 'const e = new Error("x", {cause: 7}); out(e.cause); out("cause" in e);'],
	['null', 'const e = new Error("x", {cause: null}); out(e.cause); out("cause" in e);'],
	['オブジェクトの同一性', 'const cause = {x: 7}; const e = new Error("x", {cause}); out(e.cause === cause);'],
	['cause の列挙と更新と削除', 'const e = new Error("x", {cause: 7}); const {...rest} = e; out("cause" in rest); e.cause = 9; out(e.cause); delete e.cause; out("cause" in e);'],
	['cause が無いオブジェクト', 'const e = new Error("x", {}); out("cause" in e);'],
	['オプション省略', 'const e = new Error("x"); out("cause" in e);'],
	...['null', '7', 'true', '"cause"'].map(value => [`プリミティブ ${value}`, `const e = new Error("x", ${value}); out("cause" in e);`] as const),
] as const;

describe('Error の cause', () => {
	for (const [name, source] of causeCases) {
		test(`Node と同じ値と存在判定: ${name}`, async () => {
			const reference = spawnSync(nodeExecutable, ['--input-type=module', '--eval', `const output = []; const out = x => output.push(x); ${source} console.log(JSON.stringify(output));`], {
				encoding: 'utf8', timeout: 5000,
			});
			expect(reference.status, reference.stderr).toBe(0);
			const output: unknown[] = [];
			await new Interpreter({ out: (value: unknown) => { output.push(value); } }).exec(parse(source).program);
			expect(output).toEqual(JSON.parse(reference.stdout));
		});
	}
	test('原型にだけある cause は使わない', async () => {
		const output: unknown[] = [];
		const options = Object.create({ cause: 7 });
		await new Interpreter({ options, out: (value: unknown) => { output.push(value); } }).exec(parse('const e = new Error("x", options); out("cause" in e); out(e.cause);').program);
		expect(output).toEqual([false, null]);
	});
	test('原型の cause getter を呼ばない', async () => {
		let calls = 0;
		const options = Object.create(Object.defineProperty({}, 'cause', { get() { calls++; return 7; } }));
		const output: unknown[] = [];
		await new Interpreter({ options, out: (value: unknown) => { output.push(value); } }).exec(parse('const e = new Error("x", options); out("cause" in e);').program);
		expect(calls).toBe(0);
		expect(output).toEqual([false]);
	});
	test('自分の undefined の cause は null にするが存在を保つ', async () => {
		const output: unknown[] = [];
		await new Interpreter({ options: { cause: undefined }, out: (value: unknown) => { output.push(value); } }).exec(parse('const e = new Error("x", options); out("cause" in e); out(e.cause);').program);
		expect(output).toEqual([true, null]);
	});
});

test('計算する代入先のキー検証は右辺の評価より先に行う', async () => {
	let calls = 0;
	const interpreter = new Interpreter({ obj: {}, key: {}, rhs: () => { calls++; return 1; } });
	await expect(interpreter.exec(parse('obj[key] = rhs();').program)).rejects.toMatchObject({ code: 'INVALID_PROPERTY_KEY' });
	expect(calls).toBe(0);
});
