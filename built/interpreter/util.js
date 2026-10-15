import { __exportAll } from "../_virtual/_rolldown/runtime.js";
import { TonerikoScriptRuntimeError } from "../error.js";
import { ARR, BOOL, NULL, NUM, OBJ, STR } from "./value.js";

//#region src/interpreter/util.ts
var util_exports = /* @__PURE__ */ __exportAll({
	assertArray: () => assertArray,
	assertBoolean: () => assertBoolean,
	assertFunction: () => assertFunction,
	assertNull: () => assertNull,
	assertNumber: () => assertNumber,
	assertObject: () => assertObject,
	assertString: () => assertString,
	eq: () => eq,
	expectAny: () => expectAny,
	getLangVersion: () => getLangVersion,
	isArray: () => isArray,
	isBoolean: () => isBoolean,
	isFunction: () => isFunction,
	isNull: () => isNull,
	isNumber: () => isNumber,
	isObject: () => isObject,
	isString: () => isString,
	jsToVal: () => jsToVal,
	reprValue: () => reprValue,
	stringifyObjectKey: () => stringifyObjectKey,
	valToJs: () => valToJs,
	valToString: () => valToString
});
function expectAny(val) {
	if (val == null) throw new TonerikoScriptRuntimeError("Expect anything, but got nothing.");
}
function isBoolean(val) {
	return val.type === "bool";
}
function isFunction(val) {
	return val.type === "fn";
}
function isString(val) {
	return val.type === "str";
}
function isNumber(val) {
	return val.type === "num";
}
function isObject(val) {
	return val.type === "obj";
}
function isArray(val) {
	return val.type === "arr";
}
function isNull(val) {
	return val.type === "null";
}
function assertBoolean(val) {
	if (val == null) throw new TonerikoScriptRuntimeError("Expect boolean, but got nothing.");
	if (!isBoolean(val)) throw new TonerikoScriptRuntimeError(`Expect boolean, but got ${val.type}.`);
}
function assertFunction(val) {
	if (val == null) throw new TonerikoScriptRuntimeError("Expect function, but got nothing.");
	if (!isFunction(val)) throw new TonerikoScriptRuntimeError(`Expect function, but got ${val.type}.`);
}
function assertString(val) {
	if (val == null) throw new TonerikoScriptRuntimeError("Expect string, but got nothing.");
	if (!isString(val)) throw new TonerikoScriptRuntimeError(`Expect string, but got ${val.type}.`);
}
function assertNumber(val) {
	if (val == null) throw new TonerikoScriptRuntimeError("Expect number, but got nothing.");
	if (!isNumber(val)) throw new TonerikoScriptRuntimeError(`Expect number, but got ${val.type}.`);
}
function assertObject(val) {
	if (val == null) throw new TonerikoScriptRuntimeError("Expect object, but got nothing.");
	if (!isObject(val)) throw new TonerikoScriptRuntimeError(`Expect object, but got ${val.type}.`);
}
function assertArray(val) {
	if (val == null) throw new TonerikoScriptRuntimeError("Expect array, but got nothing.");
	if (!isArray(val)) throw new TonerikoScriptRuntimeError(`Expect array, but got ${val.type}.`);
}
function assertNull(val) {
	if (val == null) throw new TonerikoScriptRuntimeError("Expect null, but got nothing.");
	if (!isNull(val)) throw new TonerikoScriptRuntimeError(`Expect null, but got ${val.type}.`);
}
function eq(a, b) {
	if (a.type === "fn" && b.type === "fn") return a.native && b.native ? a.native === b.native : a === b;
	if (a.type === "fn" || b.type === "fn") return false;
	if (a.type === "null" && b.type === "null") return true;
	if (a.type === "null" || b.type === "null") return false;
	return a.value === b.value;
}
function valToString(val, simple = false, processingObjects = /* @__PURE__ */ new Set()) {
	if (simple) {
		if (val.type === "num") return val.value.toString();
		if (val.type === "bool") return val.value ? "true" : "false";
		if (val.type === "str") return JSON.stringify(val.value);
		if (val.type === "arr") {
			if (processingObjects.has(val.value)) return "...";
			processingObjects.add(val.value);
			const result = `[${Array.from({ length: val.value.length }, (_, index) => {
				const item = val.value[index];
				return valToString(item ?? NULL, true, processingObjects);
			}).join(", ")}]`;
			processingObjects.delete(val.value);
			return result;
		}
		if (val.type === "null") return "(null)";
	}
	switch (val.type) {
		case "num": return `num<${val.value}>`;
		case "bool": return `bool<${val.value}>`;
		case "str": return `str<${JSON.stringify(val.value)}>`;
		case "fn": return "fn<...>";
		case "arr": return "arr<...>";
		case "obj": return "obj<...>";
		case "error": return `error<${val.value}>`;
		case "null": return "null<>";
	}
}
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
function stringifyObjectKey(key) {
	return identifierPattern.test(key) ? key : JSON.stringify(key);
}
function defineJsProperty(target, key, value) {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true
	});
}
function valToJsInternal(val, converted) {
	switch (val.type) {
		case "fn": return "<function>";
		case "arr": {
			const existing = converted.get(val.value);
			if (existing !== void 0) return existing;
			const result = [];
			converted.set(val.value, result);
			result.length = val.value.length;
			for (let index = 0; index < val.value.length; index++) {
				const item = val.value[index];
				result[index] = item === void 0 ? null : valToJsInternal(item, converted);
			}
			return result;
		}
		case "bool": return val.value;
		case "null": return null;
		case "num": return val.value;
		case "obj": {
			const existing = converted.get(val.value);
			if (existing !== void 0) return existing;
			const result = {};
			converted.set(val.value, result);
			for (const [key, value] of val.value) defineJsProperty(result, key, valToJsInternal(value, converted));
			return result;
		}
		case "error": {
			const existing = converted.get(val);
			if (existing !== void 0) return existing;
			const result = {};
			converted.set(val, result);
			defineJsProperty(result, "name", val.value);
			defineJsProperty(result, "info", val.info == null ? null : valToJsInternal(val.info, converted));
			return result;
		}
		case "str": return val.value;
	}
}
function valToJs(val) {
	return valToJsInternal(val, /* @__PURE__ */ new Map());
}
function jsToValInternal(val, converted) {
	if (val === null) return NULL;
	if (typeof val === "boolean") return BOOL(val);
	if (typeof val === "string") return STR(val);
	if (typeof val === "number") return NUM(val);
	if (Array.isArray(val)) {
		const existing = converted.get(val);
		if (existing !== void 0) return existing;
		const result = ARR([]);
		converted.set(val, result);
		result.value.length = val.length;
		for (let index = 0; index < val.length; index++) result.value[index] = jsToValInternal(val[index], converted);
		return result;
	}
	if (typeof val === "object") {
		const existing = converted.get(val);
		if (existing !== void 0) return existing;
		const result = OBJ(/* @__PURE__ */ new Map());
		converted.set(val, result);
		for (const [k, v] of Object.entries(val)) result.value.set(k, jsToValInternal(v, converted));
		return result;
	}
	return NULL;
}
function jsToVal(val) {
	return jsToValInternal(val, /* @__PURE__ */ new WeakMap());
}
function getLangVersion(input) {
	const match = /^\s*\/\/\/\s*@\s*([A-Z0-9_.-]+)(?:[\r\n][\s\S]*)?$/i.exec(input);
	return match != null ? match[1] : null;
}
function reprValue(value, literalLike = false, processingObjects = /* @__PURE__ */ new Set()) {
	if ((value.type === "arr" || value.type === "obj") && processingObjects.has(value.value)) return "...";
	if (literalLike && value.type === "str") return JSON.stringify(value.value);
	if (value.type === "str") return value.value;
	if (value.type === "num") return value.value.toString();
	if (value.type === "arr") {
		processingObjects.add(value.value);
		const content = [];
		for (let index = 0; index < value.value.length; index++) content.push(reprValue(value.value[index] ?? NULL, true, processingObjects));
		processingObjects.delete(value.value);
		return "[ " + content.join(", ") + " ]";
	}
	if (value.type === "obj") {
		processingObjects.add(value.value);
		const content = [];
		for (const [key, val] of value.value) content.push(`${stringifyObjectKey(key)}: ${reprValue(val, true, processingObjects)}`);
		processingObjects.delete(value.value);
		return "{ " + content.join(", ") + " }";
	}
	if (value.type === "bool") return value.value.toString();
	if (value.type === "null") return "null";
	if (value.type === "error") return `error<${value.value}>`;
	if (value.type === "fn") {
		if (value.native) return "@( ?? ) { native code }";
		return `@( ${value.params.map((v) => v.dest.type === "identifier" ? v.dest.name : "?").join(", ")} ) { ... }`;
	}
	throw new TypeError("Unrecognized Toneriko Script value type.");
}

//#endregion
export { assertArray, assertBoolean, assertFunction, assertNull, assertNumber, assertObject, assertString, eq, expectAny, getLangVersion, isArray, isBoolean, isFunction, isNull, isNumber, isObject, isString, jsToVal, reprValue, stringifyObjectKey, util_exports, valToJs, valToString };
//# sourceMappingURL=util.js.map