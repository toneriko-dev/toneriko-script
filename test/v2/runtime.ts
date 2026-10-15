import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { Interpreter, RuntimeError, ExecutionStopped, hostFunction } from '../../src/v2/interpreter.js';
import type { InterpreterOptions } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { formatDiagnostic } from '../../src/v2/diagnostics.js';
import { messages } from '../../src/v2/messages.js';

async function execute(source: string, globals: Record<string, unknown> = {}, options: InterpreterOptions = {}) {
	const output: unknown[] = [];
	const interpreter = new Interpreter({ out: (value: unknown) => { output.push(structuredClone(value)); }, ...globals }, { maxSteps: 100000, ...options });
	await interpreter.exec(parse(source).program);
	return { output, interpreter };
}

const examples: [string, string, unknown[]][] = [
	['偽になる値とオブジェクトの真', 'out([!!0, !!-0, !!"", !!(0/0), !!null, !![], !!{}, !!"0"]);', [[false, false, false, false, false, true, true, true]]],
	['厳密等価と特殊な数', 'let a = {}; out([a === a, a === {}, [] === [], 0 === -0, (0/0) === (0/0), 1/0, -1/0, -0]);', [[true, false, false, true, false, Infinity, -Infinity, -0]]],
	['文字列連結とテンプレート', 'out(["a" + 2, true + "a", `a${2}${false}`, 2 + 3]);', [['a2', 'truea', 'a2false', 5]]],
	['論理式はオペランドを返す', 'out([3 && 4, "a" && "b", 0 && 9, "" || "x", 2 || 8, null ?? 7, 0 ?? 7]);', [[4, 'b', 0, 'x', 2, 7, 0]]],
	['条件式と論理式の評価を省く', 'let n = 0; function bump() { n++; return n; } out([false && bump(), true || bump(), 2 ?? bump(), true ? 7 : bump(), n]);', [[false, true, 2, 7, 0]]],
	['関数の巻き上げと相互再帰', 'out(even(8)); function even(n) { return n === 0 || odd(n - 1); } function odd(n) { return n !== 0 && even(n - 1); }', [true]],
	['ブロックの関数はブロックに閉じる', 'function f() { return 1; } { out(f()); function f() { return 2; } } out(f());', [2, 1]],
	['閉包は更新される束縛を読む', 'let x = 1; function f() { return x; } x = 8; out(f());', [8]],
	['関数のローカルと外側の分離', 'let x = 9; function f() { let x = 2; return () => { x++; return x; }; } let a = f(); let b = f(); out([a(), a(), b(), x]);', [[3, 4, 3, 9]]],
	['既定引数は関数本体の宣言を見ない', 'let x = 3; function f(a = x) { let x = 9; return a; } out(f());', [3]],
	['既定引数の閉包は引数の束縛を読む', 'function f(a = 1, b = () => a) { a = 5; return b(); } out(f());', [5]],
	['null と欠如に引数の既定値', 'function f(a = 7) { return a; } out([f(), f(null), f({}.missing), f(0)]);', [[7, 7, 7, 0]]],
	['引数の残余', 'function f(a, ...rest) { out([a, rest]); } f(1, 2, 3);', [[1, [2, 3]]]],
	['引数と同名の関数宣言', 'function f(x) { function x() { return 9; } return x(); } out(f(1));', [9]],
	['同じ関数本体の関数宣言は後が勝つ', 'function f() { function g() { return 1; } function g() { return 2; } return g(); } out(f());', [2]],
	['for let の周回ごとの閉包', 'let a = []; for (let i = 0; i < 3; i++) a.push(() => i); out([a[0](), a[1](), a[2]()]);', [[0, 1, 2]]],
	['for 初期化の閉包と周回の束縛', 'let saved; function save(fn) { saved = fn; return 0; } let a = []; for (let i = save(() => i); i < 2; i++) a.push(() => i); out([saved(), a[0](), a[1]()]);', [[0, 0, 1]]],
	['for continue は更新式を実行する', 'let a = []; for (let i = 0; i < 4; i++) { if (i === 1) continue; a.push(i); } out(a);', [[0, 2, 3]]],
	['for of の閉包', 'let a = []; for (let x of [2, 4, 6]) a.push(() => x); out([a[0](), a[1](), a[2]()]);', [[2, 4, 6]]],
	['while と do while の continue', 'let i = 0; let a = []; while (i < 3) { i++; if (i === 2) continue; a.push(i); } do { i--; if (i === 1) continue; a.push(i); } while (i > 0); out(a);', [[1, 3, 2, 0]]],
	['外側ラベルへの continue と break', 'let a = []; outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j === 1) continue outer; a.push(i); if (i === 2) break outer; } } out(a);', [[0, 1, 2]]],
	['複数のラベルとブロックの break', 'let x = 0; a: b: while (true) { x++; break a; } block: { x++; break block; x++; } out(x);', [2]],
	['switch は一致後の case 式を評価しない', 'let n = 0; function c(x) { n++; return x; } switch (2) { case c(1): out(1); break; case c(2): out(2); case c(3): out(3); } out(n);', [2, 3, 2]],
	['switch の default は途中にも置ける', 'switch (3) { case 1: out(1); break; default: out(0); case 2: out(2); } switch (2) { default: out(9); case 2: out(4); }', [0, 2, 4]],
	['finally が return を上書き', 'function f() { try { return 1; } finally { return 2; } } out(f());', [2]],
	['finally が元の return を保つ', 'function f() { try { return 1; } finally { out(2); } } out(f());', [2, 1]],
	['finally の break が return を上書き', 'function f() { outer: while (true) { try { return 1; } finally { break outer; } } return 2; } out(f());', [2]],
	['finally の return が break を上書き', 'function f() { while (true) { try { break; } finally { return 7; } } return 3; } out(f());', [7]],
	['finally の continue が break を上書き', 'let n = 0; while (n < 3) { n++; try { break; } finally { if (n < 2) continue; } } out(n);', [2]],
	['finally の throw と入れ子', 'try { try { throw 1; } finally { throw 2; } } catch (e) { out(e); } finally { out(3); }', [2, 3]],
	['throw の値と catch 分割代入', 'let x = {value: 7}; try { throw x; } catch ({value}) { out(value); } try { throw null; } catch (e) { out(e); }', [7, null]],
	['Error の名前とメッセージ', 'try { throw new Error("problem"); } catch (e) { out([e.name, e.message]); }', [['Error', 'problem']]],
	['null は object として typeof', 'out([typeof null, typeof 1, typeof "s", typeof true, typeof [], typeof {}, typeof (() => 1)]);', [['object', 'number', 'string', 'boolean', 'object', 'object', 'function']]],
	['配列の分割代入と不足と残余', 'let [a, , b = 7, ...rest] = [1, 2]; out([a, b, rest]);', [[1, 7, []]]],
	['null の分割既定値', 'let {a = 8, b = 9} = {a: null}; let [c = 7] = [null]; out([a, b, c]);', [[8, 9, 7]]],
	['分割代入の既定値は先の束縛を読む', 'let [a = 2, b = a + 3] = []; out([a, b]);', [[2, 5]]],
	['計算キーとオブジェクト rest', 'let key = "a"; let {[key]: a, ...rest} = {a: 1, b: 2}; out([a, rest]);', [[1, {b: 2}]]],
	['分割代入は代入先のプロパティを扱う', 'let a = {}; [a.x, a.y] = [1, 2]; ({z: a.z} = {z: 3}); out(a);', [{x: 1, y: 2, z: 3}]],
	['入れ子の分割と既定値', 'let {a: [x, {y = 4}]} = {a: [2, {}]}; out([x, y]);', [[2, 4]]],
	['配列と引数スプレッド', 'function f(a, b, c) { return [a, b, c]; } out(f(...[1, 2], 3)); out([0, ...[1, 2], 3]);', [[1, 2, 3], [0, 1, 2, 3]]],
	['オブジェクトスプレッドは順番に上書き', 'out({a: 1, ...{a: 2, b: 3}, b: 4}); out({...null, a: 1});', [{a: 2, b: 4}, {a: 1}]],
	['optional chain はキーと引数を評価しない', 'let n = 0; function bump() { n++; return "x"; } let a = null; out(a?.[bump()].x); out(a?.m(bump())); out(a?.(bump())); out(n);', [null, null, null, 0]],
	['optional call は存在する対象を一度だけ呼ぶ', 'let n = 0; function f(x) { n++; return x; } out(f?.(3)); out(n);', [3, 1]],
	['複合代入の左辺は一度だけ評価', 'let a = {x: 3}; let trace = []; function obj() { trace.push("o"); return a; } function key() { trace.push("k"); return "x"; } function rhs() { trace.push("r"); return 4; } obj()[key()] += rhs(); out([a.x, trace]);', [[7, ['o', 'k', 'r']]]],
	['複合代入と前置後置更新', 'let x = 4; x *= 3; x -= 2; x /= 2; x %= 3; x **= 2; out(x); x++; ++x; out(x); x--; --x; out(x);', [4, 6, 4]],
	['null 合体代入は右辺を必要な場合だけ評価', 'let n = 0; function f() { n++; return 7; } let a = {x: 0, y: null}; a.x ??= f(); a.y ??= f(); out([a, n]);', [[{x: 0, y: 7}, 1]]],
	['呼び出しとオブジェクトキーの評価順', 'let trace = []; function f(x) { trace.push(x); return x; } function call(a,b) { trace.push("call"); } call(f("a"), f("b")); let obj = {[f("k")]: f("v")}; out(trace);', [['a', 'b', 'call', 'k', 'v']]],
	['辞書に原型はなく利用者の文字列で上書き可能', 'let o = {}; out([o.constructor, o.toString, "constructor" in o]); o.constructor = 4; o.toString = 5; out([o.constructor, o.toString, "constructor" in o]);', [[null, null, false], [4, 5, true]]],
	['添字とメソッドの書記素', 'let s = "a\\r\\né👩🏽"; out([s.length, s[1], s[2], s.at(-1)]);', [[4, '\r\n', 'é', '👩🏽']]],
	['配列の追加と切り詰め', 'let a = [1]; a[a.length] = 2; a.push(3); a.length = 1; out(a);', [[1]]],
	['型注釈は実行時に検査しない', 'let a: number = "text"; function f(x: number): number { return x; } out([a, f(true)]);', [['text', true]]],
	['未宣言の typeof は文字列 undefined', 'out(typeof missing);', ['undefined']],
	['値のない return と本体末尾', 'function f() { return; } function g() {} out([f(), g()]);', [[null, null]]],
	['関数本体から既定引数で作った閉包の環境を隠す', 'let x = 2; function f(g = () => x) { let x = 9; return g(); } out(f());', [2]],
	['switch の case を選ぶ前から全体で TDZ', 'let x = 1; try { switch (1) { case x: break; default: let x = 2; } } catch (e) { out(e.code); }', ['TDZ_ACCESS']],
	['文字列の反復とスプレッドと分割は書記素を使う', 'let a = []; for (let x of "é👩🏽") a.push(x); let [x, y] = "é👩🏽"; out([a, [..."é👩🏽"], x, y]);', [[['é', '👩🏽'], ['é', '👩🏽'], 'é', '👩🏽']]],
	['オブジェクトの削除と存在確認', 'let o = {x: null}; out("x" in o); out(delete o.x); out([o.x, "x" in o]);', [true, true, [null, false]]],
	['引数既定値の副作用は左から処理する', 'let a = []; function mark(x) { a.push(x); return x; } function f(x = mark(1), y = mark(2), z = mark(3)) {} f(null, 9); out(a);', [[1, 3]]],
	['投げたオブジェクトの同一性を catch が保つ', 'let obj = {}; try { throw obj; } catch (e) { out(e === obj); }', [true]],
	['finally の正常終了が throw を保持する', 'try { try { throw 3; } finally { out(1); } } catch (e) { out(e); }', [1, 3]],
];

