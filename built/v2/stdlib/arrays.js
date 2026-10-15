import { runtimeError } from "../runtime/errors.js";
import { isStdFunction, makeFunction, requireArray, requireNumber } from "./core.js";
import { isScriptFunction, scriptObject, scriptObjects } from "../runtime/brands.js";

//#region src/v2/stdlib/arrays.ts
const nativeShift = Array.prototype.shift;
const nativeUnshift = Array.prototype.unshift;
const iteratorStates = /* @__PURE__ */ new WeakMap();
function isArrayIterator(value) {
	return typeof value === "object" && value !== null && iteratorStates.has(value);
}
function nextArrayIterator(value, properties, pos) {
	const state = iteratorStates.get(value);
	if (state.done || state.index >= state.array.length) {
		state.done = true;
		return scriptObject(Object.assign(Object.create(null), {
			value: null,
			done: true
		}));
	}
	const index = state.index++;
	return scriptObject(Object.assign(Object.create(null), {
		value: scriptObject([index, properties.get(state.array, index, pos)]),
		done: false
	}));
}
const nextDefinition = {
	name: "next",
	receiver: "iterator",
	args: [],
	returns: "any",
	description: {
		ja: "配列の次の添字と値を返します。",
		en: "Returns the next array index and value."
	},
	*implementation(ctx, receiver) {
		if (!isArrayIterator(receiver)) throw runtimeError("INVALID_RECEIVER", ctx.pos, {}, "TypeError");
		return nextArrayIterator(receiver, ctx.properties, ctx.pos);
	}
};
const iteratorDefinitions = [nextDefinition];
function iterator(array) {
	const value = scriptObject(Object.create(null));
	iteratorStates.set(value, {
		array,
		index: 0,
		done: false
	});
	Object.defineProperty(value, "next", {
		value: makeFunction(nextDefinition),
		enumerable: false
	});
	return value;
}
function callable(ctx, value) {
	if (typeof value !== "function" && !isScriptFunction(value) && !isStdFunction(value)) throw runtimeError("NOT_CALLABLE", ctx.pos, {}, "TypeError");
	return value;
}
function integer(ctx, value, fallback) {
	if (value === void 0) return fallback;
	const n = requireNumber(ctx, value);
	return Number.isNaN(n) ? 0 : Math.trunc(n);
}
function bound(n, length) {
	return n < 0 ? Math.max(length + n, 0) : Math.min(n, length);
}
function* step(ctx, i) {
	ctx.tick();
	if (i % 64 === 63) yield ctx.checkpoint();
	return null;
}
function* copy(ctx, array, start = 0, end = array.length) {
	const result = [];
	for (let i = start; i < end; i++) {
		result.push(ctx.properties.get(array, i, ctx.pos));
		yield* step(ctx, i);
	}
	return scriptObject(result);
}
const checkedHostArrays = /* @__PURE__ */ new WeakSet();
function* nativeArray(ctx, xs) {
	if (scriptObjects.has(xs) || checkedHostArrays.has(xs)) return true;
	if (Object.getPrototypeOf(xs) !== Array.prototype) return false;
	let mutable = Object.getOwnPropertyDescriptor(xs, "length").writable === true && Object.isExtensible(xs);
	for (let i = 0; i < xs.length; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(xs, String(i));
		if (!descriptor) throw runtimeError("SPARSE_ARRAY", ctx.pos);
		if (!("value" in descriptor)) throw runtimeError("ACCESSOR_PROPERTY", ctx.pos, { key: String(i) }, "TypeError");
		if (!descriptor.writable || !descriptor.configurable) mutable = false;
		ctx.properties.normalize(descriptor.value, ctx.pos);
		yield* step(ctx, i);
	}
	if (mutable) checkedHostArrays.add(xs);
	return mutable;
}
function* prepend(ctx, xs, items) {
	if (!Object.getOwnPropertyDescriptor(xs, "length").writable) throw runtimeError("READONLY_PROPERTY", ctx.pos, { key: "length" }, "TypeError");
	if (yield* nativeArray(ctx, xs)) return nativeUnshift.call(xs, ...items);
	const old = yield* copy(ctx, xs);
	for (let i = 0; i < items.length + old.length; i++) {
		ctx.properties.set(xs, i, i < items.length ? items[i] : old[i - items.length], ctx.pos);
		yield* step(ctx, i);
	}
	return xs.length;
}
function noThis(ctx, value) {
	if (value != null) throw runtimeError("UNSUPPORTED_VALUE", ctx.pos, {}, "TypeError");
}
const a = (name, type = "any", optional = false, rest = false) => ({
	name,
	type,
	...optional ? { optional } : {},
	...rest ? { rest } : {}
});
const def = (name, args, returns, ja, en, implementation) => ({
	name,
	args,
	returns,
	receiver: "array",
	description: {
		ja,
		en
	},
	implementation
});
const arrayDefinitions = [
	def("pop", [], "any", "末尾の要素を取り除いて返します。", "Removes and returns the last element.", function* (ctx, r) {
		const xs = requireArray(ctx, r);
		if (!xs.length) return null;
		const value = ctx.properties.get(xs, xs.length - 1, ctx.pos);
		ctx.properties.set(xs, "length", xs.length - 1, ctx.pos);
		return value;
	}),
	def("shift", [], "any", "先頭の要素を取り除いて返します。", "Removes and returns the first element.", function* (ctx, r) {
		const xs = requireArray(ctx, r);
		const native = yield* nativeArray(ctx, xs);
		if (!xs.length) return null;
		if (native) return ctx.properties.normalize(nativeShift.call(xs), ctx.pos);
		const first = ctx.properties.get(xs, 0, ctx.pos);
		for (let i = 1; i < xs.length; i++) {
			ctx.properties.set(xs, i - 1, ctx.properties.get(xs, i, ctx.pos), ctx.pos);
			yield* step(ctx, i);
		}
		ctx.properties.set(xs, "length", xs.length - 1, ctx.pos);
		return first;
	}),
	def("unshift", [a("items", "any[]", false, true)], "number", "先頭に値を追加し、長さを返します。", "Prepends values and returns the length.", function* (ctx, r, args) {
		const xs = requireArray(ctx, r);
		if (!args.length) return yield* prepend(ctx, xs, []);
		for (let end = args.length; end > 0;) {
			const start = Math.max(0, end - 4096);
			yield* prepend(ctx, xs, args.slice(start, end));
			for (let i = start; i < end; i++) yield* step(ctx, i);
			end = start;
		}
		return xs.length;
	}),
	def("slice", [a("start", "number", true), a("end", "number", true)], "any[]", "指定した範囲を新しい配列にします。", "Copies the selected range into a new array.", function* (ctx, r, args) {
		const xs = requireArray(ctx, r);
		return yield* copy(ctx, xs, bound(integer(ctx, args[0], 0), xs.length), bound(integer(ctx, args[1], xs.length), xs.length));
	}),
	def("splice", [
		a("start", "number", true),
		a("deleteCount", "number", true),
		a("items", "any[]", false, true)
	], "any[]", "要素を削除・挿入し、削除した配列を返します。", "Removes and inserts elements and returns the removed values.", function* (ctx, r, args) {
		const xs = requireArray(ctx, r);
		const start = bound(integer(ctx, args[0], 0), xs.length);
		const count = !args.length ? 0 : args.length === 1 ? xs.length - start : Math.min(Math.max(integer(ctx, args[1], 0), 0), xs.length - start);
		const removed = yield* copy(ctx, xs, start, start + count);
		const tail = yield* copy(ctx, xs, start + count);
		const additions = args.slice(2);
		let i = start;
		for (const value of additions) {
			ctx.properties.set(xs, i, value, ctx.pos);
			yield* step(ctx, i++);
		}
		for (const value of tail) {
			ctx.properties.set(xs, i, value, ctx.pos);
			yield* step(ctx, i++);
		}
		ctx.properties.set(xs, "length", i, ctx.pos);
		return removed;
	}),
	def("concat", [a("items", "any[]", false, true)], "any[]", "配列と値を順に連結した新しい配列を返します。", "Returns a new array containing arrays and values in order.", function* (ctx, r, args) {
		const xs = requireArray(ctx, r);
		const out = [];
		let n = 0;
		for (const source of [xs, ...args]) if (Array.isArray(source)) for (let i = 0; i < source.length; i++) {
			out.push(ctx.properties.get(source, i, ctx.pos));
			yield* step(ctx, n++);
		}
		else {
			out.push(source);
			yield* step(ctx, n++);
		}
		return scriptObject(out);
	}),
	def("at", [a("index", "number", true)], "any", "正負の添字で要素を返し、範囲外は null にします。", "Returns an element by positive or negative index, or null.", function* (ctx, r, args) {
		const xs = requireArray(ctx, r);
		const n = integer(ctx, args[0], 0);
		const i = n < 0 ? xs.length + n : n;
		return i < 0 || i >= xs.length ? null : ctx.properties.get(xs, i, ctx.pos);
	}),
	...["indexOf", "includes"].map((name) => def(name, [a("searchElement", "any", true), a("fromIndex", "number", true)], name === "includes" ? "boolean" : "number", name === "includes" ? "指定した値を含むか返します。" : "指定した値の最初の添字を返します。", name === "includes" ? "Tests whether the array contains a value." : "Returns the first index of a value.", function* (ctx, r, args) {
		const xs = requireArray(ctx, r);
		const target = args[0];
		const n = integer(ctx, args[1], 0);
		for (let i = Math.max(n < 0 ? xs.length + n : n, 0); i < xs.length; i++) {
			const value = ctx.properties.get(xs, i, ctx.pos);
			if (value === target || name === "includes" && Number.isNaN(value) && Number.isNaN(target)) return name === "includes" ? true : i;
			yield* step(ctx, i);
		}
		return name === "includes" ? false : -1;
	})),
	def("fill", [
		a("value"),
		a("start", "number", true),
		a("end", "number", true)
	], "any[]", "指定範囲を同じ値で埋めます。", "Fills the selected range with a value.", function* (ctx, r, args) {
		const xs = requireArray(ctx, r);
		const end = bound(integer(ctx, args[2], xs.length), xs.length);
		for (let i = bound(integer(ctx, args[1], 0), xs.length); i < end; i++) {
			ctx.properties.set(xs, i, args[0], ctx.pos);
			yield* step(ctx, i);
		}
		return xs;
	}),
	...["reverse", "toReversed"].map((name) => def(name, [], "any[]", name === "reverse" ? "元の配列の順序を逆にします。" : "逆順の新しい配列を返します。", name === "reverse" ? "Reverses the array in place." : "Returns a reversed copy.", function* (ctx, r) {
		let xs = requireArray(ctx, r);
		if (name === "toReversed") xs = yield* copy(ctx, xs);
		for (let i = 0; i < Math.floor(xs.length / 2); i++) {
			const j = xs.length - i - 1;
			const left = ctx.properties.get(xs, i, ctx.pos);
			ctx.properties.set(xs, i, ctx.properties.get(xs, j, ctx.pos), ctx.pos);
			ctx.properties.set(xs, j, left, ctx.pos);
			yield* step(ctx, i);
		}
		return xs;
	})),
	def("entries", [], "any", "添字と要素を順に返す反復子を作ります。", "Creates an iterator of index and value pairs.", function* (ctx, r) {
		return iterator(requireArray(ctx, r));
	})
];
const descriptions = {
	map: ["関数の結果を新しい配列にします。", "Maps elements sequentially into a new array."],
	filter: ["条件を満たす要素の新しい配列を返します。", "Returns a new array of matching elements."],
	find: ["条件を満たす最初の要素を返します。", "Returns the first matching element."],
	findIndex: ["条件を満たす最初の添字を返します。", "Returns the first matching index."],
	some: ["条件を満たす要素があるか返します。", "Tests whether any element matches."],
	every: ["すべての要素が条件を満たすか返します。", "Tests whether all elements match."],
	forEach: ["各要素について関数を順に実行します。", "Calls a function sequentially for every element."],
	flatMap: ["各要素の関数の結果を一段平坦化します。", "Maps sequentially and flattens one level."]
};
for (const name of Object.keys(descriptions)) arrayDefinitions.push(def(name, [a("callback", "Function"), a("thisArg", "any", true)], ["some", "every"].includes(name) ? "boolean" : name === "findIndex" ? "number" : name === "forEach" ? "void" : [
	"map",
	"filter",
	"flatMap"
].includes(name) ? "any[]" : "any", descriptions[name][0], descriptions[name][1], function* (ctx, r, args) {
	const xs = requireArray(ctx, r), fn = callable(ctx, args[0]);
	noThis(ctx, args[1]);
	const length = xs.length;
	const out = [];
	for (let i = 0; i < length; i++) {
		if (i >= xs.length && name !== "find" && name !== "findIndex") {
			if (name === "map") throw runtimeError("SPARSE_ARRAY", ctx.pos);
			yield* step(ctx, i);
			continue;
		}
		const value = i < xs.length ? ctx.properties.get(xs, i, ctx.pos) : null;
		const mapped = yield ctx.call(fn, [
			value,
			i,
			xs
		]);
		if (name === "map") out.push(mapped);
		else if (name === "flatMap") {
			if (Array.isArray(mapped)) for (let j = 0; j < mapped.length; j++) {
				out.push(ctx.properties.get(mapped, j, ctx.pos));
				yield* step(ctx, j);
			}
			else out.push(mapped);
		} else if (name === "filter" && mapped) out.push(value);
		else if (name === "find" && mapped) return value;
		else if (name === "findIndex" && mapped) return i;
		else if (name === "some" && mapped) return true;
		else if (name === "every" && !mapped) return false;
		yield* step(ctx, i);
	}
	if (name === "find" || name === "forEach") return null;
	if (name === "findIndex") return -1;
	if (name === "some") return false;
	if (name === "every") return true;
	return scriptObject(out);
}));
arrayDefinitions.push(def("reduce", [a("callback", "Function"), a("initialValue", "any", true)], "any", "左から順に値を集約します。", "Reduces values sequentially from left to right.", function* (ctx, r, args) {
	const xs = requireArray(ctx, r), fn = callable(ctx, args[0]), length = xs.length;
	if (!length && args.length < 2) throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "initialValue" }, "TypeError");
	let accumulator = args.length > 1 ? args[1] : ctx.properties.get(xs, 0, ctx.pos);
	for (let i = args.length > 1 ? 0 : 1; i < length; i++) {
		if (i >= xs.length) {
			yield* step(ctx, i);
			continue;
		}
		accumulator = yield ctx.call(fn, [
			accumulator,
			ctx.properties.get(xs, i, ctx.pos),
			i,
			xs
		]);
		yield* step(ctx, i);
	}
	return accumulator;
}));
arrayDefinitions.push(def("flat", [a("depth", "number", true)], "any[]", "指定した深さまで配列を平坦化します。", "Flattens nested arrays to the specified depth.", function* (ctx, r, args) {
	const xs = requireArray(ctx, r), depth = Math.max(integer(ctx, args[0], 1), 0), out = [];
	const stack = [{
		array: xs,
		index: 0,
		depth
	}];
	const active = /* @__PURE__ */ new Set([xs]);
	let n = 0;
	while (stack.length) {
		const frame = stack[stack.length - 1];
		if (frame.index >= frame.array.length) {
			stack.pop();
			active.delete(frame.array);
			continue;
		}
		const value = ctx.properties.get(frame.array, frame.index++, ctx.pos);
		if (Array.isArray(value) && frame.depth > 0) {
			if (active.has(value) && frame.depth === Infinity) throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "acyclic array" }, "RangeError");
			active.add(value);
			stack.push({
				array: value,
				index: 0,
				depth: frame.depth - 1
			});
		} else out.push(value);
		yield* step(ctx, n++);
	}
	return scriptObject(out);
}));
function* joinText(ctx, value, active) {
	if (value === null) return "";
	if (typeof value !== "object" && typeof value !== "function") return String(value);
	if (!Array.isArray(value)) throw runtimeError("INVALID_STRING_CONVERSION", ctx.pos, {}, "TypeError");
	if (active.has(value)) return "";
	active.add(value);
	const parts = [];
	try {
		for (let i = 0; i < value.length; i++) {
			parts.push(yield joinText(ctx, ctx.properties.get(value, i, ctx.pos), active));
			yield* step(ctx, i);
		}
	} finally {
		active.delete(value);
	}
	return parts.join(",");
}
arrayDefinitions.push(def("join", [a("separator", "string", true)], "string", "要素を区切り文字で連結します。", "Joins elements with a separator.", function* (ctx, r, args) {
	const xs = requireArray(ctx, r), separator = args[0] === void 0 ? "," : args[0];
	if (typeof separator !== "string") throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "string" }, "TypeError");
	const parts = [], active = /* @__PURE__ */ new Set([xs]);
	for (let i = 0; i < xs.length; i++) {
		parts.push(yield joinText(ctx, ctx.properties.get(xs, i, ctx.pos), active));
		yield* step(ctx, i);
	}
	return parts.join(separator);
}));
arrayDefinitions.push({
	name: "Array.from",
	receiver: "global",
	args: [
		a("items"),
		a("mapFn", "Function", true),
		a("thisArg", "any", true)
	],
	returns: "any[]",
	description: {
		ja: "反復可能な値や配列状の値から配列を作ります。",
		en: "Creates an array from an iterable or array-like value."
	},
	*implementation(ctx, _r, args) {
		const source = args[0], fn = args.length < 2 ? null : callable(ctx, args[1]);
		noThis(ctx, args[2]);
		const out = [];
		if (typeof source === "string") for (const _ of ctx.properties.prepare(source, ctx.pos, true)) yield ctx.checkpoint();
		if (Array.isArray(source)) for (let i = 0; i < source.length; i++) {
			const value = Object.hasOwn(source, i) ? ctx.properties.get(source, i, ctx.pos) : null;
			out.push(fn === null ? value : yield ctx.call(fn, [value, i]));
			yield* step(ctx, i);
		}
		else if (typeof source === "string" || isArrayIterator(source)) {
			let i = 0;
			for (const value of ctx.properties.iterableIterator(source, ctx.pos)) {
				out.push(fn === null ? value : yield ctx.call(fn, [value, i]));
				yield* step(ctx, i++);
			}
		} else {
			if (source === null || typeof source !== "object" && typeof source !== "function") throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "array-like object" }, "TypeError");
			if (!scriptObjects.has(source) || Object.getPrototypeOf(source) !== null) throw runtimeError("NOT_ITERABLE", ctx.pos, {}, "TypeError");
			const raw = ctx.properties.get(source, "length", ctx.pos);
			const length = Math.min(Math.max(integer(ctx, raw === null ? void 0 : raw, 0), 0), Number.MAX_SAFE_INTEGER);
			if (length > 4294967295) throw runtimeError("INVALID_ARRAY_LENGTH", ctx.pos, {}, "RangeError");
			for (let i = 0; i < length; i++) {
				const value = ctx.properties.get(source, String(i), ctx.pos);
				out.push(fn === null ? value : yield ctx.call(fn, [value, i]));
				yield* step(ctx, i);
			}
		}
		return scriptObject(out);
	}
});

//#endregion
export { arrayDefinitions, callable, isArrayIterator, iteratorDefinitions, nextArrayIterator };
//# sourceMappingURL=arrays.js.map