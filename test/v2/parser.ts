import { nodeExecutable } from '../../scripts/v2-node.mjs';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'vitest';
import { parse } from '../../src/v2/parser/index.js';
import { TonerikoScriptSyntaxError, formatDiagnostic } from '../../src/v2/diagnostics.js';
import { messages, runtimeMessages } from '../../src/v2/messages.js';

const accepted = [
	['テンプレート補間をまたいで型引数を読まない', 'const t = `${a < b}${c > (d)}`;'],

	['条件式の単項演算と括弧', 'a ? !(b) : c => d; a ? -(b) : c => d;'],
	['条件式の真側の戻り値型', 'a ? (b): number => b : c;'],
	['条件式の入れ子の戻り値型', 'x = a ? (p): number => b ? (q): number => q : z : y'],
	['条件式の async アローの戻り値型', 'x = a ? async (p): number => p : y'],
	['試し読み後のアロー内の制御文', 'x = a ? (p): number => { label: while (p) { if (p) continue label; break label; } return p; } : y'],
	['試し読み後のアロー内のブロックラベル', 'x = a ? (p): number => { label: { break label; } return p; } : y'],
	['型付きアローを読めない条件式の区切り', 'x = a ? (p) : number => b ? (q) : string => r'],
	['case の式と括弧付きのアロー文', 'switch (k) { case (x): (y) => y; }'],
	['return の次の行のラベル', 'function f() { return\nlabel: {} }'],
	['return の次の行の関数宣言', 'function f() { return\nfunction g() {} }'],
	['return の次の行の async 関数宣言', 'function f() { return\nasync function g() {} }'],

	['型注釈の次の行の空配列', 'let x: string\n[]'],
	['型注釈の改行を含むコメントの後の空配列', 'let x: string /*\n*/ []'],
	['比較と論理式を型引数と混同しない', 'if (a < b && c > (d)) {}'],
	['別の行の比較を型引数と混同しない', 'function f() { if (x < 0) return 0\nif (x > (max - 1)) return max - 1 }'],
	['return の直後に閉じ括弧', 'function f() { return\n}'],
	['return の行コメントの後に閉じ括弧', 'function f() { return // done\n}'],
	['return のブロックコメントの後に閉じ括弧', 'function f() { return /* done\n*/ }'],
	['return の直後に case と default', 'function f() { switch (x) { case 0: return\ncase 1: return\ndefault: return\n} }'],
	['return の直後に else', 'function f() { if (x) return\nelse return; }'],
	['return の直後にセミコロン', 'function f() { return\n; }'],
	['条件式の括弧とアロー関数', 'a ? (b) : c => d;'],
	['条件式の null と引数のないアロー関数', 'const onClick = disabled ? (null) : () => go()'],
	['case の括弧と戻り値のアロー関数', 'function f() { switch (k) { case (1): return x => x } }'],
	['関数宣言の後の空文', 'function f() {};'],
	['if の後の空文', 'if (a) {};'],
	['代入の後の空文', 'x = 1;;'],
	['先頭の空文と async 即時呼び出し', ';(async () => { f() })()'],
	['改行を挟む as の呼び出し', 'foo()\nas(1)'],
	['改行を挟む type の識別子', 'type\nfoo()'],
	['改行を挟む match の識別子', 'const m = match\nfoo()'],
	['in の左辺の match', 'match in o'],
	['改行を挟む each の識別子', 'x = each\nlet y = 1'],
	['入れ子のループラベル', 'a: b: while (1) { continue a; break b; }'],
	['入れ子のブロックラベル', 'a: b: { break a; }'],
	['先頭の区切りを持つ合併型', 'let x: | number'],

	['文脈キーワードと通常の識別子', 'const each = x => x; each(xs); const match = x => x; match(xs); match;'],
	['継承プロパティと同名の識別子', 'const constructor = toString; constructor(); const o = { constructor, toString };'],
	['代入パターン中のメンバー参照', '([obj.x = 1, ...obj.rest] = xs); ({ a: obj.x, ...obj.rest } = data);'],
	['配列 rest の入れ子の既定値', '([...[x = 1]] = arr);'],
	['括弧付き async の for of', 'for ((async) of xs) {}'],
	['空のプログラム', ''],
	['const と let', 'const x = 1; let y; let a = 1, b = 2;'],
	['関数宣言', 'function f(x) { return x; }'],
	['既定値と残り引数', 'function f(x = 1, ...xs) { return xs; }'],
	['配列の束縛', 'const [a, , b = 2, ...rest] = xs;'],
	['オブジェクトの束縛', 'const { a, b: c = 2, ...rest } = obj;'],
	['引数の分割代入', 'function f({ x }, [y = 1]) { return x + y; }'],
	['if と else', 'if (ok) { f(); } else if (other) g(); else h();'],
	['for', 'for (let i = 0; i < 3; i++) { f(i); }'],
	['空の for 節', 'for (;;) { break; }'],
	['for の代入', 'for (i = 0; i < 3; i += 1) f(i);'],
	['for of', 'for (const x of xs) { if (x) continue; }'],
	['for of の分割代入', 'for (const [k, v] of entries) f(k, v);'],
	['for of の代入先の既定値', 'for ([a = 1] of xs) {} for ({ a = 1 } of xs) {}'],
	['while', 'while (ok) { break; }'],
	['do while', 'do { f(); } while (ok);'],
	['ラベル付き for', 'outer: for (;;) { continue outer; }'],
	['ラベル付き while', 'outer: while (ok) { break outer; }'],
	['ラベル付き do', 'outer: do { break outer; } while (ok);'],
	['ラベル付きブロック', 'block: { break block; }'],
	['switch', 'switch (x) { case 1: f(); break; case 2: case 3: g(); break; default: h(); }'],
	['try catch finally', 'try { f(); } catch (e) { g(e); } finally { h(); }'],
	['引数を省く catch', 'try { f(); } catch { g(); }'],
	['try finally', 'try { f(); } finally { g(); }'],
	['throw', 'throw new Error("message");'],
	['return の値の省略', 'function f() { return; }'],
	['基本リテラル', 'const xs = [1, "a", true, false, null];'],
	['数の表記', 'const xs = [1_000, 0xff, 0b10, 0o77, 1e3, .5, 1., 1.2e-3];'],
	['文字列のエスケープ', 'const x = "\\n\\r\\t\\b\\f\\v\\0\\x41\\u0042\\u{1f600}";'],
	['空のテンプレート', 'const x = ``;'],
	['テンプレート', 'const x = `a${x + 1}b${y}c`;'],
	['入れ子のテンプレート', 'const x = `a${`b${x}`}c`;'],
	['配列の穴とスプレッド', 'const xs = [1, , ...ys, 3,];'],
	['オブジェクトの各プロパティ', 'const o = { a: 1, b, [k]: v, "s": 2, 3: true, ...other, };'],
	['単一引数のアロー', 'const f = x => x + 1;'],
	['アローのブロック', 'const f = (x, y = 1, ...xs) => { return x + y; };'],
	['アローが返すオブジェクト', 'const f = () => ({ x: 1 });'],
	['条件演算子のアローと括弧付きの即時呼び出し', 'true ? x => x : y => y; (x => x)();'],
	['単項演算子', '!x; -x; +x; typeof x; delete obj.x;'],
	['更新文', 'i++; ++i; i--; --i;'],
	['算術演算と優先順位', 'const x = 1 + 2 * 3 ** 2 / 4 % 2 - 1;'],
	['累乗の右結合', 'const x = 2 ** 3 ** 2;'],
	['比較演算子', 'a === b; a !== b; a < b; a <= b; a > b; a >= b; "x" in obj;'],
	['null の緩い比較', 'x == null; null == x; x != null; null != x;'],
	['論理演算子', 'a && b || c; a ?? b; (a ?? b) || c; a ?? (b && c);'],
	['条件演算子', 'a ? b:c; a ? b : c ? d : e;'],
	['代入文', 'x = 1; x += 1; x -= 1; x *= 2; x /= 2; x %= 2; x **= 2; x ??= 1;'],
	['プロパティへの代入', 'obj.x = 1; obj[k] += 2;'],
	['分割代入文', '([a, b = 1, ...rest] = xs); ({ x, y: z } = obj);'],
	['呼び出しとスプレッド', 'f(1, ...xs); obj.f(x); obj[k](x);'],
	['オプショナルチェーン', 'obj?.x; obj?.[k]; f?.(x); obj?.x.y?.(x);'],
	['async 関数', 'async function f() { return await g(); }'],
	['async アロー', 'const f = async x => await g(x); const h = async () => { return await f(1); };'],
	['基本型注釈', 'let n: number; let s: string; let b: boolean; let z: null; let a: any;'],
	['配列と合併型', 'let xs: (string | null)[]; let ys: number[][];'],
	['オブジェクト型', 'let o: { a: number; b?: string; c: { x: boolean } };'],
	['関数型と void', 'let f: Function; function g(): void {}'],
	['引数の型と任意引数', 'function f(x: number = 1, y?: string): string | null { return y; }'],
	['アローの型', 'const f = (x: number): number => x;'],
	['型付きアローと条件式の区別', 'const f = (x): number => x; const value = true ? (a) : b;'],
	['メタ情報', 'export const meta = { name: "name", version: "1", enabled: true, config: { x: null }, tags: [1, "a"] };'],
	['改行による文の区切り', 'const x = 1\nconst y = 2\nf(x)\ng(y)'],
	['明示的なセミコロンの後の改行', 'f();\n(g)();\n[x].map(f);\n+x;\n-x;'],
	['括弧の中の改行', 'const x = (a\n + b); f(\n x\n);'],
	['条件式の途中の改行', 'const x = a ? b\n + c : d;'],
	['通常のキーとしての __proto__', 'const o = { ["__proto__"]: a, ["__proto__"]: b, __proto__ };'],
	['Object.prototype と同名の識別子', 'const constructor = 1; const toString = 2; const hasOwnProperty = 3; f(constructor, toString, hasOwnProperty);'],
	['コメント', '// a\nconst /* b */ x = 1; /* c\nd */ f(x);'],
	['Unicode の識別子', 'const 名前 = "値"; const \\u0078 = 名前;'],
	['後段に残す検査', 'const x = 1; x = 2; missing(); let y: number = "text";'],
] as const;

