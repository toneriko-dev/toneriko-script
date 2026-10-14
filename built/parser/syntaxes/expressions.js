import { TonerikoScriptSyntaxError, TonerikoScriptUnexpectedEOFError } from "../../error.js";
import { TokenKind, isKeywordTokenKind, keywordTokenKindToString } from "../token.js";
import { NODE, unexpectedTokenError } from "../utils.js";
import { TokenStream } from "../streams/token-stream.js";
import { parseType, parseTypeParams } from "./types.js";
import { parseBlock, parseLabel, parseOptionalSeparator, parseParams } from "./common.js";
import { parseBlockOrStatement } from "./statements.js";

//#region src/parser/syntaxes/expressions.ts
function parseNumberLiteral(s) {
	s.expect(3);
	const pos = s.getPos();
	const value = Number(s.getTokenValue());
	if (!Number.isFinite(value)) throw new TonerikoScriptSyntaxError("number literal is out of range", pos);
	s.next();
	return value;
}
function parseExpr(s, isStatic) {
	if (isStatic) {
		if (s.is(42)) {
			const startPos = s.getPos();
			s.next();
			const value = -parseNumberLiteral(s);
			return NODE("num", { value }, startPos, s.getPos());
		}
		return parseAtom(s, true);
	}
	return parsePratt(s, 0);
}
const operators = [
	{
		opKind: "postfix",
		kind: 36,
		bp: 20
	},
	{
		opKind: "postfix",
		kind: 59,
		bp: 20
	},
	{
		opKind: "infix",
		kind: 44,
		lbp: 18,
		rbp: 19
	},
	{
		opKind: "infix",
		kind: 62,
		lbp: 17,
		rbp: 16
	},
	{
		opKind: "prefix",
		kind: 39,
		bp: 14
	},
	{
		opKind: "prefix",
		kind: 42,
		bp: 14
	},
	{
		opKind: "prefix",
		kind: 29,
		bp: 14
	},
	{
		opKind: "infix",
		kind: 38,
		lbp: 12,
		rbp: 13
	},
	{
		opKind: "infix",
		kind: 45,
		lbp: 12,
		rbp: 13
	},
	{
		opKind: "infix",
		kind: 34,
		lbp: 12,
		rbp: 13
	},
	{
		opKind: "infix",
		kind: 39,
		lbp: 10,
		rbp: 11
	},
	{
		opKind: "infix",
		kind: 42,
		lbp: 10,
		rbp: 11
	},
	{
		opKind: "infix",
		kind: 49,
		lbp: 8,
		rbp: 9
	},
	{
		opKind: "infix",
		kind: 50,
		lbp: 8,
		rbp: 9
	},
	{
		opKind: "infix",
		kind: 55,
		lbp: 8,
		rbp: 9
	},
	{
		opKind: "infix",
		kind: 56,
		lbp: 8,
		rbp: 9
	},
	{
		opKind: "infix",
		kind: 53,
		lbp: 6,
		rbp: 7
	},
	{
		opKind: "infix",
		kind: 30,
		lbp: 6,
		rbp: 7
	},
	{
		opKind: "infix",
		kind: 35,
		lbp: 4,
		rbp: 5
	},
	{
		opKind: "infix",
		kind: 65,
		lbp: 2,
		rbp: 3
	},
	{
		opKind: "infix",
		kind: 67,
		lbp: 0,
		rbp: 1
	}
];
function parsePrefix(s, minBp) {
	const startPos = s.getPos();
	const op = s.getTokenKind();
	s.next();
	if (s.is(60)) {
		s.next();
		s.expect(1);
		s.next();
	}
	const expr = parsePratt(s, minBp);
	const endPos = expr.loc.end;
	switch (op) {
		case 39:
			if (expr.type === "num") return NODE("num", { value: expr.value }, startPos, endPos);
			return NODE("plus", { expr }, startPos, endPos);
		case 42:
			if (expr.type === "num") return NODE("num", { value: -1 * expr.value }, startPos, endPos);
			return NODE("minus", { expr }, startPos, endPos);
		case 29: return NODE("not", { expr }, startPos, endPos);
		default: throw unexpectedTokenError(op, startPos);
	}
}
function parseInfix(s, left, minBp) {
	const startPos = s.getPos();
	const op = s.getTokenKind();
	s.next();
	if (s.is(60)) {
		s.next();
		s.expect(1);
		s.next();
	}
	if (op === 44) {
		const name = parseObjectKey(s);
		s.next();
		return NODE("prop", {
			target: left,
			name
		}, startPos, s.getPos());
	}
	const right = parsePratt(s, minBp);
	const endPos = s.getPos();
	switch (op) {
		case 62: return NODE("pow", {
			left,
			right
		}, startPos, endPos);
		case 38: return NODE("mul", {
			left,
			right
		}, startPos, endPos);
		case 45: return NODE("div", {
			left,
			right
		}, startPos, endPos);
		case 34: return NODE("rem", {
			left,
			right
		}, startPos, endPos);
		case 39: return NODE("add", {
			left,
			right
		}, startPos, endPos);
		case 42: return NODE("sub", {
			left,
			right
		}, startPos, endPos);
		case 49: return NODE("lt", {
			left,
			right
		}, startPos, endPos);
		case 50: return NODE("lteq", {
			left,
			right
		}, startPos, endPos);
		case 55: return NODE("gt", {
			left,
			right
		}, startPos, endPos);
		case 56: return NODE("gteq", {
			left,
			right
		}, startPos, endPos);
		case 53: return NODE("eq", {
			left,
			right
		}, startPos, endPos);
		case 30: return NODE("neq", {
			left,
			right
		}, startPos, endPos);
		case 35: return NODE("and", {
			left,
			right
		}, startPos, endPos);
		case 65: return NODE("or", {
			left,
			right
		}, startPos, endPos);
		case 67: if (right.type === "call") return NODE("call", {
			target: right.target,
			args: [left, ...right.args]
		}, startPos, endPos);
		else return NODE("call", {
			target: right,
			args: [left]
		}, startPos, endPos);
		default: throw unexpectedTokenError(op, startPos);
	}
}
function parsePostfix(s, expr) {
	const startPos = s.getPos();
	const op = s.getTokenKind();
	switch (op) {
		case 36: return parseCall(s, expr);
		case 59: {
			s.next();
			const index = parseExpr(s, false);
			s.expect(61);
			s.next();
			return NODE("index", {
				target: expr,
				index
			}, startPos, s.getPos());
		}
		default: throw unexpectedTokenError(op, startPos);
	}
}
function parseAtom(s, isStatic) {
	const startPos = s.getPos();
	switch (s.getTokenKind()) {
		case 21:
			if (isStatic) break;
			return parseIf(s);
		case 58:
			if (isStatic) break;
			return parseFnExpr(s);
		case 18:
			if (isStatic) break;
			return parseMatch(s);
		case 25:
			if (isStatic) break;
			return parseEval(s);
		case 28:
			if (isStatic) break;
			return parseExists(s);
		case 5: {
			const values = [];
			if (isStatic) break;
			for (const [i, element] of s.getToken().children.entries()) switch (element.kind) {
				case 6: {
					const nextToken = s.getToken().children[i + 1] ?? s.lookahead(1);
					values.push(NODE("str", { value: element.value }, element.pos, nextToken.pos));
					break;
				}
				case 7: {
					const exprStream = new TokenStream(element.children);
					if (exprStream.is(1)) exprStream.next();
					const expr = parseExpr(exprStream, false);
					if (exprStream.is(1)) exprStream.next();
					exprStream.expect(0);
					values.push(expr);
					break;
				}
				default: throw unexpectedTokenError(element.kind, element.pos);
			}
			s.next();
			return NODE("tmpl", { tmpl: values }, startPos, s.getPos());
		}
		case 4: {
			const value = s.getTokenValue();
			s.next();
			return NODE("str", { value }, startPos, s.getPos());
		}
		case 3: {
			const value = parseNumberLiteral(s);
			return NODE("num", { value }, startPos, s.getPos());
		}
		case 9:
		case 10: {
			const value = s.is(9);
			s.next();
			return NODE("bool", { value }, startPos, s.getPos());
		}
		case 8:
			s.next();
			return NODE("null", {}, startPos, s.getPos());
		case 63: return parseObject(s, isStatic);
		case 59: return parseArray(s, isStatic);
		case 2:
			if (isStatic) break;
			return parseReference(s);
		case 36: {
			s.next();
			const expr = parseExpr(s, isStatic);
			s.expect(37);
			s.next();
			return expr;
		}
		case 31:
			if (isStatic) break;
			return parseExprWithLabel(s);
	}
	throw unexpectedTokenError(s.getTokenKind(), startPos);
}
/**
* Call = "(" [Expr *(SEP Expr) [SEP]] ")"
*/
function parseCall(s, target) {
	const startPos = s.getPos();
	const items = [];
	s.expect(36);
	s.next();
	if (s.is(1)) s.next();
	while (!s.is(37)) {
		items.push(parseExpr(s, false));
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
	return NODE("call", {
		target,
		args: items
	}, startPos, s.getPos());
}
/**
* ```abnf
* ExprWithLabel = "#" IDENT ":" Expr
* ```
*/
function parseExprWithLabel(s) {
	const label = parseLabel(s);
	s.expect(46);
	s.next();
	const expr = parseExpr(s, false);
	switch (expr.type) {
		case "if":
		case "match":
		case "block":
			expr.label = label;
			return expr;
		default: throw new TonerikoScriptSyntaxError("cannot use label for expression other than eval / if / match", expr.loc.start);
	}
}
/**
* ```abnf
* If = "if" Expr BlockOrStatement *("elif" Expr BlockOrStatement) ["else" BlockOrStatement]
* ```
*/
function parseIf(s) {
	const startPos = s.getPos();
	s.expect(21);
	s.next();
	const cond = parseExpr(s, false);
	const then = parseBlockOrStatement(s);
	if (s.is(1) && [22, 23].includes(s.lookahead(1).kind)) s.next();
	const elseif = [];
	while (s.is(22)) {
		s.next();
		const elifCond = parseExpr(s, false);
		const elifThen = parseBlockOrStatement(s);
		if (s.is(1) && [22, 23].includes(s.lookahead(1).kind)) s.next();
		elseif.push({
			cond: elifCond,
			then: elifThen
		});
	}
	let _else = void 0;
	if (s.is(23)) {
		s.next();
		_else = parseBlockOrStatement(s);
	}
	return NODE("if", {
		cond,
		then,
		elseif,
		else: _else
	}, startPos, s.getPos());
}
/**
* ```abnf
* FnExpr = "@" [TypeParams] Params [":" Type] Block
* ```
*/
function parseFnExpr(s) {
	const startPos = s.getPos();
	s.expect(58);
	s.next();
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
	return NODE("fn", {
		typeParams,
		params,
		retType: type,
		children: body
	}, startPos, s.getPos());
}
/**
* ```abnf
* Match = "match" Expr "{" [(MatchCase *(SEP MatchCase) [SEP DefaultCase] [SEP]) / DefaultCase [SEP]] "}"
* ```
*/
function parseMatch(s) {
	const startPos = s.getPos();
	s.expect(18);
	s.next();
	const about = parseExpr(s, false);
	s.expect(63);
	s.next();
	if (s.is(1)) s.next();
	const qs = [];
	let x;
	if (s.is(19)) {
		qs.push(parseMatchCase(s));
		let sep = parseOptionalSeparator(s);
		while (s.is(19)) {
			if (!sep) throw new TonerikoScriptSyntaxError("separator expected", s.getPos());
			qs.push(parseMatchCase(s));
			sep = parseOptionalSeparator(s);
		}
		if (s.is(20)) {
			if (!sep) throw new TonerikoScriptSyntaxError("separator expected", s.getPos());
			x = parseDefaultCase(s);
			parseOptionalSeparator(s);
		}
	} else if (s.is(20)) {
		x = parseDefaultCase(s);
		parseOptionalSeparator(s);
	}
	s.expect(66);
	s.next();
	return NODE("match", {
		about,
		qs,
		default: x
	}, startPos, s.getPos());
}
/**
* ```abnf
* MatchCase = "case" Expr ["if" Expr] "=>" BlockOrStatement
* ```
*/
function parseMatchCase(s) {
	s.expect(19);
	s.next();
	const q = parseExpr(s, false);
	let guard;
	if (s.is(21)) {
		s.next();
		guard = parseExpr(s, false);
	}
	s.expect(54);
	s.next();
	const a = parseBlockOrStatement(s);
	return {
		q,
		guard,
		a
	};
}
/**
* ```abnf
* DefaultCase = "default" "=>" BlockOrStatement
* ```
*/
function parseDefaultCase(s) {
	s.expect(20);
	s.next();
	s.expect(54);
	s.next();
	return parseBlockOrStatement(s);
}
/**
* ```abnf
* Eval = "eval" Block
* ```
*/
function parseEval(s) {
	const startPos = s.getPos();
	s.expect(25);
	s.next();
	const statements = parseBlock(s);
	return NODE("block", { statements }, startPos, s.getPos());
}
/**
* ```abnf
* Exists = "exists" Reference
* ```
*/
function parseExists(s) {
	const startPos = s.getPos();
	s.expect(28);
	s.next();
	const identifier = parseReference(s);
	return NODE("exists", { identifier }, startPos, s.getPos());
}
/**
* ```abnf
* Reference = IDENT *(":" IDENT)
* ```
*/
function parseReference(s) {
	const startPos = s.getPos();
	const segs = [];
	while (true) {
		if (segs.length > 0) {
			if (s.is(46)) {
				if (s.getToken().hasLeftSpacing) throw new TonerikoScriptSyntaxError("Cannot use spaces in a reference.", s.getPos());
				s.next();
				if (s.getToken().hasLeftSpacing) throw new TonerikoScriptSyntaxError("Cannot use spaces in a reference.", s.getPos());
			} else break;
		}
		s.expect(2);
		segs.push(s.getTokenValue());
		s.next();
	}
	return NODE("identifier", { name: segs.join(":") }, startPos, s.getPos());
}
/**
* ```abnf
* Object = "{" [ObjectKey ":" Expr *(SEP ObjectKey ":" Expr) [SEP]] "}"
* ```
*/
function parseObject(s, isStatic) {
	const startPos = s.getPos();
	s.expect(63);
	s.next();
	while (s.is(1)) s.next();
	const map = /* @__PURE__ */ new Map();
	while (!s.is(66)) {
		const k = parseObjectKey(s);
		s.next();
		s.expect(46);
		s.next();
		const v = parseExpr(s, isStatic);
		map.set(k, v);
		switch (s.getTokenKind()) {
			case 1:
			case 41:
				s.next();
				while (s.is(1)) s.next();
				break;
			case 66: break;
			case 0: throw new TonerikoScriptUnexpectedEOFError(s.getPos());
			default: throw new TonerikoScriptSyntaxError("separator expected", s.getPos());
		}
	}
	s.expect(66);
	s.next();
	return NODE("obj", { value: map }, startPos, s.getPos());
}
/**
* ```abnf
* ObjectKey = IDENT / StringLiteral / Keyword
* ```
*/
function parseObjectKey(s) {
	const tokenKind = s.getTokenKind();
	if (tokenKind === 2) return s.getTokenValue();
	if (tokenKind === 4) return s.getTokenValue();
	if (isKeywordTokenKind(tokenKind)) return keywordTokenKindToString(tokenKind);
	throw unexpectedTokenError(tokenKind, s.getPos());
}
/**
* ```abnf
* Array = "[" [Expr *(SEP Expr) [SEP]] "]"
* ```
*/
function parseArray(s, isStatic) {
	const startPos = s.getPos();
	s.expect(59);
	s.next();
	while (s.is(1)) s.next();
	const value = [];
	while (!s.is(61)) {
		value.push(parseExpr(s, isStatic));
		switch (s.getTokenKind()) {
			case 1:
			case 41:
				s.next();
				while (s.is(1)) s.next();
				break;
			case 61: break;
			case 0: throw new TonerikoScriptUnexpectedEOFError(s.getPos());
			default: throw new TonerikoScriptSyntaxError("separator expected", s.getPos());
		}
	}
	s.expect(61);
	s.next();
	return NODE("arr", { value }, startPos, s.getPos());
}
function parsePratt(s, minBp) {
	let left;
	const tokenKind = s.getTokenKind();
	const prefix = operators.find((x) => x.opKind === "prefix" && x.kind === tokenKind);
	if (prefix != null) left = parsePrefix(s, prefix.bp);
	else left = parseAtom(s, false);
	while (true) {
		if (s.is(60)) {
			s.next();
			s.expect(1);
			s.next();
		}
		const tokenKind = s.getTokenKind();
		const postfix = operators.find((x) => x.opKind === "postfix" && x.kind === tokenKind);
		if (postfix != null) {
			if (postfix.bp < minBp) break;
			if ([59, 36].includes(tokenKind) && s.getToken().hasLeftSpacing) {} else {
				left = parsePostfix(s, left);
				continue;
			}
		}
		const infix = operators.find((x) => x.opKind === "infix" && x.kind === tokenKind);
		if (infix != null) {
			if (infix.lbp < minBp) break;
			left = parseInfix(s, left, infix.rbp);
			continue;
		}
		break;
	}
	return left;
}

//#endregion
export { parseExpr };
//# sourceMappingURL=expressions.js.map