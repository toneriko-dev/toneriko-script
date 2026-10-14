import { TonerikoScriptSyntaxError, TonerikoScriptUnexpectedEOFError } from "../../error.js";
import { TokenKind } from "../token.js";
import { NODE } from "../utils.js";
import { parseType } from "./types.js";
import { parseExpr } from "./expressions.js";
import { parseStatement } from "./statements.js";

//#region src/parser/syntaxes/common.ts
/**
* ```abnf
* Dest = IDENT / Expr
* ```
*/
function parseDest(s) {
	if (s.is(2)) {
		const nameStartPos = s.getPos();
		const name = s.getTokenValue();
		s.next();
		return NODE("identifier", { name }, nameStartPos, s.getPos());
	}
	return parseExpr(s, false);
}
/**
* ```abnf
* Params = "(" [Param *(SEP Param) [SEP]] ")"
* Param = Dest ["?" / ("=" Expr)] [":" Type]
* ```
*/
function parseParams(s) {
	const items = [];
	s.expect(36);
	s.next();
	if (s.is(1)) s.next();
	while (!s.is(37)) {
		const dest = parseDest(s);
		let optional = false;
		let defaultExpr;
		if (s.is(57)) {
			s.next();
			optional = true;
		} else if (s.is(52)) {
			s.next();
			defaultExpr = parseExpr(s, false);
		}
		let type;
		if (s.is(46)) {
			s.next();
			type = parseType(s);
		}
		items.push({
			dest,
			optional,
			default: defaultExpr,
			argType: type
		});
		switch (s.getTokenKind()) {
			case 1:
				s.next();
				break;
			case 41:
				s.next();
				if (s.is(1)) s.next();
				break;
			case 37: break;
			case 0: throw new TonerikoScriptUnexpectedEOFError(s.getPos());
			default: throw new TonerikoScriptSyntaxError("separator expected", s.getPos());
		}
	}
	s.expect(37);
	s.next();
	return items;
}
/**
* ```abnf
* Block = "{" *Statement "}"
* ```
*/
function parseBlock(s) {
	s.expect(63);
	s.next();
	while (s.is(1)) s.next();
	const steps = [];
	while (!s.is(66)) {
		steps.push(parseStatement(s));
		switch (s.getTokenKind()) {
			case 1:
			case 48:
				while (s.is(1) || s.is(48)) s.next();
				break;
			case 66: break;
			case 0: throw new TonerikoScriptUnexpectedEOFError(s.getPos());
			default: throw new TonerikoScriptSyntaxError("Multiple statements cannot be placed on a single line.", s.getPos());
		}
	}
	s.expect(66);
	s.next();
	return steps;
}
/**
* ```abnf
* Label = "#" IDENT
* ```
*/
function parseLabel(s) {
	s.expect(31);
	s.next();
	if (s.getToken().hasLeftSpacing) throw new TonerikoScriptSyntaxError("cannot use spaces in a label", s.getPos());
	s.expect(2);
	const label = s.getTokenValue();
	s.next();
	return label;
}
/**
* ```abnf
* OptionalSeparator = [SEP]
* ```
*/
function parseOptionalSeparator(s) {
	switch (s.getTokenKind()) {
		case 1:
			s.next();
			return true;
		case 41:
			s.next();
			if (s.is(1)) s.next();
			return true;
		default: return false;
	}
}

//#endregion
export { parseBlock, parseDest, parseLabel, parseOptionalSeparator, parseParams };
//# sourceMappingURL=common.js.map