function checkLocations(value: unknown): void {
	if (value === null || typeof value !== 'object') return;
	if (Array.isArray(value)) {
		value.forEach(checkLocations);
		return;
	}
	const node = value as Record<string, unknown>;
	if (typeof node['type'] === 'string') {
		const loc = node['loc'] as { start: { line: number; column: number }; end: { line: number; column: number } };
		assert.ok(loc, `${node['type']} の loc`);
		assert.ok(loc.start.line >= 1 && loc.start.column >= 1);
		assert.ok(loc.end.line >= loc.start.line);
		assert.ok(loc.end.column >= 1);
		if (loc.start.line === loc.end.line) assert.ok(loc.end.column >= loc.start.column);
	}
	Object.values(node).forEach(checkLocations);
}

describe('v2 parser: 使える構文', () => {
	for (const [name, source] of accepted) {
		test(name, () => {
			const { program, warnings } = parse(source);
			assert.equal(program.type, 'Program');
			assert.deepEqual(warnings, []);
			checkLocations(program);
		});
	}
});

const rejected = [
	['NULLISH_MIX', 'a ?? b || c;'],
	['UNARY_POWER', '-2 ** 2;'],
	['LOGICAL_ASSIGNMENT', 'a &&= b;'],
	['TAGGED_TEMPLATE', 'f`c`;'],
	['TYPE_DEFINITE_ASSIGNMENT', 'let x!: number;'],
	['TYPE_THIS_PARAMETER', 'function f(this: any) {}'],
	['AISCRIPT_META', '### { name: "x" }'],

	['UNEXPECTED_TOKEN', 'const = 1;'],
	['NESTING_TOO_DEEP', '['.repeat(300) + ']'.repeat(300)],
	['INVALID_NUMBER', 'const x = 1__0;'],
	['INVALID_ESCAPE', 'const x = "\\uZZZZ";'],
	['UNTERMINATED_STRING', 'const x = "text'],
	['UNTERMINATED_COMMENT', '/* comment'],
	['UNTERMINATED_TEMPLATE', 'const x = `text'],
	['LEGACY_OCTAL', 'const x = 077;'],
	['BIGINT', 'const x = 1n;'],
	['REGEXP', 'const x = /a+/;'],
	['CLASS', 'class C {}'],
	['THIS', 'this.x;'],
	['NEW', 'new Thing();'],
	['COLLECTION', 'new Map();'],
	['VAR', 'var x = 1;'],
	['LOOSE_EQUALITY', 'a == b;'],
	['ASSIGNMENT_IN_EXPRESSION', 'if (x = 1) {}'],
	['COMMA_OPERATOR', 'const x = (a, b);'],
	['UPDATE_IN_EXPRESSION', 'const x = a[i++];'],
	['BITWISE', 'x & y;'],
	['FOR_IN', 'for (const k in obj) {}'],
	['EVAL', 'eval("x");'],
	['FUNCTION_CONSTRUCTOR', 'Function("return 1");'],
	['WITH', 'with (obj) {}'],
	['GENERATOR', 'function* f() {}'],
	['SYMBOL', 'Symbol("x");'],
	['ACCESSOR', 'const o = { get x() { return 1; } };'],
	['ARGUMENTS', 'function f() { return arguments; }'],
	['DEBUGGER', 'debugger;'],
	['IMPORT', 'import x from "x";'],
	['PROMISE', 'Promise.resolve(1);'],
	['UNDEFINED', 'const x = undefined;'],
	['FUNCTION_EXPRESSION', 'const f = function () {};'],
	['METHOD_SHORTHAND', 'const o = { f() {} };'],
	['INSTANCEOF', 'x instanceof Thing;'],
	['VOID_OPERATOR', 'void x;'],
	['SUPER', 'super.x;'],
	['YIELD', 'yield x;'],
	['LABELED_FUNCTION', 'label: function f() {}'],
	['INVALID_LABEL', 'label: if (x) {}'],
	['TYPE_ALIAS', 'type T = number;'],
	['TYPE_INTERFACE', 'interface T { x: number }'],
	['TYPE_ENUM', 'enum T { A }'],
	['TYPE_ARGUMENTS', 'function f<T>(x: T) {}'],
	['TYPE_ASSERTION', 'const x = y as number;'],
	['NON_NULL_ASSERTION', 'const x = y!;'],
	['TYPE_ARRAY_GENERIC', 'let x: Array<number>;'],
	['TYPE_RECORD', 'let x: Record<string, number>;'],
	['TYPE_LITERAL', 'let x: "x";'],
	['TYPE_TUPLE', 'let x: [number, string];'],
	['UNSUPPORTED_TYPE', 'let x: Unknown;'],
	['AISCRIPT_VERSION', '/// @ 1.3.0\nlet x = 1'],
	['AISCRIPT_OUTPUT', '<: x'],
	['AISCRIPT_FUNCTION', '@f(x) { x }'],
	['AISCRIPT_NAMESPACE', 'Core:sleep(1)'],
	['AISCRIPT_EACH', 'each let x, xs {}'],
	['AISCRIPT_FOR', 'for let i, 10 {}'],
	['AISCRIPT_EVAL', 'eval { x }'],
	['AISCRIPT_MATCH', 'match x { case 1 => 2 }'],
	['AISCRIPT_IF', 'const x = if a b else c;'],
	['AISCRIPT_POWER', 'x ^ 2;'],
	['NEWLINE_CONTINUATION', 'f()\n(g)();'],
	['NEWLINE_RETURN', 'function f() { return\n1; }'],
	['NEWLINE_ARROW', 'const f = (x)\n=> x;'],
	['NEWLINE_THROW', 'throw\nnew Error("x");'],
	['INVALID_ASSIGNMENT_TARGET', '1 = 2;'],
	['INVALID_META', 'export const meta = { name: f() };'],
	['INVALID_CONTROL_FLOW', 'break;'],
	['ARROW_OBJECT_BODY', 'x => { k: v }'],
	['DUPLICATE_DECLARATION', 'let x; let x;'],
	['TYPEOF_UNDEFINED_COMPARISON', 'typeof x === "undefined"'],
	['STRICT_DELETE_IDENTIFIER', 'delete x'],
	['STRICT_NON_SIMPLE_PARAMETERS', 'function f(x = 1) { "use strict"; }'],
] as const;

