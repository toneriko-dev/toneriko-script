import { TOKEN, TokenKind } from '../token.js';
import { unexpectedTokenError } from '../utils.js';
import type { Token, TokenPosition } from '../token.js';

export interface ITokenStream {
	getToken(): Token;

	is(kind: TokenKind): boolean;

	getTokenKind(): TokenKind;

	getTokenValue(): string;

	getPos(): TokenPosition;

	next(): void;

	lookahead(offset: number): Token;

	expect(kind: TokenKind): void;
}

export class TokenStream implements ITokenStream {
	private source: Token[];
	private index: number;
	private _token!: Token; // constructorから必ず呼ばれるload()内で代入される

	constructor(source: TokenStream['source']) {
		this.source = source;
		this.index = 0;
		this.load();
	}

	private get eof(): boolean {
		return (this.index >= this.source.length);
	}

	public getToken(): Token {
		if (this.eof) {
			return TOKEN(TokenKind.EOF, { line: -1, column: -1 });
		}
		return this._token;
	}

	public is(kind: TokenKind): boolean {
		return this.getTokenKind() === kind;
	}

	public getTokenValue(): string {
		return this.getToken().value!;
	}

	public getTokenKind(): TokenKind {
		return this.getToken().kind;
	}

	public getPos(): TokenPosition {
		return this.getToken().pos;
	}

	public next(): void {
		if (!this.eof) {
			this.index++;
		}
		this.load();
	}

	public lookahead(offset: number): Token {
		if (this.index + offset < this.source.length) {
			return this.source[this.index + offset]!;
		} else {
			return TOKEN(TokenKind.EOF, { line: -1, column: -1 });
		}
	}

	public expect(kind: TokenKind): void {
		if (!this.is(kind)) {
			throw unexpectedTokenError(this.getTokenKind(), this.getPos());
		}
	}

	private load(): void {
		if (this.eof) {
			this._token = TOKEN(TokenKind.EOF, { line: -1, column: -1 });
		} else {
			this._token = this.source[this.index]!;
		}
	}
}
