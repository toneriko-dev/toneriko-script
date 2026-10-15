import { describe, expect, test } from 'vitest';
import { PropertyAccess, isBuiltinMethod, SCRIPT_FUNCTION } from '../../src/v2/runtime/values.js';

const pos = { line: 2, column: 4 };

describe('v2 の値とプロパティ', () => {
	test('辞書は自分のプロパティだけを公開し undefined を null にする', () => {
		const properties = new PropertyAccess();
		const object = { a: undefined };
		expect(properties.get(object, 'a', pos)).toBeNull();
		for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
			expect(properties.get(object, key, pos)).toBeNull();
			expect(properties.has(object, key, pos)).toBe(false);
			properties.set(object, key, 42, pos);
			expect(properties.get(object, key, pos)).toBe(42);
			expect(properties.has(object, key, pos)).toBe(true);
		}
	});

	test('__proto__ は全プロパティ経路で拒否する', () => {
		const properties = new PropertyAccess();
		const object = Object.create(null);
		object['__proto__'] = 3;
		for (const action of [
			() => properties.get(object, '__proto__', pos),
			() => properties.set(object, '__proto__', 1, pos),
			() => properties.has(object, '__proto__', pos),
			() => properties.delete(object, '__proto__', pos),
			() => properties.entries(object, pos),
		]) expect(action).toThrow(expect.objectContaining({ code: 'FORBIDDEN_PROPERTY', pos }));
	});

	test('getter と setter を実行しない', () => {
		const properties = new PropertyAccess();
		let calls = 0;
		const object = { get x() { calls++; return 1; }, set x(_value) { calls++; } };
		expect(() => properties.get(object, 'x', pos)).toThrow(expect.objectContaining({ code: 'ACCESSOR_PROPERTY' }));
		expect(() => properties.set(object, 'x', 3, pos)).toThrow(expect.objectContaining({ code: 'ACCESSOR_PROPERTY' }));
		expect(calls).toBe(0);
	});

	test('キーの順番と共有参照を保つ', () => {
		const properties = new PropertyAccess();
		const shared = {};
		const object = Object.assign(Object.create(null), { z: 0, 10: 1, 2: 2, a: shared });
		expect(properties.entries(object, pos).map(([key]) => key)).toEqual(['2', '10', 'z', 'a']);
		expect(properties.get(object, 'a', pos)).toBe(shared);
		properties.delete(object, 'z', pos);
		properties.set(object, 'z', 1, pos);
		expect(properties.entries(object, pos).map(([key]) => key)).toEqual(['2', '10', 'a', 'z']);
	});

	test('配列は既存の添字と末尾へ書け、長さは縮められる', () => {
		const properties = new PropertyAccess();
		const array = [1, 2];
		properties.set(array, 0, 3, pos);
		properties.set(array, 2, 4, pos);
		expect(array).toEqual([3, 2, 4]);
		properties.set(array, 'length', 1, pos);
		expect(array).toEqual([3]);
		properties.set(array, 'length', 0, pos);
		expect(array).toEqual([]);
	});

	test('配列の穴と不正な操作を拒否する', () => {
		const properties = new PropertyAccess();
		const array = [1];
		for (const [action, code] of [
			[() => properties.get(array, 1, pos), 'ARRAY_INDEX_OUT_OF_RANGE'],
			[() => properties.set(array, 2, 2, pos), 'ARRAY_GAP'],
			[() => properties.set(array, 'length', 2, pos), 'ARRAY_LENGTH_GROWTH'],
			[() => properties.set(array, 'length', -1, pos), 'INVALID_ARRAY_LENGTH'],
			[() => properties.set(array, 'length', 0.5, pos), 'INVALID_ARRAY_LENGTH'],
			[() => properties.delete(array, 0, pos), 'ARRAY_DELETE'],
			[() => properties.get([, 1], 0, pos), 'SPARSE_ARRAY'],
		] as const) expect(action).toThrow(expect.objectContaining({ code }));
		expect(array).toEqual([1]);
	});

	test('ホストで変更された配列を再観測するときも穴を拒否する', () => {
		const properties = new PropertyAccess();
		const array = [1, 2];
		properties.normalize(array, pos);
		delete array[0];
		expect(() => properties.get(array, 0, pos)).toThrow(expect.objectContaining({ code: 'SPARSE_ARRAY' }));
	});

	test.each(['\r\n', 'e\u0301', '👩🏽', '👩‍👩‍👧‍👦', '🇯🇵'])('書記素 %s は 1 文字として読む', (character) => {
		const properties = new PropertyAccess();
		expect(properties.get(character, 'length', pos)).toBe(1);
		expect(properties.get(character, 0, pos)).toBe(character);
		expect(properties.get(character, 1, pos)).toBeNull();
	});

	test.each(['abc'.repeat(100), '👩🏽e\u0301\r\n'.repeat(100)])('長さと添字の反復は再分割しない', (value) => {
		let steps = 0;
		const properties = new PropertyAccess(() => { steps++; });
		const length = properties.get(value, 'length', pos) as number;
		const initial = steps;
		for (let i = 0; i < length; i++) {
			properties.get(value, 'length', pos);
			properties.get(value, i, pos);
		}
		expect(initial).toBeGreaterThan(0);
		expect(steps).toBe(initial);
	});

	test.each(['a'.repeat(192), '👩🏽'.repeat(192)])('長い値の準備を分割して進められる', (value) => {
		let steps = 0;
		const properties = new PropertyAccess(() => { steps++; });
		const preparation = properties.prepare(value, pos);
		expect(preparation.next().done).toBe(false);
		expect(steps).toBeGreaterThanOrEqual(64);
		expect(steps).toBeLessThanOrEqual(65);
		const remaining = [...preparation];
		expect(remaining.length).toBe(Math.floor(value.length / 64) - 1);
		const completedSteps = steps;
		expect(properties.get(value, 'length', pos)).toBe(192);
		expect(steps).toBe(completedSteps);
	});

	test('要素とプロパティをコピーせず逐次取得できる', () => {
		const properties = new PropertyAccess();
		expect([...properties.iterableIterator('é👩🏽', pos)]).toEqual(['é', '👩🏽']);
		expect([...properties.iterableIterator([1, undefined], pos)]).toEqual([1, null]);
		expect([...properties.entriesIterator({ b: 1, 2: 2 }, pos)]).toEqual([['2', 2], ['b', 1]]);
	});

	test('メソッドは同じ関数値を返し、受け手を呼び出し時に確認する', () => {
		const properties = new PropertyAccess();
		const array: unknown[] = [];
		const push = properties.get(array, 'push', pos);
		expect(push).toBe(properties.get([], 'push', pos));
		expect(isBuiltinMethod(push)).toBe(true);
		if (!isBuiltinMethod(push)) throw new Error('push');
		expect(properties.callMethod(push, array, [1, 2], pos)).toBe(2);
		expect(array).toEqual([1, 2]);
		expect(() => properties.callMethod(push, null, [], pos)).toThrow(expect.objectContaining({ code: 'INVALID_RECEIVER' }));
		const at = properties.get('👩🏽a', 'at', pos);
		if (!isBuiltinMethod(at)) throw new Error('at');
		expect(properties.callMethod(at, '👩🏽a', [-2], pos)).toBe('👩🏽');
		expect(properties.callMethod(at, '👩🏽a', [8], pos)).toBeNull();
	});

	test('関数の標準プロパティは未対応として拒否し内部情報を削除しない', () => {
		const properties = new PropertyAccess();
		const script = { [SCRIPT_FUNCTION]: true, body: 'internal' };
		const builtin = properties.get([], 'push', pos);
		for (const fn of [script, builtin]) {
			for (const key of ['name', 'length', 'prototype']) {
				expect(() => properties.get(fn, key, pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
				expect(() => properties.has(fn, key, pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
			}
			expect(() => properties.get(fn, 'body', pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
			expect(() => properties.has(fn, 'body', pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
			expect(() => properties.delete(fn, 'body', pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
		}
		expect(script.body).toBe('internal');
	});
});
