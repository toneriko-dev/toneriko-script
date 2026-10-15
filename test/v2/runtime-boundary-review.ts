import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { PropertyAccess, SCRIPT_FUNCTION, errorValue } from '../../src/v2/runtime/values.js';
import { createScriptError, runtimeError } from '../../src/v2/runtime/errors.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

const pos = { line: 1, column: 1 };

describe('配列のアクセス単位の検査', () => {
	test('無関係な添字を走査せず、選んだ要素だけを読む', () => {
		const properties = new PropertyAccess();
		let calls = 0;
		const array = [1, 2];
		Object.defineProperty(array, '1', { get() { calls++; return 2; } });
		expect(properties.normalize(array, pos)).toBe(array);
		expect(properties.get(array, 0, pos)).toBe(1);
		expect(() => properties.get(array, 1, pos)).toThrow(expect.objectContaining({ code: 'ACCESSOR_PROPERTY' }));
		expect(calls).toBe(0);
	});

	test('ホストの疎配列は穴を観測したときに拒否する', () => {
		const properties = new PropertyAccess();
		const array = [1, , 3];
		expect(properties.normalize(array, pos)).toBe(array);
		expect(properties.get(array, 0, pos)).toBe(1);
		expect(() => properties.get(array, 1, pos)).toThrow(expect.objectContaining({ code: 'SPARSE_ARRAY' }));
		const items = properties.iterableIterator(array, pos);
		expect(items.next().value).toBe(1);
		expect(() => items.next()).toThrow(expect.objectContaining({ code: 'SPARSE_ARRAY' }));
	});

	test('配列の own property と独自の push を読み書きする', () => {
		const properties = new PropertyAccess();
		const push = () => 7;
		const array = Object.assign([1], { foo: 3, push });
		Object.defineProperty(array, 'hidden', { value: 9 });
		Object.defineProperty(array, Symbol('extra'), { value: 10 });
		expect(properties.get(array, 'push', pos)).toBe(push);
		expect(properties.get(array, 'foo', pos)).toBe(3);
		expect(properties.get(array, 'hidden', pos)).toBe(9);
		properties.set(array, 'foo', 4, pos);
		properties.set(array, '01', 5, pos);
		expect(properties.get(array, '01', pos)).toBe(5);
		expect(properties.entries(array, pos)).toEqual([['0', 1], ['foo', 4], ['push', push], ['01', 5]]);
		expect(properties.delete(array, 'foo', pos)).toBe(true);
		expect(properties.has(array, 'foo', pos)).toBe(false);
	});

	test('配列の反復途中でホストが変更した穴と getter を検出する', () => {
		const properties = new PropertyAccess();
		for (const mode of ['hole', 'getter']) {
			const array = [1, 2];
			const iterator = properties.iterableIterator(array, pos);
			expect(iterator.next().value).toBe(1);
			if (mode === 'hole') delete array[1];
			else Object.defineProperty(array, '1', { get() { throw new Error('getter を呼ばない'); } });
			expect(() => iterator.next()).toThrow(expect.objectContaining({ code: mode === 'hole' ? 'SPARSE_ARRAY' : 'ACCESSOR_PROPERTY' }));
		}
	});
});

describe('関数と未実装メソッド', () => {
	test('ホスト関数とスクリプト関数と登録メソッドの操作をすべて拒否する', () => {
		const properties = new PropertyAccess();
		const host = Object.assign(() => 1, { x: 7 });
		const script = { [SCRIPT_FUNCTION]: true, body: 'internal' };
		for (const fn of [host, script, properties.get([], 'push', pos)]) {
			for (const key of ['x', 'missing', 'name', 'length', 'prototype']) {
				for (const operation of [
					() => properties.get(fn, key, pos),
					() => properties.has(fn, key, pos),
					() => properties.set(fn, key, 3, pos),
					() => properties.delete(fn, key, pos),
					() => properties.entries(fn, pos),
				]) expect(operation).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
			}
		}
		expect(host.x).toBe(7);
		expect(script.body).toBe('internal');
	});

	test('登録済みメソッドの存在は true、未実装メソッドは明示的に拒否する', () => {
		const properties = new PropertyAccess();
		expect(properties.has([], 'push', pos)).toBe(true);
		for (const [value, key] of [[[], 'reduceRight'], [[], 'copyWithin'], ['', 'charAt'], ['', 'normalize']] as const) {
			expect(() => properties.get(value, key, pos)).toThrow(expect.objectContaining({ code: 'METHOD_NOT_AVAILABLE' }));
			if (Array.isArray(value)) expect(() => properties.has(value, key, pos)).toThrow(expect.objectContaining({ code: 'METHOD_NOT_AVAILABLE' }));
		}
		expect(properties.get([], 'unknownName', pos)).toBeNull();
		expect(properties.get('abc', 'unknownName', pos)).toBeNull();
		expect(properties.get(Object.assign([], { map: 7 }), 'map', pos)).toBe(7);
	});
});

