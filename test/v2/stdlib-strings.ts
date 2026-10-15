import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import * as fc from 'fast-check';
import { nodeExecutable } from '../../scripts/v2-node.mjs';
import { snapshot } from '../../scripts/v2-reference.mjs';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { messages } from '../../src/v2/messages.js';
import { stringDefinitions } from '../../src/v2/stdlib/strings.js';
import { PropertyAccess } from '../../src/v2/runtime/values.js';
import type { StdContext } from '../../src/v2/stdlib/core.js';

async function execute(source: string, globals = {}) {
	const values: unknown[] = [];
	await new Interpreter({ out: (value: unknown) => { values.push(value); }, ...globals }, { maxSteps: 1_000_000 }).exec(parse(source).program);
	return values;
}
const seeds = [20261015, 17041, 89023, 424242, 314159];
const ascii = fc.array(fc.constantFrom('a', 'b', 'c', '$', ' ', '\t'), { maxLength: 24 }).map(x => x.join(''));
const sample = fc.record({ text: ascii, search: ascii, a: fc.integer({ min: -30, max: 30 }), b: fc.integer({ min: -30, max: 30 }), count: fc.integer({ min: 0, max: 15 }), replacement: fc.constantFrom('$&', '$$', "$`/$'", '$1', 'x', '') });
const methods: Record<string, (v: fc.ArbitraryValue<typeof sample>) => unknown[]> = {
	slice: v => [v.a, v.b], substring: v => [v.a, v.b], at: v => [v.a],
	indexOf: v => [v.search, v.a], includes: v => [v.search, v.a], startsWith: v => [v.search, v.a], endsWith: v => [v.search, v.a],
	padStart: v => [v.count, v.search], padEnd: v => [v.count, v.search], trim: () => [], toUpperCase: () => [], toLowerCase: () => [],
	split: v => [v.search, v.count], replace: v => [v.search, v.replacement], replaceAll: v => [v.search, v.replacement], repeat: v => [v.count],
};
describe('文字列標準関数', () => {
	for (const [method, args] of Object.entries(methods)) test(`${method}: Node 差分 5 seed × 100 件`, async () => {
		const cases = seeds.flatMap(seed => fc.sample(sample, { seed, numRuns: 100 })).map(v => `reach(); out(${JSON.stringify(v.text)}.${method}(${args(v).map(x => JSON.stringify(x)).join(',')}) ?? null);`);
		const reference = spawnSync(nodeExecutable, ['--experimental-vm-modules', fileURLToPath(new URL('../../scripts/v2-reference.mjs', import.meta.url))], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
		expect(reference.status, reference.stderr).toBe(0);
		const expected = JSON.parse(reference.stdout);
		let reached = 0, compared = 0;
		for (let i = 0; i < cases.length; i++) {
			const actual = await execute(cases[i]!, { reach: () => { reached++; } });
			expect(expected[i].reached).toBe(1);
			expect(expected[i].error).toBe(null);
			expect(actual.map(snapshot), cases[i]).toEqual(expected[i].output);
			compared++;
		}
		expect(reached).toBe(500); expect(compared).toBe(500);
	}, 60_000);

	test('絵文字・結合・CRLF・国旗を書記素として操作する', async () => {
		const text = 'a👩🏽‍💻é\r\n🇯🇵z';
		expect(await execute(`let s = ${JSON.stringify(text)}; out([s.slice(1, 3), s.substring(4, 2), s.at(-2), s.indexOf("z"), s.startsWith("👩🏽‍💻", 1), s.endsWith("é", 3), s.split("")]);`)).toEqual([['👩🏽‍💻é', 'é\r\n', '🇯🇵', 5, true, true, ['a', '👩🏽‍💻', 'é', '\r\n', '🇯🇵', 'z']]]);
		expect(await execute('out(["z".padStart(3, "👩🏽‍💻a"), "z".padEnd(3, "é"), "👩🏽‍💻".repeat(2)]);')).toEqual([['👩🏽‍💻az', 'zéé', '👩🏽‍💻👩🏽‍💻']]);
	});
	test('途中の一致が結果を変える検索だけを日英の案内付きエラーにする', async () => {
		expect(messages.STRING_GRAPHEME_MATCH.ja.hint).toContain('replaceAll("\\r\\n", "\\n")');
		expect(messages.STRING_GRAPHEME_MATCH.en.hint).toContain('combining characters');
		const cases = [
			['a\r\nb', 'split', '\n'], ['a\r\nb', 'includes', '\n'],
			['a\r\nb\r\n', 'replaceAll', '\n'], ['é', 'includes', 'e'],
			['é e', 'indexOf', 'e'], ['é e', 'replace', 'e'],
			['é', 'startsWith', 'e'], ['é', 'endsWith', '́'],
			['👩🏽‍💻', 'includes', '💻'],
		];
		for (const [input, method, search] of cases) {
			await expect(execute(`${JSON.stringify(input)}.${method}(${JSON.stringify(search)}${method!.startsWith('replace') ? ', "x"' : ''});`)).rejects.toMatchObject({ code: 'STRING_GRAPHEME_MATCH', name: 'TypeError', pos: expect.objectContaining({ line: 1 }) });
		}
	});
	test('includes は後の境界一致まで探し、結果が決まれば途中一致を調べない', async () => {
		expect(await execute('out(["é e".includes("e"), "e é".includes("e"), "e é".indexOf("e"), "e é".replace("e", "x"), "é e".includes("e", 2)]);')).toEqual([[true, true, 0, 'x é', true]]);
	});
	test('split の limit に達した後と空の検索は途中一致を調べない', async () => {
		expect(await execute('out(["e é".split("e", 1), "é".split("e", 0), "é".split(""), "é".includes(""), "é".indexOf("", 1), "é".replaceAll("", "-")]);')).toEqual([[[''], [], ['é'], true, 1, '-é-']]);
		await expect(execute('"e é".split("e", 2);')).rejects.toMatchObject({ code: 'STRING_GRAPHEME_MATCH' });
	});
	test('部分一致を含む長い検索も線形のステップ数に収まる', () => {
		const definition = stringDefinitions.find(d => d.name === 'includes')!;
		for (const length of [1000, 2000, 4000]) {
			let ticks = 0;
			const ctx: StdContext = { pos: { line: 1, column: 1 }, properties: new PropertyAccess(), tick() { ticks++; }, *checkpoint() { return null; }, *call() { return null; } };
			const frame = definition.implementation(ctx, 'é'.repeat(length) + 'e', ['e']);
			let result = frame.next(); while (!result.done) result = frame.next();
			expect(result.value).toBe(true); expect(ticks).toBeLessThan(length * 5);
		}
	});
	test('置換は書記素の位置を渡し、利用者の関数を順に待つ', async () => {
		const trace: string[] = [];
		const output = await execute('out("👩🏽‍💻a👩🏽‍💻a".replaceAll("a", (match, index, input) => wait(index)));', { wait: async (index: number) => { trace.push(`start${index}`); await new Promise(resolve => setTimeout(resolve, 1)); trace.push(`end${index}`); return `${index}`; } });
		expect(output).toEqual(['👩🏽‍💻1👩🏽‍💻3']); expect(trace).toEqual(['start1', 'end1', 'start3', 'end3']);
		expect(await execute('out(["aaa".replace("a", "x"), "aaa".replaceAll("a", "x"), "éz".replaceAll("", "-"), "aba".replace("b", "$$:$&:$`:$\'")]);')).toEqual([['xaa', 'xxx', '-é-z-', 'a$:b:a:aa']]);
	});
	test('substring の丸め・入れ替えと省略', async () => {
		expect(await execute('out(["abcd".substring(3.9, 1.8), "abcd".substring(-3, 2), "abcd".substring(0/0, 1/0), "abcd".slice(), "abcd".split(), "abcd".at()]);')).toEqual([['bc', 'ab', 'abcd', 'abcd', ['abcd'], 'a']]);
	});
	test('dedent は空白とタブを区別し空行を無視する', async () => {
		expect(await execute('out(["  a\\n    b\\n  ".dedent(), "\\ta\\n b".dedent(), "\\r\\n  a\\r\\n  b".dedent()]);')).toEqual([['a\n  b\n', '\ta\n b', '\r\na\r\nb']]);
	});
	test('数値の特殊値・引数省略・連結境界', async () => {
		expect(await execute('out(["abc".repeat(), "abc".repeat(-0.5), "abc".padStart(0/0), "abc".padEnd(-1/0), "abc".indexOf("", 1/0), "abc".split("", 1/0), "\\n".padStart(2, "\\r").length, "e".padEnd(2, "́").length]);')).toEqual([['', '', 'abc', 'abc', 3, [], 1, 1]]);
		expect(await execute('let errors = []; for (let f of [() => "a".repeat(1/0), () => "a".repeat(-1), () => "a".padStart(1/0)]) { try { f(); } catch (e) { errors.push([e.name, e.code]); } } out(errors);')).toEqual([[['RangeError', 'STDLIB_ARGUMENT_RANGE'], ['RangeError', 'STDLIB_ARGUMENT_RANGE'], ['RangeError', 'STDLIB_ARGUMENT_RANGE']]]);
	});
	test('dedent は冪等', async () => {
		for (const input of fc.sample(ascii, { seed: 20261015, numRuns: 100 })) expect(await execute(`let s = ${JSON.stringify('  ' + input + '\n  x')}; out(s.dedent().dedent() === s.dedent());`)).toEqual([true]);
	});
	test('長い共通接頭辞の検索は線形数の中断点で完了する', () => {
		const definition = stringDefinitions.find(d => d.name === 'indexOf')!;
		for (const length of [1000, 2000, 4000]) {
			let ticks = 0;
			const ctx: StdContext = { pos: { line: 1, column: 1 }, properties: new PropertyAccess(), tick() { ticks++; }, *checkpoint() { return null; }, *call() { return null; } };
			const frame = definition.implementation(ctx, 'a'.repeat(length) + 'b', ['a'.repeat(length / 2) + 'c']);
			let step = frame.next(); while (!step.done) step = frame.next();
			expect(step.value).toBe(-1); expect(ticks).toBeLessThan(length * 4);
		}
	});
});
