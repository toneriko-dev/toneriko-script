import { describe, expect, test, vi } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { PropertyAccess, scriptObject, invalidateErrorKinds } from '../../src/v2/runtime/values.js';

const pos = { line: 1, column: 1 };

describe('ホストとスクリプトのエラー判定', () => {
	for (const kind of ['object', 'array', 'error'] as const) {
		test(`${kind}のプロパティ操作ごとにホストの原型を確かめる`, () => {
			const target = Object.assign(kind === 'array' ? [] : kind === 'error' ? new Error('x') : {}, { a: 1 });
			let prototypes = 0;
			const value = new Proxy(target, { getPrototypeOf(object) { prototypes++; return Reflect.getPrototypeOf(object); } });
			const properties = new PropertyAccess();
			properties.normalize(value, pos);
			prototypes = 0;
			for (let i = 0; i < 100; i++) {
				expect(properties.get(value, 'a', pos)).toBe(i || 1);
				properties.set(value, 'a', i + 1, pos);
				expect(properties.has(value, 'a', pos)).toBe(true);
				expect(properties.delete(value, 'absent', pos)).toBe(true);
				expect(properties.entries(value, pos)).toEqual([['a', i + 1]]);
			}
			expect(prototypes).toBeGreaterThanOrEqual(600);
		});
	}

	test('スクリプトが作った辞書と配列はエラー判定の原型走査を通らない', async () => {
		const getPrototypeOf = Object.getPrototypeOf;
		let prototypes = 0;
		const spy = vi.spyOn(Object, 'getPrototypeOf').mockImplementation(value => {
			if (Object.hasOwn(value, 'rv6Marker') || (Array.isArray(value) && value[0] === 'rv6Marker')) prototypes++;
			return getPrototypeOf(value);
		});
		try {
			await new Interpreter({}, { now: () => 0 }).exec(parse(`
				let o = { rv6Marker: 1 }; let a = ["rv6Marker"];
				for (let i = 0; i < 100; i++) { o.rv6Marker += 1; a[0]; }
			`).program);
			expect(prototypes).toBe(0);
		} finally { spy.mockRestore(); }
	});

	test('中断後はスクリプトで作った値だけを一度再検証して近道へ戻す', () => {
		const properties = new PropertyAccess();
		const value = scriptObject(Object.assign(Object.create(null), { a: 1 }));
		invalidateErrorKinds();
		const getPrototypeOf = Object.getPrototypeOf;
		let prototypes = 0;
		const spy = vi.spyOn(Object, 'getPrototypeOf').mockImplementation(object => {
			if (object === value) prototypes++;
			return getPrototypeOf(object);
		});
		try {
			for (let i = 0; i < 100; i++) expect(properties.get(value, 'a', pos)).toBe(1);
			expect(prototypes).toBe(1);
		} finally { spy.mockRestore(); }
	});

	test('ホスト呼び出しと次の実行で原型が変わっても古い判定を使わない', async () => {
		const value = { status: 7 };
		const output: unknown[] = [];
		const interpreter = new Interpreter({
			value, mutate: () => { Object.setPrototypeOf(value, TypeError.prototype); },
			out: (item: unknown) => { output.push(item); },
		});
		await interpreter.exec(parse('value.status; mutate(); out(value.name);').program);
		Object.setPrototypeOf(value, RangeError.prototype);
		await interpreter.exec(parse('out(value.name);').program);
		expect(output).toEqual(['TypeError', 'RangeError']);
	});

	test('Proxyの罠が別の値の原型を変えた直後にnameを読み存在判定できる', async () => {
		const o = { stack: 'private' };
		const p = new Proxy({}, { getOwnPropertyDescriptor(target, key) {
			if (key === 'x') Object.setPrototypeOf(o, TypeError.prototype);
			return Reflect.getOwnPropertyDescriptor(target, key);
		} });
		const output: unknown[] = [];
		await new Interpreter({ o, p, out: (value: unknown) => { output.push(value); } }).exec(parse(`
			const r = [o.name]; p.x; r.push(o.name, "name" in o, o.stack); out(r);
		`).program);
		expect(output).toEqual([[null, 'TypeError', true, null]]);
	});

	test('Proxyの罠がtoStringTagを変えた直後にも値を検証する', async () => {
		const o = { message: 'x', stack: 'private' };
		const p = new Proxy({}, { getOwnPropertyDescriptor(target, key) {
			if (key === 'x') Object.defineProperty(o, Symbol.toStringTag, { value: 'Other' });
			return Reflect.getOwnPropertyDescriptor(target, key);
		} });
		const output: unknown[] = [];
		await new Interpreter({ o, p, out: (value: unknown) => { output.push(value); } }).exec(parse(`
			o.message; p.x; try { o.message; out("missed"); } catch(e) { out(e.code); }
		`).program);
		expect(output).toEqual(['UNSUPPORTED_VALUE']);
	});

	test('通常のホスト辞書はコンストラクタのソースを調べない', () => {
		const properties = new PropertyAccess();
		const source = vi.spyOn(Function.prototype, 'toString');
		try {
			for (const value of [{ a: 1 }, Object.assign(Object.create(null), { a: 1 })]) {
				for (let i = 0; i < 100; i++) expect(properties.get(value, 'a', pos)).toBe(1);
			}
			expect(source).not.toHaveBeenCalled();
		} finally { source.mockRestore(); }
	});

	test('Proxyが原型を変えてもキャッシュから位置情報を公開しない', () => {
		const target = { stack: 'private', sourceURL: 'private', status: 7 };
		const value = new Proxy(target, {});
		const properties = new PropertyAccess();
		expect(properties.get(value, 'status', pos)).toBe(7);
		Object.setPrototypeOf(target, Error.prototype);
		for (const key of ['stack', 'sourceURL']) {
			expect(properties.get(value, key, pos)).toBeNull();
			expect(properties.has(value, key, pos)).toBe(false);
		}
		expect(properties.entries(value, pos)).toEqual([['status', 7]]);
	});
});
