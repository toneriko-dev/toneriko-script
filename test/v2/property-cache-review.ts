import { describe, expect, test, vi } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { PropertyAccess } from '../../src/v2/runtime/values.js';

const pos = { line: 1, column: 1 };

describe('エラーの判定のキャッシュ', () => {
	for (const kind of ['object', 'array', 'error'] as const) {
		test(`${kind}のプロパティ操作を繰り返しても原型を調べ直さない`, () => {
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
			expect(prototypes).toBe(0);
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
