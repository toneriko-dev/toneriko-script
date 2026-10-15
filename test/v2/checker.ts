import * as assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parse } from '../../src/v2/parser/index.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { check, type CheckOptions } from '../../src/v2/checker/index.js';
import { formatDiagnostic } from '../../src/v2/diagnostics.js';
import { catalog } from '../../src/v2/stdlib/index.js';
import type { CatalogEntry } from '../../src/v2/catalog.js';

function diagnostics(source: string, options?: CheckOptions) { return check(parse(source).program, options); }
function codes(source: string, options?: CheckOptions) { return diagnostics(source, options).map(item => item.code); }

describe('実行前の明示型検査', () => {
	for (const source of [
		'let x: number = "bad";', 'let x: number; x = false;', 'let x: number[] = [1, "bad"];',
		'let x: {a: number} = {a: "bad"};', 'let x: {a: number} = {};', 'let x: Function = 1;',
		'let x: number | boolean = "bad";', 'let x: number[][] = [1];', 'let x: {a: number[]} = {a: 1};',
		'let [x]: number[] = [1]; x = "bad";', 'let {x}: {x: number} = {x: 1}; x = "bad";',
		'let {a: {x}}: {a: {x: number}} = {a: {x: 1}}; x = "bad";',
		'let x: number = 1; [x] = ["bad"];', 'let x: number = 1; ({a: x} = {a: "bad"});',
		'function f(x: number = "bad") {}', 'let x: number = 1; function f() { x = "bad"; }',
		'let x: {a: number} = {...unknown, a: "bad"};',
	]) test(`不一致: ${source}`, () => assert.ok(codes(source, { globals: ['unknown'] }).includes('TYPE_ANNOTATION_MISMATCH')));
	for (const source of [
		'let x: number;', 'let x: number = -1;', 'let x: any = "bad";', 'let x: number | string = "ok";',
		'let x: number[][] = [["shallow"]];', 'let x: {a: number[]} = {a: ["shallow"]};',
		'let x: {a?: number} = {};', 'let x: {a: number} = {a: 1, extra: true};',
		'let x: Function = () => 1;', 'let x: number = unknown;', 'let x: number[] = [unknown];',
		'let x: {a: number} = {a: "bad", ...unknown};', 'let x: {a: number} = {...unknown};',
		'let x: number = 1; {let x = "ok"; x = false;}',
		'function f(x?: number) {x = null;} f();',
		'let a: number[] = []; [a = []] = [null];',
		'const k = "b"; function f({[k]: v = "ok"}: {k: number, b: string}) {}',
		'let x: number = 1; x += unknown;', 'let x = 1; x = "ok";',
	]) test(`非検出: ${source}`, () => assert.deepEqual(codes(source, { globals: ['unknown'] }), []));
});

describe('const と名前解決', () => {
	for (const source of [
		'const x = 1; x = 2;', 'const x = 1; x += 1;', 'const x = 1; x++;',
		'const x = 1; [x] = [2];', 'const x = 1; ({a: x} = {a: 2});',
		'const x = 1; for (x of [2]) {}', 'const x = 1; function f() { x = 2; }',
	]) test(`再代入: ${source}`, () => assert.ok(codes(source).includes('CONST_ASSIGNMENT')));
	for (const source of [
		'const x = {a: 1}; x.a = 2;', 'const x = 1; { let x = 2; x++; }',
		'f(); function f() {}', 'let x = y; let y = 1;', 'let x = 1; let o = {x, other: x}; o.x;',
		'outer: for (let i = 0; i < 2; i++) { continue outer; }',
		'try {throw 1;} catch (e) {e;}', 'function f(a, b = a) { return b; }',
	]) test(`束縛: ${source}`, () => assert.deepEqual(codes(source), []));
	test('未宣言と近い名前', () => {
		const result = diagnostics('let count = 1; coun; totallyUnknown;');
		assert.deepEqual(result.map(item => item.code), ['UNBOUND_IDENTIFIER_SUGGESTION', 'UNBOUND_IDENTIFIER']);
		assert.equal(result[0]!.params.suggestion, 'count');
	});
	test('外側から内側の名前を提案しない', () => assert.equal(diagnostics('{let hidden = 1;} hidde;')[0]!.code, 'UNBOUND_IDENTIFIER'));
	test('引数既定値から関数本体の名前は見えない', () => assert.ok(codes('function f(x = local) { let local = 1; }').includes('UNBOUND_IDENTIFIER')));
	test('計算キー・既定値・右辺も参照として検査', () => assert.equal(diagnostics('let {[missing]: x = other} = source;').length, 3));
});

