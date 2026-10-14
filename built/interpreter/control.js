import { TonerikoScriptRuntimeError } from "../error.js";
import { NULL } from "./value.js";

//#region src/interpreter/control.ts
const RETURN = (v) => ({
	type: "return",
	value: v
});
const BREAK = (label, value) => ({
	type: "break",
	label,
	value
});
const CONTINUE = (label) => ({
	type: "continue",
	label,
	value: null
});
function unWrapLabeledBreak(v, label) {
	if (v.type === "break" && v.label != null && v.label === label) return v.value ?? NULL;
	return v;
}
function unWrapRet(v) {
	switch (v.type) {
		case "return": return v.value;
		default:
			assertValue(v);
			return v;
	}
}
function assertValue(v) {
	switch (v.type) {
		case "return": throw new TonerikoScriptRuntimeError("Invalid return");
		case "break": throw new TonerikoScriptRuntimeError("Invalid break");
		case "continue": throw new TonerikoScriptRuntimeError("Invalid continue");
	}
}
function isControl(v) {
	switch (v.type) {
		case "null":
		case "bool":
		case "num":
		case "str":
		case "arr":
		case "obj":
		case "fn":
		case "error":
		case "reference": return false;
		case "return":
		case "break":
		case "continue": return true;
	}
	throw new TypeError("expected value or control");
}

//#endregion
export { BREAK, CONTINUE, RETURN, assertValue, isControl, unWrapLabeledBreak, unWrapRet };
//# sourceMappingURL=control.js.map