describe('v2 の実行時の意味', () => {
	for (const [name, source, expected] of examples) test(name, async () => {
		expect((await execute(source)).output).toEqual(expected);
	});

	test('for の条件式と更新式も異なる周回の束縛を捕捉する', async () => {
		const source = 'let conditions = []; let updates = []; function condition(fn) { conditions.push(fn); return fn() < 2; } function update(fn) { updates.push(fn); return 1; } for (let i = 0; condition(() => i); i += update(() => i)) {} out([conditions[0](), conditions[1](), conditions[2](), updates[0](), updates[1]()]);';
		expect((await execute(source)).output).toEqual([[0, 1, 2, 1, 2]]);
	});
});

const failures: [string, string, string, string?][] = [
	['let の TDZ', 'out(x); let x = 1;', 'TDZ_ACCESS', 'ReferenceError'],
	['typeof の TDZ', 'out(typeof x); let x = 1;', 'TDZ_ACCESS', 'ReferenceError'],
	['後の引数の TDZ', 'function f(a = b, b = 1) {} f();', 'TDZ_ACCESS', 'ReferenceError'],
	['自分の引数の TDZ', 'function f(a = a) {} f();', 'TDZ_ACCESS', 'ReferenceError'],
	['switch の共有スコープと TDZ', 'switch (1) { case 0: let x = 3; break; case 1: out(x); }', 'TDZ_ACCESS', 'ReferenceError'],
	['const 再代入', 'const x = 1; x = 2;', 'CONST_ASSIGNMENT', 'TypeError'],
	['未宣言の識別子', 'out(missing);', 'UNBOUND_IDENTIFIER', 'ReferenceError'],
	['null の読み', 'out(null.x);', 'NULL_PROPERTY_ACCESS', 'TypeError'],
	['括弧で optional chain が切れる', 'out((null?.x).y);', 'NULL_PROPERTY_ACCESS', 'TypeError'],
	['数の暗黙変換', 'out(true + 1);', 'IMPLICIT_COERCION', 'TypeError'],
	['文字列の暗黙数値変換', 'out("2" - 1);', 'IMPLICIT_COERCION', 'TypeError'],
	['null の文字列連結', 'out("x" + null);', 'INVALID_STRING_CONVERSION', 'TypeError'],
	['配列のテンプレート連結', 'out(`${[]}`);', 'INVALID_STRING_CONVERSION', 'TypeError'],
	['関数の文字列連結', 'out("x" + (() => 1));', 'INVALID_STRING_CONVERSION', 'TypeError'],
	['配列範囲外の読み', 'out([1][1]);', 'ARRAY_INDEX_OUT_OF_RANGE', 'RangeError'],
	['配列の末尾の複合代入は読みで失敗', 'let a = [1]; a[a.length] += 2;', 'ARRAY_INDEX_OUT_OF_RANGE', 'RangeError'],
	['配列の隙間への書き込み', 'let a = []; a[2] = 1;', 'ARRAY_GAP'],
	['length を増やさない', 'let a = []; a.length = 2;', 'ARRAY_LENGTH_GROWTH'],
	['配列要素の削除', 'let a = [1]; delete a[0];', 'ARRAY_DELETE'],
	['配列の穴', 'out([, 1]);', 'SPARSE_ARRAY'],
	['取り出したメソッドは受け手を失う', 'let push = [].push; push(1);', 'INVALID_RECEIVER', 'TypeError'],
	['null の分割', 'let {x} = null;', 'NULL_PROPERTY_ACCESS', 'TypeError'],
	['非反復値のスプレッド', 'out([...1]);', 'NOT_ITERABLE', 'TypeError'],
	['原型メソッドへの案内', '({}).hasOwnProperty("x");', 'PROTOTYPE_METHOD_CALL', 'TypeError'],
	['__proto__ の静的キー', 'out({__proto__: 1});', 'FORBIDDEN_PROPERTY'],
	['__proto__ の動的キー', 'let key = "__" + "proto__"; out({[key]: 1});', 'FORBIDDEN_PROPERTY'],
	['__proto__ の読み', 'out(({}).__proto__);', 'FORBIDDEN_PROPERTY'],
	['__proto__ の分割', 'let {__proto__: x} = {};', 'FORBIDDEN_PROPERTY'],
];

