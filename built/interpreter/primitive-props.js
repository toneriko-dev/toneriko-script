import { textEncoder } from "../const.js";
import { MAX_ARRAY_FLAT_DEPTH, MAX_NATIVE_VALUE_SIZE } from "../constants.js";
import { TonerikoScriptRuntimeError } from "../error.js";
import { ARR, FALSE, FN_NATIVE, NULL, NUM, STR, TRUE } from "./value.js";
import { assertArray, assertBoolean, assertFunction, assertNumber, assertString, eq, expectAny, isArray } from "./util.js";
import { indexOf, length, substring, toArray } from "../utils/graphemes.js";

//#region src/interpreter/primitive-props.ts
/**
* Array.prototype.slice(start)と同じ規則でstartを非負のインデックスにクランプする
* (負数は末尾からのオフセット、範囲外は境界に丸める)。配列をコピーせずに済む。
*/
function clampSliceStart(index, length) {
	const i = Number.isNaN(index) ? 0 : Math.trunc(index);
	return i < 0 ? Math.max(length + i, 0) : Math.min(i, length);
}
const PRIMITIVE_PROPS = {
	num: {
		to_str: (target) => FN_NATIVE((_, _opts) => {
			return STR(target.value.toString());
		}),
		to_hex: (target) => FN_NATIVE((_, _opts) => {
			if (!Number.isFinite(target.value)) throw new TonerikoScriptRuntimeError("num.to_hex cannot convert a non-finite number");
			return STR(target.value.toString(16));
		})
	},
	str: {
		to_num: (target) => FN_NATIVE((_, _opts) => {
			const parsed = parseInt(target.value, 10);
			if (isNaN(parsed)) return NULL;
			return NUM(parsed);
		}),
		to_arr: (target) => FN_NATIVE((_, _opts) => {
			return ARR(toArray(target.value).map((s) => STR(s)));
		}),
		to_unicode_arr: (target) => FN_NATIVE((_, _opts) => {
			return ARR([...target.value].map((s) => STR(s)));
		}),
		to_unicode_codepoint_arr: (target) => FN_NATIVE((_, _opts) => {
			return ARR([...target.value].map((s) => {
				const res = s.codePointAt(0);
				return NUM(res ?? s.charCodeAt(0));
			}));
		}),
		to_char_arr: (target) => FN_NATIVE((_, _opts) => {
			return ARR(target.value.split("").map((s) => STR(s)));
		}),
		to_charcode_arr: (target) => FN_NATIVE((_, _opts) => {
			return ARR(target.value.split("").map((s) => NUM(s.charCodeAt(0))));
		}),
		to_utf8_byte_arr: (target) => FN_NATIVE((_, _opts) => {
			return ARR(Array.from(textEncoder.encode(target.value)).map((s) => NUM(s)));
		}),
		len: (target) => NUM(length(target.value)),
		replace: (target) => FN_NATIVE(([a, b], _opts) => {
			assertString(a);
			assertString(b);
			return STR(target.value.split(a.value).join(b.value));
		}),
		index_of: (target) => FN_NATIVE(([search, fromI], _opts) => {
			assertString(search);
			if (fromI) assertNumber(fromI);
			const pos = fromI ? fromI.value < 0 ? length(target.value) + fromI.value : fromI.value : void 0;
			return NUM(indexOf(target.value, search.value, pos));
		}),
		incl: (target) => FN_NATIVE(([search], _opts) => {
			assertString(search);
			return target.value.includes(search.value) ? TRUE : FALSE;
		}),
		trim: (target) => FN_NATIVE((_, _opts) => {
			return STR(target.value.trim());
		}),
		upper: (target) => FN_NATIVE((_, _opts) => {
			return STR(target.value.toUpperCase());
		}),
		lower: (target) => FN_NATIVE((_, _opts) => {
			return STR(target.value.toLowerCase());
		}),
		split: (target) => FN_NATIVE(([splitter], _opts) => {
			if (splitter) assertString(splitter);
			if (splitter) return ARR(target.value.split(splitter ? splitter.value : "").map((s) => STR(s)));
			return ARR(toArray(target.value).map((s) => STR(s)));
		}),
		slice: (target) => FN_NATIVE(([begin, end], _opts) => {
			assertNumber(begin);
			assertNumber(end);
			return STR(substring(target.value, begin.value, end.value));
		}),
		pick: (target) => FN_NATIVE(([i], _opts) => {
			assertNumber(i);
			const char = toArray(target.value)[i.value];
			return char ? STR(char) : NULL;
		}),
		charcode_at: (target) => FN_NATIVE(([i], _) => {
			assertNumber(i);
			const res = target.value.charCodeAt(i.value);
			return Number.isNaN(res) ? NULL : NUM(res);
		}),
		codepoint_at: (target) => FN_NATIVE(([i], _) => {
			assertNumber(i);
			const res = target.value.codePointAt(i.value) ?? target.value.charCodeAt(i.value);
			return Number.isNaN(res) ? NULL : NUM(res);
		}),
		starts_with: (target) => FN_NATIVE(([prefix, start_index], _opts) => {
			assertString(prefix);
			if (!prefix.value) return TRUE;
			if (start_index) assertNumber(start_index);
			const raw_index = start_index?.value ?? 0;
			if (raw_index < -target.value.length || raw_index > target.value.length) return FALSE;
			const index = raw_index >= 0 ? raw_index : target.value.length + raw_index;
			return target.value.startsWith(prefix.value, index) ? TRUE : FALSE;
		}),
		ends_with: (target) => FN_NATIVE(([suffix, end_index], _opts) => {
			assertString(suffix);
			if (!suffix.value) return TRUE;
			if (end_index) assertNumber(end_index);
			const raw_index = end_index?.value ?? target.value.length;
			if (raw_index < -target.value.length || raw_index > target.value.length) return FALSE;
			const index = raw_index >= 0 ? raw_index : target.value.length + raw_index;
			return target.value.endsWith(suffix.value, index) ? TRUE : FALSE;
		}),
		pad_start: (target) => FN_NATIVE(([width, pad], _) => {
			assertNumber(width);
			const s = pad ? (assertString(pad), pad.value) : " ";
			if (width.value > 1e6) throw new TonerikoScriptRuntimeError(`str.pad_start width must not exceed ${MAX_NATIVE_VALUE_SIZE}`);
			return STR(target.value.padStart(width.value, s));
		}),
		pad_end: (target) => FN_NATIVE(([width, pad], _) => {
			assertNumber(width);
			const s = pad ? (assertString(pad), pad.value) : " ";
			if (width.value > 1e6) throw new TonerikoScriptRuntimeError(`str.pad_end width must not exceed ${MAX_NATIVE_VALUE_SIZE}`);
			return STR(target.value.padEnd(width.value, s));
		})
	},
	arr: {
		len: (target) => NUM(target.value.length),
		push: (target) => FN_NATIVE(([val], _opts) => {
			expectAny(val);
			target.value.push(val);
			return target;
		}),
		unshift: (target) => FN_NATIVE(([val], _opts) => {
			expectAny(val);
			target.value.unshift(val);
			return target;
		}),
		pop: (target) => FN_NATIVE((_, _opts) => {
			return target.value.pop() ?? NULL;
		}),
		shift: (target) => FN_NATIVE((_, _opts) => {
			return target.value.shift() ?? NULL;
		}),
		concat: (target) => FN_NATIVE(([x], _opts) => {
			assertArray(x);
			return ARR(target.value.concat(x.value));
		}),
		slice: (target) => FN_NATIVE(([begin, end], _opts) => {
			assertNumber(begin);
			assertNumber(end);
			return ARR(target.value.slice(begin.value, end.value));
		}),
		join: (target) => FN_NATIVE(([joiner], _opts) => {
			if (joiner) assertString(joiner);
			return STR(target.value.map((i) => i.type === "str" ? i.value : "").join(joiner ? joiner.value : ""));
		}),
		map: (target) => FN_NATIVE(async ([fn], opts) => {
			assertFunction(fn);
			const vals = target.value.map(async (item, i) => {
				return await opts.call(fn, [item, NUM(i)]);
			});
			return ARR(await Promise.all(vals));
		}, ([fn], opts) => {
			assertFunction(fn);
			const vals = target.value.map((item, i) => {
				return opts.call(fn, [item, NUM(i)]);
			});
			return ARR(vals);
		}),
		filter: (target) => FN_NATIVE(async ([fn], opts) => {
			assertFunction(fn);
			const vals = [];
			for (let i = 0; i < target.value.length; i++) {
				const item = target.value[i];
				const res = await opts.call(fn, [item, NUM(i)]);
				assertBoolean(res);
				if (res.value) vals.push(item);
			}
			return ARR(vals);
		}, ([fn], opts) => {
			assertFunction(fn);
			const vals = [];
			for (let i = 0; i < target.value.length; i++) {
				const item = target.value[i];
				const res = opts.call(fn, [item, NUM(i)]);
				assertBoolean(res);
				if (res.value) vals.push(item);
			}
			return ARR(vals);
		}),
		reduce: (target) => FN_NATIVE(async ([fn, initialValue], opts) => {
			assertFunction(fn);
			const withInitialValue = initialValue != null;
			if (!withInitialValue && target.value.length === 0) throw new TonerikoScriptRuntimeError("Reduce of empty array without initial value");
			let accumulator = withInitialValue ? initialValue : target.value[0];
			for (let i = withInitialValue ? 0 : 1; i < target.value.length; i++) {
				const item = target.value[i];
				accumulator = await opts.call(fn, [
					accumulator,
					item,
					NUM(i)
				]);
			}
			return accumulator;
		}, ([fn, initialValue], opts) => {
			assertFunction(fn);
			const withInitialValue = initialValue != null;
			if (!withInitialValue && target.value.length === 0) throw new TonerikoScriptRuntimeError("Reduce of empty array without initial value");
			let accumulator = withInitialValue ? initialValue : target.value[0];
			for (let i = withInitialValue ? 0 : 1; i < target.value.length; i++) {
				const item = target.value[i];
				accumulator = opts.call(fn, [
					accumulator,
					item,
					NUM(i)
				]);
			}
			return accumulator;
		}),
		find: (target) => FN_NATIVE(async ([fn], opts) => {
			assertFunction(fn);
			for (let i = 0; i < target.value.length; i++) {
				const item = target.value[i];
				const res = await opts.call(fn, [item, NUM(i)]);
				assertBoolean(res);
				if (res.value) return item;
			}
			return NULL;
		}, ([fn], opts) => {
			assertFunction(fn);
			for (let i = 0; i < target.value.length; i++) {
				const item = target.value[i];
				const res = opts.call(fn, [item, NUM(i)]);
				assertBoolean(res);
				if (res.value) return item;
			}
			return NULL;
		}),
		incl: (target) => FN_NATIVE(([val], _opts) => {
			expectAny(val);
			return target.value.some((item) => eq(val, item)) ? TRUE : FALSE;
		}),
		index_of: (target) => FN_NATIVE(([val, fromI], _opts) => {
			expectAny(val);
			let start = 0;
			if (fromI) {
				assertNumber(fromI);
				start = clampSliceStart(fromI.value, target.value.length);
			}
			for (let i = start; i < target.value.length; i++) if (eq(target.value[i], val)) return NUM(i);
			return NUM(-1);
		}),
		reverse: (target) => FN_NATIVE((_, _opts) => {
			target.value.reverse();
			return NULL;
		}),
		copy: (target) => FN_NATIVE((_, _opts) => {
			return ARR([...target.value]);
		}),
		sort: (target) => FN_NATIVE(async ([comp], opts) => {
			const mergeSort = async (arr, comp) => {
				if (arr.length <= 1) return arr;
				const mid = Math.floor(arr.length / 2);
				const left_promise = mergeSort(arr.slice(0, mid), comp);
				const right_promise = mergeSort(arr.slice(mid), comp);
				const [left, right] = await Promise.all([left_promise, right_promise]);
				return merge(left, right, comp);
			};
			const merge = async (left, right, comp) => {
				const result = [];
				let leftIndex = 0;
				let rightIndex = 0;
				while (leftIndex < left.length && rightIndex < right.length) {
					const l = left[leftIndex];
					const r = right[rightIndex];
					const compValue = await opts.call(comp, [l, r]);
					assertNumber(compValue);
					if (compValue.value <= 0) {
						result.push(left[leftIndex]);
						leftIndex++;
					} else {
						result.push(right[rightIndex]);
						rightIndex++;
					}
				}
				return result.concat(left.slice(leftIndex)).concat(right.slice(rightIndex));
			};
			assertFunction(comp);
			assertArray(target);
			target.value = await mergeSort(target.value, comp);
			return target;
		}, ([comp], opts) => {
			const mergeSort = (arr, comp) => {
				if (arr.length <= 1) return arr;
				const mid = Math.floor(arr.length / 2);
				const left = mergeSort(arr.slice(0, mid), comp);
				const right = mergeSort(arr.slice(mid), comp);
				return merge(left, right, comp);
			};
			const merge = (left, right, comp) => {
				const result = [];
				let leftIndex = 0;
				let rightIndex = 0;
				while (leftIndex < left.length && rightIndex < right.length) {
					const l = left[leftIndex];
					const r = right[rightIndex];
					const compValue = opts.call(comp, [l, r]);
					assertNumber(compValue);
					if (compValue.value <= 0) {
						result.push(left[leftIndex]);
						leftIndex++;
					} else {
						result.push(right[rightIndex]);
						rightIndex++;
					}
				}
				return result.concat(left.slice(leftIndex)).concat(right.slice(rightIndex));
			};
			assertFunction(comp);
			assertArray(target);
			target.value = mergeSort(target.value, comp);
			return target;
		}),
		fill: (target) => FN_NATIVE(([val, st, ed], opts) => {
			const value = val ?? NULL;
			const start = st && (assertNumber(st), st.value);
			const end = ed && (assertNumber(ed), ed.value);
			target.value.fill(value, start, end);
			return target;
		}),
		repeat: (target) => FN_NATIVE(([times], opts) => {
			assertNumber(times);
			if (times.value < 0) throw new TonerikoScriptRuntimeError("arr.repeat expected non-negative number, got negative");
			if (!Number.isInteger(times.value)) throw new TonerikoScriptRuntimeError("arr.repeat expected integer, got non-integer");
			if (target.value.length === 0) return ARR([]);
			if (target.value.length * times.value > 1e6) throw new TonerikoScriptRuntimeError(`arr.repeat size must not exceed ${MAX_NATIVE_VALUE_SIZE}`);
			return ARR(Array(times.value).fill(target.value).flat());
		}),
		splice: (target) => FN_NATIVE(([idx, rc, vs], opts) => {
			assertNumber(idx);
			const index = idx.value < -target.value.length ? 0 : idx.value < 0 ? target.value.length + idx.value : idx.value >= target.value.length ? target.value.length : idx.value;
			const remove_count = rc != null ? (assertNumber(rc), rc.value) : target.value.length - index;
			const items = vs != null ? (assertArray(vs), vs.value) : [];
			const result = target.value.splice(index, remove_count, ...items);
			return ARR(result);
		}),
		flat: (target) => FN_NATIVE(([depth], opts) => {
			depth = depth ?? NUM(1);
			assertNumber(depth);
			if (!Number.isInteger(depth.value)) throw new TonerikoScriptRuntimeError("arr.flat expected integer, got non-integer");
			if (depth.value < 0) throw new TonerikoScriptRuntimeError("arr.flat expected non-negative number, got negative");
			if (depth.value > 100) throw new TonerikoScriptRuntimeError(`arr.flat depth must not exceed ${100}`);
			const flat = (arr, depth, result) => {
				if (depth === 0) {
					if (result.length + arr.length > 1e6) throw new TonerikoScriptRuntimeError(`arr.flat size must not exceed ${MAX_NATIVE_VALUE_SIZE}`);
					result.push(...arr);
					return;
				}
				for (const v of arr) if (isArray(v)) flat(v.value, depth - 1, result);
				else {
					if (result.length >= 1e6) throw new TonerikoScriptRuntimeError(`arr.flat size must not exceed ${MAX_NATIVE_VALUE_SIZE}`);
					result.push(v);
				}
			};
			const result = [];
			flat(target.value, depth.value, result);
			return ARR(result);
		}),
		flat_map: (target) => FN_NATIVE(async ([fn], opts) => {
			assertFunction(fn);
			const vals = target.value.map(async (item, i) => {
				const result = await opts.call(fn, [item, NUM(i)]);
				return isArray(result) ? result.value : result;
			});
			const mapped_vals = await Promise.all(vals);
			return ARR(mapped_vals.flat());
		}, ([fn], opts) => {
			assertFunction(fn);
			const mapped_vals = target.value.map((item, i) => {
				const result = opts.call(fn, [item, NUM(i)]);
				return isArray(result) ? result.value : result;
			});
			return ARR(mapped_vals.flat());
		}),
		every: (target) => FN_NATIVE(async ([fn], opts) => {
			assertFunction(fn);
			for (let i = 0; i < target.value.length; i++) {
				const item = target.value[i];
				const res = await opts.call(fn, [item, NUM(i)]);
				assertBoolean(res);
				if (!res.value) return FALSE;
			}
			return TRUE;
		}, ([fn], opts) => {
			assertFunction(fn);
			for (let i = 0; i < target.value.length; i++) {
				const item = target.value[i];
				const res = opts.call(fn, [item, NUM(i)]);
				assertBoolean(res);
				if (!res.value) return FALSE;
			}
			return TRUE;
		}),
		some: (target) => FN_NATIVE(async ([fn], opts) => {
			assertFunction(fn);
			for (let i = 0; i < target.value.length; i++) {
				const item = target.value[i];
				const res = await opts.call(fn, [item, NUM(i)]);
				assertBoolean(res);
				if (res.value) return TRUE;
			}
			return FALSE;
		}, ([fn], opts) => {
			assertFunction(fn);
			for (let i = 0; i < target.value.length; i++) {
				const item = target.value[i];
				const res = opts.call(fn, [item, NUM(i)]);
				assertBoolean(res);
				if (res.value) return TRUE;
			}
			return FALSE;
		}),
		insert: (target) => FN_NATIVE(([index, item], opts) => {
			assertNumber(index);
			expectAny(item);
			target.value.splice(index.value, 0, item);
			return NULL;
		}),
		remove: (target) => FN_NATIVE(([index], opts) => {
			assertNumber(index);
			return target.value.splice(index.value, 1)[0] ?? NULL;
		}),
		at: (target) => FN_NATIVE(([index, otherwise], opts) => {
			assertNumber(index);
			return target.value.at(index.value) ?? otherwise ?? NULL;
		})
	},
	error: {
		name: (target) => STR(target.value),
		info: (target) => target.info ?? NULL
	}
};
function getPrimProp(target, name) {
	if (Object.hasOwn(PRIMITIVE_PROPS, target.type)) {
		const props = PRIMITIVE_PROPS[target.type];
		if (Object.hasOwn(props, name)) return props[name](target);
		throw new TonerikoScriptRuntimeError(`No such prop (${name}) in ${target.type}.`);
	} else throw new TonerikoScriptRuntimeError(`Cannot read prop of ${target.type}. (reading ${name})`);
}

//#endregion
export { getPrimProp };
//# sourceMappingURL=primitive-props.js.map