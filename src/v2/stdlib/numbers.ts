import type { Value } from '../runtime/values.js';
import { RuntimeError, runtimeError } from '../runtime/errors.js';
import { requireNumber, type StdContext, type StdDefinition } from './core.js';

function primitive(ctx: StdContext, value: Value): string | number | boolean | null {
	if (value !== null && typeof value === 'object' || typeof value === 'function') throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'number | string | boolean | null' }, 'TypeError');
	return value as string | number | boolean | null;
}
const numeric = requireNumber;
function rangeError(ctx: StdContext): never { throw runtimeError('STDLIB_ARGUMENT_RANGE', ctx.pos, {}, 'RangeError'); }
const arg = (name: string, type = 'number', optional = false) => ({ name, type, ...(optional ? { optional: true } : {}) });
function definition(name: string, args: StdDefinition['args'], returns: string, ja: string, en: string, fn: (ctx: StdContext, receiver: Value, args: Value[]) => Value, receiver: StdDefinition['receiver'] = 'global'): StdDefinition {
	return { name, receiver, args, returns, description: { ja, en }, *implementation(ctx, value, values) {
		try { return fn(ctx, value, values); }
		catch (error) {
			if (error instanceof RuntimeError) throw error;
			if (error instanceof RangeError) throw runtimeError('STDLIB_ARGUMENT_RANGE', ctx.pos, {}, 'RangeError');
			if (error instanceof URIError) throw runtimeError('STDLIB_URI_ERROR', ctx.pos, {}, 'URIError');
			throw error;
		}
	} };
}

// 公開名を固定し、実行環境が Math に追加した関数を自動で公開しません。
export const mathConstants = Object.freeze({ E: Math.E, LN10: Math.LN10, LN2: Math.LN2, LOG10E: Math.LOG10E, LOG2E: Math.LOG2E, PI: Math.PI, SQRT1_2: Math.SQRT1_2, SQRT2: Math.SQRT2 });
const unary = ['abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'cbrt', 'ceil', 'clz32', 'cos', 'cosh', 'exp', 'expm1', 'floor', 'fround', 'f16round', 'log', 'log1p', 'log2', 'log10', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc'] as const;
const math = Math as unknown as Record<string, (...args: number[]) => number>;

// binary16 の最近接偶数丸めを binary64 のまま行い、float32 の二重丸めを避けます。
function f16round(value: number): number {
	if (!Number.isFinite(value) || value === 0) return value;
	const sign = value < 0 ? -1 : 1;
	const x = Math.abs(value);
	if (x >= 65520) return sign * Infinity;
	const step = 2 ** Math.max(-24, Math.floor(Math.log2(x)) - 10);
	const scaled = x / step;
	const low = Math.floor(scaled);
	const fraction = scaled - low;
	return sign * (fraction > 0.5 || fraction === 0.5 && low % 2 !== 0 ? low + 1 : low) * step;
}

/** 種の byte 順と演算の桁あふれは、実行環境に依存しない乱数列の仕様です。 */
export function seededRandom(seed: string | number): () => number {
	const bytes: number[] = [];
	if (typeof seed === 'number') {
		bytes.push(0);
		const data = new DataView(new ArrayBuffer(8));
		data.setFloat64(0, seed, true);
		for (let i = 0; i < 8; i++) bytes.push(data.getUint8(i));
	} else {
		bytes.push(1);
		for (let i = 0; i < seed.length; i++) bytes.push(seed.charCodeAt(i) & 255, seed.charCodeAt(i) >>> 8);
	}
	const state = Array.from({ length: 4 }, (_, index) => {
		let hash = Math.imul(0x811c9dc5 ^ index, 0x01000193);
		for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
		return hash >>> 0;
	});
	if (state.every((value): boolean => value === 0)) state[0] = 1;
	const rotate = (x: number, k: number) => (x << k | x >>> (32 - k)) >>> 0;
	const next = () => {
		const result = Math.imul(rotate(Math.imul(state[1]!, 5), 7), 9) >>> 0;
		const t = state[1]! << 9;
		state[2] = state[2]! ^ state[0]!;
		state[3] = state[3]! ^ state[1]!;
		state[1] = state[1]! ^ state[2]!;
		state[0] = state[0]! ^ state[3]!;
		state[2] = state[2]! ^ t;
		state[3] = rotate(state[3]!, 11);
		return result;
	};
	return () => ((next() >>> 5) * 67108864 + (next() >>> 6)) / 9007199254740992;
}