describe('v2 の実行時エラー', () => {
	for (const [name, source, code, errorName] of failures) test(name, async () => {
		await expect(execute(source)).rejects.toMatchObject({ code, ...(errorName ? { name: errorName } : {}) });
	});

	test('実行時エラーを catch してコードと位置を読める', async () => {
		const { output } = await execute('try {\n  null.x;\n} catch (e) { out([e.name, e.code, e.pos.line, e.pos.column]); }');
		expect(output).toEqual([['TypeError', 'NULL_PROPERTY_ACCESS', 2, 3]]);
	});

	test('実行時診断の日英の文と案内を整形できる', async () => {
		let error: unknown;
		try { await execute('let x = 1;\nout("a" + null);'); } catch (caught) { error = caught; }
		expect(error).toBeInstanceOf(RuntimeError);
		if (!(error instanceof RuntimeError)) throw error;
		expect(error.pos).toEqual({ line: 2, column: 5 });
		for (const language of ['ja', 'en'] as const) {
			const formatted = formatDiagnostic(error, language);
			expect(formatted).toContain(messages.INVALID_STRING_CONVERSION[language].message);
			expect(formatted).toContain('JSON.stringify(x)');
		}
	});

	test('原型メソッドの案内は利用者の同名関数を妨げない', async () => {
		expect((await execute('let obj = {hasOwnProperty: () => 3}; out(obj.hasOwnProperty());')).output).toEqual([3]);
		await expect(execute('({}).hasOwnProperty("x");')).rejects.toMatchObject({ hint: expect.stringContaining('Object.hasOwn(obj, k)') });
	});

	test('再送出しても元の位置を保つ', async () => {
		await expect(execute('try {\n null.x;\n} catch (e) { throw e; }')).rejects.toMatchObject({ code: 'NULL_PROPERTY_ACCESS', pos: { line: 2, column: 2 } });
	});
});

