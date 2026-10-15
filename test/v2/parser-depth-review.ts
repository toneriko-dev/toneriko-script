import { strict as assert } from 'node:assert';
import { describe, test } from 'vitest';
import { parse } from '../../src/v2/parser/index.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { formatDiagnostic, TonerikoScriptSyntaxError } from '../../src/v2/diagnostics.js';

const forms: [string, (depth: number) => string][] = [
	['配列', n => 'out(' + '['.repeat(n) + ']'.repeat(n) + '.length)'],
	['括弧', n => '('.repeat(n) + '1' + ')'.repeat(n)],
	['オブジェクト', n => '(' + '{x:'.repeat(n) + '1' + '}'.repeat(n) + ')'],
	['ブロック', n => '{'.repeat(n) + ';' + '}'.repeat(n)],
	['関数', n => 'function f(){'.repeat(n) + 'return 1;' + '}'.repeat(n)],
	['アロー関数', n => 'const f = ' + 'x => '.repeat(n) + '1'],
	['型付きアローの条件式', n => 'x = ' + 'a ? (p): number => '.repeat(n) + '1' + ' : y'.repeat(n)],
	['型付きアローの既定値', n => 'x = ' + '(p = '.repeat(n) + '1' + '): number => p'.repeat(n)],
	['単項式', n => '!'.repeat(n) + 'true'],
	['右結合の演算', n => '1 ** '.repeat(n) + '1'],
	['左結合の演算', n => '1 + '.repeat(n) + '1'],
	['プロパティの連鎖', n => 'o' + '.x'.repeat(n)],
	['条件式', n => 'true ? 1 : '.repeat(n) + '1'],
	['if', n => 'if (true) '.repeat(n) + ';'],
	['分割代入', n => 'let ' + '['.repeat(n) + 'x' + ']'.repeat(n) + ' = []'],
	['括弧付きの型注釈', n => 'let x: ' + '('.repeat(n) + 'number' + ')'.repeat(n)],
	['配列の型注釈', n => 'let x: number' + '[]'.repeat(n)],
	['オブジェクトの型注釈', n => 'let x: ' + '{x:'.repeat(n) + 'number' + '}'.repeat(n)],
	['テンプレート補間', n => '`x${'.repeat(n) + '1' + '}`'.repeat(n)],
];

describe('構文の深さの上限', () => {
	for (const [name, source] of forms) {
		test(`${name}を再帰上限より前に構文エラーにする`, () => {
			assert.doesNotThrow(() => parse(source(24)));
			assert.throws(() => parse(source(1_000)), error => error instanceof TonerikoScriptSyntaxError && error.code === 'NESTING_TOO_DEEP');
		});
	}
	test('深さ256の構文木を同期評価でき、次の深さは拒否する', async () => {
		const output: unknown[] = [];
		const accepted = 'out(' + '1 + '.repeat(252) + '1)';
		await new Interpreter({ out: (value: unknown) => { output.push(value); } }).exec(parse(accepted).program);
		assert.deepEqual(output, [253]);
		assert.throws(() => parse('out(' + '1 + '.repeat(253) + '1)'), { code: 'NESTING_TOO_DEEP' });
	});
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