export const numberDefinitions: StdDefinition[] = [
	...unary.map(name => definition(`Math.${name}`, [arg('x', 'number', true)], 'number', `${name} を計算します。`, `Compute ${name}.`, (ctx, _, args) => (name === 'f16round' ? f16round : math[name]!)(args.length ? Number(primitive(ctx, args[0]!)) : NaN))),
	...(['atan2', 'pow', 'imul'] as const).map(name => definition(`Math.${name}`, [arg(name === 'atan2' ? 'y' : 'x', 'number', true), arg(name === 'atan2' ? 'x' : 'y', 'number', true)], 'number', `${name} を計算します。`, `Compute ${name}.`, (ctx, _, args) => math[name]!(args.length ? Number(primitive(ctx, args[0]!)) : NaN, args.length > 1 ? Number(primitive(ctx, args[1]!)) : NaN))),
	...(['min', 'max', 'hypot'] as const).map(name => definition(`Math.${name}`, [{ name: 'values', type: 'number', rest: true }], 'number', `${name} を計算します。`, `Compute ${name}.`, (ctx, _, args) => math[name]!(...args.map(value => Number(primitive(ctx, value)))))),
	definition('Math.random', [], 'number', '0 以上 1 未満の乱数を返します。', 'Return a random number in [0, 1).', () => Math.random()),
	definition('Number', [arg('value', 'any', true)], 'number', '基本値を数に変換します。', 'Convert a primitive value to a number.', (ctx, _, args) => args.length ? Number(primitive(ctx, args[0]!)) : 0),
	definition('String', [arg('value', 'any', true)], 'string', '基本値を文字列に変換します。', 'Convert a primitive value to a string.', (ctx, _, args) => args.length ? String(primitive(ctx, args[0]!)) : ''),
	definition('parseInt', [arg('string', 'string', true), arg('radix', 'number', true)], 'number', '文字列の先頭の整数を読み取ります。', 'Parse an integer prefix.', (ctx, _, args) => parseInt(args.length ? String(primitive(ctx, args[0]!)) : 'undefined', args.length > 1 ? Number(primitive(ctx, args[1]!)) : undefined)),
	definition('parseFloat', [arg('string', 'string', true)], 'number', '文字列の先頭の数を読み取ります。', 'Parse a numeric prefix.', (ctx, _, args) => parseFloat(args.length ? String(primitive(ctx, args[0]!)) : 'undefined')),
	definition('Number.isInteger', [arg('value', 'any', true)], 'boolean', '整数かどうかを返します。', 'Test whether a value is an integer.', (_, __, args) => Number.isInteger(args[0])),
	definition('Array.isArray', [arg('value', 'any', true)], 'boolean', '配列かどうかを返します。', 'Test whether a value is an array.', (_, __, args) => Array.isArray(args[0])),
	definition('toFixed', [arg('digits', 'number', true)], 'string', '小数点以下の桁数を指定して文字列にします。', 'Format a number with fixed fraction digits.', (ctx, receiver, args) => numeric(ctx, receiver).toFixed(args.length ? Number(primitive(ctx, args[0]!)) : undefined), 'number'),
	definition('toString', [arg('radix', 'number', true)], 'string', '基数を指定して数を文字列にします。', 'Format a number in the given radix.', (ctx, receiver, args) => numeric(ctx, receiver).toString(args.length ? Number(primitive(ctx, args[0]!)) : undefined), 'number'),
	...(['encodeURIComponent', 'decodeURIComponent'] as const).map(name => definition(name, [arg('value', 'string', true)], 'string', name === 'encodeURIComponent' ? 'URI の構成要素を符号化します。' : 'URI の構成要素を復号します。', name === 'encodeURIComponent' ? 'Encode a URI component.' : 'Decode a URI component.', (ctx, _, args) => (name === 'encodeURIComponent' ? encodeURIComponent : decodeURIComponent)(args.length ? String(primitive(ctx, args[0]!)) : 'undefined'))),
	definition('Math.clamp', [arg('x'), arg('min'), arg('max')], 'number', '数を指定した範囲に収めます。', 'Clamp a number to the given range.', (ctx, _, args) => {
		const [x, min, max] = args.map(value => numeric(ctx, value));
		if (min! > max!) rangeError(ctx);
		return Math.min(Math.max(x!, min!), max!);
	}),
	definition('Math.randomInt', [arg('min'), arg('max')], 'number', '両端を含む範囲の整数を返します。', 'Return a random integer including both bounds.', (ctx, _, args) => {
		const min = numeric(ctx, args[0]!); const max = numeric(ctx, args[1]!);
		const width = max - min + 1;
		if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max || !Number.isSafeInteger(width)) rangeError(ctx);
		return min + Math.floor(Math.random() * width);
	}),
	definition('Math.seededRandom', [arg('seed', 'number | string')], 'Function', '種から再現可能な乱数関数を作ります。', 'Create a reproducible random generator from a seed.', (ctx, _, args) => {
		const seed = args[0];
		if (typeof seed !== 'number' && typeof seed !== 'string') throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'number | string' }, 'TypeError');
		if (typeof seed === 'number' && !Number.isFinite(seed)) rangeError(ctx);
		return seededRandom(seed);
	}),
];
