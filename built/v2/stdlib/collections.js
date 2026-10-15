import { runtimeError } from "../runtime/errors.js";
import { isStdFunction, requireArray, requireNumber } from "./core.js";
import { isScriptFunction, scriptObject } from "../runtime/brands.js";

//#region src/v2/stdlib/collections.ts
function callback(ctx, value) {
	if (typeof value !== "function" && !isScriptFunction(value) && !isStdFunction(value)) throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "Function" }, "TypeError");
	return value;
}
function rangeError(ctx) {
	throw runtimeError("STDLIB_ARGUMENT_RANGE", ctx.pos, {}, "RangeError");
}
function step(ctx, work) {
	ctx.tick();
	return ++work.count % 64 === 0;
}
function* copy(ctx, array, work) {
	const result = [];
	const length = array.length;
	for (let i = 0; i < length; i++) {
		result.push(ctx.properties.get(array, i, ctx.pos));
		if (step(ctx, work)) yield ctx.checkpoint();
	}
	return result;
}
function* compareScalar(ctx, left, right, work) {
	if (typeof left !== typeof right) throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "matching key types" }, "TypeError");
	if (typeof left === "number") {
		if (step(ctx, work)) yield ctx.checkpoint();
		return left < right ? -1 : left > right ? 1 : 0;
	}
	const other = right;
	for (let i = 0; i < Math.min(left.length, other.length); i++) {
		const difference = left.charCodeAt(i) - other.charCodeAt(i);
		if (step(ctx, work)) yield ctx.checkpoint();
		if (difference !== 0) return difference < 0 ? -1 : 1;
	}
	return left.length < other.length ? -1 : left.length > other.length ? 1 : 0;
}
function* compareKeys(ctx, left, right, work) {
	if (!Array.isArray(left) && !Array.isArray(right)) return yield* compareScalar(ctx, left, right, work);
	if (!Array.isArray(left) || !Array.isArray(right)) throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "matching key types" }, "TypeError");
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		const order = yield* compareScalar(ctx, left[i], right[i], work);
		if (order !== 0) return order;
	}
	return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}
