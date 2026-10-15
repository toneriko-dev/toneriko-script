import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { PropertyAccess } from '../../src/v2/runtime/values.js';
import { createScriptError, runtimeError } from '../../src/v2/runtime/errors.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

const pos = { line: 1, column: 1 };

describe('v2 の公開プロパティ境界の回帰', () => {
	test.each([
		new Error('message', { cause: 'reason' }),
		new TypeError('message', { cause: 'reason' }),
		runInNewContext('new Error("message", {cause: "reason"})') as Error,
	])('ホスト Error は stack だけを隠し own データを読み書きできる', (error) => {
		const properties = new PropertyAccess();
		Object.defineProperty(error, 'secret', { value: 123, enumerable: true, writable: true, configurable: true });
		expect(properties.get(error, 'message', pos)).toBe('message');
		expect(properties.get(error, 'cause', pos)).toBe('reason');
		expect(properties.get(error, 'name', pos)).toBe(error.name);
		for (const key of ['stack']) {
			expect(properties.get(error, key, pos)).toBeNull();
			expect(properties.has(error, key, pos)).toBe(false);
			expect(properties.entries(error, pos).map(([name]) => name)).not.toContain(key);
			expect(() => properties.set(error, key, 7, pos)).toThrow(expect.objectContaining({ code: 'READONLY_PROPERTY' }));
			const descriptor = Object.getOwnPropertyDescriptor(error, key);
			expect(properties.delete(error, key, pos)).toBe(true);
			expect(Object.getOwnPropertyDescriptor(error, key)).toEqual(descriptor);
		}
		expect(properties.get(error, 'secret', pos)).toBe(123);
		expect(properties.has(error, 'secret', pos)).toBe(true);
		expect(properties.entries(error, pos)).toEqual([['secret', 123]]);
		properties.set(error, 'secret', 7, pos);
		expect(Object.getOwnPropertyDescriptor(error, 'secret')?.value).toBe(7);
		expect(properties.delete(error, 'secret', pos)).toBe(true);
		expect(Object.hasOwn(error, 'secret')).toBe(false);
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
		const diagnostic = runtimeError('TDZ_ACCESS', pos, { name: 'x' }, 'ReferenceError');
		const error = createScriptError(diagnostic.name, diagnostic.message, diagnostic);
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
		expect(() => properties.get(fn, 'secret', pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
		expect(() => properties.has(fn, 'secret', pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
		expect(() => properties.entries(fn, pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
		expect(() => properties.set(fn, 'secret', 7, pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
		expect(() => properties.delete(fn, 'secret', pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
		expect(fn.secret).toBe(42);
		for (const key of ['name', 'length', 'prototype']) {
			expect(() => properties.get(fn, key, pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
			expect(() => properties.has(fn, key, pos)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VALUE' }));
		}
	});

	test.each([
		['foo', true], ['hidden', false], ['push', true], [Symbol('hidden'), false],
	] as const)('配列の追加 own property %s があっても既存の要素を読む', (key, enumerable) => {
		const array = [1, 2];
		Object.defineProperty(array, key, { value: 9, enumerable, configurable: true });
		const properties = new PropertyAccess();
		expect(properties.normalize(array, pos)).toBe(array);
		expect(properties.get(array, 0, pos)).toBe(1);
		if (typeof key === 'string') expect(properties.get(array, key, pos)).toBe(9);
	});

	test('ホストが追加した配列プロパティを再観測で読める', () => {
		const properties = new PropertyAccess();
		const array = [1];
		properties.normalize(array, pos);
		Object.defineProperty(array, 'hidden', { value: 3 });
		expect(properties.get(array, 'hidden', pos)).toBe(3);
	});
});

test('ホスト Error の then getter は Promise 判定で読まず明示的な読みを拒否する', async () => {
	let calls = 0;
	const error = new Error('host');
	Object.defineProperty(error, 'then', { get: () => { calls++; return null; } });
	const output: unknown[] = [];
	await expect(new Interpreter({ getError: () => error, out: (x: unknown) => { output.push(x); } }).exec(parse('out(getError().message); out(getError().then);').program)).rejects.toMatchObject({ code: 'ACCESSOR_PROPERTY' });
	expect(calls).toBe(0);
	expect(output).toEqual(['host']);
});

test.each(['throw e;', 'fail();'])('エラーの報告でも name の getter を呼ばず元の値を付ける: %s', async source => {
	let calls = 0;
	const error = new Error('host');
	Object.defineProperty(error, 'name', { get: () => { calls++; return 'Error'; } });
	await expect((async () => {
		const globals = source === 'throw e;' ? { e: error } : { fail: () => { throw error; } };
		const interpreter = new Interpreter(globals);
		await interpreter.exec(parse(source).program);
	})()).rejects.toMatchObject({ code: 'UNCAUGHT_EXCEPTION', thrownValue: error });
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

test('ホストが返す配列の独自 push を優先する', async () => {
	const array: unknown[] = [];
	Object.assign(array, { push: () => 123, tag: 7 });
	const output: unknown[] = [];
	await new Interpreter({ getArray: () => array, out: (value: unknown) => { output.push(value); } }).exec(parse('const a=getArray(); out(a.push(1)); out(a.tag);').program);
	expect(output).toEqual([123, 7]);
	expect(array.length).toBe(0);
});
