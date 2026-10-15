import { isStdFunction } from "../stdlib/core.js";

//#region src/v2/runtime/brands.ts
const SCRIPT_FUNCTION = Symbol("script function");
function isScriptFunction(value) {
	return typeof value === "object" && value !== null && Object.getOwnPropertyDescriptor(value, SCRIPT_FUNCTION)?.value === true;
}
function valueTypeof(value) {
	return isScriptFunction(value) || isStdFunction(value) ? "function" : typeof value;
}
const scriptObjects = /* @__PURE__ */ new WeakSet();
/** 通常の辞書と配列の作成元だけを記録し、ホストへ渡した後も現在の原型を別に確かめます。 */
function scriptObject(value) {
	scriptObjects.add(value);
	return value;
}

//#endregion
export { SCRIPT_FUNCTION, isScriptFunction, scriptObject, scriptObjects, valueTypeof };
//# sourceMappingURL=brands.js.map