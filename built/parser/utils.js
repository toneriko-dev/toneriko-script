import { TonerikoScriptSyntaxError, TonerikoScriptUnexpectedEOFError } from "../error.js";
import { TokenKind } from "./token.js";

//#region src/parser/utils.ts
function NODE(type, params, start, end) {
	const node = { type };
	for (const key of Object.keys(params)) if (params[key] !== void 0) node[key] = params[key];
	node["loc"] = {
		start,
		end
	};
	return node;
}
function CALL_NODE(name, args, start, end) {
	return NODE("call", {
		target: NODE("identifier", { name }, start, start),
		args
	}, start, end);
}
function unexpectedTokenError(token, pos, info) {
	if (token === 0) return new TonerikoScriptUnexpectedEOFError(pos, info);
	return new TonerikoScriptSyntaxError(`unexpected token: ${TokenKind[token]}`, pos, info);
}

//#endregion
export { CALL_NODE, NODE, unexpectedTokenError };
//# sourceMappingURL=utils.js.map