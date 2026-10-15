import { describe, expect, test } from 'vitest';
import { catalog, definitions, standardGlobals, standardMethod } from '../../src/v2/stdlib/index.js';
import { STANDARD_FUNCTION, catalogOf, isStdFunction } from '../../src/v2/stdlib/core.js';
import { parse } from '../../src/v2/parser/index.js';
import { Interpreter } from '../../src/v2/interpreter.js';

describe('標準ライブラリの単一定義', () => {
	test('公開一覧と実行表がすべての定義に対応する', () => {
		expect(catalog).toEqual(catalogOf(definitions));
		expect(new Set(catalog.map(d => `${d.receiver}:${d.name}`)).size).toBe(definitions.length);
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
