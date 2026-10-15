import { isScriptErrorValue, runtimeError, scriptErrorName } from "./errors.js";
import { isStdFunction } from "../stdlib/core.js";
import { SCRIPT_FUNCTION, isScriptFunction, scriptObject, scriptObjects, valueTypeof } from "./brands.js";
import { isArrayIterator, nextArrayIterator } from "../stdlib/arrays.js";
import { standardMethod } from "../stdlib/index.js";
import { GraphemeCache } from "./strings.js";

//#region src/v2/runtime/values.ts
function indexOf(key) {
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === key ? index : null;
}
function opaqueFunction(value) {
	return typeof value === "function" || isScriptFunction(value) || isStdFunction(value);
}
const domExceptionPrototype = typeof DOMException === "undefined" ? void 0 : DOMException.prototype;
const domExceptionName = domExceptionPrototype && Object.getOwnPropertyDescriptor(domExceptionPrototype, "name")?.get;
const hiddenErrorKeys = [
	"stack",
	"sourceURL",
	"line",
	"column",
	"originalLine",
	"originalColumn",
	"fileName",
	"lineNumber",
	"columnNumber"
];
const errorConstructorNames = /* @__PURE__ */ new Set([
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"EvalError",
	"URIError",
	"AggregateError",
	"DOMException"
]);
const errorPrototypes = /* @__PURE__ */ new Set([
	Error.prototype,
	TypeError.prototype,
	RangeError.prototype,
	ReferenceError.prototype,
	SyntaxError.prototype,
	EvalError.prototype,
	URIError.prototype,
	AggregateError.prototype
]);
function errorValue(value, pos = {
	line: 1,
	column: 1
}) {
	return classifyError(value, pos, "detached");
}
/** 隠すキーでは、原型を外された DOMException のブランドも確かめます。 */
function propertyError(value, key, pos) {
	return classifyError(value, pos, hiddenErrorKeys.includes(key) ? "all" : false);
}
/** 原型は毎回確かめ、利用者の toStringTag の getter は呼びません。 */
function classifyError(value, pos, domProbe) {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype === null && scriptObjects.has(value)) return false;
	if (isScriptErrorValue(value)) return true;
	let tag = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag);
	let object = prototype;
	let local = false;
	while (object) {
		if (errorPrototypes.has(object) || object === domExceptionPrototype) return true;
		tag ??= Object.getOwnPropertyDescriptor(object, Symbol.toStringTag);
		if (object === Object.prototype) {
			local = true;
			break;
		}
		object = Object.getPrototypeOf(object);
	}
	const brand = tag ? void 0 : Object.prototype.toString.call(value);
	if (brand === "[object Error]" || brand === "[object DOMException]") return true;
	if (domExceptionName && (domProbe === "all" || prototype === null && (domProbe === "detached" || tag))) try {
		Reflect.apply(domExceptionName, value, []);
		return true;
	} catch {}
	if (!local && prototype !== null) {
		object = prototype;
		while (object) {
			const constructor = Object.getOwnPropertyDescriptor(object, "constructor");
			if (constructor && "value" in constructor && typeof constructor.value === "function") {
				const name = Object.getOwnPropertyDescriptor(constructor.value, "name")?.value;
				if (!errorConstructorNames.has(name)) {
					object = Object.getPrototypeOf(object);
					continue;
				}
				const source = Function.prototype.toString.call(constructor.value);
				if (/^function\s+(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError|AggregateError|DOMException)\s*\(\s*\)\s*\{\s*\[native code\]\s*\}$/.test(source)) return true;
			}
			object = Object.getPrototypeOf(object);
		}
	}
	if (tag) {
		if ("value" in tag && (tag.value === "Error" || tag.value === "DOMException")) return true;
		if (Object.hasOwn(value, "stack") || Object.hasOwn(value, "message")) throw runtimeError("UNSUPPORTED_VALUE", pos, {}, "TypeError");
		return false;
	}
	return false;
}
function hiddenErrorKey(value, key) {
	return isScriptErrorValue(value) ? key === "stack" : hiddenErrorKeys.includes(key);
}
function registeredMethod(type, key, pos) {
	const method = standardMethod(type, key);
	if (method) return method;
	if (Object.hasOwn(type === "array" ? Array.prototype : type === "string" ? String.prototype : Number.prototype, key)) throw runtimeError("METHOD_NOT_AVAILABLE", pos, { key });
	return null;
}
/** getter の許可は値のタグではなく、この realm の組み込み原型の同一性で決める。 */
function inheritedErrorDescriptor(value, key) {
	let owner = Object.getPrototypeOf(value);
	while (owner) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor) {
			if (key === "name" || key === "message" || key === "code" && owner === domExceptionPrototype) return {
				owner,
				descriptor
			};
			return;
		}
		owner = Object.getPrototypeOf(owner);
	}
}
/** プロパティ操作は原型を参照せず、書記素のキャッシュを実行単位で共有する。 */
var PropertyAccess = class {
	onStep;
	strings;
	errorValue(value, pos) {
		return errorValue(value, pos);
	}
	constructor(onStep = () => {}) {
		this.onStep = onStep;
		this.strings = new GraphemeCache(onStep);
	}
	clear() {
		this.strings.clear();
	}
	normalize(value, pos) {
		if (value === void 0) return null;
		if (typeof value === "symbol" || typeof value === "bigint") throw runtimeError("UNSUPPORTED_VALUE", pos, {}, "TypeError");
		errorValue(value, pos);
		return value;
	}
	key(value, pos) {
		if (typeof value !== "string" && typeof value !== "number") throw runtimeError("INVALID_PROPERTY_KEY", pos, {}, "TypeError");
		const key = String(value);
		if (key === "__proto__") throw runtimeError("FORBIDDEN_PROPERTY", pos, { key });
		return key;
	}
	stringInfo(value) {
		return this.strings.info(value);
	}
	/** 64 要素以下の区間で制御を返し、評価器が時間の上限と譲る時刻を確認できるようにする。 */
	*prepare(value, pos, parts = false) {
		if (typeof value === "string") {
			if (parts) yield* this.strings.prepareParts(value);
			else yield* this.strings.prepare(value);
		}
	}
	*prepareSearch(value) {
		return yield* this.strings.prepareSearch(value);
	}
	concat(left, right) {
		return this.strings.concat(left, right);
	}
	graphemes(value) {
		return this.strings.graphemes(value);
	}
	get(value, property, pos) {
		const key = this.key(property, pos);
		if (value === null || value === void 0) throw runtimeError("NULL_PROPERTY_ACCESS", pos, { key }, "TypeError");
		if (typeof value === "string") {
			const info = this.stringInfo(value);
			if (key === "length") return info.length;
			const index = indexOf(key);
			if (index !== null) return this.strings.at(value, index) ?? null;
			return registeredMethod("string", key, pos);
		}
		if (typeof value === "number") return registeredMethod("number", key, pos);
		if (isStdFunction(value)) {
			const own = Object.getOwnPropertyDescriptor(value, key);
			if (own && "value" in own) return this.normalize(own.value, pos);
			throw runtimeError("UNSUPPORTED_VALUE", pos, { key }, "TypeError");
		}
		if (Array.isArray(value)) {
			const index = indexOf(key);
			const own = Object.hasOwn(value, key);
			if (!own && index === null && (typeof property === "number" || String(Number(key)) === key)) throw runtimeError("ARRAY_INDEX_OUT_OF_RANGE", pos, {}, "RangeError");
			if (index !== null && index >= value.length) throw runtimeError("ARRAY_INDEX_OUT_OF_RANGE", pos, { index }, "RangeError");
			if (index !== null && !own) throw runtimeError("SPARSE_ARRAY", pos);
			if (!own && key !== "length" && index === null) return registeredMethod("array", key, pos);
		}
		if (opaqueFunction(value)) throw runtimeError("UNSUPPORTED_VALUE", pos, { key }, "TypeError");
		const error = propertyError(value, key, pos);
		if (error && hiddenErrorKey(value, key)) return null;
		const own = Object.getOwnPropertyDescriptor(Object(value), key);
		if (own) {
			if ("value" in own) return this.normalize(own.value, pos);
			throw runtimeError("ACCESSOR_PROPERTY", pos, { key }, "TypeError");
		}
		if (error) {
			if (isScriptErrorValue(value) && (key === "name" || key === "message")) return key === "name" ? scriptErrorName(value) : "";
			const inherited = inheritedErrorDescriptor(value, key);
			if (inherited) {
				const { owner, descriptor } = inherited;
				if ("value" in descriptor) return this.normalize(descriptor.value, pos);
				if (owner !== domExceptionPrototype) throw runtimeError("ACCESSOR_PROPERTY", pos, { key }, "TypeError");
				return this.normalize(descriptor.get?.call(value), pos);
			}
		}
		return null;
	}
	set(value, property, next, pos) {
		const key = this.key(property, pos);
		if (value === null || value === void 0) throw runtimeError("NULL_PROPERTY_ACCESS", pos, { key }, "TypeError");
		if (opaqueFunction(value)) throw runtimeError("UNSUPPORTED_VALUE", pos, { key }, "TypeError");
		if (typeof value !== "object" || propertyError(value, key, pos) && hiddenErrorKey(value, key)) throw runtimeError("READONLY_PROPERTY", pos, { key }, "TypeError");
		const normalized = this.normalize(next, pos);
		if (Array.isArray(value)) {
			if (key === "length") {
				if (typeof normalized !== "number" || !Number.isInteger(normalized) || normalized < 0 || normalized > 4294967295) throw runtimeError("INVALID_ARRAY_LENGTH", pos, {}, "RangeError");
				if (normalized > value.length) throw runtimeError("ARRAY_LENGTH_GROWTH", pos);
			} else {
				const index = indexOf(key);
				if (index !== null && index > value.length) throw runtimeError("ARRAY_GAP", pos, { index });
			}
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && !("value" in descriptor)) throw runtimeError("ACCESSOR_PROPERTY", pos, { key }, "TypeError");
		if (descriptor?.writable === false) throw runtimeError("READONLY_PROPERTY", pos, { key }, "TypeError");
		const arrayIndex = Array.isArray(value) ? indexOf(key) : null;
		if (arrayIndex !== null && descriptor) {
			value[arrayIndex] = normalized;
			return normalized;
		}
		if (!descriptor) {
			let prototype = Object.getPrototypeOf(value);
			while (prototype) {
				const inherited = Object.getOwnPropertyDescriptor(prototype, key);
				if (inherited) {
					if (!("value" in inherited)) throw runtimeError("ACCESSOR_PROPERTY", pos, { key }, "TypeError");
					if (!inherited.writable) throw runtimeError("READONLY_PROPERTY", pos, { key }, "TypeError");
					break;
				}
				prototype = Object.getPrototypeOf(prototype);
			}
		}
		if (!Reflect.defineProperty(value, key, descriptor ? { value: normalized } : {
			value: normalized,
			writable: true,
			enumerable: true,
			configurable: true
		})) throw runtimeError("READONLY_PROPERTY", pos, { key }, "TypeError");
		return normalized;
	}
	has(value, property, pos) {
		const key = this.key(property, pos);
		if (value === null || typeof value !== "object" && typeof value !== "function") throw runtimeError("INVALID_RECEIVER", pos, {}, "TypeError");
		if (opaqueFunction(value)) throw runtimeError("UNSUPPORTED_VALUE", pos, { key }, "TypeError");
		if (Array.isArray(value) && !Object.hasOwn(value, key)) return registeredMethod("array", key, pos) !== null;
		if (propertyError(value, key, pos)) {
			if (hiddenErrorKey(value, key)) return false;
			if (isScriptErrorValue(value) && (key === "name" || key === "message")) return true;
			return Object.getOwnPropertyDescriptor(value, key) !== void 0 || inheritedErrorDescriptor(value, key) !== void 0;
		}
		return Object.hasOwn(value, key);
	}
	delete(value, property, pos) {
		const key = this.key(property, pos);
		if (value === null || value === void 0) throw runtimeError("NULL_PROPERTY_ACCESS", pos, { key }, "TypeError");
		if (opaqueFunction(value)) throw runtimeError("UNSUPPORTED_VALUE", pos, { key }, "TypeError");
		if (propertyError(value, key, pos) && hiddenErrorKey(value, key)) return true;
		if (Array.isArray(value) && (indexOf(key) !== null || key === "length")) throw runtimeError("ARRAY_DELETE", pos);
		if (typeof value === "string" && (indexOf(key) !== null || key === "length")) throw runtimeError("READONLY_PROPERTY", pos, { key }, "TypeError");
		if (!Reflect.deleteProperty(Object(value), key)) throw runtimeError("READONLY_PROPERTY", pos, { key }, "TypeError");
		return true;
	}
	entries(value, pos) {
		return [...this.entriesIterator(value, pos)];
	}
	*entriesIterator(value, pos) {
		if (value === null || value === void 0) return;
		if (typeof value === "string") {
			const units = this.strings.units(value);
			for (let i = 0; i < units.length; i++) {
				this.onStep();
				yield [String(i), units[i]];
			}
			return;
		}
		if (opaqueFunction(value)) throw runtimeError("UNSUPPORTED_VALUE", pos, {}, "TypeError");
		errorValue(value, pos);
		for (const key of Object.keys(Object(value))) {
			this.onStep();
			if (hiddenErrorKeys.includes(key) && propertyError(value, key, pos) && hiddenErrorKey(value, key)) continue;
			this.key(key, pos);
			yield [key, this.get(value, key, pos)];
		}
	}
	iterable(value, pos) {
		return [...this.iterableIterator(value, pos)];
	}
	iterableIterator(value, pos) {
		if (typeof value !== "string" && !Array.isArray(value) && !isArrayIterator(value)) throw runtimeError("NOT_ITERABLE", pos, {}, "TypeError");
		return this.iterate(value, pos);
	}
	*iterate(value, pos) {
		if (isArrayIterator(value)) while (true) {
			this.onStep();
			const item = nextArrayIterator(value, this, pos);
			if (item.done) return;
			yield item.value;
		}
		if (typeof value === "string") {
			const units = this.strings.units(value);
			for (let i = 0; i < units.length; i++) {
				this.onStep();
				yield units[i];
			}
			return;
		}
		if (!Array.isArray(value)) throw runtimeError("NOT_ITERABLE", pos, {}, "TypeError");
		for (let i = 0; i < value.length; i++) {
			this.onStep();
			yield this.get(value, i, pos);
		}
	}
};

//#endregion
export { PropertyAccess, SCRIPT_FUNCTION, errorValue, isScriptFunction, scriptObject, valueTypeof };
//# sourceMappingURL=values.js.map