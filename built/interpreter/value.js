import { __exportAll } from "../_virtual/_rolldown/runtime.js";

//#region src/interpreter/value.ts
var value_exports = /* @__PURE__ */ __exportAll({
	ARR: () => ARR,
	BOOL: () => BOOL,
	ERROR: () => ERROR,
	FALSE: () => FALSE,
	FN: () => FN,
	FN_NATIVE: () => FN_NATIVE,
	NULL: () => NULL,
	NUM: () => NUM,
	OBJ: () => OBJ,
	STR: () => STR,
	TRUE: () => TRUE
});
const NULL = { type: "null" };
const TRUE = {
	type: "bool",
	value: true
};
const FALSE = {
	type: "bool",
	value: false
};
const NUM = (num) => ({
	type: "num",
	value: num
});
const STR = (str) => ({
	type: "str",
	value: str
});
const BOOL = (bool) => bool ? TRUE : FALSE;
const OBJ = (obj) => ({
	type: "obj",
	value: obj
});
const ARR = (arr) => ({
	type: "arr",
	value: arr
});
const FN = (params, statements, scope, typeParams = []) => ({
	type: "fn",
	params,
	typeParams,
	statements,
	scope
});
const FN_NATIVE = (fn, fnSync) => ({
	type: "fn",
	native: fn,
	nativeSync: fnSync
});
const ERROR = (name, info) => ({
	type: "error",
	value: name,
	info
});

//#endregion
export { ARR, BOOL, ERROR, FALSE, FN, FN_NATIVE, NULL, NUM, OBJ, STR, TRUE, value_exports };
//# sourceMappingURL=value.js.map