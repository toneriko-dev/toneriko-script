import { diagnosticTranslation } from "../messages.js";

//#region src/v2/runtime/errors.ts
var RuntimeError = class extends Error {
	code;
	pos;
	params;
	severity = "error";
	hint;
	constructor(code, pos, params = {}, name = "TonerikoScriptRuntimeError") {
		const text = diagnosticTranslation(code, "ja", params);
		const replace = (s) => s.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? key));
		super(replace(text.message) + (code === "TYPE_ANNOTATION_MISMATCH" ? ` (${pos.line} 行目、${pos.column} 列目)` : ""));
		this.code = code;
		this.pos = pos;
		this.params = params;
		this.pos = {
			line: pos.line,
			column: pos.column
		};
		this.name = name;
		this.hint = replace(text.hint);
	}
};
function runtimeError(code, pos, params = {}, name) {
	return new RuntimeError(code, pos, params, name);
}
var ExecutionStopped = class extends RuntimeError {};
const scriptErrorKinds = /* @__PURE__ */ new WeakMap();
function scriptErrorDiagnostic(value) {
	return value !== null && typeof value === "object" ? scriptErrorKinds.get(value)?.diagnostic : void 0;
}
function isScriptErrorValue(value) {
	return value !== null && typeof value === "object" && scriptErrorKinds.has(value);
}
function scriptErrorName(value) {
	return scriptErrorKinds.get(value).name;
}
/** 原型の代わりに種類だけを保持し、message の省略と own property の列挙規則を保つ。 */
function createScriptError(name = "Error", message, diagnostic) {
	const result = Object.create(null);
	scriptErrorKinds.set(result, {
		name,
		diagnostic
	});
	const define = (key, value) => Object.defineProperty(result, key, {
		value,
		writable: true,
		configurable: true,
		enumerable: false
	});
	if (message !== void 0) define("message", message);
	if (diagnostic) {
		define("code", diagnostic.code);
		define("pos", {
			line: diagnostic.pos.line,
			column: diagnostic.pos.column
		});
	}
	return result;
}

//#endregion
export { ExecutionStopped, RuntimeError, createScriptError, isScriptErrorValue, runtimeError, scriptErrorDiagnostic, scriptErrorName };
//# sourceMappingURL=errors.js.map