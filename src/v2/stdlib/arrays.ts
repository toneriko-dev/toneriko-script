import { type StdDefinition, type StdContext, type StdFrame, requireArray, requireNumber, isStdFunction } from './core.js';
import { scriptObject, isScriptFunction, PropertyAccess, type Value } from '../runtime/values.js';
import { runtimeError } from '../runtime/errors.js';
import type { Pos } from '../ast.js';

const iteratorStates = new WeakMap<object, { array: Value[]; index: number; done: boolean }>();
export function isArrayIterator(value: unknown): value is object { return typeof value === 'object' && value !== null && iteratorStates.has(value); }
export function nextArrayIterator(value: object, properties: PropertyAccess, pos: Pos): { value: Value; done: boolean } {
	const state = iteratorStates.get(value)!;
	if (state.done || state.index >= state.array.length) { state.done = true; return scriptObject(Object.assign(Object.create(null), { value: null, done: true })); }
	const index = state.index++;
	return scriptObject(Object.assign(Object.create(null), { value: scriptObject([index, properties.get(state.array, index, pos)]), done: false }));
}
function iterator(array: Value[], pos: Pos): Value {
	const value = scriptObject(Object.create(null));
	iteratorStates.set(value, { array, index: 0, done: false });
	Object.defineProperty(value, 'next', { value: () => nextArrayIterator(value, new PropertyAccess(), pos), enumerable: false });
	return value;
}
export function callable(ctx: StdContext, value: Value | undefined): Value {
	if (typeof value !== 'function' && !isScriptFunction(value) && !isStdFunction(value)) throw runtimeError('NOT_CALLABLE', ctx.pos, {}, 'TypeError');
	return value;
}
function integer(ctx: StdContext, value: Value | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const n = requireNumber(ctx, value);
	return Number.isNaN(n) ? 0 : Math.trunc(n);
}
function bound(n: number, length: number): number { return n < 0 ? Math.max(length + n, 0) : Math.min(n, length); }
function* step(ctx: StdContext, i: number): StdFrame { ctx.tick(); if (i % 64 === 63) yield ctx.checkpoint(); return null; }
function* copy(ctx: StdContext, array: Value[], start = 0, end = array.length): StdFrame {
	const result: Value[] = [];
	for (let i = start; i < end; i++) { result.push(ctx.properties.get(array, i, ctx.pos)); yield* step(ctx, i); }
	return scriptObject(result);
}
function noThis(ctx: StdContext, value: Value | undefined): void { if (value != null) throw runtimeError('UNSUPPORTED_VALUE', ctx.pos, {}, 'TypeError'); }
const a = (name: string, type = 'any', optional = false, rest = false) => ({ name, type, ...(optional ? { optional } : {}), ...(rest ? { rest } : {}) });
const def = (name: string, args: StdDefinition['args'], returns: string, ja: string, en: string, implementation: StdDefinition['implementation']): StdDefinition => ({ name, args, returns, receiver: 'array', description: { ja, en }, implementation });
export const arrayDefinitions: StdDefinition[] = [
	def('pop', [], 'any', '末尾の要素を取り除いて返します。', 'Removes and returns the last element.', function* (ctx, r) {
		const xs = requireArray(ctx, r); if (!xs.length) return null;
		const value = ctx.properties.get(xs, xs.length - 1, ctx.pos); ctx.properties.set(xs, 'length', xs.length - 1, ctx.pos); return value;
	}),
	def('shift', [], 'any', '先頭の要素を取り除いて返します。', 'Removes and returns the first element.', function* (ctx, r) {
		const xs = requireArray(ctx, r); if (!xs.length) return null; const first = ctx.properties.get(xs, 0, ctx.pos);
		for (let i = 1; i < xs.length; i++) { ctx.properties.set(xs, i - 1, ctx.properties.get(xs, i, ctx.pos), ctx.pos); yield* step(ctx, i); }
		ctx.properties.set(xs, 'length', xs.length - 1, ctx.pos); return first;
	}),
	def('unshift', [a('items', 'any[]', false, true)], 'number', '先頭に値を追加し、長さを返します。', 'Prepends values and returns the length.', function* (ctx, r, args) {
		const xs = requireArray(ctx, r); const old = (yield* copy(ctx, xs)) as Value[];
		for (let i = 0; i < args.length + old.length; i++) { ctx.properties.set(xs, i, i < args.length ? args[i]! : old[i - args.length]!, ctx.pos); yield* step(ctx, i); }
		return xs.length;
	}),
	def('slice', [a('start', 'number', true), a('end', 'number', true)], 'any[]', '指定した範囲を新しい配列にします。', 'Copies the selected range into a new array.', function* (ctx, r, args) {
		const xs = requireArray(ctx, r); return yield* copy(ctx, xs, bound(integer(ctx, args[0], 0), xs.length), bound(integer(ctx, args[1], xs.length), xs.length));
	}),
	def('splice', [a('start', 'number', true), a('deleteCount', 'number', true), a('items', 'any[]', false, true)], 'any[]', '要素を削除・挿入し、削除した配列を返します。', 'Removes and inserts elements and returns the removed values.', function* (ctx, r, args) {
		const xs = requireArray(ctx, r); const start = bound(integer(ctx, args[0], 0), xs.length);
		const count = !args.length ? 0 : args.length === 1 ? xs.length - start : Math.min(Math.max(integer(ctx, args[1], 0), 0), xs.length - start);
		const removed = yield* copy(ctx, xs, start, start + count); const tail = (yield* copy(ctx, xs, start + count)) as Value[];
		const additions = args.slice(2); let i = start;
		for (const value of additions) { ctx.properties.set(xs, i, value, ctx.pos); yield* step(ctx, i++); }
		for (const value of tail) { ctx.properties.set(xs, i, value, ctx.pos); yield* step(ctx, i++); }
		ctx.properties.set(xs, 'length', i, ctx.pos); return removed;
	}),
	def('concat', [a('items', 'any[]', false, true)], 'any[]', '配列と値を順に連結した新しい配列を返します。', 'Returns a new array containing arrays and values in order.', function* (ctx, r, args) {
		const xs = requireArray(ctx, r); const out: Value[] = []; let n = 0;
		for (const source of [xs, ...args]) {
			if (Array.isArray(source)) for (let i = 0; i < source.length; i++) { out.push(ctx.properties.get(source, i, ctx.pos)); yield* step(ctx, n++); }
			else { out.push(source); yield* step(ctx, n++); }
		} return scriptObject(out);
	}),
	def('at', [a('index', 'number', true)], 'any', '正負の添字で要素を返し、範囲外は null にします。', 'Returns an element by positive or negative index, or null.', function* (ctx, r, args) {
		const xs = requireArray(ctx, r); const n = integer(ctx, args[0], 0); const i = n < 0 ? xs.length + n : n;
		return i < 0 || i >= xs.length ? null : ctx.properties.get(xs, i, ctx.pos);
	}),
	...(['indexOf', 'includes'] as const).map(name => def(name, [a('searchElement', 'any', true), a('fromIndex', 'number', true)], name === 'includes' ? 'boolean' : 'number', name === 'includes' ? '指定した値を含むか返します。' : '指定した値の最初の添字を返します。', name === 'includes' ? 'Tests whether the array contains a value.' : 'Returns the first index of a value.', function* (ctx, r, args) {
		const xs = requireArray(ctx, r); const target = args[0]; const n = integer(ctx, args[1], 0);
		for (let i = Math.max(n < 0 ? xs.length + n : n, 0); i < xs.length; i++) { const value = ctx.properties.get(xs, i, ctx.pos); if (value === target || (name === 'includes' && Number.isNaN(value) && Number.isNaN(target))) return name === 'includes' ? true : i; yield* step(ctx, i); }
		return name === 'includes' ? false : -1;
	})),
	def('fill', [a('value'), a('start', 'number', true), a('end', 'number', true)], 'any[]', '指定範囲を同じ値で埋めます。', 'Fills the selected range with a value.', function* (ctx, r, args) {
		const xs = requireArray(ctx, r); const end = bound(integer(ctx, args[2], xs.length), xs.length);
		for (let i = bound(integer(ctx, args[1], 0), xs.length); i < end; i++) { ctx.properties.set(xs, i, args[0]!, ctx.pos); yield* step(ctx, i); } return xs;
	}),
	...(['reverse', 'toReversed'] as const).map(name => def(name, [], 'any[]', name === 'reverse' ? '元の配列の順序を逆にします。' : '逆順の新しい配列を返します。', name === 'reverse' ? 'Reverses the array in place.' : 'Returns a reversed copy.', function* (ctx, r) {
		let xs = requireArray(ctx, r); if (name === 'toReversed') xs = (yield* copy(ctx, xs)) as Value[];
		for (let i = 0; i < Math.floor(xs.length / 2); i++) { const j = xs.length - i - 1; const left = ctx.properties.get(xs, i, ctx.pos); ctx.properties.set(xs, i, ctx.properties.get(xs, j, ctx.pos), ctx.pos); ctx.properties.set(xs, j, left, ctx.pos); yield* step(ctx, i); } return xs;
	})),
	def('entries', [], 'any', '添字と要素を順に返す反復子を作ります。', 'Creates an iterator of index and value pairs.', function* (ctx, r) { return iterator(requireArray(ctx, r), ctx.pos); }),
];
const descriptions = {
	map: ['関数の結果を新しい配列にします。', 'Maps elements sequentially into a new array.'],
	filter: ['条件を満たす要素の新しい配列を返します。', 'Returns a new array of matching elements.'],
	find: ['条件を満たす最初の要素を返します。', 'Returns the first matching element.'],
	findIndex: ['条件を満たす最初の添字を返します。', 'Returns the first matching index.'],
	some: ['条件を満たす要素があるか返します。', 'Tests whether any element matches.'],
	every: ['すべての要素が条件を満たすか返します。', 'Tests whether all elements match.'],
	forEach: ['各要素について関数を順に実行します。', 'Calls a function sequentially for every element.'],
	flatMap: ['各要素の関数の結果を一段平坦化します。', 'Maps sequentially and flattens one level.'],
} as const;
for (const name of Object.keys(descriptions) as (keyof typeof descriptions)[]) {
	arrayDefinitions.push(def(name, [a('callback', 'Function'), a('thisArg', 'any', true)], ['some', 'every'].includes(name) ? 'boolean' : name === 'findIndex' ? 'number' : name === 'forEach' ? 'void' : ['map', 'filter', 'flatMap'].includes(name) ? 'any[]' : 'any', descriptions[name][0], descriptions[name][1], function* (ctx, r, args) {
		const xs = requireArray(ctx, r), fn = callable(ctx, args[0]); noThis(ctx, args[1]); const length = xs.length; const out: Value[] = [];
		for (let i = 0; i < length; i++) {
			if (i >= xs.length && name !== 'find' && name !== 'findIndex') { if (name === 'map') throw runtimeError('SPARSE_ARRAY', ctx.pos); yield* step(ctx, i); continue; }
			const value = i < xs.length ? ctx.properties.get(xs, i, ctx.pos) : null;
			const mapped: Value = yield ctx.call(fn, [value, i, xs]);
			if (name === 'map') out.push(mapped);
			else if (name === 'flatMap') { if (Array.isArray(mapped)) for (let j = 0; j < mapped.length; j++) { out.push(ctx.properties.get(mapped, j, ctx.pos)); yield* step(ctx, j); } else out.push(mapped); }
			else if (name === 'filter' && mapped) out.push(value);
			else if (name === 'find' && mapped) return value;
			else if (name === 'findIndex' && mapped) return i;
			else if (name === 'some' && mapped) return true;
			else if (name === 'every' && !mapped) return false;
			yield* step(ctx, i);
		}
		if (name === 'find' || name === 'forEach') return null;
		if (name === 'findIndex') return -1;
		if (name === 'some') return false;
		if (name === 'every') return true;
		return scriptObject(out);
	}));
}
arrayDefinitions.push(def('reduce', [a('callback', 'Function'), a('initialValue', 'any', true)], 'any', '左から順に値を集約します。', 'Reduces values sequentially from left to right.', function* (ctx, r, args) {
	const xs = requireArray(ctx, r), fn = callable(ctx, args[0]), length = xs.length;
	if (!length && args.length < 2) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'initialValue' }, 'TypeError');
	let accumulator = args.length > 1 ? args[1]! : ctx.properties.get(xs, 0, ctx.pos);
	for (let i = args.length > 1 ? 0 : 1; i < length; i++) { if (i >= xs.length) { yield* step(ctx, i); continue; } accumulator = yield ctx.call(fn, [accumulator, ctx.properties.get(xs, i, ctx.pos), i, xs]); yield* step(ctx, i); }
	return accumulator;
}));
arrayDefinitions.push(def('flat', [a('depth', 'number', true)], 'any[]', '指定した深さまで配列を平坦化します。', 'Flattens nested arrays to the specified depth.', function* (ctx, r, args) {
	const xs = requireArray(ctx, r), depth = Math.max(integer(ctx, args[0], 1), 0), out: Value[] = [];
	const stack = [{ array: xs, index: 0, depth }]; const active = new Set<Value[]>([xs]); let n = 0;
	while (stack.length) { const frame = stack[stack.length - 1]!; if (frame.index >= frame.array.length) { stack.pop(); active.delete(frame.array); continue; }
		const value = ctx.properties.get(frame.array, frame.index++, ctx.pos);
		if (Array.isArray(value) && frame.depth > 0) { if (active.has(value) && frame.depth === Infinity) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'acyclic array' }, 'RangeError'); active.add(value); stack.push({ array: value, index: 0, depth: frame.depth - 1 }); } else out.push(value);
		yield* step(ctx, n++);
	} return scriptObject(out);
}));
// join は循環参照を空文字として扱い、利用者の変換関数を暗黙には呼びません。
function* joinText(ctx: StdContext, value: Value, active: Set<object>): StdFrame {
	if (value === null) return '';
	if (typeof value !== 'object' && typeof value !== 'function') return String(value);
	if (!Array.isArray(value)) throw runtimeError('INVALID_STRING_CONVERSION', ctx.pos, {}, 'TypeError');
	if (active.has(value)) return '';
	active.add(value); const parts: string[] = [];
	try { for (let i = 0; i < value.length; i++) { parts.push((yield joinText(ctx, ctx.properties.get(value, i, ctx.pos), active)) as string); yield* step(ctx, i); } } finally { active.delete(value); }
	return parts.join(',');
}
arrayDefinitions.push(def('join', [a('separator', 'string', true)], 'string', '要素を区切り文字で連結します。', 'Joins elements with a separator.', function* (ctx, r, args) {
	const xs = requireArray(ctx, r), separator = args[0] === undefined ? ',' : args[0];
	if (typeof separator !== 'string') throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'string' }, 'TypeError');
	const parts: string[] = [], active = new Set<object>([xs]);
	for (let i = 0; i < xs.length; i++) { parts.push((yield joinText(ctx, ctx.properties.get(xs, i, ctx.pos), active)) as string); yield* step(ctx, i); }
	return parts.join(separator);
}));
arrayDefinitions.push({ name: 'Array.from', receiver: 'global', args: [a('items'), a('mapFn', 'Function', true), a('thisArg', 'any', true)], returns: 'any[]', description: { ja: '反復可能な値や配列状の値から配列を作ります。', en: 'Creates an array from an iterable or array-like value.' }, *implementation(ctx, _r, args) {
	const source = args[0]!, fn = args.length < 2 ? null : callable(ctx, args[1]); noThis(ctx, args[2]); const out: Value[] = [];
	if (typeof source === 'string') { for (const _ of ctx.properties.prepare(source, ctx.pos, true)) yield ctx.checkpoint(); }
	if (Array.isArray(source)) {
		for (let i = 0; i < source.length; i++) { const value = Object.hasOwn(source, i) ? ctx.properties.get(source, i, ctx.pos) : null; out.push(fn === null ? value : yield ctx.call(fn, [value, i])); yield* step(ctx, i); }
	} else if (typeof source === 'string' || isArrayIterator(source)) {
		let i = 0;
		for (const value of ctx.properties.iterableIterator(source, ctx.pos)) { out.push(fn === null ? value : yield ctx.call(fn, [value, i])); yield* step(ctx, i++); }
	} else {
		if (source === null || (typeof source !== 'object' && typeof source !== 'function')) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'array-like object' }, 'TypeError');
		const raw = ctx.properties.get(source, 'length', ctx.pos);
		const length = Math.min(Math.max(integer(ctx, raw === null ? undefined : raw, 0), 0), Number.MAX_SAFE_INTEGER);
		if (length > 0xffffffff) throw runtimeError('INVALID_ARRAY_LENGTH', ctx.pos, {}, 'RangeError');
		for (let i = 0; i < length; i++) { const value = ctx.properties.get(source, String(i), ctx.pos); out.push(fn === null ? value : yield ctx.call(fn, [value, i])); yield* step(ctx, i); }
	} return scriptObject(out);
} });
