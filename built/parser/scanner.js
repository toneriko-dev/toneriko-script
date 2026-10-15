import { TonerikoScriptSyntaxError, TonerikoScriptUnexpectedEOFError } from "../error.js";
import { decodeUnicodeEscapeSequence } from "../utils/characters.js";
import { CharStream } from "./streams/char-stream.js";
import { TOKEN, TokenKind } from "./token.js";
import { unexpectedTokenError } from "./utils.js";

//#region src/parser/scanner.ts
const spaceChars = [" ", "	"];
const lineBreakChars = ["\r", "\n"];
const digit = /^[0-9]$/;
const decimalDigitOrUnderscore = /^[0-9_]$/;
const hexDigitOrUnderscore = /^[0-9a-fA-F_]$/;
const binaryDigitOrUnderscore = /^[01_]$/;
const octalDigitOrUnderscore = /^[0-7_]$/;
const identifierStart = /^[A-Za-z_]$/u;
const identifierPart = /^[A-Za-z0-9_]$/u;
const hexDigit = /^[0-9a-fA-F]$/;
const exponentIndicatorPattern = /^[eE]$/;
var Scanner = class {
	stream;
	_tokens = [];
	constructor(x) {
		if (typeof x === "string") this.stream = new CharStream(x);
		else this.stream = x;
		this._tokens.push(this.readToken());
	}
	getToken() {
		return this._tokens[0];
	}
	is(kind) {
		return this.getTokenKind() === kind;
	}
	getTokenKind() {
		return this.getToken().kind;
	}
	getTokenValue() {
		return this.getToken().value;
	}
	getPos() {
		return this.getToken().pos;
	}
	next() {
		if (this._tokens[0].kind === 0) return;
		this._tokens.shift();
		if (this._tokens.length === 0) this._tokens.push(this.readToken());
	}
	lookahead(offset) {
		while (this._tokens.length <= offset) this._tokens.push(this.readToken());
		return this._tokens[offset];
	}
	expect(kind) {
		if (!this.is(kind)) throw unexpectedTokenError(this.getTokenKind(), this.getPos());
	}
	readToken() {
		let hasLeftSpacing = false;
		while (true) {
			if (this.stream.eof) return TOKEN(0, this.stream.getPos(), { hasLeftSpacing });
			if (spaceChars.includes(this.stream.char)) {
				this.stream.next();
				hasLeftSpacing = true;
				continue;
			}
			const pos = this.stream.getPos();
			if (lineBreakChars.includes(this.stream.char)) {
				this.skipEmptyLines();
				return TOKEN(1, pos, { hasLeftSpacing });
			}
			switch (this.stream.char) {
				case "!":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === "=") {
						this.stream.next();
						return TOKEN(30, pos, { hasLeftSpacing });
					}
					return TOKEN(29, pos, { hasLeftSpacing });
				case "\"":
				case "'": return this.readStringLiteral(hasLeftSpacing);
				case "#":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === "#") {
						this.stream.next();
						if (!this.stream.eof && this.stream.char === "#") {
							this.stream.next();
							return TOKEN(33, pos, { hasLeftSpacing });
						}
						throw new TonerikoScriptSyntaxError("invalid sequence of characters: \"##\"", pos);
					} else if (!this.stream.eof && this.stream.char === "[") {
						this.stream.next();
						return TOKEN(32, pos, { hasLeftSpacing });
					} else return TOKEN(31, pos, { hasLeftSpacing });
				case "%":
					this.stream.next();
					return TOKEN(34, pos, { hasLeftSpacing });
				case "&":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === "&") {
						this.stream.next();
						return TOKEN(35, pos, { hasLeftSpacing });
					}
					throw new TonerikoScriptSyntaxError("invalid character: \"&\"", pos);
				case "(":
					this.stream.next();
					return TOKEN(36, pos, { hasLeftSpacing });
				case ")":
					this.stream.next();
					return TOKEN(37, pos, { hasLeftSpacing });
				case "*":
					this.stream.next();
					return TOKEN(38, pos, { hasLeftSpacing });
				case "+":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === "=") {
						this.stream.next();
						return TOKEN(40, pos, { hasLeftSpacing });
					}
					return TOKEN(39, pos, { hasLeftSpacing });
				case ",":
					this.stream.next();
					return TOKEN(41, pos, { hasLeftSpacing });
				case "-":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === "=") {
						this.stream.next();
						return TOKEN(43, pos, { hasLeftSpacing });
					}
					return TOKEN(42, pos, { hasLeftSpacing });
				case ".":
					this.stream.next();
					return TOKEN(44, pos, { hasLeftSpacing });
				case "/":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === "*") {
						this.stream.next();
						this.skipCommentRange();
						continue;
					} else if (!this.stream.eof && this.stream.char === "/") {
						this.stream.next();
						this.skipCommentLine();
						continue;
					} else return TOKEN(45, pos, { hasLeftSpacing });
				case ":":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === ":") {
						this.stream.next();
						return TOKEN(47, pos, { hasLeftSpacing });
					}
					return TOKEN(46, pos, { hasLeftSpacing });
				case ";":
					this.stream.next();
					return TOKEN(48, pos, { hasLeftSpacing });
				case "<":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === "=") {
						this.stream.next();
						return TOKEN(50, pos, { hasLeftSpacing });
					} else if (!this.stream.eof && this.stream.char === ":") {
						this.stream.next();
						return TOKEN(51, pos, { hasLeftSpacing });
					}
					return TOKEN(49, pos, { hasLeftSpacing });
				case "=":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === "=") {
						this.stream.next();
						return TOKEN(53, pos, { hasLeftSpacing });
					} else if (!this.stream.eof && this.stream.char === ">") {
						this.stream.next();
						return TOKEN(54, pos, { hasLeftSpacing });
					}
					return TOKEN(52, pos, { hasLeftSpacing });
				case ">":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === "=") {
						this.stream.next();
						return TOKEN(56, pos, { hasLeftSpacing });
					}
					return TOKEN(55, pos, { hasLeftSpacing });
				case "?":
					this.stream.next();
					return TOKEN(57, pos, { hasLeftSpacing });
				case "@":
					this.stream.next();
					return TOKEN(58, pos, { hasLeftSpacing });
				case "[":
					this.stream.next();
					return TOKEN(59, pos, { hasLeftSpacing });
				case "\\":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === "u") {
						this.stream.prev();
						const wordToken = this.tryReadWord(hasLeftSpacing);
						if (wordToken) return wordToken;
					}
					return TOKEN(60, pos, { hasLeftSpacing });
				case "]":
					this.stream.next();
					return TOKEN(61, pos, { hasLeftSpacing });
				case "^":
					this.stream.next();
					return TOKEN(62, pos, { hasLeftSpacing });
				case "`": return this.readTemplate(hasLeftSpacing);
				case "{":
					this.stream.next();
					return TOKEN(63, pos, { hasLeftSpacing });
				case "|":
					this.stream.next();
					if (!this.stream.eof && this.stream.char === "|") {
						this.stream.next();
						return TOKEN(65, pos, { hasLeftSpacing });
					} else if (!this.stream.eof && this.stream.char === ">") {
						this.stream.next();
						return TOKEN(67, pos, { hasLeftSpacing });
					}
					return TOKEN(64, pos, { hasLeftSpacing });
				case "}":
					this.stream.next();
					return TOKEN(66, pos, { hasLeftSpacing });
				default: {
					const digitToken = this.tryReadDigits(hasLeftSpacing);
					if (digitToken) return digitToken;
					const wordToken = this.tryReadWord(hasLeftSpacing);
					if (wordToken) return wordToken;
					throw new TonerikoScriptSyntaxError(`invalid character: "${this.stream.char}"`, pos);
				}
			}
		}
	}
	tryReadWord(hasLeftSpacing) {
		if (this.stream.eof) return;
		const pos = this.stream.getPos();
		let rawValue = this.tryReadIdentifierStart();
		if (rawValue === void 0) return;
		while (!this.stream.eof) {
			const matchedIdentifierPart = this.tryReadIdentifierPart();
			if (matchedIdentifierPart === void 0) break;
			rawValue += matchedIdentifierPart;
		}
		const value = decodeUnicodeEscapeSequence(rawValue);
		if (value !== rawValue) throw new TonerikoScriptSyntaxError(`Invalid identifier: "${rawValue}"`, pos);
		switch (value) {
			case "null": return TOKEN(8, pos, { hasLeftSpacing });
			case "true": return TOKEN(9, pos, { hasLeftSpacing });
			case "false": return TOKEN(10, pos, { hasLeftSpacing });
			case "each": return TOKEN(11, pos, { hasLeftSpacing });
			case "for": return TOKEN(12, pos, { hasLeftSpacing });
			case "loop": return TOKEN(13, pos, { hasLeftSpacing });
			case "do": return TOKEN(14, pos, { hasLeftSpacing });
			case "while": return TOKEN(15, pos, { hasLeftSpacing });
			case "break": return TOKEN(16, pos, { hasLeftSpacing });
			case "continue": return TOKEN(17, pos, { hasLeftSpacing });
			case "match": return TOKEN(18, pos, { hasLeftSpacing });
			case "case": return TOKEN(19, pos, { hasLeftSpacing });
			case "default": return TOKEN(20, pos, { hasLeftSpacing });
			case "if": return TOKEN(21, pos, { hasLeftSpacing });
			case "elif": return TOKEN(22, pos, { hasLeftSpacing });
			case "else": return TOKEN(23, pos, { hasLeftSpacing });
			case "return": return TOKEN(24, pos, { hasLeftSpacing });
			case "eval": return TOKEN(25, pos, { hasLeftSpacing });
			case "var": return TOKEN(26, pos, { hasLeftSpacing });
			case "let": return TOKEN(27, pos, { hasLeftSpacing });
			case "exists": return TOKEN(28, pos, { hasLeftSpacing });
			default: return TOKEN(2, pos, {
				hasLeftSpacing,
				value
			});
		}
	}
	tryReadIdentifierStart() {
		if (this.stream.eof) return;
		if (identifierStart.test(this.stream.char)) {
			const value = this.stream.char;
			this.stream.next();
			return value;
		}
		if (this.stream.char === "\\") {
			this.stream.next();
			return "\\" + this.readUnicodeEscapeSequence();
		}
	}
	tryReadIdentifierPart() {
		if (this.stream.eof) return;
		const matchedIdentifierStart = this.tryReadIdentifierStart();
		if (matchedIdentifierStart !== void 0) return matchedIdentifierStart;
		if (identifierPart.test(this.stream.char)) {
			const value = this.stream.char;
			this.stream.next();
			return value;
		}
	}
	readUnicodeEscapeSequence() {
		if (this.stream.eof || this.stream.char !== "u") throw new TonerikoScriptSyntaxError("character \"u\" expected", this.stream.getPos());
		this.stream.next();
		let code = "";
		for (let i = 0; i < 4; i++) {
			if (this.stream.eof || !hexDigit.test(this.stream.char)) throw new TonerikoScriptSyntaxError("hexadecimal digit expected", this.stream.getPos());
			code += this.stream.char;
			this.stream.next();
		}
		return `u${code}`;
	}
	tryReadDigits(hasLeftSpacing) {
		const pos = this.stream.getPos();
		if (!this.stream.eof && this.stream.char === "0") {
			this.stream.next();
			if (!this.stream.eof && (this.stream.char === "x" || this.stream.char === "X")) {
				this.stream.next();
				const value = this.readRadixDigits(hexDigitOrUnderscore, pos, "hexadecimal");
				return TOKEN(3, pos, {
					hasLeftSpacing,
					value: "0x" + value
				});
			}
			if (!this.stream.eof && (this.stream.char === "b" || this.stream.char === "B")) {
				this.stream.next();
				const value = this.readRadixDigits(binaryDigitOrUnderscore, pos, "binary");
				return TOKEN(3, pos, {
					hasLeftSpacing,
					value: "0b" + value
				});
			}
			if (!this.stream.eof && (this.stream.char === "o" || this.stream.char === "O")) {
				this.stream.next();
				const value = this.readRadixDigits(octalDigitOrUnderscore, pos, "octal");
				return TOKEN(3, pos, {
					hasLeftSpacing,
					value: "0o" + value
				});
			}
			this.stream.prev();
		}
		if (this.stream.eof || !digit.test(this.stream.char)) return;
		let wholeNumber = this.stream.char;
		this.stream.next();
		while (!this.stream.eof && decimalDigitOrUnderscore.test(this.stream.char)) {
			wholeNumber += this.stream.char;
			this.stream.next();
		}
		this.validateNumericSeparators(wholeNumber, pos);
		let fractional = "";
		if (!this.stream.eof && this.stream.char === ".") {
			this.stream.next();
			if (this.stream.eof || !digit.test(this.stream.char)) throw new TonerikoScriptSyntaxError("digit expected", pos);
			fractional = this.stream.char;
			this.stream.next();
			while (!this.stream.eof && decimalDigitOrUnderscore.test(this.stream.char)) {
				fractional += this.stream.char;
				this.stream.next();
			}
			this.validateNumericSeparators(fractional, pos);
		}
		let exponentIndicator = "";
		let exponentSign = "";
		let exponentAbsolute = "";
		if (!this.stream.eof && exponentIndicatorPattern.test(this.stream.char)) {
			exponentIndicator = this.stream.char;
			this.stream.next();
			if (!this.stream.eof && this.stream.char === "-") {
				exponentSign = "-";
				this.stream.next();
			} else if (!this.stream.eof && this.stream.char === "+") {
				exponentSign = "+";
				this.stream.next();
			}
			if (this.stream.eof || !digit.test(this.stream.char)) throw new TonerikoScriptSyntaxError("exponent expected", pos);
			exponentAbsolute = this.stream.char;
			this.stream.next();
			while (!this.stream.eof && decimalDigitOrUnderscore.test(this.stream.char)) {
				exponentAbsolute += this.stream.char;
				this.stream.next();
			}
			this.validateNumericSeparators(exponentAbsolute, pos);
		}
		let value = wholeNumber.replaceAll("_", "");
		if (fractional.length > 0) value += "." + fractional.replaceAll("_", "");
		if (exponentIndicator.length > 0) value += exponentIndicator + exponentSign + exponentAbsolute.replaceAll("_", "");
		return TOKEN(3, pos, {
			hasLeftSpacing,
			value
		});
	}
	readRadixDigits(pattern, pos, radixName) {
		let raw = "";
		while (!this.stream.eof && pattern.test(this.stream.char)) {
			raw += this.stream.char;
			this.stream.next();
		}
		this.validateNumericSeparators(raw, pos);
		const value = raw.replaceAll("_", "");
		if (value.length === 0) throw new TonerikoScriptSyntaxError(`${radixName} digit expected`, pos);
		return value;
	}
	validateNumericSeparators(value, pos) {
		if (value.startsWith("_") || value.endsWith("_") || value.includes("__")) throw new TonerikoScriptSyntaxError("numeric separator must be placed between digits", pos);
	}
	readStringLiteral(hasLeftSpacing) {
		let value = "";
		const literalMark = this.stream.char;
		let state = "string";
		const pos = this.stream.getPos();
		this.stream.next();
		while (state !== "finish") switch (state) {
			case "string":
				if (this.stream.eof) throw new TonerikoScriptUnexpectedEOFError(pos);
				if (this.stream.char === "\\") {
					this.stream.next();
					state = "escape";
					break;
				}
				if (this.stream.char === literalMark) {
					this.stream.next();
					state = "finish";
					break;
				}
				value += this.stream.char;
				this.stream.next();
				break;
			case "escape":
				value += this.readEscapeSequence(pos);
				state = "string";
		}
		return TOKEN(4, pos, {
			hasLeftSpacing,
			value
		});
	}
	/**
	* 呼び出し時点で先頭の `\` は消費済み。未知のエスケープは次の文字をそのまま返す。
	*/
	readEscapeSequence(literalStartPos) {
		if (this.stream.eof) throw new TonerikoScriptUnexpectedEOFError(literalStartPos);
		const escapeChar = this.stream.char;
		switch (escapeChar) {
			case "n":
				this.stream.next();
				return "\n";
			case "t":
				this.stream.next();
				return "	";
			case "r":
				this.stream.next();
				return "\r";
			case "0":
				this.stream.next();
				return "\0";
			case "b":
				this.stream.next();
				return "\b";
			case "f":
				this.stream.next();
				return "\f";
			case "v":
				this.stream.next();
				return "\v";
			case "u": {
				const code = this.readUnicodeEscapeSequence().slice(1);
				return String.fromCharCode(Number.parseInt(code, 16));
			}
			default:
				this.stream.next();
				return escapeChar;
		}
	}
	readTemplate(hasLeftSpacing) {
		const elements = [];
		let buf = "";
		let tokenBuf = [];
		let state = "string";
		let exprBracketDepth = 0;
		const pos = this.stream.getPos();
		let elementPos = pos;
		this.stream.next();
		while (state !== "finish") switch (state) {
			case "string":
				if (this.stream.eof) throw new TonerikoScriptUnexpectedEOFError(pos);
				if (this.stream.char === "\\") {
					this.stream.next();
					state = "escape";
					break;
				}
				if (this.stream.char === "`") {
					this.stream.next();
					if (buf.length > 0) elements.push(TOKEN(6, elementPos, {
						hasLeftSpacing,
						value: buf
					}));
					state = "finish";
					break;
				}
				if (this.stream.char === "{") {
					this.stream.next();
					if (buf.length > 0) {
						elements.push(TOKEN(6, elementPos, {
							hasLeftSpacing,
							value: buf
						}));
						buf = "";
					}
					elementPos = this.stream.getPos();
					state = "expr";
					break;
				}
				buf += this.stream.char;
				this.stream.next();
				break;
			case "escape":
				buf += this.readEscapeSequence(pos);
				state = "string";
				break;
			case "expr": {
				if (this.stream.eof) throw new TonerikoScriptUnexpectedEOFError(pos);
				if (spaceChars.includes(this.stream.char)) {
					this.stream.next();
					continue;
				}
				if (this.stream.char === "{") exprBracketDepth++;
				if (this.stream.char === "}") {
					if (exprBracketDepth === 0) {
						elements.push(TOKEN(7, elementPos, {
							hasLeftSpacing,
							children: tokenBuf
						}));
						elementPos = this.stream.getPos();
						tokenBuf.push(TOKEN(0, elementPos));
						tokenBuf = [];
						state = "string";
						this.stream.next();
						break;
					}
					exprBracketDepth--;
				}
				const token = this.readToken();
				tokenBuf.push(token);
				break;
			}
		}
		return TOKEN(5, pos, {
			hasLeftSpacing,
			children: elements
		});
	}
	skipEmptyLines() {
		while (!this.stream.eof) {
			if (spaceChars.includes(this.stream.char) || lineBreakChars.includes(this.stream.char)) {
				this.stream.next();
				continue;
			}
			if (this.stream.char === "/") {
				this.stream.next();
				if (!this.stream.eof && this.stream.char === "*") {
					this.stream.next();
					this.skipCommentRange();
					continue;
				} else if (!this.stream.eof && this.stream.char === "/") {
					this.stream.next();
					this.skipCommentLine();
					continue;
				} else {
					this.stream.prev();
					break;
				}
			}
			break;
		}
	}
	skipCommentLine() {
		while (true) {
			if (this.stream.eof) break;
			if (this.stream.char === "\n") break;
			this.stream.next();
		}
	}
	skipCommentRange() {
		let depth = 1;
		while (depth > 0) {
			if (this.stream.eof) throw new TonerikoScriptUnexpectedEOFError(this.stream.getPos());
			if (this.stream.char === "/") {
				this.stream.next();
				if (!this.stream.eof && this.stream.char === "*") {
					this.stream.next();
					depth++;
				}
				continue;
			}
			if (this.stream.char === "*") {
				this.stream.next();
				if (this.stream.eof) throw new TonerikoScriptUnexpectedEOFError(this.stream.getPos());
				if (this.stream.char === "/") {
					this.stream.next();
					depth--;
				}
				continue;
			}
			this.stream.next();
		}
	}
};

//#endregion
export { Scanner };
//# sourceMappingURL=scanner.js.map