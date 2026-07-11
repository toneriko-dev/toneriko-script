import { describe, expect, test } from 'vitest';
import { AiSON } from '../src/parser/aison';
import type { JsValue } from '../src/interpreter/util';

describe('parse', () => {
	test.concurrent('str', () => {
		expect(AiSON.parse('"Ai-chan kawaii"')).toEqual('Ai-chan kawaii');
	});

	test.concurrent('number', () => {
		expect(AiSON.parse('42')).toEqual(42);
	});

	test.concurrent('bool', () => {
		expect(AiSON.parse('true')).toEqual(true);
	});

	test.concurrent('null', () => {
		expect(AiSON.parse('null')).toEqual(null);
	});

	test.concurrent('array', () => {
		expect(AiSON.parse('[1, 2, 3]')).toEqual([1, 2, 3]);
	});

	test.concurrent('object', () => {
		expect(AiSON.parse('{key: "value"}')).toEqual({ key: 'value' });
	});

	test.concurrent('special object keys do not alter the prototype', () => {
		const value = AiSON.parse('{__proto__: {polluted: true}}');

		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.hasOwn(value as object, '__proto__')).toBe(true);
		expect((value as Record<string, unknown>).polluted).toBeUndefined();
		expect((value as Record<string, unknown>).__proto__).toEqual({ polluted: true });
	});

	test.concurrent('nested', () => {
		expect(AiSON.parse('[{key: "value"}]')).toEqual([{ key: 'value' }]);
	});

	test.concurrent('invalid: unclosed string', () => {
		expect(() => AiSON.parse('"hello')).toThrow();
	});

	test.concurrent('invalid: unclosed array', () => {
		expect(() => AiSON.parse('[1, 2, 3')).toThrow();
	});

	test.concurrent('not allowed: empty', () => {
		expect(() => AiSON.parse('')).toThrow();
	});

	test.concurrent('not allowed: function', () => {
		expect(() => AiSON.parse(`@greet() { return "hello" }

greet()`)).toThrow();
	});

	test.concurrent('not allowed: variable assignment', () => {
		expect(() => AiSON.parse('let x = 42')).toThrow();
	});

	test.concurrent('not allowed: namespace', () => {
		expect(() => AiSON.parse(`:: Ai {
	let x = 42
}`)).toThrow();
	});

	test.concurrent('not allowed: expression', () => {
		expect(() => AiSON.parse('{key: (3 + 5)}')).toThrow();
	});

	test.concurrent('not allowed: labeled expression', () => {
		expect(() => AiSON.parse('#label: eval { 1 }')).toThrow();
	});

	test.concurrent('not allowed: multiple statements (string)', () => {
		expect(() => AiSON.parse(`"hello"

"hi"`)).toThrow();
	});

	test.concurrent('not allowed: multiple statements in the same line', () => {
		expect(() => AiSON.parse('"hello" "hi"')).toThrow();
	});

	test.concurrent('not allowed: multiple statements (object)', () => {
		expect(() => AiSON.parse(`{key: "value"}

{foo: "bar"}`)).toThrow();
	});
});

