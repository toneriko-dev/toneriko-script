import { runtimeError } from "../runtime/errors.js";

//#region src/v2/stdlib/core.ts
const STANDARD_FUNCTION = Symbol("standard function");
function isStdFunction(value) {
	return typeof value === "object" && value !== null && Object.getOwnPropertyDescriptor(value, STANDARD_FUNCTION)?.value !== void 0;
}
function makeFunction(definition) {
	return Object.assign(Object.create(null), { [STANDARD_FUNCTION]: definition });
}
function requireNumber(ctx, value) {
	if (typeof value !== "number") throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "number" }, "TypeError");
	return value;
}
function requireString(ctx, value) {
	if (typeof value !== "string") throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "string" }, "TypeError");
	return value;
}
function requireArray(ctx, value) {
	if (!Array.isArray(value)) throw runtimeError("STDLIB_ARGUMENT_TYPE", ctx.pos, { expected: "any[]" }, "TypeError");
	return value;
}
function validateArguments(ctx, definition, args) {
	const required = definition.args.filter((arg) => !arg.optional && !arg.rest).length;
	if (args.length < required) throw runtimeError("STDLIB_ARGUMENT_COUNT", ctx.pos, {
		name: definition.name,
		count: required
	}, "TypeError");
}
function catalogOf(definitions) {
	return definitions.map(({ implementation: _, ...metadata }) => metadata);
}

//#endregion
export { STANDARD_FUNCTION, catalogOf, isStdFunction, makeFunction, requireArray, requireNumber, requireString, validateArguments };
//# sourceMappingURL=core.js.map