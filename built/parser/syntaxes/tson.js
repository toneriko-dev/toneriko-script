import { TonerikoScriptSyntaxError } from "../../error.js";
import { TokenKind } from "../token.js";
import { parseExpr } from "./expressions.js";

//#region src/parser/syntaxes/tson.ts
function parseTsonTopLevel(s) {
	let node = null;
	while (s.is(1)) s.next();
	while (!s.is(0)) {
		if (node == null) node = parseExpr(s, true);
		else throw new TonerikoScriptSyntaxError("TSON only supports one top-level expression.", s.getPos());
		switch (s.getTokenKind()) {
			case 1:
			case 48:
				while (s.is(1) || s.is(48)) s.next();
				break;
			case 0: break;
			default: throw new TonerikoScriptSyntaxError("Multiple statements cannot be placed on a single line.", s.getPos());
		}
	}
	if (node == null) throw new TonerikoScriptSyntaxError("TSON requires at least one top-level expression.", s.getPos());
	return node;
}

//#endregion
export { parseTsonTopLevel };
//# sourceMappingURL=tson.js.map