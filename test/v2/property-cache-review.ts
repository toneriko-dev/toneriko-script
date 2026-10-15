import { runInNewContext } from 'node:vm';
import { describe, expect, test, vi } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { PropertyAccess, errorValue } from '../../src/v2/runtime/values.js';

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

	test('保存したスクリプトの値もProxyが原型を変えた直後に読み直す', async () => {
		let saved: object;
		const p = new Proxy({}, { getOwnPropertyDescriptor(target, key) {
			if (key === 'x') Object.setPrototypeOf(saved, TypeError.prototype);
			return Reflect.getOwnPropertyDescriptor(target, key);
		} });
		const output: unknown[] = [];
		await new Interpreter({ save: (value: object) => { saved = value; }, p, out: (value: unknown) => { output.push(value); } }).exec(parse(`
			const o = {}; save(o); o.name; p.x; const r = [o.name, "name" in o]; out(r);
		`).program);
		expect(output).toEqual([['TypeError', true]]);
	});

	test('Proxyへの代入で渡したスクリプトの値の原型変更も見落とさない', async () => {
		const holder = new Proxy({}, { defineProperty(target, key, descriptor) {
			Object.setPrototypeOf(descriptor.value, RangeError.prototype);
			return Reflect.defineProperty(target, key, descriptor);
		} });
		const output: unknown[] = [];
		await new Interpreter({ holder, out: (value: unknown) => { output.push(value); } }).exec(parse(`
			const o = {}; holder.x = o; const r = [o.name, "name" in o]; out(r);
		`).program);
		expect(output).toEqual([['RangeError', true]]);
	});

	test.each([false, true])('普通のクラスの読み取りでDOMExceptionのブランド検査や関数の文字列化をしない: 別realm=%s', foreign => {
		class H { x = 1; }
		const h = foreign ? runInNewContext('new (class H { x = 1 })()') : new H();
		const properties = new PropertyAccess();
		const getter = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')!.get;
		const apply = vi.spyOn(Reflect, 'apply');
		const source = vi.spyOn(Function.prototype, 'toString');
		try {
			for (let i = 0; i < 100; i++) expect(properties.get(h, 'x', pos)).toBe(1);
			expect(apply.mock.calls.filter(([fn]) => fn === getter)).toHaveLength(0);
			expect(source).not.toHaveBeenCalled();
		} finally { source.mockRestore(); apply.mockRestore(); }
	});

	test('原型をnullにしたDOMExceptionもエラーのブランドを保つ', () => {
		const error = Object.setPrototypeOf(new DOMException('host', 'AbortError'), null);
		expect(errorValue(error)).toBe(true);
	});

	test.each([null, Object.prototype, (class H {}).prototype])('原型を変えたDOMExceptionの非公開キーも隠す: %s', prototype => {
		const error = Object.setPrototypeOf(new DOMException('host', 'AbortError'), prototype);
		Object.defineProperty(error, 'stack', { value: 'private', enumerable: true, configurable: true });
		const properties = new PropertyAccess();
		expect(properties.get(error, 'stack', pos)).toBeNull();
		expect(properties.has(error, 'stack', pos)).toBe(false);
		expect(properties.entries(error, pos)).toEqual([]);
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
