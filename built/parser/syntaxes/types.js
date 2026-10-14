import { TonerikoScriptSyntaxError, TonerikoScriptUnexpectedEOFError } from "../../error.js";
import { TokenKind } from "../token.js";
import { NODE } from "../utils.js";
import { parseOptionalSeparator } from "./common.js";

//#region src/parser/syntaxes/types.ts
/**
* ```abnf
* Type = UnionType
* ```
*/
function parseType(s) {
	return parseUnionType(s);
}
/**
* ```abnf
* TypeParams = "<" TypeParam *(SEP TypeParam) [SEP] ">"
* ```
*/
function parseTypeParams(s) {
	s.expect(49);
	s.next();
	if (s.is(1)) s.next();
	const items = [parseTypeParam(s)];
	while (parseOptionalSeparator(s)) {
		if (s.is(55)) break;
		const item = parseTypeParam(s);
		items.push(item);
	}
	s.expect(55);
	s.next();
	return items;
}
/**
* ```abnf
* TypeParam = IDENT
* ```
*/
function parseTypeParam(s) {
	s.expect(2);
	const name = s.getTokenValue();
	s.next();
	return { name };
}
/**
* ```abnf
* UnionType = UnionTypeTerm *("|" UnionTypeTerm)
* ```
*/
function parseUnionType(s) {
	const startPos = s.getPos();
	const first = parseUnionTypeInner(s);
	if (!s.is(64)) return first;
	const inners = [first];
	do {
		s.next();
		inners.push(parseUnionTypeInner(s));
	} while (s.is(64));
	return NODE("unionTypeSource", { inners }, startPos, s.getPos());
}
/**
* ```abnf
* UnionTypeTerm = FnType / NamedType
* ```
*/
function parseUnionTypeInner(s) {
	if (s.is(58)) return parseFnType(s);
	return parseNamedType(s);
}
/**
* ```abnf
* FnType = "@" [TypeParams] "(" ParamTypes ")" "=>" Type
* ParamTypes = [Type *("," Type)]
* ```
*/
function parseFnType(s) {
	const startPos = s.getPos();
	s.expect(58);
	s.next();
	let typeParams;
	if (s.is(49)) typeParams = parseTypeParams(s);
	else typeParams = [];
	s.expect(36);
	s.next();
	const params = [];
	while (!s.is(37)) {
		if (params.length > 0) switch (s.getTokenKind()) {
			case 41:
				s.next();
				break;
			case 0: throw new TonerikoScriptUnexpectedEOFError(s.getPos());
			default: throw new TonerikoScriptSyntaxError("separator expected", s.getPos());
		}
		const type = parseType(s);
		params.push(type);
	}
	s.expect(37);
	s.next();
	s.expect(54);
	s.next();
	const resultType = parseType(s);
	return NODE("fnTypeSource", {
		typeParams,
		params,
		result: resultType
	}, startPos, s.getPos());
}
/**
* ```abnf
* NamedType = (IDENT / "null") ["<" Type ">"]
* ```
*/
function parseNamedType(s) {
	const startPos = s.getPos();
	let name;
	if (s.is(2)) {
		name = s.getTokenValue();
		s.next();
	} else {
		s.expect(8);
		s.next();
		name = "null";
	}
	let inner;
	if (s.is(49)) {
		s.next();
		inner = parseType(s);
		s.expect(55);
		s.next();
	}
	return NODE("namedTypeSource", {
		name,
		inner
	}, startPos, s.getPos());
}

//#endregion
export { parseType, parseTypeParams };
//# sourceMappingURL=types.js.map