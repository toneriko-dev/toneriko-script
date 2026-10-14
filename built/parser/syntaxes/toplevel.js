import { TonerikoScriptSyntaxError, TonerikoScriptUnexpectedEOFError } from "../../error.js";
import { TokenKind } from "../token.js";
import { NODE } from "../utils.js";
import { parseExpr } from "./expressions.js";
import { parseDefStatement, parseStatement, parseStatementWithAttr } from "./statements.js";

//#region src/parser/syntaxes/toplevel.ts
/**
* ```abnf
* TopLevel = *(Namespace / Meta / Statement)
* ```
*/
function parseTopLevel(s) {
	const nodes = [];
	while (s.is(1)) s.next();
	while (!s.is(0)) {
		switch (s.getTokenKind()) {
			case 47:
				nodes.push(parseNamespace(s));
				break;
			case 33:
				nodes.push(parseMeta(s));
				break;
			default: nodes.push(parseStatement(s));
		}
		switch (s.getTokenKind()) {
			case 1:
			case 48:
				while (s.is(1) || s.is(48)) s.next();
				break;
			case 0: break;
			default: throw new TonerikoScriptSyntaxError("Multiple statements cannot be placed on a single line.", s.getPos());
		}
	}
	return nodes;
}
/**
* ```abnf
* Namespace = "::" IDENT "{" *(DefStatement / StatementWithAttr / Namespace) "}"
* ```
*/
function parseNamespace(s) {
	const startPos = s.getPos();
	s.expect(47);
	s.next();
	s.expect(2);
	const name = s.getTokenValue();
	s.next();
	const members = [];
	s.expect(63);
	s.next();
	while (s.is(1)) s.next();
	while (!s.is(66)) {
		switch (s.getTokenKind()) {
			case 26:
			case 27:
			case 58:
				members.push(parseDefStatement(s));
				break;
			case 47:
				members.push(parseNamespace(s));
				break;
			case 32: members.push(parseStatementWithAttr(s));
		}
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
	return NODE("ns", {
		name,
		members
	}, startPos, s.getPos());
}
/**
* ```abnf
* Meta = "###" [IDENT] StaticExpr
* ```
*/
function parseMeta(s) {
	const startPos = s.getPos();
	s.expect(33);
	s.next();
	let name = null;
	if (s.is(2)) {
		name = s.getTokenValue();
		s.next();
	}
	const value = parseExpr(s, true);
	return NODE("meta", {
		name,
		value
	}, startPos, value.loc.end);
}

//#endregion
export { parseMeta, parseNamespace, parseTopLevel };
//# sourceMappingURL=toplevel.js.map