import { createScriptError, runtimeError } from "../runtime/errors.js";

//#region src/v2/stdlib/basics.ts
const errorDefinition = {
	name: "Error",
	receiver: "global",
	args: [{
		name: "message",
		type: "string | number | boolean",
		optional: true
	}, {
		name: "options",
		type: "any",
		optional: true
	}],
	returns: "any",
	description: {
		ja: "原型を持たないエラーの値を作ります。",
		en: "Creates an error value without a prototype."
	},
	*implementation(ctx, _receiver, args) {
		const message = args[0];
		if (args.length && typeof message !== "string" && typeof message !== "number" && typeof message !== "boolean") throw runtimeError("INVALID_STRING_CONVERSION", ctx.pos, {}, "TypeError");
		const error = createScriptError("Error", args.length ? String(message) : void 0);
		const options = args[1];
		if (options !== null && (typeof options === "object" || typeof options === "function") && ctx.properties.has(options, "cause", ctx.pos)) Object.defineProperty(error, "cause", {
			value: ctx.properties.get(options, "cause", ctx.pos),
			configurable: true,
			writable: true
		});
		return error;
	}
};
const basicDefinitions = [errorDefinition, {
	name: "push",
	receiver: "array",
	args: [{
		name: "items",
		type: "any[]",
		rest: true
	}],
	returns: "number",
	description: {
		ja: "末尾に値を追加し、配列の長さを返します。",
		en: "Appends values and returns the array length."
	},
	*implementation(ctx, receiver, args) {
		if (!Array.isArray(receiver)) throw runtimeError("INVALID_RECEIVER", ctx.pos, {}, "TypeError");
		for (let i = 0; i < args.length; i++) {
			ctx.tick();
			ctx.properties.set(receiver, receiver.length, args[i], ctx.pos);
			if (i % 64 === 63) yield ctx.checkpoint();
		}
		return receiver.length;
	}
}];

//#endregion
export { basicDefinitions, errorDefinition };
//# sourceMappingURL=basics.js.map