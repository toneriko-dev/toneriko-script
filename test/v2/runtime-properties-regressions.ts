import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { PropertyAccess } from '../../src/v2/runtime/values.js';
import { runtimeError } from '../../src/v2/runtime/errors.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

const pos = { line: 1, column: 1 };

describe('v2 の公開プロパティ境界の回帰', () => {
	test.each([
		new Error('message', { cause: 'reason' }),
		new TypeError('message', { cause: 'reason' }),
		runInNewContext('new Error("message", {cause: "reason"})') as Error,
	])('Error は許可した値だけを公開する', (error) => {
		const properties = new PropertyAccess();
		Object.defineProperty(error, 'secret', { value: 123, enumerable: true });
		expect(properties.get(error, 'message', pos)).toBe('message');
		expect(properties.get(error, 'cause', pos)).toBe('reason');
		expect(properties.get(error, 'name', pos)).toBe(error.name);
		for (const key of ['stack', 'secret']) {
			expect(properties.get(error, key, pos)).toBeNull();
			expect(properties.has(error, key, pos)).toBe(false);
			expect(properties.entries(error, pos).map(([name]) => name)).not.toContain(key);
			expect(() => properties.set(error, key, 7, pos)).toThrow(expect.objectContaining({ code: 'READONLY_PROPERTY' }));
			const descriptor = Object.getOwnPropertyDescriptor(error, key);
			expect(properties.delete(error, key, pos)).toBe(true);
			expect(Object.getOwnPropertyDescriptor(error, key)).toEqual(descriptor);
		}
	});

	test('Error の cause は自分のプロパティだけを読む', () => {
		const properties = new PropertyAccess();
		const error = new Error('message');
		Object.setPrototypeOf(error, Object.assign(Object.create(Error.prototype), { cause: 'hidden' }));
		expect(properties.get(error, 'cause', pos)).toBeNull();
		expect(properties.has(error, 'cause', pos)).toBe(false);
	});

	test('Error 判別は toStringTag の getter を呼ばない', () => {
		const properties = new PropertyAccess();
		let calls = 0;
		const object = { x: 3, get [Symbol.toStringTag]() { calls++; return 'Error'; } };
		expect(properties.get(object, 'x', pos)).toBe(3);
		expect(properties.entries(object, pos)).toEqual([['x', 3]]);
		expect(calls).toBe(0);
		const error = runInNewContext('new Error("message")') as Error;
		Object.defineProperty(error, Symbol.toStringTag, { get() { calls++; return 'Other'; } });
		expect(properties.get(error, 'stack', pos)).toBeNull();
		expect(calls).toBe(0);
	});

	test('実行時エラーは code と pos 以外の内部診断を隠す', () => {
		const properties = new PropertyAccess();
		const error = runtimeError('TDZ_ACCESS', pos, { name: 'x' }, 'ReferenceError');
		expect(properties.get(error, 'code', pos)).toBe('TDZ_ACCESS');
		expect(properties.get(error, 'pos', pos)).toEqual(pos);
		for (const key of ['stack', 'params', 'hint', 'severity']) {
			expect(properties.get(error, key, pos)).toBeNull();
			expect(properties.has(error, key, pos)).toBe(false);
			expect(properties.entries(error, pos).map(([name]) => name)).not.toContain(key);
		}
	});

	test('ホスト関数の任意の own property を全経路で隠す', () => {
		const properties = new PropertyAccess();
		const fn = Object.assign(function host() {}, { secret: 42 });
		expect(properties.get(fn, 'secret', pos)).toBeNull();
		expect(properties.has(fn, 'secret', pos)).toBe(false);
		expect(properties.entries(fn, pos)).toEqual([]);
		expect(() => properties.set(fn, 'secret', 7, pos)).toThrow(expect.objectContaining({ code: 'READONLY_PROPERTY' }));
		expect(properties.delete(fn, 'secret', pos)).toBe(true);
		expect(fn.secret).toBe(42);
		for (const key of ['name', 'length', 'prototype']) {
			expect(() => properties.get(fn, key, pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
			expect(() => properties.has(fn, key, pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
		}
	});

	test.each([
		['foo', true], ['hidden', false], ['push', true], [Symbol('hidden'), false],
	] as const)('配列の余分な own property %s を拒否する', (key, enumerable) => {
		const array = [1, 2];
		Object.defineProperty(array, key, { value: 9, enumerable, configurable: true });
		for (const operation of [
			(properties: PropertyAccess) => properties.normalize(array, pos),
			(properties: PropertyAccess) => properties.get(array, 'length', pos),
			(properties: PropertyAccess) => properties.set(array, 0, 3, pos),
			(properties: PropertyAccess) => properties.has(array, 'length', pos),
			(properties: PropertyAccess) => properties.delete(array, 'missing', pos),
			(properties: PropertyAccess) => properties.entries(array, pos),
			(properties: PropertyAccess) => properties.iterable(array, pos),
		]) expect(() => operation(new PropertyAccess())).toThrow(expect.objectContaining({ code: 'INVALID_ARRAY_PROPERTY' }));
	});

	test('ホストが追加した配列プロパティを再観測で拒否する', () => {
		const properties = new PropertyAccess();
		const array = [1];
		properties.normalize(array, pos);
		Object.defineProperty(array, 'hidden', { value: 3 });
		properties.invalidateHostArrays();
		expect(() => properties.get(array, 0, pos)).toThrow(expect.objectContaining({ code: 'INVALID_ARRAY_PROPERTY' }));
	});
});

test('ホストのErrorにある非公開thenをPromiseとして読まない', async () => {
	let calls = 0;
	const error = new Error('host');
	Object.defineProperty(error, 'then', { get: () => { calls++; return null; } });
	const output: unknown[] = [];
	await new Interpreter({ getError: () => error, out: (x: unknown) => { output.push(x); } }).exec(parse('out(getError().message); out(getError().then);').program);
	expect(calls).toBe(0);
	expect(output).toEqual(['host', null]);
});

test.each(['throw e;', 'fail();'])('エラーの包装でもgetterを実行しない: %s', async source => {
	let calls = 0;
	const error = new Error('host');
	Object.defineProperty(error, 'name', { get: () => { calls++; return 'Error'; } });
	const interpreter = new Interpreter({ e: error, fail: () => { throw error; } });
	await expect(interpreter.exec(parse(source).program)).rejects.toMatchObject({ code: 'ACCESSOR_PROPERTY' });
	expect(calls).toBe(0);
});

test.each([
	'const e=new Error("x"); out(e.stack); out("stack" in e);',
	'try { null.x; } catch(e) { out(e.stack); out("stack" in e); }',
	'try { fail(); } catch(e) { out(e.stack); out("stack" in e); }',
])('スクリプトからエラーのstackを読めない: %s', async source => {
	const output: unknown[] = [];
	await new Interpreter({ fail: () => { throw new Error('host'); }, out: (x: unknown) => { output.push(x); } }).exec(parse(source).program);
	expect(output).toEqual([null, false]);
});

test('スクリプトからホスト関数のprototypeを変更できない', async () => {
	function Host() {}
	const instance = new Host();
	await expect(new Interpreter({ host: Host }).exec(parse('host.prototype.x=42;').program)).rejects.toMatchObject({ code: 'UNSUPPORTED_VALUE' });
	expect(instance.x).toBeUndefined();
	expect(Object.hasOwn(Host.prototype, 'x')).toBe(false);
});

test('ホストが返す独自プロパティ付き配列を観測時に拒否する', async () => {
	const array: unknown[] = [];
	Object.assign(array, { push: () => 123, tag: 7 });
	await expect(new Interpreter({ getArray: () => array }).exec(parse('const a=getArray(); a.push(1);').program)).rejects.toMatchObject({ code: 'INVALID_ARRAY_PROPERTY' });
	expect(array.length).toBe(0);
});