const hostCatalog: CatalogEntry[] = [{ name: 'Mk.api', receiver: 'global', args: [{ name: 'endpoint', type: 'string' }, { name: 'params', type: 'any', optional: true }], returns: 'any', description: { ja: 'API', en: 'API' } }];
describe('catalog の引数数', () => {
	for (const source of ['range(1);', 'range(1, 2, 3, 4);', '"x".repeat(1, 2);', '[].map();', 'new Error(1, 2, 3);', 'range(...[1]);']) test(`引数不足・過剰: ${source}`, () => assert.ok(codes(source).includes('ARGUMENT_COUNT')));
	for (const source of [
		'range(1, 2);', 'range(1, 2, 3);', 'range(...unknown);',
		'let range = x => x; range();', 'function f(range) {range();}', 'let x = []; x.map();',
		'const fn = range; fn();', 'const math = Math; Math.abs(1, 2);',
		'Math.abs = () => 1; Math.abs(1, 2);', 'function f() { Math.abs = () => 1; } Math.abs(1, 2);',
		'unknown(Math); Math.abs(1, 2);', 'Math[unknown] = () => 1; Math.abs(1, 2);',
	]) test(`確定できない呼出しは断定しない: ${source}`, () => assert.deepEqual(codes(source, { globals: ['unknown'] }), []));
	test('ホストの同形式定義', () => {
		assert.deepEqual(codes('Mk.api(); Mk.api("x"); Mk.api("x", {}, 1);', { hostCatalog }), ['ARGUMENT_COUNT', 'ARGUMENT_COUNT']);
	});
	test('catalog のホスト名前空間は標準名前空間全体を上書きする', () => assert.deepEqual(codes('Math.abs(1, 2);', { hostCatalog: [{ ...hostCatalog[0]!, name: 'Math.custom' }] }), []));
	test('標準の葉を読むだけでは名前空間を無効化しない', () => assert.deepEqual(codes('Math.PI; Math.abs(1, 2);'), ['ARGUMENT_COUNT']));
	test('明示注釈の原始型メソッド', () => assert.deepEqual(codes('let x: string = ""; x.repeat(1, 2); let n: (number) = 1; n.toFixed(1, 2);'), ['ARGUMENT_COUNT', 'ARGUMENT_COUNT']));
	test('globals による標準の上書き', () => assert.deepEqual(codes('range();', { globals: ['range'] }), []));
	test('host catalog による標準の上書き', () => assert.deepEqual(codes('range();', { hostCatalog: [{ ...hostCatalog[0]!, name: 'range', args: [] }] }), []));
	for (const entry of catalog) {
		if ('kind' in entry || entry.receiver === 'iterator') continue;
		const callee = entry.receiver === 'global' ? entry.name : entry.receiver === 'array' ? `[].${entry.name}` : entry.receiver === 'string' ? `"".${entry.name}` : `(1).${entry.name}`;
		const minimum = entry.args.filter(arg => !arg.optional && !arg.rest).length;
		const maximum = entry.args.some(arg => arg.rest) ? Infinity : entry.args.length;
		for (const count of new Set([0, Math.max(0, minimum - 1), minimum, entry.args.length, entry.args.length + 1])) {
			test(`${callee} の ${count} 引数`, () => assert.equal(codes(`${callee}(${Array(count).fill('null').join(',')});`).includes('ARGUMENT_COUNT'), count < minimum || count > maximum));
		}
	}
});