function diagnostic(source: string, code: string): void {
	assert.throws(() => parse(source), (error: unknown) => {
		assert.ok(error instanceof TonerikoScriptSyntaxError);
		assert.equal(error.code, code, source);
		assert.ok(error.hint.length > 0);
		assert.equal(typeof error.params, 'object');
		assert.ok(error.pos.line >= 1 && error.pos.column >= 1);
		for (const language of ['ja', 'en'] as const) {
			const formatted = formatDiagnostic(error, language);
			assert.ok(formatted.length > 0);
			assert.ok(!/\{(?:token|name|value)\}/u.test(formatted));
		}
		return true;
	});
}

describe('v2 parser: 専用の診断', () => {
	for (const [code, source] of rejected) test(code, () => diagnostic(source, code));
	test('すべての構文診断 code に入力例がある', () => {
		assert.deepEqual(new Set(rejected.map(([code]) => code)), new Set(Object.keys(messages).filter(code => !Object.hasOwn(runtimeMessages, code))));
	});
});

describe('v2 parser: 診断の境界', () => {
	for (const prefix of ['(', '[', '`', '+', '-', '/']) {
		const tail: Record<string, string> = { '(': '(x);', '[': '[x];', '`': '`x`;', '+': '+ x;', '-': '- x;', '/': '/ x;' };
		test(`前の行を継続する ${prefix}`, () => diagnostic(`f()\n${tail[prefix]}`, 'NEWLINE_CONTINUATION'));
	}
	for (const source of ['new Set();', 'new Date();']) test(source, () => diagnostic(source, 'COLLECTION'));
	for (const source of ['a != b;', 'a == 0;']) test(source, () => diagnostic(source, 'LOOSE_EQUALITY'));
	for (const source of ['a = b = 1;', 'f(a += 1);', 'const x = (a = 1);']) test(source, () => diagnostic(source, 'ASSIGNMENT_IN_EXPRESSION'));
	for (const source of ['const x = ++i;', 'f(i--);']) test(source, () => diagnostic(source, 'UPDATE_IN_EXPRESSION'));
	for (const source of ['x | y;', '~x;', 'x << 1;', 'x >> 1;', 'x >>> 1;']) test(source, () => diagnostic(source, 'BITWISE'));
	for (const source of ['f().then(g);', 'f["then"](g);']) test(source, () => diagnostic(source, 'PROMISE'));
	test('setter', () => diagnostic('const o = { set x(v) {} };', 'ACCESSOR'));
	test('無名の AiScript 関数', () => diagnostic('const f = @(x) { x };', 'AISCRIPT_FUNCTION'));
	test('名前空間の二段の区切り', () => diagnostic('Ui:C:button({});', 'AISCRIPT_NAMESPACE'));
	test('return とコメント内の改行', () => diagnostic('function f() { return /*\n*/ 1; }', 'NEWLINE_RETURN'));
	test('文頭の正規表現', () => diagnostic('/x/.test(s);', 'REGEXP'));
	test('除算の後の正規表現', () => diagnostic('a / /x/;', 'REGEXP'));
	test('最初の診断だけを投げる', () => diagnostic('var x = 1; class C {}', 'VAR'));
	for (const source of ['const x = 0x;', 'const x = 0b2;', 'const x = 1e;', 'const x = 1_;']) test(source, () => diagnostic(source, 'INVALID_NUMBER'));
	for (const source of ['let x: 1;', 'let x: true;']) test(source, () => diagnostic(source, 'TYPE_LITERAL'));
	test('呼び出しの型引数', () => diagnostic('f<number>(1);', 'TYPE_ARGUMENTS'));
	for (const source of ['for (i++; i < 4; i++) {}', 'for (++i; i < 4; i++) {}']) test(source, () => diagnostic(source, 'UPDATE_IN_EXPRESSION'));
	test('async の計算メソッド', () => diagnostic('const o = { async [k]() {} };', 'METHOD_SHORTHAND'));
	test('async のジェネレーターメソッド', () => diagnostic('const o = { async *f() {} };', 'GENERATOR'));
	for (const source of ['const r = x + y => y;', 'const r = !x => x;', 'const f = x => {}.foo;', 'const f = (x) => {}();']) {
		test(source, () => diagnostic(source, 'UNEXPECTED_TOKEN'));
	}
	for (const [code, source] of [['CLASS', 'class "\\uZZZZ"'], ['VAR', 'var "\\uZZZZ"'], ['THIS', 'this "\\uZZZZ"']] as const) {
		test(`先読み先の字句エラーより ${code}`, () => diagnostic(source, code));
	}
	for (const source of ['const x = Mk:api(1);', 'foo(Core:sleep(1));', 'const o = { x: Core:sleep(1) };']) {
		test(source, () => diagnostic(source, 'AISCRIPT_NAMESPACE'));
	}
	test('先読み先の字句エラーより先の構文エラーを返す', () => {
		assert.throws(() => parse('(a + )\n"\\uZZZZ"'), (error: unknown) => {
			assert.ok(error instanceof TonerikoScriptSyntaxError);
			assert.equal(error.code, 'UNEXPECTED_TOKEN');
			assert.deepEqual(error.pos, { line: 1, column: 6 });
			return true;
		});
	});
});