describe('stringify', () => {
	test.concurrent('str', () => {
		expect(AiSON.stringify('Ai-chan kawaii')).toEqual('"Ai-chan kawaii"');
	});

	test.concurrent('number', () => {
		expect(AiSON.stringify(42)).toEqual('42');
		expect(AiSON.parse('-42')).toBe(-42);
		expect(AiSON.parse('{negative: -42}')).toEqual({ negative: -42 });
	});

	test.concurrent('preserves negative zero and rejects non-finite numbers', () => {
		const negativeZero = AiSON.parse(AiSON.stringify(-0));
		expect(Object.is(negativeZero, -0)).toBe(true);

		for (const value of [NaN, Infinity, -Infinity]) {
			expect(() => AiSON.stringify(value)).toThrow(new TypeError('Cannot stringify non-finite number as AiSON.'));
		}
	});

	test.concurrent('bool', () => {
		expect(AiSON.stringify(true)).toEqual('true');
	});

	test.concurrent('null', () => {
		expect(AiSON.stringify(null)).toEqual('null');
	});

	test.concurrent('array', () => {
		expect(AiSON.stringify([1, 2, 3])).toEqual('[1, 2, 3]');
	});

	test.concurrent('serializes sparse array slots as null', () => {
		const sparse: JsValue[] = [];
		sparse.length = 2;

		const serialized = AiSON.stringify(sparse);

		expect(serialized).toBe('[null, null]');
		expect(AiSON.parse(serialized)).toEqual([null, null]);
	});

	test.concurrent('object', () => {
		expect(AiSON.stringify({ key: 'value' })).toEqual('{key: "value"}');
	});

	test.concurrent('nested', () => {
		expect(AiSON.stringify([{ key: 'value' }])).toEqual('[{key: "value"}]');
	});

	test.concurrent('repeats shared values and rejects circular references', () => {
		const shared = { value: 1 };
		expect(AiSON.stringify([shared, shared])).toBe('[{value: 1}, {value: 1}]');

		const circular: { [key: string]: JsValue } = {};
		circular.self = circular;
		expect(() => AiSON.stringify(circular)).toThrow(new TypeError('Cannot stringify circular AiSON value.'));
	});

	test.concurrent('pretty print: array', () => {
		expect(AiSON.stringify([1, 2, 3], null, 2)).toEqual(`[
  1,
  2,
  3
]`);
	});

	test.concurrent('pretty print: object', () => {
		expect(AiSON.stringify({ key: 'value', foo: 'bar' }, null, 2)).toEqual(`{
  key: "value",
  foo: "bar"
}`);
	});

	test.concurrent('pretty print: nested', () => {
		expect(AiSON.stringify({ arr: [1, 2, { key: 'value' }] }, null, 2)).toEqual(`{
  arr: [
    1,
    2,
    {
      key: "value"
    }
  ]
}`);
	});
	
	test.concurrent('custom indent', () => {
		expect(AiSON.stringify({ key: 'value', foo: 'bar' }, null, '\t')).toEqual(`{
\tkey: "value",
\tfoo: "bar"
}`);
	});

	test.concurrent('normalizes indentation like JSON.stringify', () => {
		const value = { nested: { value: 1 } };
		const tenSpaces = AiSON.stringify(value, null, 10);

		expect(AiSON.stringify(value, null, 2.9)).toBe(AiSON.stringify(value, null, 2));
		expect(AiSON.stringify(value, null, 12)).toBe(tenSpaces);
		expect(AiSON.stringify(value, null, Infinity)).toBe(tenSpaces);
		expect(AiSON.stringify(value, null, -Infinity)).toBe('{nested: {value: 1}}');
		expect(AiSON.stringify(value, null, NaN)).toBe('{nested: {value: 1}}');
		expect(AiSON.stringify(value, null, '123456789012')).toBe(AiSON.stringify(value, null, '1234567890'));
	});
	
	test.concurrent('no indent when indent is 0', () => {
		expect(AiSON.stringify({ key: 'value', foo: 'bar' }, null, 0)).toEqual('{key: "value", foo: "bar"}');
	});

	test.concurrent('can parse generated aison', () => {
		const obj = { arr: [1, 2, { key: 'value' }] };
		const aison = AiSON.stringify(obj);
		const parsed = AiSON.parse(aison);
		expect(parsed).toStrictEqual(obj);
	});

	test.concurrent('quotes object keys that are not identifiers', () => {
		const obj = {
			'': 0,
			'foo-bar': 1,
			'with space': 2,
			'日本語': 3,
			'quote"key': 4,
		};
		const aison = AiSON.stringify(obj);

		expect(AiSON.parse(aison)).toStrictEqual(obj);
	});
});
