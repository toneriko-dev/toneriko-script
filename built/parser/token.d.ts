//#region src/parser/token.d.ts
export declare enum TokenKind {
  EOF = 0,
  NewLine = 1,
  Identifier = 2,
  NumberLiteral = 3,
  StringLiteral = 4,
  Template = 5,
  TemplateStringElement = 6,
  TemplateExprElement = 7,
  NullKeyword = 8,
  TrueKeyword = 9,
  FalseKeyword = 10,
  EachKeyword = 11,
  ForKeyword = 12,
  LoopKeyword = 13,
  DoKeyword = 14,
  WhileKeyword = 15,
  BreakKeyword = 16,
  ContinueKeyword = 17,
  MatchKeyword = 18,
  CaseKeyword = 19,
  DefaultKeyword = 20,
  IfKeyword = 21,
  ElifKeyword = 22,
  ElseKeyword = 23,
  ReturnKeyword = 24,
  EvalKeyword = 25,
  VarKeyword = 26,
  LetKeyword = 27,
  ExistsKeyword = 28,
  /** "!" */
  Not = 29,
  /** "!=" */
  NotEq = 30,
  /** "#" */
  Sharp = 31,
  /** "#[" */
  OpenSharpBracket = 32,
  /** "###" */
  Sharp3 = 33,
  /** "%" */
  Percent = 34,
  /** "&&" */
  And2 = 35,
  /** "(" */
  OpenParen = 36,
  /** ")" */
  CloseParen = 37,
  /** "*" */
  Asterisk = 38,
  /** "+" */
  Plus = 39,
  /** "+=" */
  PlusEq = 40,
  /** "," */
  Comma = 41,
  /** "-" */
  Minus = 42,
  /** "-=" */
  MinusEq = 43,
  /** "." */
  Dot = 44,
  /** "/" */
  Slash = 45,
  /** ":" */
  Colon = 46,
  /** "::" */
  Colon2 = 47,
  /** ";" */
  SemiColon = 48,
  /** "<" */
  Lt = 49,
  /** "<=" */
  LtEq = 50,
  /** "<:" */
  Out = 51,
  /** "=" */
  Eq = 52,
  /** "==" */
  Eq2 = 53,
  /** "=>" */
  Arrow = 54,
  /** ">" */
  Gt = 55,
  /** ">=" */
  GtEq = 56,
  /** "?" */
  Question = 57,
  /** "@" */
  At = 58,
  /** "[" */
  OpenBracket = 59,
  /** "\\" */
  BackSlash = 60,
  /** "]" */
  CloseBracket = 61,
  /** "^" */
  Hat = 62,
  /** "{" */
  OpenBrace = 63,
  /** "|" */
  Or = 64,
  /** "||" */
  Or2 = 65,
  /** "}" */
  CloseBrace = 66,
  /** "|>" */
  Pipe = 67
}
export type TokenPosition = {
  column: number;
  line: number;
};
export declare class Token {
  kind: TokenKind;
  pos: TokenPosition;
  hasLeftSpacing: boolean;
  value?: string | undefined;
  children?: Token[] | undefined;
  constructor(kind: TokenKind, pos: TokenPosition, hasLeftSpacing?: boolean, value?: string | undefined, children?: Token[] | undefined);
}
export declare function TOKEN(kind: TokenKind, pos: TokenPosition, opts?: {
  hasLeftSpacing?: boolean;
  value?: Token['value'];
  children?: Token['children'];
}): Token;
declare const KEYWORDS: readonly [TokenKind.NullKeyword, TokenKind.TrueKeyword, TokenKind.FalseKeyword, TokenKind.EachKeyword, TokenKind.ForKeyword, TokenKind.LoopKeyword, TokenKind.DoKeyword, TokenKind.WhileKeyword, TokenKind.BreakKeyword, TokenKind.ContinueKeyword, TokenKind.MatchKeyword, TokenKind.CaseKeyword, TokenKind.DefaultKeyword, TokenKind.IfKeyword, TokenKind.ElifKeyword, TokenKind.ElseKeyword, TokenKind.ReturnKeyword, TokenKind.EvalKeyword, TokenKind.VarKeyword, TokenKind.LetKeyword, TokenKind.ExistsKeyword];
export type KeywordTokenKind = (typeof KEYWORDS)[number];
export declare function isKeywordTokenKind(token: TokenKind): token is KeywordTokenKind;
export declare function keywordTokenKindToString(token: KeywordTokenKind): string;
//#endregion
//# sourceMappingURL=token.d.ts.map