import { runtimeError } from '../runtime/errors.js';
import { isScriptFunction, scriptObject, type Value } from '../runtime/brands.js';
import { isStdFunction, requireArray, requireNumber, type StdContext, type StdDefinition, type StdFrame } from './core.js';

type Key = number | string | (number | string)[];
type Item = { value: Value; key: Key };
type Work = { count: number };
function callback(ctx: StdContext, value: Value | undefined): Value {
	if (typeof value !== 'function' && !isScriptFunction(value) && !isStdFunction(value)) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'Function' }, 'TypeError');
	return value as Value;
}
function rangeError(ctx: StdContext): never { throw runtimeError('STDLIB_ARGUMENT_RANGE', ctx.pos, {}, 'RangeError'); }
function step(ctx: StdContext, work: Work): boolean {
	ctx.tick();
	return ++work.count % 64 === 0;
}
function *copy(ctx: StdContext, array: Value[], work: Work): StdFrame {
	const result: Value[] = [];
	const length = array.length;
	for (let i = 0; i < length; i++) { result.push(ctx.properties.get(array, i, ctx.pos)); if (step(ctx, work)) yield ctx.checkpoint(); }
	return result;
}

// 文字列比較は UTF-16 辞書順を保ち、長い共通接頭辞の途中でも制御を返します。
function *compareScalar(ctx: StdContext, left: number | string, right: number | string, work: Work): StdFrame {
	if (typeof left !== typeof right) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'matching key types' }, 'TypeError');
	if (typeof left === 'number') { if (step(ctx, work)) yield ctx.checkpoint(); return left < (right as number) ? -1 : left > (right as number) ? 1 : 0; }
	const other = right as string;
	for (let i = 0; i < Math.min(left.length, other.length); i++) {
		const difference = left.charCodeAt(i) - other.charCodeAt(i);
		if (step(ctx, work)) yield ctx.checkpoint();
		if (difference !== 0) return difference < 0 ? -1 : 1;
	}
	return left.length < other.length ? -1 : left.length > other.length ? 1 : 0;
}
function *compareKeys(ctx: StdContext, left: Key, right: Key, work: Work): StdFrame {
	if (!Array.isArray(left) && !Array.isArray(right)) return yield* compareScalar(ctx, left, right, work);
	if (!Array.isArray(left) || !Array.isArray(right)) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'matching key types' }, 'TypeError');
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		const order = yield* compareScalar(ctx, left[i]!, right[i]!, work);
		if (order !== 0) return order;
	}
	return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}
type KeySchema = { array?: boolean; positions: (string | undefined)[] };
function *readKey(ctx: StdContext, value: Value, schema: KeySchema, work: Work): StdFrame {
	const array = Array.isArray(value);
	if (schema.array !== undefined && schema.array !== array) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'matching key types' }, 'TypeError');
	schema.array = array;
	const source = array ? value : [value];
	const result: (number | string)[] = [];
	for (let i = 0; i < source.length; i++) {
		const item = source[i];
		if (typeof item !== 'number' && typeof item !== 'string') throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'number | string | (number | string)[]' }, 'TypeError');
		if (typeof item === 'number' && Number.isNaN(item)) rangeError(ctx);
		if (schema.positions[i] !== undefined && schema.positions[i] !== typeof item) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'matching key types' }, 'TypeError');
		schema.positions[i] = typeof item;
		result.push(item); if (step(ctx, work)) yield ctx.checkpoint();
	}
	return array ? result : result[0]!;
}

// 同値では左側を先に取り、比較関数を常に一つずつ待ちます。
function *mergeSort(ctx: StdContext, input: Item[], compare: (left: Item, right: Item) => StdFrame, work: Work): StdFrame {
	let source = input;
	let target: Item[] = [];
	for (let width = 1; width < source.length; width *= 2) {
		for (let start = 0; start < source.length; start += width * 2) {
			const middle = Math.min(start + width, source.length), end = Math.min(start + width * 2, source.length);
			let left = start, right = middle;
			for (let i = start; i < end; i++) {
				if (left >= middle) target[i] = source[right++]!;
				else if (right >= end) target[i] = source[left++]!;
				else target[i] = (yield compare(source[left]!, source[right]!)) as number <= 0 ? source[left++]! : source[right++]!;
				if (step(ctx, work)) yield ctx.checkpoint();
			}
		}
		[source, target] = [target, source];
	}
	return source;
}
function definition(name: string, args: StdDefinition['args'], returns: string, ja: string, en: string, implementation: StdDefinition['implementation']): StdDefinition {
	return { name, receiver: 'array', args, returns, description: { ja, en }, implementation };
}
const keyArg = [{ name: 'key', type: 'Function' }];
const rngArg = [{ name: 'rng', type: 'Function', optional: true }];
function *random(ctx: StdContext, rng: Value | undefined): StdFrame {
	const value = rng === undefined ? Math.random() : requireNumber(ctx, yield ctx.call(rng, []));
	if (!(value >= 0 && value < 1)) rangeError(ctx);
	return value;
}

