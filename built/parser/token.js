//#region src/parser/token.ts
let TokenKind = /* @__PURE__ */ function(TokenKind) {
	TokenKind[TokenKind["EOF"] = 0] = "EOF";
	TokenKind[TokenKind["NewLine"] = 1] = "NewLine";
	TokenKind[TokenKind["Identifier"] = 2] = "Identifier";
	TokenKind[TokenKind["NumberLiteral"] = 3] = "NumberLiteral";
	TokenKind[TokenKind["StringLiteral"] = 4] = "StringLiteral";
	TokenKind[TokenKind["Template"] = 5] = "Template";
	TokenKind[TokenKind["TemplateStringElement"] = 6] = "TemplateStringElement";
	TokenKind[TokenKind["TemplateExprElement"] = 7] = "TemplateExprElement";
	TokenKind[TokenKind["NullKeyword"] = 8] = "NullKeyword";
	TokenKind[TokenKind["TrueKeyword"] = 9] = "TrueKeyword";
	TokenKind[TokenKind["FalseKeyword"] = 10] = "FalseKeyword";
	TokenKind[TokenKind["EachKeyword"] = 11] = "EachKeyword";
	TokenKind[TokenKind["ForKeyword"] = 12] = "ForKeyword";
	TokenKind[TokenKind["LoopKeyword"] = 13] = "LoopKeyword";
	TokenKind[TokenKind["DoKeyword"] = 14] = "DoKeyword";
	TokenKind[TokenKind["WhileKeyword"] = 15] = "WhileKeyword";
	TokenKind[TokenKind["BreakKeyword"] = 16] = "BreakKeyword";
	TokenKind[TokenKind["ContinueKeyword"] = 17] = "ContinueKeyword";
	TokenKind[TokenKind["MatchKeyword"] = 18] = "MatchKeyword";
	TokenKind[TokenKind["CaseKeyword"] = 19] = "CaseKeyword";
	TokenKind[TokenKind["DefaultKeyword"] = 20] = "DefaultKeyword";
	TokenKind[TokenKind["IfKeyword"] = 21] = "IfKeyword";
	TokenKind[TokenKind["ElifKeyword"] = 22] = "ElifKeyword";
	TokenKind[TokenKind["ElseKeyword"] = 23] = "ElseKeyword";
	TokenKind[TokenKind["ReturnKeyword"] = 24] = "ReturnKeyword";
	TokenKind[TokenKind["EvalKeyword"] = 25] = "EvalKeyword";
	TokenKind[TokenKind["VarKeyword"] = 26] = "VarKeyword";
	TokenKind[TokenKind["LetKeyword"] = 27] = "LetKeyword";
	TokenKind[TokenKind["ExistsKeyword"] = 28] = "ExistsKeyword";
	/** "!" */
	TokenKind[TokenKind["Not"] = 29] = "Not";
	/** "!=" */
	TokenKind[TokenKind["NotEq"] = 30] = "NotEq";
	/** "#" */
	TokenKind[TokenKind["Sharp"] = 31] = "Sharp";
	/** "#[" */
	TokenKind[TokenKind["OpenSharpBracket"] = 32] = "OpenSharpBracket";
	/** "###" */
	TokenKind[TokenKind["Sharp3"] = 33] = "Sharp3";
	/** "%" */
	TokenKind[TokenKind["Percent"] = 34] = "Percent";
	/** "&&" */
	TokenKind[TokenKind["And2"] = 35] = "And2";
	/** "(" */
	TokenKind[TokenKind["OpenParen"] = 36] = "OpenParen";
	/** ")" */
	TokenKind[TokenKind["CloseParen"] = 37] = "CloseParen";
	/** "*" */
	TokenKind[TokenKind["Asterisk"] = 38] = "Asterisk";
	/** "+" */
	TokenKind[TokenKind["Plus"] = 39] = "Plus";
	/** "+=" */
	TokenKind[TokenKind["PlusEq"] = 40] = "PlusEq";
	/** "," */
	TokenKind[TokenKind["Comma"] = 41] = "Comma";
	/** "-" */
	TokenKind[TokenKind["Minus"] = 42] = "Minus";
	/** "-=" */
	TokenKind[TokenKind["MinusEq"] = 43] = "MinusEq";
	/** "." */
	TokenKind[TokenKind["Dot"] = 44] = "Dot";
	/** "/" */
	TokenKind[TokenKind["Slash"] = 45] = "Slash";
	/** ":" */
	TokenKind[TokenKind["Colon"] = 46] = "Colon";
	/** "::" */
	TokenKind[TokenKind["Colon2"] = 47] = "Colon2";
	/** ";" */
	TokenKind[TokenKind["SemiColon"] = 48] = "SemiColon";
	/** "<" */
	TokenKind[TokenKind["Lt"] = 49] = "Lt";
	/** "<=" */
	TokenKind[TokenKind["LtEq"] = 50] = "LtEq";
	/** "<:" */
	TokenKind[TokenKind["Out"] = 51] = "Out";
	/** "=" */
	TokenKind[TokenKind["Eq"] = 52] = "Eq";
	/** "==" */
	TokenKind[TokenKind["Eq2"] = 53] = "Eq2";
	/** "=>" */
	TokenKind[TokenKind["Arrow"] = 54] = "Arrow";
	/** ">" */
	TokenKind[TokenKind["Gt"] = 55] = "Gt";
	/** ">=" */
	TokenKind[TokenKind["GtEq"] = 56] = "GtEq";
	/** "?" */
	TokenKind[TokenKind["Question"] = 57] = "Question";
	/** "@" */
	TokenKind[TokenKind["At"] = 58] = "At";
	/** "[" */
	TokenKind[TokenKind["OpenBracket"] = 59] = "OpenBracket";
	/** "\\" */
	TokenKind[TokenKind["BackSlash"] = 60] = "BackSlash";
	/** "]" */
	TokenKind[TokenKind["CloseBracket"] = 61] = "CloseBracket";
	/** "^" */
	TokenKind[TokenKind["Hat"] = 62] = "Hat";
	/** "{" */
	TokenKind[TokenKind["OpenBrace"] = 63] = "OpenBrace";
	/** "|" */
	TokenKind[TokenKind["Or"] = 64] = "Or";
	/** "||" */
	TokenKind[TokenKind["Or2"] = 65] = "Or2";
	/** "}" */
	TokenKind[TokenKind["CloseBrace"] = 66] = "CloseBrace";
	/** "|>" */
	TokenKind[TokenKind["Pipe"] = 67] = "Pipe";
	return TokenKind;
}({});
var Token = class {
	kind;
	pos;
	hasLeftSpacing;
	value;
	children;
	constructor(kind, pos, hasLeftSpacing = false, value, children) {
		this.kind = kind;
		this.pos = pos;
		this.hasLeftSpacing = hasLeftSpacing;
		this.value = value;
		this.children = children;
	}
};
function TOKEN(kind, pos, opts) {
	return new Token(kind, pos, opts?.hasLeftSpacing, opts?.value, opts?.children);
}
const KEYWORDS = [
	8,
	9,
	10,
	11,
	12,
	13,
	14,
	15,
	16,
	17,
	18,
	19,
	20,
	21,
	22,
	23,
	24,
	25,
	26,
	27,
	28
];
function isKeywordTokenKind(token) {
	return KEYWORDS.includes(token);
}
function keywordTokenKindToString(token) {
	switch (token) {
		case 8: return "null";
		case 9: return "true";
		case 10: return "false";
		case 11: return "each";
		case 12: return "for";
		case 13: return "loop";
		case 14: return "do";
		case 15: return "while";
		case 16: return "break";
		case 17: return "continue";
		case 18: return "match";
		case 19: return "case";
		case 20: return "default";
		case 21: return "if";
		case 22: return "elif";
		case 23: return "else";
		case 24: return "return";
		case 25: return "eval";
		case 26: return "var";
		case 27: return "let";
		case 28: return "exists";
		default: throw new TypeError(`Unknown keyword token kind ${token}`);
	}
}

//#endregion
export { TOKEN, Token, TokenKind, isKeywordTokenKind, keywordTokenKindToString };
//# sourceMappingURL=token.js.map