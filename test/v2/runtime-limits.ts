import { test, expect } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

for (const text of ['a'.repeat(10000), '👍🏽'.repeat(10000), '\r\n'.repeat(10000)]) {
	test(`長い文字列の初回分割でも途中で譲る ${text.length}`, async () => {
		let clock = 0;
		let yields = 0;
		const output: unknown[] = [];
		const interpreter = new Interpreter({ text, out: (x: unknown) => { output.push(x); } }, {
			now: () => ++clock, yieldInterval: 1, maxBusyTime: 100000,
			yieldToHost: async () => { yields++; },
		});
		await interpreter.exec(parse('out(text.length); out(text[9999]);').program);
		expect(output).toEqual([10000, text.startsWith('a') ? 'a' : text.startsWith('\r') ? '\r\n' : '👍🏽']);
		expect(yields).toBeGreaterThan(100);
	});
}

test('書記素の分割途中に abort すると後続と finally を実行しない', async () => {
	let clock = 0;
	let yields = 0;
	const output: unknown[] = [];
	const interpreter = new Interpreter({ text: '👍🏽'.repeat(10000), out: (x: unknown) => { output.push(x); } }, {
		now: () => ++clock, yieldInterval: 1, maxBusyTime: 100000,
		yieldToHost: async () => { if (++yields === 2) interpreter.abort(); },
	});
	await expect(interpreter.exec(parse('try { out(text.length); } finally { out("finally"); }').program)).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' });
	expect(output).toEqual([]);
});

test('Error の同名束縛を無視しない', async () => {
	const output: unknown[] = [];
	await new Interpreter({ out: (x: unknown) => { output.push(x); } }).exec(parse('const Error = 1; try { new Error("x"); out("success"); } catch(e) { out(e.name); }').program);
	expect(output).toEqual(['TypeError']);
});

test('未対応の関数プロパティは異なる値を返さずエラーにする', async () => {
	for (const source of ['function f(a,b) {} out(f.length);', 'function f() {} out(f.name);', 'const f = () => 1; out("length" in f);']) {
		await expect(new Interpreter({ out: () => {} }).exec(parse(source).program)).rejects.toMatchObject({ code: 'UNSUPPORTED_VALUE' });
	}
});


test('負数や整数でない数の配列添字も範囲外にする', async () => {
	for (const index of ['-1', '1.5', '0/0', '1/0', '"-1"']) {
		await expect(new Interpreter({ out: () => {} }).exec(parse(`out([1][${index}]);`).program)).rejects.toMatchObject({ code: 'ARRAY_INDEX_OUT_OF_RANGE' });
	}
});

for (const source of ['const { length: n } = s;', 'const [...rest] = a;', 'const b=[]; b.push(...a);', 'try { fail(); } catch(e) { const x=[...e]; }']) {
	test(`大量の要素処理でも一定間隔で譲る: ${source}`, async () => {
		let clock = 0;
		let previous = 0;
		let maxGap = 0;
		const a = Array.from({ length: 6400 }, () => 1);
		const interpreter = new Interpreter({ s: 'a'.repeat(6400), a, fail: () => Promise.reject(a) }, {
			now: () => ++clock, yieldInterval: 1, maxBusyTime: 100000,
			yieldToHost: async () => {
				maxGap = Math.max(maxGap, interpreter.stepCount - previous);
				previous = interpreter.stepCount;
			},
		});
		await interpreter.exec(parse(source).program);
		expect(previous).toBeGreaterThan(0);
		expect(maxGap).toBeLessThan(150);
	});
}

test('message を持つ辞書の reject は同じ辞書として catch する', async () => {
	const token = { message: 'bad', detail: 42 };
	const output: unknown[] = [];
	await new Interpreter({ token, fail: () => Promise.reject(token), out: (x: unknown) => { output.push(x); } }).exec(parse('try { fail(); } catch(e) { out(e === token); out(e.detail); out(e.message); }').program);
	expect(output).toEqual([true, 42, 'bad']);
});

test.each(['throw 3;', 'throw new Error("bad");', 'fail();'])('未捕捉例外の公開診断にコードと位置を付ける: %s', async source => {
	await expect(new Interpreter({ fail: () => Promise.reject(7) }).exec(parse(`\n\n${source}`).program)).rejects.toMatchObject({ code: 'UNCAUGHT_EXCEPTION', pos: { line: 3, column: 1 } });
});
