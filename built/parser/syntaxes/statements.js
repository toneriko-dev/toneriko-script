import { TonerikoScriptSyntaxError } from "../../error.js";
import { TokenKind } from "../token.js";
import { CALL_NODE, NODE, unexpectedTokenError } from "../utils.js";
import { parseType, parseTypeParams } from "./types.js";
import { parseExpr } from "./expressions.js";
import { parseBlock, parseDest, parseLabel, parseParams } from "./common.js";

//#region src/parser/syntaxes/statements.ts
function parseStatement(s) {
	switch (s.getTokenKind()) {
		case 26:
		case 27: return parseVarDef(s);
		case 58:
			if (s.lookahead(1).kind === 2) return parseFnDef(s);
			break;
		case 51: return parseOut(s);
		case 24: return parseReturn(s);
		case 32: return parseStatementWithAttr(s);
		case 31: return parseStatementWithLabel(s);
		case 11: return parseEach(s);
		case 12: return parseFor(s);
		case 13: return parseLoop(s);
		case 14: return parseDoWhile(s);
		case 15: return parseWhile(s);
		case 16: return parseBreak(s);
		case 17: return parseContinue(s);
	}
	const expr = parseExpr(s, false);
	const assign = tryParseAssign(s, expr);
	if (assign) return assign;
	return expr;
}
/**
* ```abnf
* DefStatement = VarDef / FnDef
* ```
*/
function parseDefStatement(s) {
	switch (s.getTokenKind()) {
		case 26:
		case 27: return parseVarDef(s);
		case 58: return parseFnDef(s);
		default: throw unexpectedTokenError(s.getTokenKind(), s.getPos());
	}
}
/**
* ```abnf
* BlockOrStatement = Block / Statement
* ```
*/
function parseBlockOrStatement(s) {
	if (s.is(63)) {
		const startPos = s.getPos();
		const statements = parseBlock(s);
		return NODE("block", { statements }, startPos, s.getPos());
	}
	return parseStatement(s);
}
/**
* ```abnf
* VarDef = ("let" / "var") Dest [":" Type] "=" Expr
* ```
*/
function parseVarDef(s) {
	const startPos = s.getPos();
	let mut;
	switch (s.getTokenKind()) {
		case 27:
			mut = false;
			break;
		case 26:
			mut = true;
			break;
		default: throw unexpectedTokenError(s.getTokenKind(), s.getPos());
	}
	s.next();
	const dest = parseDest(s);
	let type;
	if (s.is(46)) {
		s.next();
		type = parseType(s);
	}
	s.expect(52);
	s.next();
	if (s.is(1)) s.next();
	const expr = parseExpr(s, false);
	return NODE("def", {
		dest,
		varType: type,
		expr,
		mut,
		attr: []
	}, startPos, s.getPos());
}
/**
* ```abnf
* FnDef = "@" IDENT [TypeParams] Params [":" Type] Block
* ```
*/
function parseFnDef(s) {
	const startPos = s.getPos();
	s.expect(58);
	s.next();
	s.expect(2);
	const nameStartPos = s.getPos();
	const name = s.getTokenValue();
	s.next();
	const dest = NODE("identifier", { name }, nameStartPos, s.getPos());
	let typeParams;
	if (s.is(49)) typeParams = parseTypeParams(s);
	else typeParams = [];
	const params = parseParams(s);
	let type;
	if (s.is(46)) {
		s.next();
		type = parseType(s);
	}
	const body = parseBlock(s);
	const endPos = s.getPos();
	return NODE("def", {
		dest,
		expr: NODE("fn", {
			typeParams,
			params,
			retType: type,
			children: body
		}, startPos, endPos),
		mut: false,
		attr: []
	}, startPos, endPos);
}
/**
* ```abnf
* Out = "<:" Expr
* ```
*/
function parseOut(s) {
	const startPos = s.getPos();
	s.expect(51);
	s.next();
	const expr = parseExpr(s, false);
	return CALL_NODE("print", [expr], startPos, s.getPos());
}
/**
* ```abnf
* StatementWithLabel = "#" IDENT ":" Statement
* ```
*/
function parseStatementWithLabel(s) {
	const label = parseLabel(s);
	s.expect(46);
	s.next();
	const statement = parseStatement(s);
	switch (statement.type) {
		case "if":
		case "match":
		case "block":
		case "each":
		case "for":
		case "loop":
			statement.label = label;
			return statement;
		default: throw new TonerikoScriptSyntaxError("cannot use label for statement other than eval / if / match / for / each / while / do-while / loop", statement.loc.start);
	}
}
/**
* ```abnf
* Each = "each" "(" "let" Dest "," Expr ")" BlockOrStatement
*      / "each"     "let" Dest "," Expr     BlockOrStatement
* ```
*/
function parseEach(s) {
	const startPos = s.getPos();
	let hasParen = false;
	s.expect(11);
	s.next();
	if (s.is(36)) {
		hasParen = true;
		s.next();
	}
	s.expect(27);
	s.next();
	const dest = parseDest(s);
	if (s.is(41)) s.next();
	else throw new TonerikoScriptSyntaxError("separator expected", s.getPos());
	const items = parseExpr(s, false);
	if (hasParen) {
		s.expect(37);
		s.next();
	}
	const body = parseBlockOrStatement(s);
	return NODE("each", {
		var: dest,
		items,
		for: body
	}, startPos, s.getPos());
}
/**
* ```abnf
* For = ForRange / ForTimes
* ForRange = "for" "(" "let" IDENT ["=" Expr] "," Expr ["," Expr] ")" BlockOrStatement
*          / "for"     "let" IDENT ["=" Expr] "," Expr ["," Expr]     BlockOrStatement
* ForTimes = "for" "(" Expr ")" BlockOrStatement
*          / "for"     Expr     BlockOrStatement
* ```
*/
function parseFor(s) {
	const startPos = s.getPos();
	let hasParen = false;
	s.expect(12);
	s.next();
	if (s.is(36)) {
		hasParen = true;
		s.next();
	}
	if (s.is(27)) {
		s.next();
		const identPos = s.getPos();
		s.expect(2);
		const name = s.getTokenValue();
		s.next();
		let _from;
		if (s.is(52)) {
			s.next();
			_from = parseExpr(s, false);
		} else _from = NODE("num", { value: 0 }, identPos, identPos);
		if (s.is(41)) s.next();
		else throw new TonerikoScriptSyntaxError("separator expected", s.getPos());
		const to = parseExpr(s, false);
		let step;
		if (s.is(41)) {
			s.next();
			step = parseExpr(s, false);
		}
		if (hasParen) {
			s.expect(37);
			s.next();
		}
		const body = parseBlockOrStatement(s);
		return NODE("for", {
			var: name,
			from: _from,
			to,
			step,
			for: body
		}, startPos, s.getPos());
	}
	const times = parseExpr(s, false);
	if (hasParen) {
		s.expect(37);
		s.next();
	}
	const body = parseBlockOrStatement(s);
	return NODE("for", {
		times,
		for: body
	}, startPos, s.getPos());
}
/**
* ```abnf
* Return = "return" Expr
* ```
*/
function parseReturn(s) {
	const startPos = s.getPos();
	s.expect(24);
	s.next();
	const expr = parseExpr(s, false);
	return NODE("return", { expr }, startPos, s.getPos());
}
/**
* ```abnf
* StatementWithAttr = *(Attr NewLine) DefStatement
* ```
*/
function parseStatementWithAttr(s) {
	const attrs = [];
	while (s.is(32)) {
		attrs.push(parseAttr(s));
		s.expect(1);
		s.next();
	}
	const statement = parseStatement(s);
	if (statement.type !== "def") throw new TonerikoScriptSyntaxError("invalid attribute.", statement.loc.start);
	if (statement.attr != null) statement.attr.push(...attrs);
	else statement.attr = attrs;
	return statement;
}
/**
* ```abnf
* Attr = "#[" IDENT [StaticExpr] "]"
* ```
*/
function parseAttr(s) {
	const startPos = s.getPos();
	s.expect(32);
	s.next();
	s.expect(2);
	const name = s.getTokenValue();
	s.next();
	let value;
	if (!s.is(61)) value = parseExpr(s, true);
	else {
		const closePos = s.getPos();
		value = NODE("bool", { value: true }, closePos, closePos);
	}
	s.expect(61);
	s.next();
	return NODE("attr", {
		name,
		value
	}, startPos, s.getPos());
}
/**
* ```abnf
* Loop = "loop" Block
* ```
*/
function parseLoop(s) {
	const startPos = s.getPos();
	s.expect(13);
	s.next();
	const statements = parseBlock(s);
	return NODE("loop", { statements }, startPos, s.getPos());
}
/**
* ```abnf
* Loop = "do" BlockOrStatement "while" Expr
* ```
*/
function parseDoWhile(s) {
	const doStartPos = s.getPos();
	s.expect(14);
	s.next();
	const body = parseBlockOrStatement(s);
	const whilePos = s.getPos();
	s.expect(15);
	s.next();
	const cond = parseExpr(s, false);
	const endPos = s.getPos();
	return NODE("loop", { statements: [body, NODE("if", {
		cond: NODE("not", { expr: cond }, whilePos, endPos),
		then: NODE("break", {}, endPos, endPos),
		elseif: []
	}, whilePos, endPos)] }, doStartPos, endPos);
}
/**
* ```abnf
* Loop = "while" Expr BlockOrStatement
* ```
*/
function parseWhile(s) {
	const startPos = s.getPos();
	s.expect(15);
	s.next();
	const cond = parseExpr(s, false);
	const condEndPos = s.getPos();
	const body = parseBlockOrStatement(s);
	return NODE("loop", { statements: [NODE("if", {
		cond: NODE("not", { expr: cond }, startPos, condEndPos),
		then: NODE("break", {}, condEndPos, condEndPos),
		elseif: []
	}, startPos, condEndPos), body] }, startPos, s.getPos());
}
/**
* ```abnf
* Break = "break" ["#" IDENT [Expr]]
* ```
*/
function parseBreak(s) {
	const startPos = s.getPos();
	s.expect(16);
	s.next();
	let label;
	let expr;
	if (s.is(31)) {
		label = parseLabel(s);
		if (s.is(46)) throw new TonerikoScriptSyntaxError("cannot omit label from break if expression is given", startPos);
		else if (!isStatementTerminator(s)) expr = parseExpr(s, false);
	}
	return NODE("break", {
		label,
		expr
	}, startPos, s.getPos());
}
/**
* ```abnf
* Continue = "continue" ["#" IDENT]
* ```
*/
function parseContinue(s) {
	const startPos = s.getPos();
	s.expect(17);
	s.next();
	let label;
	if (s.is(31)) label = parseLabel(s);
	return NODE("continue", { label }, startPos, s.getPos());
}
/**
* ```abnf
* Assign = Expr ("=" / "+=" / "-=") Expr
* ```
*/
function tryParseAssign(s, dest) {
	const startPos = s.getPos();
	switch (s.getTokenKind()) {
		case 52: {
			s.next();
			const expr = parseExpr(s, false);
			return NODE("assign", {
				dest,
				expr
			}, startPos, s.getPos());
		}
		case 40: {
			s.next();
			const expr = parseExpr(s, false);
			return NODE("addAssign", {
				dest,
				expr
			}, startPos, s.getPos());
		}
		case 43: {
			s.next();
			const expr = parseExpr(s, false);
			return NODE("subAssign", {
				dest,
				expr
			}, startPos, s.getPos());
		}
		default: return;
	}
}
function isStatementTerminator(s) {
	switch (s.getTokenKind()) {
		case 0:
		case 1:
		case 15:
		case 22:
		case 23:
		case 41:
		case 48:
		case 66: return true;
		default: return false;
	}
}

//#endregion
export { parseBlockOrStatement, parseDefStatement, parseStatement, parseStatementWithAttr };
//# sourceMappingURL=statements.js.map