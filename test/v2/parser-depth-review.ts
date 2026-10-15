import { strict as assert } from 'node:assert';
import { describe, test, vi } from 'vitest';
import { parse } from '../../src/v2/parser/index.js';
import { Scanner } from '../../src/v2/parser/scanner.js';
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

// 各段が全優先順位を含んでも、演算子の数は再帰のフレームを増やしません。
const operators = 'true || false && 0 === 1 < 2 + 3 * 1 ** - ';
const mixedForms: [string, (depth: number) => string][] = [
	['全優先順位を含む括弧', n => (operators + '(').repeat(n) + '1' + ')'.repeat(n)],
	['全優先順位を含む配列', n => ('[' + operators).repeat(n) + '1' + ']'.repeat(n)],
	['全優先順位を含む呼び出し', n => ('identity(' + operators).repeat(n) + '1' + ')'.repeat(n)],
	['全優先順位を含む型付きアローの既定値', n => 'const f = ' + ('(p: number = false ? ' + operators + '1 : ').repeat(n - 1) + '(p: number = 1): number => p' + '): number => p'.repeat(n - 1)],
	['全優先順位を含むテンプレート', n => ('`${' + operators).repeat(n) + '1' + '}`'.repeat(n)],
	['全優先順位と構文を混ぜた入れ子', n => {
		const pairs: [string, string, number][] = [['(' + operators, ')', 1], ['[' + operators, ']', 1], ['identity(' + operators, ')', 1], ['`${' + operators, '}`', 1], ['(([p]: number[] = false ? ' + operators + '1 : ', '): number => p)', 3]];
		let prefix = '', suffix = '';
		for (let i = 0, depth = 0; depth < n; i++) {
			const pair = pairs[i % pairs.length]!;
			if (depth + pair[2] > n || (pair[2] === 3 && depth + 3 === n)) { prefix += '('; suffix = ')' + suffix; depth++; }
			else { prefix += pair[0]; suffix = pair[1] + suffix; depth += pair[2]; }
		}
		return prefix + '1' + suffix;
	}],
];