test('別 realm と toStringTag を持つ Error を既存の組み込みだけで判別する', () => {
	let calls = 0;
	const error = runInNewContext('new TypeError("x")') as Error;
	Object.defineProperty(error, Symbol.toStringTag, { get() { calls++; return 'hidden'; } });
	expect(errorValue(error)).toBe(true);
	expect(errorValue({ get [Symbol.toStringTag]() { calls++; return 'Error'; } })).toBe(false);
	expect(errorValue(runInNewContext('new Error("x")'))).toBe(true);
	expect(calls).toBe(0);
});

test('実行時 Error の値は内部診断と位置を分離し、同一性を保つ', () => {
	const properties = new PropertyAccess();
	const diagnostic = runtimeError('TDZ_ACCESS', pos, { name: 'x' });
	const value = createScriptError(diagnostic.name, diagnostic.message, diagnostic);
	expect(value).not.toBe(diagnostic);
	expect(properties.normalize(value, pos)).toBe(value);
	expect(properties.get(value, 'code', pos)).toBe('TDZ_ACCESS');
	expect(properties.entries(value, pos)).toEqual([]);
	const location = properties.get(value, 'pos', pos);
	expect(location).not.toBe(diagnostic.pos);
	properties.set(location, 'line', 99, pos);
	expect(diagnostic.pos).toEqual(pos);
	properties.set(value, 'message', 'changed', pos);
	expect(diagnostic.message).not.toBe('changed');
});

test('ホスト Error は同じ参照と変更を次の実行にも持ち越す', () => {
	const properties = new PropertyAccess();
	const error = new Error('original');
	const object = { error };
	const first = properties.get(object, 'error', pos);
	expect(first).toBe(error);
	expect(properties.get(object, 'error', pos)).toBe(first);
	properties.set(first, 'message', 'edited', pos);
	expect(properties.get(properties.get(object, 'error', pos), 'message', pos)).toBe('edited');
	expect(error.message).toBe('edited');
	properties.clear();
	const next = properties.get(object, 'error', pos);
	expect(next).toBe(first);
	expect(properties.get(next, 'message', pos)).toBe('edited');
});

test('プロパティから読む Error は exec をまたいで同一性と変更を保つ', async () => {
	const object = { error: new Error('original') };
	const output: unknown[] = [];
	const interpreter = new Interpreter({ object, out: (value: unknown) => { output.push(value); } });
	await interpreter.exec(parse('out(object.error === object.error); object.error.message = "edited"; out(object.error.message);').program);
	await interpreter.exec(parse('out(object.error.message);').program);
	expect(output).toEqual([true, 'edited', 'edited']);
	expect(object.error.message).toBe('edited');
});

test.each(['new Error("message")', 'new Error()'])('判別できないタグ付き Error の内部値を漏らさない: %s', (source) => {
	const properties = new PropertyAccess();
	const error = runInNewContext(source) as Error;
	Object.setPrototypeOf(error, null);
	Object.defineProperty(error, Symbol.toStringTag, { value: 'Other' });
	for (const operation of [
		() => properties.normalize(error, pos),
		() => properties.get(error, 'stack', pos),
		() => properties.has(error, 'stack', pos),
		() => properties.entries(error, pos),
	]) expect(operation).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE', pos }));
});
