import { strict as assert } from 'node:assert';
import { describe, test, vi } from 'vitest';
import { parse } from '../../src/v2/parser/index.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { formatDiagnostic, TonerikoScriptSyntaxError } from '../../src/v2/diagnostics.js';

const forms: [string, (depth: number) => string][] = [
	['配列', n => 'const value = ' + '['.repeat(n) + '1' + ']'.repeat(n)],
	['括弧', n => '('.repeat(n) + '1' + ')'.repeat(n)],
	['オブジェクト', n => 'const value = ' + '{x:'.repeat(n) + '1' + '}'.repeat(n)],
	['ブロック', n => '{'.repeat(n) + ';' + '}'.repeat(n)],
	['関数', n => 'function f(){'.repeat(n) + 'return 1;' + '}'.repeat(n)],
	['アロー関数', n => 'const f = ' + 'x => '.repeat(n) + '1'],
	['型付きアローの既定値', n => 'const f = ' + '(p = '.repeat(n) + '1' + '): number => p'.repeat(n)],
	['配列の分割代入', n => 'let ' + '['.repeat(n) + 'x' + ']'.repeat(n) + ' = data'],
	['オブジェクトの分割代入', n => 'let ' + '{x:'.repeat(n) + 'x' + '}'.repeat(n) + ' = objectData'],
	['括弧付きの型注釈', n => 'let x: ' + '('.repeat(n) + 'number' + ')'.repeat(n) + ' = 1'],
	['オブジェクトの型注釈', n => 'let x: ' + '{x:'.repeat(n) + 'number' + '}'.repeat(n) + ' = null'],
	['テンプレート補間', n => '`x${'.repeat(n) + '1' + '}`'.repeat(n)],
	['呼び出し引数', n => 'identity('.repeat(n) + '1' + ')'.repeat(n)],
	['計算するプロパティ', n => 'lookup['.repeat(n) + '0' + ']'.repeat(n)],
	['ifの本体', n => 'if (true) '.repeat(n) + ';'],
	['switch', n => 'switch (0) { case 0: '.repeat(n) + ';' + '}'.repeat(n)],
	['条件式の真の枝', n => 'true ? '.repeat(n) + '1' + ' : 0'.repeat(n)],
];

function globals(depth: number) {
	let data: unknown = 1;
	let objectData: unknown = 1;
	for (let i = 0; i < depth; i++) { data = [data]; objectData = { x: objectData }; }
	return { data, objectData, identity: (value: unknown) => value, lookup: { 0: 0 } };
}

const chains: [string, (size: number) => string, unknown][] = [
	['加算', n => 'out(' + Array(n).fill('1').join(' + ') + ')', 10_000],
	['文字列の連結', n => 'let x = "a"; out((' + Array(n).fill('x').join(' + ') + ').length)', 10_000],
	['論理積', n => 'out(' + Array(n).fill('true').join(' && ') + ')', true],
	['null合体', n => 'out(' + Array(n).fill('null').join(' ?? ') + ' ?? 1)', 1],
	['メンバー', n => 'out(chain' + '.next'.repeat(n) + ' === chain)', true],
	['呼び出し', n => 'out(next' + '()'.repeat(n) + ' === next)', true],
	['optional chaining', n => 'out(null' + '?.next'.repeat(n) + ')', null],
	['else if', n => 'let r = -1; ' + Array.from({ length: n }, (_, i) => `if (${i} === ${n - 1}) r = ${i}; else `).join('') + 'r = -2; out(r)', 9_999],
	['条件式', n => 'out(' + Array.from({ length: n }, (_, i) => `${i} === ${n - 1} ? ${i} : `).join('') + '-1)', 9_999],
];

describe('構文の深さの上限', () => {
	test('節を作るたびに Object.values で部分木の深さを調べ直さない', () => {
		const source = Array.from({ length: 50 }, (_, i) => `function f${i}(a: number, b: string = "x"): string { let r = []; for (const x of [a, a + 1, a * 2]) { if (x > 3 && b !== "" || x === 0) { r.push(b + x); } else { r.push(b); } } return r.length > 1 ? r[0] : b; }`).join('\n');
		const values = vi.spyOn(Object, 'values');
		try {
			assert.equal(parse(source).program.body.length, 50);
			assert.equal(values.mock.calls.length, 0);
		} finally { values.mockRestore(); }
	});
	test('型付きアローの試し読みでも引数の既定値に関数の一段を数える', () => {
		const source = (depth: number) => 'const f = (p = ' + '['.repeat(depth) + '1' + ']'.repeat(depth) + '): number => p';
		assert.doesNotThrow(() => parse(source(255)));
		assert.throws(() => parse(source(256)), { code: 'NESTING_TOO_DEEP' });
	});
	for (const [name, source] of forms) {
		test(`${name}の入れ子256段を読み評価でき、257段は拒否する`, async () => {
			const program = parse(source(256)).program;
			await new Interpreter(globals(256), { maxSteps: 1_000_000 }).exec(program);
			assert.throws(() => parse(source(257)), error => error instanceof TonerikoScriptSyntaxError && error.code === 'NESTING_TOO_DEEP');
		});
	}
	for (const [name, source, expected] of chains) {
		test(`${name}の10000項の連鎖を読み評価できる`, async () => {
			const output: unknown[] = [];
			const chain: { next?: unknown } = {}; chain.next = chain;
			const next = () => next;
			await new Interpreter({ chain, next, out: (value: unknown) => { output.push(value); } }, { maxSteps: 1_000_000 }).exec(parse(source(10_000)).program);
			assert.deepEqual(output, [expected]);
		});
	}
	for (const [name, source] of [
		['単項演算', (n: number) => '!'.repeat(n) + 'true'],
		['右結合の演算', (n: number) => '1 ** '.repeat(n) + '1'],
	] as const) {
		test(`${name}の別上限1024段を読み評価でき、超過は拒否する`, async () => {
			await new Interpreter({}, { maxSteps: 100_000 }).exec(parse(source(1024)).program);
			for (const size of [1025, 10_000]) assert.throws(() => parse(source(size)), { code: 'NESTING_TOO_DEEP' });
		});
	}
	for (const source of [
		'!'.repeat(1024) + '('.repeat(256) + 'true' + ')'.repeat(256),
		'('.repeat(256) + '!'.repeat(1024) + 'true' + ')'.repeat(256),
	]) {
		test(`真の入れ子と演算の別上限を組み合わせて評価する ${source[0]}`, async () => {
			await new Interpreter({}, { maxSteps: 100_000 }).exec(parse(source).program);
		});
	}
	test('4000段の配列を位置付きの日英の診断で拒否する', () => {
		assert.throws(() => parse(forms[0]![1](4_000)), error => {
			assert.ok(error instanceof TonerikoScriptSyntaxError);
			assert.equal(error.code, 'NESTING_TOO_DEEP');
			assert.equal(error.pos.line, 1);
			assert.ok(error.pos.column > 1 && error.pos.column < 300);
			assert.match(formatDiagnostic(error, 'ja'), /入れ子が深すぎます/);
			assert.match(formatDiagnostic(error, 'en'), /nesting is too deep/);
			return true;
		});
	});
});
