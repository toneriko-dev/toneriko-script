import { diagnosticTranslation, messages } from "./messages.js";

//#region src/v2/diagnostics.ts
function interpolate(text, params) {
	return text.replace(/\{(\w+)\}/g, (placeholder, key) => String(params[key] ?? placeholder));
}
function formatDiagnostic(diagnostic, language) {
	const translation = diagnosticTranslation(diagnostic.code, language, diagnostic.params);
	const position = language === "ja" ? `(${diagnostic.pos.line} 行目、${diagnostic.pos.column} 列目)` : `(line ${diagnostic.pos.line}, column ${diagnostic.pos.column})`;
	return `${interpolate(translation.message, diagnostic.params)} ${position} ${interpolate(translation.hint, diagnostic.params)}`;
}
function diagnostic(code, pos, params = {}, options = {}) {
	return {
		code,
		params,
		pos,
		hint: interpolate(messages[code].ja.hint, params),
		severity: options.severity ?? "error",
		...options.loc ? { loc: options.loc } : {}
	};
}
var TonerikoScriptSyntaxError = class extends SyntaxError {
	code;
	params;
	pos;
	hint;
	severity = "error";
	constructor(code, pos, params = {}) {
		const value = diagnostic(code, pos, params);
		super(formatDiagnostic(value, "ja"));
		this.name = "TonerikoScriptSyntaxError";
		this.code = code;
		this.params = params;
		this.pos = pos;
		this.hint = value.hint;
	}
};
function syntaxError(code, pos, params = {}) {
	return new TonerikoScriptSyntaxError(code, pos, params);
}

//#endregion
export { TonerikoScriptSyntaxError, diagnostic, formatDiagnostic, syntaxError };
//# sourceMappingURL=diagnostics.js.map