describe('case の到達可能性と診断 API', () => {
	for (const body of ['1;', 'if (x) break;', 'while (x) {break;}', 'try { if(x) return; } finally {}', 'label: {break label;}', 'switch(x) {case 1: break;}', 'try {return x();} catch {}']) {
		test(`次へ進む: ${body}`, () => assert.equal(diagnostics(`function f(x) { switch(x) { case 0: ${body} case 1: break; } }`).filter(item => item.code === 'CASE_FALLTHROUGH').length, 1));
	}
	for (const body of ['break;', 'return;', 'throw 1;', 'if(x) break; else return;', 'try {return;} finally {}', 'try {1;} finally {break;}', 'switch(x) {default: return;}', 'while (true) {}', 'inner: while (true) {continue inner;}', 'do {throw 1;} while (false);', 'try {return;} catch {}', 'try {return 1;} catch {}', 'try {break;} catch {}']) {
		test(`次へ進まない: ${body}`, () => assert.deepEqual(codes(`function f(x) { switch(x) { case 0: ${body} case 1: break; } }`), []));
	}
	test('空 case と最終 case', () => assert.deepEqual(codes('switch(1) {case 0: case 1: 1;}'), []));
	test('外側ループへの continue', () => assert.deepEqual(codes('outer: while(true) {switch(1) {case 0: continue outer; case 1: break;}}'), []));
	test('finally が戻り値を上書きする', () => assert.ok(codes('function f() {switch(1) {case 0: try {return;} finally {while(true) {break;}} case 1: break;}}').length === 0));
	test('複数診断の位置・順序・日英・警告', () => {
		const result = diagnostics('let n: number = "bad";\nswitch(n) {case 1: n++; case 2: break;}\nmissing;');
		assert.deepEqual(result.map(item => item.severity), ['error', 'warning', 'error']);
		for (const item of result) {
			assert.deepEqual(item.loc!.start, item.pos);
			assert.ok(formatDiagnostic(item, 'ja').includes('行目'));
			assert.ok(formatDiagnostic(item, 'en').includes('line'));
		}
	});
});


test('長い配列型の不一致もスタックを消費せず診断する', () => {
	const annotation = 'number' + '[]'.repeat(50_000);
	const result = diagnostics(`let x: ${annotation} = 1;`);
	assert.equal(result.length, 1);
	assert.equal(result[0]!.code, 'TYPE_ANNOTATION_MISMATCH');
	assert.equal(result[0]!.params.expected, annotation);
});

