import * as assert from 'assert';
import { describe, expect, test } from 'vitest';
import { Interpreter, Parser, utils } from '../src';
import { T_FN, T_GENERIC, T_PARAM, T_SIMPLE, T_UNION } from '../src/type';
import { NUM, STR, NULL, ARR, OBJ, BOOL, TRUE, FALSE, ERROR ,FN_NATIVE } from '../src/interpreter/value';
import { AiScriptRuntimeError, AiScriptSyntaxError } from '../src/error';
import { exe, getMeta, eq } from './testutils';

describe('function types', () => {
	test.concurrent('multiple params', async () => {
		const res = await exe(`
		let f: @(str, num) => bool = @() { true }
		<: f('abc', 123)
		`);
		eq(res, TRUE);
	});

	test.concurrent('preserves parameter types on function values', async () => {
		const parser = new Parser();
		const interpreter = new Interpreter({});
		await interpreter.exec(parser.parse(`
		@outer<T>(value: T, items: arr<T>, mapper: @(T) => str, untyped) {
			@inner<U>(nested: T | U) {}
			inner
		}
		let inner = outer(1, [], @(value) { value.to_str() }, null)
		@with_default<T>(callback = @(value: T) { value }) { callback }
		let default_callback = with_default()
		`));

		const outer = interpreter.scope.get('outer');
		assert.ok(outer.type === 'fn' && outer.native == null);
		expect(outer.params.map(param => param.type)).toStrictEqual([
			T_PARAM('T'),
			T_GENERIC('arr', [T_PARAM('T')]),
			T_FN([T_PARAM('T')], T_SIMPLE('str')),
			undefined,
		]);
		expect(outer.typeParams).toStrictEqual([{ name: 'T' }]);

		const inner = interpreter.scope.get('inner');
		assert.ok(inner.type === 'fn' && inner.native == null);
		expect(inner.params[0]?.type).toStrictEqual(T_UNION([T_PARAM('T'), T_PARAM('U')]));
		expect(inner.typeParams).toStrictEqual([{ name: 'U' }]);

		const defaultCallback = interpreter.scope.get('default_callback');
		assert.ok(defaultCallback.type === 'fn' && defaultCallback.native == null);
		expect(defaultCallback.params[0]?.type).toStrictEqual(T_PARAM('T'));
	});

	test.concurrent('preserves parameter types in synchronous execution', async () => {
		const parser = new Parser();
		const interpreter = new Interpreter({});
		interpreter.execSync(parser.parse('@f(value: num) {}'));

		const fn = interpreter.scope.get('f');
		assert.ok(fn.type === 'fn' && fn.native == null);
		expect(fn.params[0]?.type).toStrictEqual(T_SIMPLE('num'));
	});

	test.concurrent('reports unknown composite types with source-like names', async () => {
		for (const [source, expectedType] of [
			['unknown<num | str>', 'unknown<num | str>'],
			['unknown<@(num) => str>', 'unknown<@(num) => str>'],
		]) {
			await expect(() => exe(`let value: ${source} = null`)).rejects.toThrow(
				`Unknown type: '${expectedType}'`,
			);
		}
	});
});