describe('v2 のホスト境界', () => {
	test('ホストの同期値と Promise を待ち undefined を null にする', async () => {
		const { output } = await execute('out(sync()); out(later()); out(empty());', { sync: () => 3, later: () => Promise.resolve(4), empty: () => undefined });
		expect(output).toEqual([3, 4, null]);
	});

	test('別 realm の Promise も待つ', async () => {
		expect((await execute('out(remote());', { remote: () => runInNewContext('Promise.resolve(7)') })).output).toEqual([7]);
	});

	test('Promise の reject を catch できる', async () => {
		expect((await execute('try { fail(); } catch (e) { out([e.name, e.message]); }', { fail: () => Promise.reject(new TypeError('host')) })).output).toEqual([['TypeError', 'host']]);
	});

	test('実行後もホストから閉包を呼べる', async () => {
		const { interpreter } = await execute('let count = 2; function next(n = 1) { count += n; return count; }');
		const fn = interpreter.getGlobal('next');
		expect(await interpreter.call(fn, [])).toBe(3);
		expect(await interpreter.call(fn, [4])).toBe(7);
	});

	test('ホストがスクリプト関数を呼び返せる', async () => {
		const invoke = hostFunction(async ([fn], context) => context.call(fn!, [5]));
		expect((await execute('out(invoke(x => x * 2));', { invoke })).output).toEqual([10]);
	});

	test('ホストのメソッドは呼び出しの受け手を保つ', async () => {
		const object = { value: 8, read() { return this.value; } };
		expect((await execute('out(obj.read());', { obj: object })).output).toEqual([8]);
	});

	test('ホストの共有参照と自分のプロパティだけを観測する', async () => {
		const object = Object.assign(Object.create({ inherited: 9 }), { x: undefined });
		expect((await execute('out([a === b, a.x, a.inherited, "inherited" in a]); a.x = 4;', { a: object, b: object })).output).toEqual([[true, null, null, false]]);
		expect(object.x).toBe(4);
	});

	test('ホストの getter を呼ばない', async () => {
		let count = 0;
		const object = { get value() { count++; return 3; } };
		await expect(execute('out(obj.value);', { obj: object })).rejects.toMatchObject({ code: 'ACCESSOR_PROPERTY' });
		expect(count).toBe(0);
	});

	test('ホストの疎配列を拒否する', async () => {
		await expect(execute('out(a);', { a: [, 2] })).rejects.toMatchObject({ code: 'SPARSE_ARRAY' });
	});

	test('ホストの非 Error な reject も値のまま catch する', async () => {
		expect((await execute('try { fail(); } catch (e) { out(e); }', { fail: () => Promise.reject(42) })).output).toEqual([42]);
	});

	test('ホストからの undefined のプロパティにも既定値を適用する', async () => {
		expect((await execute('let {x = 8} = obj; function f(a = 9) { return a; } out([x, f(obj.x)]);', { obj: { x: undefined } })).output).toEqual([[8, 9]]);
	});

	test('ホストで後から配列に穴を作っても読みを許さない', async () => {
		const a = [1, 2];
		await expect(execute('out(a[0]); change(); out(a[0]);', { a, change: () => { delete a[0]; } })).rejects.toMatchObject({ code: 'SPARSE_ARRAY' });
	});

	test('オブジェクトスプレッドはホストの原型を含めない', async () => {
		const obj = Object.assign(Object.create({ hidden: 9 }), { own: 3 });
		expect((await execute('out({...obj});', { obj })).output).toEqual([{ own: 3 }]);
	});

	test('列挙可能な __proto__ はホストからのスプレッドでも拒否する', async () => {
		const obj = Object.create(null);
		obj['__proto__'] = 1;
		await expect(execute('out({...obj});', { obj })).rejects.toMatchObject({ code: 'FORBIDDEN_PROPERTY' });
	});
});