function* readKey(ctx, value, schema, work) {
	const array = Array.isArray(value);
	if (schema.array !== void 0 && schema.array !== array) throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "matching key types" }, "TypeError");
	schema.array = array;
	const source = array ? value : [value];
	const result = [];
	for (let i = 0; i < source.length; i++) {
		const item = ctx.properties.get(source, i, ctx.pos);
		if (typeof item !== "number" && typeof item !== "string") throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "number | string | (number | string)[]" }, "TypeError");
		if (typeof item === "number" && Number.isNaN(item)) rangeError(ctx);
		if (schema.positions[i] !== void 0 && schema.positions[i] !== typeof item) throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "matching key types" }, "TypeError");
		schema.positions[i] = typeof item;
		result.push(item);
		if (step(ctx, work)) yield ctx.checkpoint();
	}
	return array ? result : result[0];
}
function* mergeSort(ctx, input, compare, work) {
	let source = input;
	let target = [];
	for (let width = 1; width < source.length; width *= 2) {
		for (let start = 0; start < source.length; start += width * 2) {
			const middle = Math.min(start + width, source.length), end = Math.min(start + width * 2, source.length);
			let left = start, right = middle;
			for (let i = start; i < end; i++) {
				if (left >= middle) target[i] = source[right++];
				else if (right >= end) target[i] = source[left++];
				else {
					const compared = compare(source[left], source[right]);
					const order = requireNumber(ctx, "ready" in compared ? compared.ready : yield compared);
					target[i] = Number.isNaN(order) || order <= 0 ? source[left++] : source[right++];
				}
				if (step(ctx, work)) yield ctx.checkpoint();
			}
		}
		[source, target] = [target, source];
	}
	return source;
}
function definition(name, args, returns, ja, en, implementation) {
	return {
		name,
		receiver: "array",
		args,
		returns,
		description: {
			ja,
			en
		},
		implementation
	};
}
const keyArg = [{
	name: "key",
	type: "Function"
}];
const rngArg = [{
	name: "rng",
	type: "Function",
	optional: true
}];
function* random(ctx, rng) {
	const value = rng === void 0 ? Math.random() : requireNumber(ctx, yield ctx.call(rng, []));
	if (!(value >= 0 && value < 1)) rangeError(ctx);
	return value;
}
const collectionDefinitions = [
	...[
		"sort",
		"toSorted",
		"sortBy"
	].map((name) => definition(name, name === "sortBy" ? keyArg : [{
		name: "compare",
		type: "Function",
		optional: true
	}], "any[]", name === "toSorted" ? "安定な並べ替えの結果を新しい配列で返します。" : name === "sortBy" ? "キーを一度ずつ求め、元の配列を安定に並べ替えます。" : "元の配列を安定に並べ替えます。", name === "toSorted" ? "Returns a stably sorted copy." : name === "sortBy" ? "Stably sorts the array in place using one key per element." : "Stably sorts the array in place.", function* (ctx, receiver, args) {
		const array = requireArray(ctx, receiver), work = { count: 0 };
		const fn = args[0] === void 0 ? void 0 : callback(ctx, args[0]);
		const source = yield* copy(ctx, array, work);
		const items = [], schema = { positions: [] };
		for (let i = 0; i < source.length; i++) {
			const value = source[i];
			let key = 0;
			if (name === "sortBy") key = yield* readKey(ctx, yield ctx.call(fn, [
				value,
				i,
				array
			]), schema, work);
			else if (fn === void 0) {
				if (typeof value !== "string") throw runtimeError("STDLIB_SORT_COMPARATOR_REQUIRED", ctx.pos, {}, "TypeError");
				key = value;
			}
			items.push({
				value,
				key
			});
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		const sorted = yield* mergeSort(ctx, items, (left, right) => {
			if (name === "sortBy" || fn === void 0) return compareKeys(ctx, left.key, right.key, work);
			return ctx.call(fn, [left.value, right.value]);
		}, work);
		const result = name === "toSorted" ? scriptObject([]) : array;
		for (let i = 0; i < sorted.length; i++) {
			ctx.properties.set(result, i, sorted[i].value, ctx.pos);
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return result;
	})),
	definition("unique", [], "any[]", "重複を除き、最初の要素を残した配列を返します。", "Returns the first occurrence of each distinct value.", function* (ctx, receiver) {
		const array = requireArray(ctx, receiver), result = scriptObject([]), seen = /* @__PURE__ */ new Set(), work = { count: 0 };
		for (let i = 0; i < array.length; i++) {
			const value = ctx.properties.get(array, i, ctx.pos);
			if (!seen.has(value)) {
				seen.add(value);
				result.push(value);
			}
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return result;
	}),
	definition("uniqueBy", keyArg, "any[]", "キーの重複を除き、最初の要素を残した配列を返します。", "Returns the first element for each distinct key.", function* (ctx, receiver, args) {
		const array = requireArray(ctx, receiver), fn = callback(ctx, args[0]), result = scriptObject([]), work = { count: 0 }, schema = { positions: [] };
		const root = {
			children: /* @__PURE__ */ new Map(),
			end: false
		}, length = array.length;
		for (let i = 0; i < length; i++) {
			const value = ctx.properties.get(array, i, ctx.pos);
			const key = yield* readKey(ctx, yield ctx.call(fn, [
				value,
				i,
				array
			]), schema, work);
			let node = root;
			for (const part of Array.isArray(key) ? key : [key]) {
				let next = node.children.get(part);
				if (!next) {
					next = {
						children: /* @__PURE__ */ new Map(),
						end: false
					};
					node.children.set(part, next);
				}
				node = next;
				if (step(ctx, work)) yield ctx.checkpoint();
			}
			if (!node.end) {
				node.end = true;
				result.push(value);
			}
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return result;
	}),
	definition("sum", [], "number", "数を左から加算し、空配列では 0 を返します。", "Adds numbers from left to right, returning zero for an empty array.", function* (ctx, receiver) {
		const array = requireArray(ctx, receiver), work = { count: 0 };
		let total = 0;
		for (let i = 0; i < array.length; i++) {
			total += requireNumber(ctx, ctx.properties.get(array, i, ctx.pos));
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return total;
	}),
	...["minBy", "maxBy"].map((name) => definition(name, keyArg, "any", name === "minBy" ? "最小のキーを持つ最初の要素を返します。" : "最大のキーを持つ最初の要素を返します。", name === "minBy" ? "Returns the first element with the smallest key." : "Returns the first element with the largest key.", function* (ctx, receiver, args) {
		const array = requireArray(ctx, receiver), fn = callback(ctx, args[0]), schema = { positions: [] }, work = { count: 0 }, length = array.length;
		let result = null, best;
		for (let i = 0; i < length; i++) {
			const value = ctx.properties.get(array, i, ctx.pos), key = yield* readKey(ctx, yield ctx.call(fn, [
				value,
				i,
				array
			]), schema, work);
			const order = best === void 0 ? 0 : yield* compareKeys(ctx, key, best, work);
			if (best === void 0 || (name === "minBy" ? order < 0 : order > 0)) {
				result = value;
				best = key;
			}
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return result;
	})),
	definition("countBy", keyArg, "any", "キーを文字列にして、出現回数を原型のない辞書に数えます。", "Counts stringified keys in a prototype-free object.", function* (ctx, receiver, args) {
		const array = requireArray(ctx, receiver), fn = callback(ctx, args[0]), result = scriptObject(Object.create(null)), work = { count: 0 }, length = array.length;
		for (let i = 0; i < length; i++) {
			const key = yield ctx.call(fn, [
				ctx.properties.get(array, i, ctx.pos),
				i,
				array
			]);
			if (typeof key !== "number" && typeof key !== "string" && typeof key !== "boolean") throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "number | string | boolean" }, "TypeError");
			if (typeof key === "number" && Number.isNaN(key)) rangeError(ctx);
			if (key === "__proto__") throw runtimeError("STDLIB_FORBIDDEN_KEY", ctx.pos, {}, "TypeError");
			const name = ctx.properties.key(typeof key === "boolean" ? String(key) : key, ctx.pos);
			ctx.properties.set(result, name, (ctx.properties.get(result, name, ctx.pos) ?? 0) + 1, ctx.pos);
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return result;
	}),
	definition("shuffle", rngArg, "any[]", "元の配列を無作為に並べ替えて返します。", "Randomly shuffles the array in place and returns it.", function* (ctx, receiver, args) {
		const array = requireArray(ctx, receiver), rng = args[0] === void 0 ? void 0 : callback(ctx, args[0]), work = { count: 0 };
		for (let i = array.length - 1; i > 0; i--) {
			const j = Math.floor((yield* random(ctx, rng)) * (i + 1));
			const a = ctx.properties.get(array, i, ctx.pos), b = ctx.properties.get(array, j, ctx.pos);
			ctx.properties.set(array, i, b, ctx.pos);
			ctx.properties.set(array, j, a, ctx.pos);
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return array;
	}),
	definition("sample", rngArg, "any", "無作為に一要素を返し、空配列では null を返します。", "Returns a random element, or null for an empty array.", function* (ctx, receiver, args) {
		const array = requireArray(ctx, receiver), rng = args[0] === void 0 ? void 0 : callback(ctx, args[0]);
		if (array.length === 0) return null;
		return ctx.properties.get(array, Math.floor((yield* random(ctx, rng)) * array.length), ctx.pos);
	}),
	definition("sampleBy", [{
		name: "weight",
		type: "Function"
	}, ...rngArg], "any", "非負の重みに比例して一要素を選びます。", "Samples an element proportionally to its non-negative weight.", function* (ctx, receiver, args) {
		const array = requireArray(ctx, receiver), fn = callback(ctx, args[0]), rng = args[1] === void 0 ? void 0 : callback(ctx, args[1]), work = { count: 0 };
		const source = yield* copy(ctx, array, work);
		if (source.length === 0) return null;
		const weights = [];
		let maximum = 0;
		for (let i = 0; i < source.length; i++) {
			const weight = requireNumber(ctx, yield ctx.call(fn, [
				source[i],
				i,
				array
			]));
			if (!Number.isFinite(weight) || weight < 0) rangeError(ctx);
			weights.push(weight);
			maximum = Math.max(maximum, weight);
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		if (maximum === 0) rangeError(ctx);
		let total = 0;
		for (let i = 0; i < weights.length; i++) {
			weights[i] = weights[i] / maximum;
			total += weights[i];
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		let threshold = (yield* random(ctx, rng)) * total, last = 0;
		for (let i = 0; i < weights.length; i++) {
			const weight = weights[i];
			if (weight > 0) {
				last = i;
				if (threshold < weight) return source[i];
			}
			threshold -= weight;
			if (step(ctx, work)) yield ctx.checkpoint();
		}
		return source[last];
	})
];

//#endregion
export { collectionDefinitions };
//# sourceMappingURL=collections.js.map