export const collectionDefinitions: StdDefinition[] = [
	...(['sort', 'toSorted', 'sortBy'] as const).map(name => definition(name,
		name === 'sortBy' ? keyArg : [{ name: 'compare', type: 'Function', optional: true }], 'any[]',
		name === 'toSorted' ? '安定な並べ替えの結果を新しい配列で返します。' : name === 'sortBy' ? 'キーを一度ずつ求め、元の配列を安定に並べ替えます。' : '元の配列を安定に並べ替えます。',
		name === 'toSorted' ? 'Returns a stably sorted copy.' : name === 'sortBy' ? 'Stably sorts the array in place using one key per element.' : 'Stably sorts the array in place.',
		function *(ctx, receiver, args) {
			const array = requireArray(ctx, receiver), work = { count: 0 };
			const fn = args[0] === undefined ? undefined : callback(ctx, args[0]);
			const source = (yield* copy(ctx, array, work)) as Value[];
			const items: Item[] = [], schema: KeySchema = { positions: [] };
			for (let i = 0; i < source.length; i++) {
				const value = source[i]!;
				let key: Key = 0;
				if (name === 'sortBy') key = (yield* readKey(ctx, yield ctx.call(fn!, [value, i, array]), schema, work)) as Key;
				else if (fn === undefined) {
					if (typeof value !== 'string') throw runtimeError('STDLIB_SORT_COMPARATOR_REQUIRED', ctx.pos, {}, 'TypeError');
					key = value;
				}
				items.push({ value, key }); if (step(ctx, work)) yield ctx.checkpoint();
			}
			const sorted = (yield* mergeSort(ctx, items, function *(left, right) {
				if (name === 'sortBy' || fn === undefined) return yield* compareKeys(ctx, left.key, right.key, work);
				const order = requireNumber(ctx, yield ctx.call(fn, [left.value, right.value]));
				return Number.isNaN(order) ? 0 : order;
			}, work)) as Item[];
			const result = name === 'toSorted' ? scriptObject([] as Value[]) : array;
			for (let i = 0; i < sorted.length; i++) { ctx.properties.set(result, i, sorted[i]!.value, ctx.pos); if (step(ctx, work)) yield ctx.checkpoint(); }
			return result;
		})),
	definition('unique', [], 'any[]', '重複を除き、最初の要素を残した配列を返します。', 'Returns the first occurrence of each distinct value.', function *(ctx, receiver) {
		const array = requireArray(ctx, receiver), result = scriptObject([] as Value[]), seen = new Set<Value>(), work = { count: 0 };
		for (let i = 0; i < array.length; i++) {
			const value = ctx.properties.get(array, i, ctx.pos);
			if (!seen.has(value)) { seen.add(value); result.push(value); }
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return result;
	}),
	definition('uniqueBy', keyArg, 'any[]', 'キーの重複を除き、最初の要素を残した配列を返します。', 'Returns the first element for each distinct key.', function *(ctx, receiver, args) {
		const array = requireArray(ctx, receiver), fn = callback(ctx, args[0]), result = scriptObject([] as Value[]), work = { count: 0 }, schema: KeySchema = { positions: [] };
		type Trie = { children: Map<number | string, Trie>; end: boolean };
		const root: Trie = { children: new Map(), end: false }, length = array.length;
		for (let i = 0; i < length; i++) {
			const value = ctx.properties.get(array, i, ctx.pos);
			const key = (yield* readKey(ctx, yield ctx.call(fn, [value, i, array]), schema, work)) as Key;
			let node = root;
			for (const part of Array.isArray(key) ? key : [key]) {
				let next = node.children.get(part);
				if (!next) { next = { children: new Map(), end: false }; node.children.set(part, next); }
				node = next; if (step(ctx, work)) yield ctx.checkpoint();
			}
			if (!node.end) { node.end = true; result.push(value); }
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return result;
	}),
	definition('sum', [], 'number', '数を左から加算し、空配列では 0 を返します。', 'Adds numbers from left to right, returning zero for an empty array.', function *(ctx, receiver) {
		const array = requireArray(ctx, receiver), work = { count: 0 }; let total = 0;
		for (let i = 0; i < array.length; i++) { total += requireNumber(ctx, ctx.properties.get(array, i, ctx.pos)); if (step(ctx, work)) yield ctx.checkpoint(); }
		return total;
	}),
	...(['minBy', 'maxBy'] as const).map(name => definition(name, keyArg, 'any', name === 'minBy' ? '最小のキーを持つ最初の要素を返します。' : '最大のキーを持つ最初の要素を返します。', name === 'minBy' ? 'Returns the first element with the smallest key.' : 'Returns the first element with the largest key.', function *(ctx, receiver, args) {
		const array = requireArray(ctx, receiver), fn = callback(ctx, args[0]), schema: KeySchema = { positions: [] }, work = { count: 0 }, length = array.length;
		let result: Value = null, best: Key | undefined;
		for (let i = 0; i < length; i++) {
			const value = ctx.properties.get(array, i, ctx.pos), key = (yield* readKey(ctx, yield ctx.call(fn, [value, i, array]), schema, work)) as Key;
			const order = best === undefined ? 0 : (yield* compareKeys(ctx, key, best, work)) as number;
			if (best === undefined || (name === 'minBy' ? order < 0 : order > 0)) { result = value; best = key; }
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return result;
	})),
	definition('countBy', keyArg, 'any', 'キーを文字列にして、出現回数を原型のない辞書に数えます。', 'Counts stringified keys in a prototype-free object.', function *(ctx, receiver, args) {
		const array = requireArray(ctx, receiver), fn = callback(ctx, args[0]), result = scriptObject(Object.create(null)), work = { count: 0 }, length = array.length;
		for (let i = 0; i < length; i++) {
			const key = yield ctx.call(fn, [ctx.properties.get(array, i, ctx.pos), i, array]);
			if (typeof key !== 'number' && typeof key !== 'string') throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'number | string' }, 'TypeError');
			if (typeof key === 'number' && Number.isNaN(key)) rangeError(ctx);
			const name = ctx.properties.key(key, ctx.pos);
			ctx.properties.set(result, name, (ctx.properties.get(result, name, ctx.pos) as number | null ?? 0) + 1, ctx.pos);
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return result;
	}),
	definition('shuffle', rngArg, 'any[]', '元の配列を無作為に並べ替えて返します。', 'Randomly shuffles the array in place and returns it.', function *(ctx, receiver, args) {
		const array = requireArray(ctx, receiver), rng = args[0] === undefined ? undefined : callback(ctx, args[0]), work = { count: 0 };
		for (let i = array.length - 1; i > 0; i--) {
			const j = Math.floor((yield* random(ctx, rng)) as number * (i + 1));
			const a = ctx.properties.get(array, i, ctx.pos), b = ctx.properties.get(array, j, ctx.pos);
			ctx.properties.set(array, i, b, ctx.pos); ctx.properties.set(array, j, a, ctx.pos); if (step(ctx, work)) yield ctx.checkpoint();
		}
		return array;
	}),
	definition('sample', rngArg, 'any', '無作為に一要素を返し、空配列では null を返します。', 'Returns a random element, or null for an empty array.', function *(ctx, receiver, args) {
		const array = requireArray(ctx, receiver), rng = args[0] === undefined ? undefined : callback(ctx, args[0]);
		if (array.length === 0) return null;
		return ctx.properties.get(array, Math.floor((yield* random(ctx, rng)) as number * array.length), ctx.pos);
	}),
	definition('sampleBy', [{ name: 'weight', type: 'Function' }, ...rngArg], 'any', '非負の重みに比例して一要素を選びます。', 'Samples an element proportionally to its non-negative weight.', function *(ctx, receiver, args) {
		const array = requireArray(ctx, receiver), fn = callback(ctx, args[0]), rng = args[1] === undefined ? undefined : callback(ctx, args[1]), work = { count: 0 };
		const source = (yield* copy(ctx, array, work)) as Value[];
		if (source.length === 0) return null;
		const weights: number[] = []; let maximum = 0;
		for (let i = 0; i < source.length; i++) {
			const weight = requireNumber(ctx, yield ctx.call(fn, [source[i]!, i, array]));
			if (!Number.isFinite(weight) || weight < 0) rangeError(ctx);
			weights.push(weight); maximum = Math.max(maximum, weight); if (step(ctx, work)) yield ctx.checkpoint();
		}
		if (maximum === 0) rangeError(ctx);
		// 最大値で割ることで、有限の重みの合計がオーバーフローしません。
		let total = 0;
		for (let i = 0; i < weights.length; i++) { weights[i] = weights[i]! / maximum; total += weights[i]!; if (step(ctx, work)) yield ctx.checkpoint(); }
		let threshold = (yield* random(ctx, rng)) as number * total, last = 0;
		for (let i = 0; i < weights.length; i++) {
			const weight = weights[i]!;
			if (weight > 0) { last = i; if (threshold < weight) return source[i]!; }
			threshold -= weight; if (step(ctx, work)) yield ctx.checkpoint();
		}
		return source[last]!;
	}),
];