describe('v2 の実行上限と abort', () => {
	test('空の無限ループもステップ上限で止まり catch と finally を実行しない', async () => {
		const output: unknown[] = [];
		const interpreter = new Interpreter({ out: (x: unknown) => output.push(x) }, { maxSteps: 100 });
		await expect(interpreter.exec(parse('try { while (true) {} } catch (e) { out(1); } finally { out(2); }').program)).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
		expect(output).toEqual([]);
	});

	test('ステップ上限ちょうどは成功し次の一歩で停止する', async () => {
		const source = 'let x = 0; for (let i = 0; i < 3; i++) x += i;';
		const { interpreter } = await execute(source);
		await expect(execute(source, {}, { maxSteps: interpreter.stepCount })).resolves.toBeDefined();
		await expect(execute(source, {}, { maxSteps: interpreter.stepCount - 1 })).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
	});

	test('呼び返しでステップ予算をリセットしない', async () => {
		const repeat = hostFunction(async ([fn], context) => {
			for (let i = 0; i < 100; i++) await context.call(fn!, []);
		});
		await expect(execute('repeat(() => 1);', { repeat }, { maxSteps: 80 })).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
	});

	test('制御時計で時間上限を検証する', async () => {
		let clock = 0;
		await expect(execute('while (true) {}', {}, { maxSteps: 1000000, maxBusyTime: 5, yieldInterval: 0, now: () => clock++ })).rejects.toMatchObject({ code: 'BUSY_TIME_EXCEEDED' });
	});

	test('譲っても累積実行時間をリセットしない', async () => {
		let clock = 0;
		let yields = 0;
		await expect(execute('while (true) {}', {}, { maxSteps: 1000000, maxBusyTime: 30, yieldInterval: 1, now: () => clock++, yieldToHost: async () => { yields++; await new Promise(resolve => setTimeout(resolve, 0)); } })).rejects.toMatchObject({ code: 'BUSY_TIME_EXCEEDED' });
		expect(yields).toBeGreaterThan(0);
	});

	test('即時解決 Promise は待機として実行時間をリセットしない', async () => {
		let clock = 0;
		await expect(execute('while (true) ping();', { ping: () => Promise.resolve(1) }, { maxSteps: 1000000, maxBusyTime: 10, yieldInterval: 0, now: () => clock++ })).rejects.toMatchObject({ code: 'BUSY_TIME_EXCEEDED' });
	});

	test('実際に待った時間は実行時間に含めない', async () => {
		let clock = 0;
		const pause = () => new Promise(resolve => setTimeout(() => { clock += 100; resolve(null); }, 5));
		expect((await execute('pause(); out(1); pause(); out(2);', { pause }, { maxBusyTime: 5, now: () => clock })).output).toEqual([1, 2]);
	});

	test('実時間でも短い上限でループが停止する', async () => {
		await expect(execute('while (true) {}', {}, { maxSteps: undefined, maxBusyTime: 20, yieldInterval: 2 })).rejects.toBeInstanceOf(ExecutionStopped);
	});

	test('Promise 待機中の abort は catch と finally を飛ばす', async () => {
		const output: unknown[] = [];
		let resolve!: (value: unknown) => void;
		const interpreter = new Interpreter({ wait: () => new Promise(r => { resolve = r; }), out: (x: unknown) => output.push(x) });
		const running = interpreter.exec(parse('try { wait(); out(1); } catch (e) { out(2); } finally { out(3); }').program);
		interpreter.abort();
		await expect(running).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' });
		resolve(4);
		await new Promise(r => setTimeout(r, 0));
		expect(output).toEqual([]);
	});

	test('abort はホストの signal にも通知する', async () => {
		let signal: AbortSignal | undefined;
		const wait = hostFunction((_args, context) => { signal = context.signal; return new Promise(() => {}); });
		const interpreter = new Interpreter({ wait });
		const running = interpreter.exec(parse('wait();').program);
		interpreter.abort();
		await expect(running).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' });
		expect(signal?.aborted).toBe(true);
	});

	test('停止したインタプリタの並行呼び出しも終了する', async () => {
		let clock = 0;
		const interpreter = new Interpreter({ ping: () => Promise.resolve(null) }, { now: () => clock++, maxBusyTime: 40, yieldInterval: 0 });
		await interpreter.exec(parse('function run() { while (true) ping(); }').program);
		const fn = interpreter.getGlobal('run');
		const results = await Promise.allSettled([interpreter.call(fn, []), interpreter.call(fn, [])]);
		for (const result of results) {
			expect(result.status).toBe('rejected');
			if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'BUSY_TIME_EXCEEDED' });
		}
	});

	test('別のインタプリタには停止が伝わらない', async () => {
		const first = new Interpreter();
		first.abort();
		await expect(first.exec(parse('let x = 1;').program)).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' });
		expect((await execute('out(2);')).output).toEqual([2]);
	});
});