describe('v2 parser: JavaScript の構文制約', () => {
	for (const source of [
		'const x = -a ** 2;',
		'for (async of xs) {}',
		'([...x,] = xs);',
		'({...x,} = obj);',
		'([...x = []] = xs);',
		'({...{x}} = obj);',
		'([x = 1]);',
		'({x = 1});',
		'const x = a ?? b || c;',
		'const x = a && b ?? c;',
		'obj?.x = 1;',
		'obj?.x++;',
		'const [a, ...rest, b] = xs;',
		'const { ...rest, a } = obj;',
		'function f(...rest, x) {}',
		'function f(...rest = []) {}',
		'const x;',
		'throw;',
		'try {}',
		'switch (x) { default: f(); default: g(); }',
		'continue;',
		'outer: { continue outer; }',
		'while (x) { function f() { break; } }',
		'const x = "\\1";',
		'const x = "\\u{110000}";',
		'const x = 0x_1;',
		'const x = 1e_2;',
		'let ...x = y;',
		'try {} catch (...e) {}',
		'const { x: ...y } = z;',
		'const [x: number] = xs;',
		'const { a: b: number } = xs;',
		'const o = { __proto__: a, __proto__: b };',
		'const o = { __proto__: a, "__proto__": b };',
		'const o = { "__proto__": a, "__proto__": b };',
	]) {
		test(source, () => {
			assert.throws(() => parse(source), (error: unknown) => {
				assert.ok(error instanceof TonerikoScriptSyntaxError);
				assert.ok(error.code && error.hint);
				return true;
			});
		});
	}
});