describe('クロスレビューの回帰', () => {
	test('typeof の直接の未宣言識別子を許可する', () => {
		assert.deepEqual(codes('typeof missing; typeof Mk === "object";'), []);
		assert.deepEqual(codes('typeof missing.value;'), ['UNBOUND_IDENTIFIER']);
		assert.deepEqual(codes('missing;'), ['UNBOUND_IDENTIFIER']);
	});

	test('静的な計算キーを rest の型から除外する', () => {
		assert.deepEqual(codes('let {["x"]: x, ...rest}: {x: number, y: string} = {x: 1, y: "ok"}; rest = {y: "ok"};'), []);
		assert.deepEqual(codes('let {[1]: x, ...rest}: {1: number, y: string} = {1: 1, y: "ok"}; rest = {y: "ok"};'), []);
		assert.deepEqual(codes('let {["x"]: x, ...rest}: {x: number, y: string} = {x: 1, y: "ok"}; rest = {y: 1};'), ['TYPE_ANNOTATION_MISMATCH']);
	});

	test('動的な計算キーを持つ rest の型は推論しない', () => {
		assert.deepEqual(codes('const key = "x"; let {[key]: x, ...rest}: {x: number, y: string} = {x: 1, y: "ok"}; rest = {y: "ok"};'), []);
		assert.deepEqual(codes('const key = "x"; let {[key]: x, ...rest}: {x: number, y: string} = {x: 1, y: "ok"}; rest = {y: 1};'), []);
	});

	test('配列の object 分割では length と添字とその他を区別する', () => {
		assert.deepEqual(codes('let {length, 0: first, push}: string[] = ["a"]; length = 2; first = "b"; push = 1;'), []);
		const result = diagnostics('let {length, 0: first}: string[] = ["a"]; length = "bad"; first = 2;');
		assert.deepEqual(result.map(item => [item.params.name, item.params.expected]), [['length', 'number'], ['first', 'string']]);
		assert.deepEqual(codes('let {"01": other}: string[] = ["a"]; other = 2;'), []);
	});

	test('分割で欠けた値を null として既定値の後に検査する', () => {
		const result = diagnostics('let [a, b]: number[] = [1];');
		assert.equal(result.length, 1);
		assert.deepEqual(result[0]!.params, { name: 'b', expected: 'number', actual: 'null', value: 'null' });
		assert.deepEqual(codes('let [a, b = 2]: number[] = [1];'), []);
		assert.deepEqual(codes('let [a, b = "bad"]: number[] = [1];'), ['TYPE_ANNOTATION_MISMATCH']);
		assert.deepEqual(codes('let {x = 2}: {x?: number} = {};'), []);
		assert.deepEqual(codes('let [a, b]: number[] = unknown;', { globals: ['unknown'] }), []);
		assert.deepEqual(codes('let a: number = 1; [a] = [];'), ['TYPE_ANNOTATION_MISMATCH']);
		assert.deepEqual(codes('let a: number = 1; [a = 2] = [];'), []);
	});

	test('投影した初期束縛もそれぞれ浅く検査する', () => {
		const result = diagnostics('let {items}: {items: number[]} = {items: ["bad"]};');
		assert.equal(result.length, 1);
		assert.equal(result[0]!.params.name, 'items[0]');
		assert.equal(result[0]!.params.expected, 'number');
		assert.deepEqual(codes('let {items}: {items: number[][]} = {items: [["shallow"]]};'), []);
		assert.deepEqual(codes('let {child: {n}}: {child: {n: number}} = {child: {}};'), ['TYPE_ANNOTATION_MISMATCH']);
		assert.deepEqual(codes('let {child: {n = 2}}: {child: {n: number}} = {child: {}};'), []);
	});

	test('型不一致の診断は容器ではなく失敗した葉を示す', () => {
		for (const [source, name] of [
			['let x: number[] = [1, "a"];', 'x[1]'],
			['let x: {a: number} = {a: "a"};', 'x.a'],
			['let {a: x}: {a: number} = {a: "a"};', 'x'],
			['let [a, b]: number[] = [1, "a"];', 'b'],
			['let [a, ...rest]: number[] = [1, 2, "a"];', 'rest[1]'],
			['let {a, ...rest}: {a: number, b: number} = {a: 1, b: "a"};', 'rest.b'],
		] as const) {
			const result = diagnostics(source);
			assert.equal(result.length, 1, source);
			assert.deepEqual(result[0]!.params, { name, expected: 'number', actual: 'string', value: '"a"' }, source);
		}
	});

	test('欠けたプロパティの診断は missing を示す', () => {
		const result = diagnostics('let {a: x}: {a: number} = {};');
		assert.equal(result.length, 1);
		assert.equal(result[0]!.params.name, 'x');
		assert.equal(result[0]!.params.actual, 'missing');
	});

	test('truthy リテラルと省略条件のループは fallthrough しない', () => {
		for (const loop of ['while (1) {}', 'while (-1) {}', 'while ("x") {}', 'for (;;) {}', 'do {} while (1);']) assert.deepEqual(codes(`switch (0) {case 0: ${loop} case 1: break;}`), []);
		for (const loop of ['while (0) {}', 'while (-0) {}', 'while ("") {}', 'while (1) {break;}', 'for (;;) {break;}']) assert.deepEqual(codes(`switch (0) {case 0: ${loop} case 1: break;}`), ['CASE_FALLTHROUGH']);
	});
});


for (const [label, source, expected] of [
	['二項式', `let result = ${'1 + '.repeat(29_999)}1;`, 30_000],
	['member', `let x = {}; x.next = x; let result = x${'.next'.repeat(30_000)} === x;`, true],
	['call', `function f() { return f; } let result = f${'()'.repeat(30_000)} === f;`, true],
] as const) test(`実行できる 30000 段の ${label} をスタック超過なく検査する`, async () => {
	const { program } = parse(source);
	assert.deepEqual(check(program), []);
	const interpreter = new Interpreter({}, { maxSteps: 1_000_000 });
	await interpreter.exec(program);
	assert.equal(interpreter.getGlobal('result'), expected);
});

test('長い else-if の fallthrough 判定もスタック超過しない', () => {
	const branches = 'if (false) break; else '.repeat(10_000);
	assert.deepEqual(codes(`switch (0) {case 0: ${branches} break; case 1: break;}`), []);
});
