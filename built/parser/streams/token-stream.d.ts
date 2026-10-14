import { Token, TokenKind, TokenPosition } from "../token.js";
//#region src/parser/streams/token-stream.d.ts
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
export declare class TokenStream implements ITokenStream {
  private source;
  private index;
  private _token;
  constructor(source: TokenStream['source']);
  private get eof();
  getToken(): Token;
  is(kind: TokenKind): boolean;
  getTokenValue(): string;
  getTokenKind(): TokenKind;
  getPos(): TokenPosition;
  next(): void;
  lookahead(offset: number): Token;
  expect(kind: TokenKind): void;
  private load;
}
//#endregion
//# sourceMappingURL=token-stream.d.ts.map