test('コンストラクターの引数を次の行から始めない', () => {
	diagnostic('const error = new Error\n("message");', 'NEWLINE_CONTINUATION');
});

for (const [source, code] of [
	['(Date)();', 'COLLECTION'],
	['Date?.();', 'COLLECTION'],
	['(obj?.then)();', 'PROMISE'],
	['obj?.then?.();', 'PROMISE'],
	['new Error<string>("x");', 'TYPE_ARGUMENTS'],
	['([(x = 1)] = xs);', 'INVALID_ASSIGNMENT_TARGET'],
] as const) {
	test(source, () => diagnostic(source, code));
}


describe('v2 parser: レビュー指摘の境界', () => {
	for (const source of ['a || b ?? c;', 'a && b ?? c;', 'a ?? b && c;']) {
		test(source, () => diagnostic(source, 'NULLISH_MIX'));
	}
	for (const source of ['!x ** 2;', '+x ** 2;', 'typeof x ** 2;']) {
		test(source, () => diagnostic(source, 'UNARY_POWER'));
	}
	for (const [source, code] of [
		['a ||= b;', 'LOGICAL_ASSIGNMENT'],
		['for (a &&= b;;) {}', 'LOGICAL_ASSIGNMENT'],
		['f`a${x}b`;', 'TAGGED_TEMPLATE'],
		['obj.f`c`;', 'TAGGED_TEMPLATE'],
		['let x!: number = 1;', 'TYPE_DEFINITE_ASSIGNMENT'],
		['const f = (this: any) => 1;', 'TYPE_THIS_PARAMETER'],
		['let x: undefined;', 'UNDEFINED'],
		['let x: number | undefined;', 'UNDEFINED'],
		['function f() { return\n', 'UNEXPECTED_TOKEN'],
		['a: b: function f() {}', 'LABELED_FUNCTION'],
		['a: b: { continue a; }', 'INVALID_CONTROL_FLOW'],
		['a: a: while (1) {}', 'INVALID_LABEL'],
		['a: b: if (x) {}', 'INVALID_LABEL'],
		['a: b: c: if (x) {}', 'INVALID_LABEL'],
		['a: b: switch (x) {}', 'INVALID_LABEL'],
		['while (ok) { x = a ? (p): number => { break; } : y }', 'INVALID_CONTROL_FLOW'],
		['outer: while (ok) { x = a ? (p): number => { continue outer; } : y }', 'INVALID_CONTROL_FLOW'],
		['outer: { x = a ? (p): number => { break outer; } : y }', 'INVALID_CONTROL_FLOW'],
	] as const) {
		test(source, () => diagnostic(source, code));
	}
	test('空文を独立したノードとして残す', () => {
		const { program } = parse('x = 1;;');
		assert.deepEqual(program.body.map(node => node.type), ['ExpressionStatement', 'EmptyStatement']);
		assert.deepEqual(program.body[1]!.loc, { start: { line: 1, column: 7 }, end: { line: 1, column: 8 } });
	});
	test('型注釈の後の空配列を次の文として残す', () => {
		const { program } = parse('let x: string\n[]');
		assert.equal(program.body.length, 2);
		const first = program.body[0]!;
		assert.equal(first.type, 'VariableDeclaration');
		if (first.type !== 'VariableDeclaration') assert.fail();
		const id = first.declarations[0]!.id;
		assert.equal(id.type, 'Identifier');
		if (id.type !== 'Identifier') assert.fail();
		assert.equal(id.typeAnnotation!.type, 'KeywordTypeAnnotation');
		assert.deepEqual(first.loc.end, { line: 1, column: 14 });
		assert.equal(program.body[1]!.type, 'ExpressionStatement');
	});
	test('多数の比較を後続行の型引数と混同しない', () => {
		const source = Array.from({ length: 4000 }, (_, index) => `if (x < ${index}) f(x)`).join('\n');
		assert.equal(parse(source).program.body.length, 4000);
	});
	for (const source of [
		'let x: number\n[1, 2].forEach(f)',
		'let x: number /*\n*/ [1].forEach(f)',
		'let x\n[1, 2].forEach(f)',
		'let x: number\n(f)()',
		'let x: number\n+x',
	]) {
		test(`初期値のない宣言の後で文を区切る: ${source}`, () => {
			const { program } = parse(source);
			assert.deepEqual(program.body.map(node => node.type), ['VariableDeclaration', 'ExpressionStatement']);
			const declaration = program.body[0]!;
			if (declaration.type !== 'VariableDeclaration') assert.fail();
			assert.equal(declaration.declarations[0]!.init, null);
		});
	}
	for (const source of [
		'f = () => {}\n+x',
		'f = () => {} /*\n*/ -x',
		'const f = () => {}\n+x',
		'f = async () => {}\n+x',
		'const f = (p = (q): number => q): number => {}\n+x',
	]) {
		test(`ブロック本体のアローの後で文を区切る: ${source}`, () => {
			const { program } = parse(source);
			assert.equal(program.body.length, 2);
			const second = program.body[1]!;
			if (second.type !== 'ExpressionStatement') assert.fail();
			assert.equal(second.expression.type, 'UnaryExpression');
		});
	}
	for (const source of ['f = () => {} +x', 'f = () => {}\n*x']) {
		test(`アローの後に演算子を続けられない: ${source}`, () => diagnostic(source, 'UNEXPECTED_TOKEN'));
	}
	for (const source of [
		'let x: number = 1\n[1, 2].forEach(f)',
		'f = (() => {})\n+x',
		'const f = (p = (q): number => q): number => p\n+x',
	]) {
		test(`実際に前の行を継続する式: ${source}`, () => diagnostic(source, 'NEWLINE_CONTINUATION'));
	}
});

