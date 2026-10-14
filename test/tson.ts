import { describe, expect, test } from 'vitest';
import { TSON } from '../src/parser/tson';
import type { JsValue } from '../src/interpreter/util';

describe('parse', () => {
	test.concurrent('str', () => {
		expect(TSON.parse('"Ai-chan kawaii"')).toEqual('Ai-chan kawaii');
	});

	test.concurrent('number', () => {
		expect(TSON.parse('42')).toEqual(42);
	});

	test.concurrent('bool', () => {
		expect(TSON.parse('true')).toEqual(true);
	});

	test.concurrent('null', () => {
		expect(TSON.parse('null')).toEqual(null);
	});

	test.concurrent('array', () => {
		expect(TSON.parse('[1, 2, 3]')).toEqual([1, 2, 3]);
	});

	test.concurrent('object', () => {
		expect(TSON.parse('{key: "value"}')).toEqual({ key: 'value' });
	});

	test.concurrent('special object keys do not alter the prototype', () => {
		const value = TSON.parse('{__proto__: {polluted: true}}');

		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.hasOwn(value as object, '__proto__')).toBe(true);
		expect((value as Record<string, unknown>).polluted).toBeUndefined();
		expect((value as Record<string, unknown>).__proto__).toEqual({ polluted: true });
	});

	test.concurrent('nested', () => {
		expect(TSON.parse('[{key: "value"}]')).toEqual([{ key: 'value' }]);
	});

	test.concurrent('invalid: unclosed string', () => {
		expect(() => TSON.parse('"hello')).toThrow();
	});

	test.concurrent('invalid: unclosed array', () => {
		expect(() => TSON.parse('[1, 2, 3')).toThrow();
	});

	test.concurrent('not allowed: empty', () => {
		expect(() => TSON.parse('')).toThrow();
	});

	test.concurrent('not allowed: function', () => {
		expect(() => TSON.parse(`@greet() { return "hello" }

greet()`)).toThrow();
	});

	test.concurrent('not allowed: variable assignment', () => {
		expect(() => TSON.parse('let x = 42')).toThrow();
	});

	test.concurrent('not allowed: namespace', () => {
		expect(() => TSON.parse(`:: Ai {
	let x = 42
}`)).toThrow();
	});

	test.concurrent('not allowed: expression', () => {
		expect(() => TSON.parse('{key: (3 + 5)}')).toThrow();
	});

	test.concurrent('not allowed: labeled expression', () => {
		expect(() => TSON.parse('#label: eval { 1 }')).toThrow();
	});

	test.concurrent('not allowed: multiple statements (string)', () => {
		expect(() => TSON.parse(`"hello"

"hi"`)).toThrow();
	});

	test.concurrent('not allowed: multiple statements in the same line', () => {
		expect(() => TSON.parse('"hello" "hi"')).toThrow();
	});

});

describe('stringify', () => {
	test.concurrent('str', () => {
		expect(TSON.stringify('Ai-chan kawaii')).toEqual('"Ai-chan kawaii"');
	});

	test.concurrent('number', () => {
		expect(TSON.stringify(42)).toEqual('42');
		expect(TSON.parse('-42')).toBe(-42);
		expect(TSON.parse('{negative: -42}')).toEqual({ negative: -42 });
	});

	test.concurrent('preserves negative zero and rejects non-finite numbers', () => {
		const negativeZero = TSON.parse(TSON.stringify(-0));
		expect(Object.is(negativeZero, -0)).toBe(true);

		for (const value of [NaN, Infinity, -Infinity]) {
			expect(() => TSON.stringify(value)).toThrow(new TypeError('Cannot stringify non-finite number as TSON.'));
		}
	});

	test.concurrent('bool', () => {
		expect(TSON.stringify(true)).toEqual('true');
	});

	test.concurrent('null', () => {
		expect(TSON.stringify(null)).toEqual('null');
	});

	test.concurrent('array', () => {
		expect(TSON.stringify([1, 2, 3])).toEqual('[1, 2, 3]');
	});

	test.concurrent('serializes sparse array slots as null', () => {
		const sparse: JsValue[] = [];
		sparse.length = 2;

		const serialized = TSON.stringify(sparse);

		expect(serialized).toBe('[null, null]');
		expect(TSON.parse(serialized)).toEqual([null, null]);
	});

	test.concurrent('object', () => {
		expect(TSON.stringify({ key: 'value' })).toEqual('{key: "value"}');
	});

	test.concurrent('nested', () => {
		const value = [{ key: 'value' }];
		const serialized = TSON.stringify(value);
		expect(serialized).toEqual('[{key: "value"}]');
		expect(TSON.parse(serialized)).toStrictEqual(value);
	});

	test.concurrent('repeats shared values and rejects circular references', () => {
		const shared = { value: 1 };
		expect(TSON.stringify([shared, shared])).toBe('[{value: 1}, {value: 1}]');

		const circular: { [key: string]: JsValue } = {};
		circular.self = circular;
		expect(() => TSON.stringify(circular)).toThrow(new TypeError('Cannot stringify circular TSON value.'));
	});

	test.concurrent('pretty print: nested', () => {
		const value = { arr: [1, 2, { key: 'value' }] };
		const serialized = TSON.stringify(value, null, 2);
		expect(serialized).toEqual(`{
  arr: [
    1,
    2,
    {
      key: "value"
    }
  ]
}`);
		expect(TSON.parse(serialized)).toStrictEqual(value);
	});
	
	test.concurrent('custom indent', () => {
		expect(TSON.stringify({ key: 'value', foo: 'bar' }, null, '\t')).toEqual(`{
\tkey: "value",
\tfoo: "bar"
}`);
	});

	test.concurrent('normalizes indentation like JSON.stringify', () => {
		const value = { nested: { value: 1 } };
		const tenSpaces = TSON.stringify(value, null, 10);

		expect(TSON.stringify(value, null, 2.9)).toBe(TSON.stringify(value, null, 2));
		expect(TSON.stringify(value, null, 12)).toBe(tenSpaces);
		expect(TSON.stringify(value, null, Infinity)).toBe(tenSpaces);
		expect(TSON.stringify(value, null, -Infinity)).toBe('{nested: {value: 1}}');
		expect(TSON.stringify(value, null, NaN)).toBe('{nested: {value: 1}}');
		expect(TSON.stringify(value, null, '123456789012')).toBe(TSON.stringify(value, null, '1234567890'));
	});
	

	test.concurrent('quotes object keys that are not identifiers', () => {
		const obj = {
			'': 0,
			'foo-bar': 1,
			'with space': 2,
			'日本語': 3,
			'quote"key': 4,
		};
		const tson = TSON.stringify(obj);

		expect(TSON.parse(tson)).toStrictEqual(obj);
	});
});
