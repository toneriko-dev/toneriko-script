import { describe, expect, test } from 'vitest';
import { catalog, constantDefinitions, definitions, standardGlobals, standardMethod } from '../../src/v2/stdlib/index.js';
import { STANDARD_FUNCTION, catalogOf, isStdFunction } from '../../src/v2/stdlib/core.js';
import { parse } from '../../src/v2/parser/index.js';
import { Interpreter } from '../../src/v2/interpreter.js';

describe('標準ライブラリの単一定義', () => {
	test('公開一覧と実行表がすべての定義に対応する', () => {
		expect(catalog).toEqual([...catalogOf(definitions), ...constantDefinitions.map(({ value: _, ...metadata }) => metadata)]);
		expect(new Set(catalog.map(d => `${d.receiver}:${d.name}`)).size).toBe(definitions.length + constantDefinitions.length);
		const globals = standardGlobals();
		for (const definition of definitions) {
			const fn = definition.receiver === 'global'
				? definition.name.split('.').reduce<any>((value, key) => value[key], globals)
				: standardMethod(definition.receiver, definition.name);
			expect(isStdFunction(fn)).toBe(true);
			expect(fn[STANDARD_FUNCTION]).toBe(definition);
			expect(definition.description.ja.length).toBeGreaterThan(0);
			expect(definition.description.en.length).toBeGreaterThan(0);
			expect(definition.description.ja).not.toContain('\n');
			expect(definition.description.en).not.toContain('\n');
			for (const type of [...definition.args.map(arg => arg.type), definition.returns]) {
				const source = `function check(value: ${type === 'void' ? 'any' : type}): ${type} { return null; }`;
				expect(() => parse(source)).not.toThrow();
			}
		}
	});

	test('標準メソッドを評価フレームから呼び、関数型として公開する', async () => {
		const interpreter = new Interpreter();
		await interpreter.exec(parse('const a = []; const length = a.push(1, 2); const value = "👩🏽a".at(-2); const type = typeof a.push;').program);
		expect(interpreter.getGlobal('length')).toBe(2);
		expect(interpreter.getGlobal('a')).toEqual([1, 2]);
		expect(interpreter.getGlobal('value')).toBe('👩🏽');
		expect(interpreter.getGlobal('type')).toBe('function');
	});

	test('標準メソッド内の処理も実行上限を共有する', async () => {
		const interpreter = new Interpreter({ values: Array.from({ length: 1024 }, (_, i) => i) }, { maxSteps: 100 });
		await expect(interpreter.exec(parse('const a = []; a.push(...values);').program)).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
	});
});


test('設計書の全公開名が一覧にあり、内部反復子の next も単一定義を使う', async () => {
	const expected = {
		array: 'push pop shift unshift slice splice concat join indexOf includes find findIndex filter map flatMap flat reduce some every forEach sort reverse toSorted toReversed at fill entries shuffle sample sampleBy sortBy unique uniqueBy sum minBy maxBy countBy mapConcurrent',
		string: 'slice substring at indexOf includes startsWith endsWith padStart padEnd trim toUpperCase toLowerCase split replace replaceAll repeat dedent',
		number: 'toFixed toString', iterator: 'next',
		global: 'NaN Infinity Error Number String parseInt parseFloat Number.isInteger Number.isNaN Number.isFinite Number.MAX_SAFE_INTEGER Number.MIN_SAFE_INTEGER Array.isArray Array.from Object.keys Object.values Object.entries Object.fromEntries Object.groupBy JSON.parse JSON.stringify structuredClone encodeURIComponent decodeURIComponent Date.now Date.parts Date.format console.log sleep range setTimeout setInterval clearTimeout clearInterval deepEqual',
	};
	for (const [receiver, names] of Object.entries(expected)) {
		const actual = catalog.filter(d => d.receiver === receiver && !d.name.startsWith('Math.')).map(d => d.name).sort();
		expect(actual).toEqual(names.split(' ').sort());
	}
	const interpreter = new Interpreter();
	await interpreter.exec(parse('const iter = [1].entries(); const next = iter.next;').program);
	expect(interpreter.getGlobal('next')[STANDARD_FUNCTION]).toBe(definitions.find(d => d.receiver === 'iterator' && d.name === 'next'));
});

test('名前空間のメンバーは列挙されず、数学定数は変更・削除できない', async () => {
	const output: unknown[] = [];
	const vm = new Interpreter({ out: (value: unknown) => { output.push(value); } });
	await vm.exec(parse('out(Object.keys(Math)); out(Object.keys(JSON)); out(JSON.stringify(Math)); out(Math.sqrt(9));').program);
	expect(output).toEqual([[], [], '{}', 3]);
	for (const source of ['Math.PI = 3;', 'delete Math.PI;']) {
		await expect(new Interpreter().exec(parse(source).program)).rejects.toMatchObject({ name: 'TypeError', code: 'READONLY_PROPERTY' });
	}
	for (const entry of constantDefinitions.filter(entry => entry.name.startsWith('Math.'))) {
		expect(Object.getOwnPropertyDescriptor(standardGlobals().Math, entry.name.slice(5))).toEqual({ value: entry.value, enumerable: false, writable: false, configurable: false });
	}
});

test('NaN と Infinity はグローバル定数として一覧と実行表で一致する', async () => {
	const vm = new Interpreter();
	await vm.exec(parse('const n = NaN; const i = Infinity; const negative = -Infinity;').program);
	expect(vm.getGlobal('n')).toBeNaN(); expect(vm.getGlobal('i')).toBe(Infinity); expect(vm.getGlobal('negative')).toBe(-Infinity);
	for (const name of ['NaN', 'Infinity']) {
		expect(catalog.find(entry => entry.name === name)).toMatchObject({ kind: 'constant', returns: 'number', args: [] });
		await expect(new Interpreter().exec(parse(`${name} = 0;`).program)).rejects.toMatchObject({ code: 'CONST_ASSIGNMENT' });
	}
	for (const definition of constantDefinitions) {
		const value = definition.name.split('.').reduce<any>((object, key) => object[key], standardGlobals());
		expect(value).toBe(definition.value);
	}
});