function nested(depth: number, wrap: (body: string) => string): string {
	let source = 'z';
	for (let i = 0; i < depth; i++) source = wrap(source);
	return source;
}

function countNodes(value: unknown, type: string): number {
	let count = 0;
	const pending = [value];
	while (pending.length) {
		const node = pending.pop();
		if (node === null || typeof node !== 'object') continue;
		if ('type' in node && node.type === type) count++;
		pending.push(...Object.values(node));
	}
	return count;
}

describe('v2 parser: 入れ子の試し読みの上限', () => {
	for (const context of ['代入', 'case'] as const) {
		for (const depth of [20, 100]) {
			test(`${context} の型付きアロー ${depth} 段`, () => {
				const source = nested(depth, body => `a ? (p): number => ${body} : y`);
				const wrap = (body: string) => context === '代入' ? `x = ${body}` : `switch (k) { case ${body}: }`;
				parse(wrap(nested(2, body => `a ? (p): number => ${body} : y`)));
				const started = performance.now();
				const { program } = parse(wrap(source));
				const elapsed = performance.now() - started;
				assert.ok(elapsed < 100, `${depth} 段: ${elapsed}ms`);
				assert.equal(countNodes(program, 'ArrowFunctionExpression'), depth);
				assert.equal(countNodes(program, 'ConditionalExpression'), depth);
			});
		}
	}
	for (const depth of [20, 100]) {
		test(`既定値の試し読みで最深部の型が使えない ${depth} 段`, () => {
			const inner = '(q: Unknown): number => q';
			let source = inner;
			for (let i = 0; i < depth; i++) source = `(p = ${source}): number => p`;
			let original: TonerikoScriptSyntaxError | undefined;
			assert.throws(() => parse(`x = ${inner}`), (error: unknown) => {
				assert.ok(error instanceof TonerikoScriptSyntaxError);
				original = error;
				return true;
			});
			assert.ok(original);
			assert.equal(original.code, 'UNSUPPORTED_TYPE');
			assert.deepEqual(original.pos, { line: 1, column: 9 });
			const started = performance.now();
			let actual: unknown;
			try { parse(`x = ${source}`); } catch (error) { actual = error; }
			const elapsed = performance.now() - started;
			assert.ok(elapsed < 100, `${depth} 段: ${elapsed}ms`);
			assert.ok(actual instanceof TonerikoScriptSyntaxError);
			assert.equal(actual.code, original.code);
			assert.equal(actual.hint, original.hint);
			assert.ok(actual.hint.length > 0);
			assert.deepEqual(actual.pos, { line: 1, column: original.pos.column + '(p = '.length * depth });
		});
		test(`型付きアローとして採用しない試し読み ${depth} 段`, () => {
			const wrap = (body: string) => `a ? (p): number => ${body}`;
			parse(`x = ${nested(2, wrap)}`);
			const source = `x = ${nested(depth, wrap)}`;
			const started = performance.now();
			const { program } = parse(source);
			const elapsed = performance.now() - started;
			assert.ok(elapsed < 100, `${depth} 段: ${elapsed}ms`);
			assert.equal(countNodes(program, 'ConditionalExpression'), depth);
			assert.equal(countNodes(program, 'ArrowFunctionExpression'), depth);
			assert.equal(countNodes(program, 'KeywordTypeAnnotation'), 0);
		});
		test(`既定値の型付きアロー ${depth} 段`, () => {
			const wrap = (body: string) => `(p = ${body}): number => p`;
			parse(`x = ${nested(2, wrap)}`);
			const source = `x = ${nested(depth, wrap)}`;
			const started = performance.now();
			const { program } = parse(source);
			const elapsed = performance.now() - started;
			assert.ok(elapsed < 100, `${depth} 段: ${elapsed}ms`);
			assert.equal(countNodes(program, 'ArrowFunctionExpression'), depth);
			assert.equal(countNodes(program, 'AssignmentPattern'), depth);
		});
		test(`括弧のアロー判定 ${depth} 段`, () => {
			const source = `x = ${nested(depth, body => `(${body})`)}`;
			parse('x = ((z))');
			const started = performance.now();
			const { program } = parse(source);
			const elapsed = performance.now() - started;
			assert.ok(elapsed < 100, `${depth} 段: ${elapsed}ms`);
			assert.equal(countNodes(program, 'AssignmentExpression'), 1);
			assert.equal(countNodes(program, 'ArrowFunctionExpression'), 0);
		});
		test(`入れ子の型引数の判定 ${depth} 段`, () => {
			const source = `f<${nested(depth, body => `Array<${body}>`)}>(x)`;
			diagnostic('f<Array<number>>(x)', 'TYPE_ARGUMENTS');
			const started = performance.now();
			diagnostic(source, 'TYPE_ARGUMENTS');
			const elapsed = performance.now() - started;
			assert.ok(elapsed < 100, `${depth} 段: ${elapsed}ms`);
		});
	}
});

