import { TOKEN, TokenKind } from "../token.js";
import { unexpectedTokenError } from "../utils.js";

//#region src/parser/streams/token-stream.ts
var TokenStream = class {
	source;
	index;
	_token;
	constructor(source) {
		this.source = source;
		this.index = 0;
		this.load();
	}
	get eof() {
		return this.index >= this.source.length;
	}
	getToken() {
		if (this.eof) return TOKEN(0, {
			line: -1,
			column: -1
		});
		return this._token;
	}
	is(kind) {
		return this.getTokenKind() === kind;
	}
	getTokenValue() {
		return this.getToken().value;
	}
	getTokenKind() {
		return this.getToken().kind;
	}
	getPos() {
		return this.getToken().pos;
	}
	next() {
		if (!this.eof) this.index++;
		this.load();
	}
	lookahead(offset) {
		if (this.index + offset < this.source.length) return this.source[this.index + offset];
		return TOKEN(0, {
			line: -1,
			column: -1
		});
	}
	expect(kind) {
		if (!this.is(kind)) throw unexpectedTokenError(this.getTokenKind(), this.getPos());
	}
	load() {
		if (this.eof) this._token = TOKEN(0, {
			line: -1,
			column: -1
		});
		else this._token = this.source[this.index];
	}
};

//#endregion
export { TokenStream };
//# sourceMappingURL=token-stream.js.map