function evaluatedMixed(depth: number): string {
	const pairs: [string, string, number][] = [
		['false || true && (0 === 1 < 2 + 3 * 1 ** -1 ? null : ', ')', 1],
		['[', '][0]', 1], ['identity(', ')', 1], ['`${', '}`', 1],
		['((p: string = ', '): string => p)()', 2],
		['(([p]: string[] = [', ']): string => p)()', 4],
	];
	let prefix = '', suffix = '';
	for (let i = 0, used = 0; used < depth - 1; i++) {
		const pair = pairs[i % pairs.length]!;
		if (used + pair[2] > depth - 1) { prefix += '('; suffix = ')' + suffix; used++; }
		else { prefix += pair[0]; suffix = pair[1] + suffix; used += pair[2]; }
	}
	return prefix + 'probe()' + suffix;
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
	for (const [name, source] of [
		['べき乗', (outer: number, inner: number) => '1 ** '.repeat(outer) + '(' + '1 ** '.repeat(inner) + '1)'],
		['単項', (outer: number, inner: number) => '!'.repeat(outer) + '(' + '!'.repeat(inner) + 'true)'],
		['単項とべき乗', (outer: number, inner: number) => '!'.repeat(outer) + '(' + '1 ** '.repeat(inner) + '1)'],
	] as const) {
		test(`${name}は括弧をまたいだ経路の合計1024段まで`, () => {
			const program = parse(source(512, 512)).program;
			assert.doesNotThrow(() => structuredClone(program));
			assert.doesNotThrow(() => JSON.stringify(program));
			assert.throws(() => parse(source(512, 513)), { code: 'NESTING_TOO_DEEP' });
		});
	}
	test('左の括弧のべき乗も経路の合計に含める', () => {
		assert.doesNotThrow(() => parse('(' + '1 ** '.repeat(1023) + '1) ** 1'));
		assert.throws(() => parse('(' + '1 ** '.repeat(1024) + '1) ** 1'), { code: 'NESTING_TOO_DEEP' });
	});
	test('隣り合う別々の式の単項演算は合算しない', () => {
		assert.doesNotThrow(() => parse('!'.repeat(1024) + 'true; ' + '!'.repeat(1024) + 'true;'));
	});

	for (const [engine, error] of [
		['V8', new RangeError('Maximum call stack size exceeded')],
		['SpiderMonkey', Object.assign(new Error('too much recursion'), { name: 'InternalError' })],
		['JSC', new RangeError('Maximum call stack size exceeded.')],
	] as const) {
		test(`${engine}のスタック溢れは最後の防御で構文エラーにする`, () => {
			const next = vi.spyOn(Scanner.prototype, 'next').mockImplementation(() => { throw error; });
			try { assert.throws(() => parse('1'), { code: 'NESTING_TOO_DEEP' }); }
			finally { next.mockRestore(); }
		});
	}
	test('スタック溢れの判定に正規表現を使わない', () => {
		const next = vi.spyOn(Scanner.prototype, 'next').mockImplementation(() => { throw new RangeError('Maximum call stack size exceeded'); });
		const original = RegExp.prototype.test;
		const inspect = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, value: string) {
			if (this.source === 'stack|recursion') throw new SyntaxError('Invalid regular expression: Stack overflow');
			return original.call(this, value);
		});
		try { assert.throws(() => parse('1'), { code: 'NESTING_TOO_DEEP' }); }
		finally { inspect.mockRestore(); next.mockRestore(); }
	});
	test('型付きアローの試し読み中のスタック溢れを別の構文エラーに置き換えない', () => {
		const original = Object.hasOwn;
		let raised = 0;
		const own = vi.spyOn(Object, 'hasOwn').mockImplementation((object, key) => {
			if (key === 'marker' && raised++ === 0) throw new RangeError('Maximum call stack size exceeded');
			return original(object, key);
		});
		try { assert.throws(() => parse('(p = marker): number => p'), { code: 'NESTING_TOO_DEEP' }); }
		finally { own.mockRestore(); }
	});
	test('スタック溢れ以外のRangeErrorを深さの診断に置き換えない', () => {
		const error = new RangeError('Invalid string length');
		const next = vi.spyOn(Scanner.prototype, 'next').mockImplementation(() => { throw error; });
		try { assert.throws(() => parse('1'), actual => actual === error); }
		finally { next.mockRestore(); }
	});

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
	test('混合256段の受理と257段の拒否はスタック溢れの変換に頼らない', () => {
		const original = String.prototype.includes;
		let fallbacks = 0;
		const inspect = vi.spyOn(String.prototype, 'includes').mockImplementation(function (this: string, value: string, position?: number) {
			if (value === 'stack' || value === 'recursion') fallbacks++;
			return original.call(this, value, position);
		});
		try {
			const source = mixedForms[5]![1];
			assert.doesNotThrow(() => parse(source(256)));
			assert.throws(() => parse(source(257)), { code: 'NESTING_TOO_DEEP' });
			assert.equal(fallbacks, 0);
		} finally { inspect.mockRestore(); }
	});
	test('混合256段の評価で最も内側の呼び出しに一度到達する', async () => {
		let reached = 0;
		await new Interpreter({ identity: (value: unknown) => value, probe: () => { reached++; return 1; } }, { maxSteps: 1_000_000 }).exec(parse(evaluatedMixed(256)).program);
		assert.equal(reached, 1);
		assert.throws(() => parse(evaluatedMixed(257)), { code: 'NESTING_TOO_DEEP' });
	});
	for (const [name, source] of mixedForms) {
		test(`${name}の256段を読み評価でき、257段は明示的な上限で拒否する`, async () => {
			await new Interpreter(globals(256), { maxSteps: 1_000_000 }).exec(parse(source(256)).program);
			assert.throws(() => parse(source(257)), error => {
				assert.ok(error instanceof TonerikoScriptSyntaxError);
				assert.equal(error.code, 'NESTING_TOO_DEEP');
				return true;
			});
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
		'1 ** '.repeat(1024) + '('.repeat(256) + '1' + ')'.repeat(256),
		'true || ' + '1 ** '.repeat(500) + ('[' + operators).repeat(254) + '1' + ']'.repeat(254),
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