for (const [source, code] of [
	['const f = (x: Array<number>): number => x', 'TYPE_ARRAY_GENERIC'],
	['const f = (this: any): number => 1', 'TYPE_THIS_PARAMETER'],
	['f<T extends any ? number : string>(x)', 'TYPE_ARGUMENTS'],
	['f<[number, ...string[]]>(x)', 'TYPE_ARGUMENTS'],
] as const) {
	test(source, () => diagnostic(source, code));
}

for (const source of ['f<\nnumber\n>(1);', 'f<{a: number; b: string}>(x);', 'f<Array<number>>(x);']) {
	test(source, () => diagnostic(source, 'TYPE_ARGUMENTS'));
}

describe('インタプリタに渡す前の診断', () => {
	for (const source of ['x => { k: v }', '(x) => { k: 1 }', 'async x => { k: null }']) {
		test(`オブジェクトを返す括弧の案内: ${source}`, () => {
			diagnostic(source, 'ARROW_OBJECT_BODY');
			assert.throws(() => parse(source), (error: unknown) => error instanceof TonerikoScriptSyntaxError && error.hint.includes('({ … })'));
		});
	}
	for (const source of ['x => ({ k: x })', 'x => { k: { break k; } }', 'x => { k: while (x) break k; }', 'x => { a: b: for (;;) break a; }']) {
		test(`オブジェクトか有効なラベル: ${source}`, () => parse(source));
	}
	for (const operator of ['===', '!==']) {
		for (const expression of ['typeof x', '(typeof x)', 'typeof obj.x']) {
			for (const source of [`${expression} ${operator} "undefined"`, `"undefined" ${operator} ${expression}`]) {
				test(`欠如値の比較の案内: ${source}`, () => diagnostic(source, 'TYPEOF_UNDEFINED_COMPARISON'));
			}
		}
	}
	for (const source of ['typeof null === "object"', 'typeof x === "number"', 'x == null', 'x != null']) {
		test(`型と欠如値の有効な比較: ${source}`, () => parse(source));
	}

	const declarations = [
		['let x; let x;', false],
		['const x = 1; let x;', false],
		['let x, x;', false],
		['function x() {} function x() {}', false],
		['let x; function x() {}', false],
		['function x() {} let x;', false],
		['{ function x() {} function x() {} }', false],
		['{ let x; function x() {} }', false],
		['function f(x) { let x; }', false],
		['function f({ x }, [x]) {}', false],
		['function f(x, x) {}', false],
		['(x, x) => x', false],
		['(x) => { const x = 1; }', false],
		['function f() { function x() {} let x; }', false],
		['function f() { let x; function x() {} }', false],
		['let [x, x] = [1, 2];', false],
		['let { a: x, b: x } = {};', false],
		['let [x, ...x] = [];', false],
		['try {} catch (x) { let x; }', false],
		['try {} catch (x) { function x() {} }', false],
		['try {} catch ({ x, a: x }) {}', false],
		['switch (0) { case 0: let x; break; case 1: let x; }', false],
		['switch (0) { case 0: function f() {} break; default: function f() {} }', false],
		['for (let x = 0, x = 1; false;) {}', false],
		['for (let [x, x] of []) {}', false],
		['export const meta = {}; let meta;', false],
		['function f() { function x() {} function x() {} }', true],
		['function f(x) { function x() {} }', true],
		['function f(x = 1) { function x() {} }', true],
		['function f(x) { { let x; } }', true],
		['function f() { let f; }', true],
		['let x; { let x; }', true],
		['try {} catch (x) { { let x; } }', true],
		['switch (0) { case 0: { let x; } break; case 1: { let x; } }', true],
		['for (let x = 0; x < 1; x++) { let x; }', true],
		['for (const x of []) { let x; }', true],
		['for (let x = 0; false;) {} let x;', true],
		['const f = (x = (() => { let x; })) => x;', true],
	] as const;
	for (const [source, valid] of declarations) {
		test(`モジュールの宣言規則: ${source}`, () => {
			const reference = spawnSync(nodeExecutable, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
			assert.equal(reference.error, undefined);
			assert.equal(reference.status === 0, valid, reference.stderr);
			if (valid) parse(source);
			else diagnostic(source, 'DUPLICATE_DECLARATION');
		});
	}
});