describe('generics', () => {
	describe('function', () => {
		test.concurrent('expr', async () => {
			const res = await exe(`
				let f = @<T>(v: T): void {}
				<: f("a")
			`);
			eq(res, NULL);
		});

		test.concurrent('consumer', async () => {
			const res = await exe(`
			@f<T>(v: T): void {}
			<: f("a")
			`);
			eq(res, NULL);
		});

		test.concurrent('identity function', async () => {
			const res = await exe(`
			@f<T>(v: T): T { v }
			<: f(1)
			`);
			eq(res, NUM(1));
		});

		test.concurrent('use as inner type', async () => {
			const res = await exe(`
			@vals<T>(v: obj<T>): arr<T> {
				Obj:vals(v)
			}
			<: vals({ a: 1, b: 2, c: 3 })
			`);
			eq(res, ARR([NUM(1), NUM(2), NUM(3)]));
		});

		test.concurrent('use as variable type', async () => {
			const res = await exe(`
			@f<T>(v: T): void {
				let v2: T = v
			}
			<: f(1)
			`);
			eq(res, NULL);
		});

		test.concurrent('use as function type', async () => {
			const res = await exe(`
			@f<T>(v: T): @() => T {
				let g: @() => T = @() { v }
				g
			}
			<: f(1)()
			`);
			eq(res, NUM(1))
		});

		test.concurrent('curried', async () => {
			const res = await exe(`
			@concat<A>(a: A): @<B>(B) => str {
				@<B>(b: B) {
					\`{a}{b}\`
				}
			}
			<: concat("abc")(123)
			`);
			eq(res, STR('abc123'));
		});

		test.concurrent('new lines', async () => {
			const res = await exe(`
			@f<
				T
				U
			>(x: T, y: U): arr<T | U> {
				[x, y]
			}
			<: f("abc", 123)
			`);
			eq(res, ARR([STR('abc'), NUM(123)]));
		});

		test.concurrent('duplicate', async () => {
			await expect(() => exe(`
			@f<T, T>(v: T) {}
			`)).rejects.toThrow(AiScriptSyntaxError);
		});

		test.concurrent('duplicate (no param and ret types)', async () => {
			await expect(() => exe(`
			@f<T, T>() {}
			`)).rejects.toThrow(AiScriptSyntaxError);
		});

		test.concurrent('empty', async () => {
			await assert.rejects(() => exe(`
			@f<>() {}
			`));
		});

		test.concurrent('cannot have inner type', async () => {
			await expect(() => exe(`
			@f<T>(v: T<num>) {}
			`)).rejects.toThrow(AiScriptSyntaxError);
		});
	});
});

describe('union', () => {
	test.concurrent('variable type', async () => {
		const res = await exe(`
		let a: num | null = null
		<: a
		`);
		eq(res, NULL);
	});

	test.concurrent('more inners', async () => {
		const res = await exe(`
		let a: str | num | null = null
		<: a
		`);
		eq(res, NULL);
	});

	test.concurrent('inner type', async () => {
		const res = await exe(`
		let a: arr<num | str> = ["abc", 123]
		<: a
		`);
		eq(res, ARR([STR('abc'), NUM(123)]));
	});

	test.concurrent('param type', async () => {
		const res = await exe(`
		@f(x: num | str): str {
			\`{x}\`
		}
		<: f(1)
		`);
		eq(res, STR('1'));
	});

	test.concurrent('return type', async () => {
		const res = await exe(`
		@f(): num | str { 1 }
		<: f()
		`);
		eq(res, NUM(1));
	});

    test.concurrent('type parameter', async () => {
        const res = await exe(`
        @f<T>(v: T): T | null { null }
        <: f(1)
        `);
        eq(res, NULL);
    });

	test.concurrent('function type', async () => {
		const res = await exe(`
		let f: @(num | str) => str = @(x) { \`{x}\` }
		<: f(1)
		`);
		eq(res, STR('1'));
	});

	test.concurrent('invalid inner', async () => {
		await assert.rejects(() => exe(`
		let a: ThisIsAnInvalidTypeName | null = null
		`));
	});
});

describe('simple', () => {
	test.concurrent('error', async () => {
		const res = await exe(`
		let a: error = Error:create("Ai")
		<: a
		`);
		eq(res, ERROR('Ai'));
	});

	test.concurrent('never', async () => {
		const res = await exe(`
		@f() {
			let a: never = eval {
				return 1
			}
		}
		<: f()
		`);
		eq(res, NUM(1));
	});
});

test.concurrent('in break', async () => {
	await expect(() => exe(`
	#l: eval {
		break #l eval {
			let x: invalid = 0
		}
	}
	`)).rejects.toThrow(AiScriptSyntaxError);
});
