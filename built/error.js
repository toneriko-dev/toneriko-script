import { __exportAll } from "./_virtual/_rolldown/runtime.js";

//#region src/error.ts
var error_exports = /* @__PURE__ */ __exportAll({
	NonTonerikoScriptError: () => NonTonerikoScriptError,
	TonerikoScriptError: () => TonerikoScriptError,
	TonerikoScriptHostsideError: () => TonerikoScriptHostsideError,
	TonerikoScriptIndexOutOfRangeError: () => TonerikoScriptIndexOutOfRangeError,
	TonerikoScriptNamespaceError: () => TonerikoScriptNamespaceError,
	TonerikoScriptRuntimeError: () => TonerikoScriptRuntimeError,
	TonerikoScriptSyntaxError: () => TonerikoScriptSyntaxError,
	TonerikoScriptUnexpectedEOFError: () => TonerikoScriptUnexpectedEOFError,
	TonerikoScriptUserError: () => TonerikoScriptUserError
});
var TonerikoScriptError = class TonerikoScriptError extends Error {
	name = "TonerikoScript";
	info;
	pos;
	constructor(message, info) {
		super(message);
		this.info = info;
		if (Error.captureStackTrace) Error.captureStackTrace(this, TonerikoScriptError);
	}
};
var NonTonerikoScriptError = class extends TonerikoScriptError {
	name = "Internal";
	constructor(error) {
		const message = String(error?.message ?? error);
		super(message, error);
	}
};
var TonerikoScriptSyntaxError = class extends TonerikoScriptError {
	pos;
	name = "Syntax";
	constructor(message, pos, info) {
		super(`${message} (Line ${pos.line}, Column ${pos.column})`, info);
		this.pos = pos;
	}
};
var TonerikoScriptUnexpectedEOFError = class extends TonerikoScriptSyntaxError {
	constructor(pos, info) {
		super("unexpected EOF", pos, info);
	}
};
var TonerikoScriptNamespaceError = class extends TonerikoScriptError {
	pos;
	name = "Namespace";
	constructor(message, pos, info) {
		super(`${message} (Line ${pos.line}, Column ${pos.column})`, info);
		this.pos = pos;
	}
};
var TonerikoScriptRuntimeError = class extends TonerikoScriptError {
	name = "Runtime";
};
var TonerikoScriptIndexOutOfRangeError = class extends TonerikoScriptRuntimeError {};
var TonerikoScriptUserError = class extends TonerikoScriptRuntimeError {
	name = "";
};
var TonerikoScriptHostsideError = class extends TonerikoScriptError {
	name = "Host";
};

//#endregion
export { NonTonerikoScriptError, TonerikoScriptError, TonerikoScriptHostsideError, TonerikoScriptIndexOutOfRangeError, TonerikoScriptNamespaceError, TonerikoScriptRuntimeError, TonerikoScriptSyntaxError, TonerikoScriptUnexpectedEOFError, TonerikoScriptUserError, error_exports };
//# sourceMappingURL=error.js.map