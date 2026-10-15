import { nodeExecutable } from '../../scripts/v2-node.mjs';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

const cases: [string, string, unknown[]][] = [
	['配列の既定値より前に代入先を決める', `
		let original = {}; let replacement = {}; let target = original;
		function fallback() { target = replacement; return 7; }
		[target.x = fallback()] = [];
		out(original.x == null); out(replacement.x == null);
	`, [false, true]],
	['オブジェクトの既定値より前に代入先を決める', `
		let original = {}; let replacement = {}; let target = original;
		function fallback() { target = replacement; return 7; }
		({x: target.x = fallback()} = {});
		out(original.x == null); out(replacement.x == null);
	`, [false, true]],
	['計算した代入先のキーを既定値より前に一度だけ評価する', `
		const target = {}; let calls = 0; let key = "before";
		function getKey() { calls++; return key; }
		function fallback() { key = "after"; return 7; }
		[target[getKey()] = fallback()] = [];
		out(target.before); out(target.after == null); out(calls);
	`, [7, true, 1]],
	['配列の各値は代入時に読む', `
		let a = [1, 2]; let x;
		[a[1], x] = a; out(x);
	`, [1]],
	['オブジェクトの元値より前に代入先を評価する', `
		const source = {x: 1}; const dest = {};
		function target() { source.x = 2; return dest; }
		({x: target().x} = source); out(dest.x);
	`, [2]],
	['配列の元値より前に代入先を評価する', `
		const source = [1]; const dest = {};
		function target() { source[0] = 2; return dest; }
		[target().x] = source; out(dest.x);
	`, [2]],
	['配列 rest は先行する代入の変更を読む', `
		let source = [1, 2]; let dest = {};
		function target() { source[1] = 3; return dest; }
		[target().x, ...dest.rest] = source; out(dest.rest[0]);
	`, [3]],
	['配列 rest の代入先は残りの値を集める前に評価する', `
		const source = [1]; const dest = {};
		function target() { source[0] = 2; return dest; }
		[...target().rest] = source; out(dest.rest[0]);
	`, [2]],
	['オブジェクト rest の代入先は値を集める前に評価する', `
		const source = {x: 1}; const dest = {};
		function target() { source.x = 2; return dest; }
		({...target().rest} = source); out(dest.rest.x);
	`, [2]],
	['終了済みの配列反復は既定値で要素を追加しても再開しない', `
		const source = [];
		function fallback() { source.push(1); return 9; }
		const [a = fallback(), b] = source; out(a); out(b == null);
	`, [9, true]],
	['括弧で囲んだ optional メンバーの受け手を保つ', `
		let a = []; (a?.push)(3); out(a[0]);
	`, [3]],
	['括弧で囲んだ optional メンバーの optional 呼び出し', `
		let a = []; (a?.push)?.(3); out(a[0]);
	`, [3]],
	['通常の括弧付きメソッドの受け手を保つ', `
		let a = []; (a.push)(3); out(a[0]);
	`, [3]],
	['括弧付き optional メンバーの欠如値は optional 呼び出しで短絡する', `
		let a = null; let calls = 0;
		function argument() { calls++; return 3; }
		(a?.push)?.(argument()); out(calls);
	`, [0]],
	['括弧の外の通常呼び出しは短絡せず引数を評価する', `
		let a = null; let calls = 0;
		function argument() { calls++; return 3; }
		try { (a?.push)(argument()); } catch (error) { out(error.name); }
		out(calls);
	`, ['TypeError', 1]],
	['既定引数の閉包は本体の関数宣言を見ない', `
		function f(a = () => b, b = 1) { function b() {} b = 2; return a(); }
		out(f());
	`, [1]],
	['for の初期化式の閉包は周回の束縛と分かれる', `
		let functions = [];
		for (let i = 0, f = () => i; i < 3; i++) { functions.push(f); }
		out(functions[0]()); out(functions[2]());
	`, [0, 0]],
	['for の更新式の閉包は次の本体と束縛を共有する', `
		let functions = [];
		for (let i = 0; i < 3; functions.push(() => i)) { i++; }
		out(functions[0]()); out(functions[2]());
	`, [2, 3]],
];

describe('v2 の評価順と束縛の回帰検査', () => {
	for (const [name, source, expected] of cases) {
		test(name, async () => {
			const reference = spawnSync(nodeExecutable, ['--input-type=module', '--eval', `const output = []; const out = value => output.push(value);\n${source}\nconsole.log(JSON.stringify(output));`], { encoding: 'utf8', timeout: 5000 });
			expect(reference.error).toBeUndefined();
			expect(reference.status, reference.stderr).toBe(0);
			expect(JSON.parse(reference.stdout)).toEqual(expected);
			const actual: unknown[] = [];
			await new Interpreter({ out: (value: unknown) => { actual.push(value); } }).exec(parse(source).program);
			expect(actual).toEqual(expected);
		});
	}
});
