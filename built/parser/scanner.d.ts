import { CharStream } from "./streams/char-stream.js";
import { Token, TokenKind, TokenPosition } from "./token.js";
import { ITokenStream } from "./streams/token-stream.js";
//#region src/parser/scanner.d.ts
export declare class Scanner implements ITokenStream {
  private stream;
  private _tokens;
  constructor(source: string);
  constructor(stream: CharStream);
  getToken(): Token;
  is(kind: TokenKind): boolean;
  getTokenKind(): TokenKind;
  getTokenValue(): string;
  getPos(): TokenPosition;
  next(): void;
  lookahead(offset: number): Token;
  expect(kind: TokenKind): void;
  private readToken;
  private tryReadWord;
  private tryReadIdentifierStart;
  private tryReadIdentifierPart;
  private readUnicodeEscapeSequence;
  private tryReadDigits;
  private readRadixDigits;
  private validateNumericSeparators;
  private readStringLiteral;
  /**
   * 呼び出し時点で先頭の `\` は消費済み。未知のエスケープは次の文字をそのまま返す。
   */
  private readEscapeSequence;
  private readTemplate;
  private skipEmptyLines;
  private skipCommentLine;
  private skipCommentRange;
}
//#endregion
//# sourceMappingURL=scanner.d.ts.map