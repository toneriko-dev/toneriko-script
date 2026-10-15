import { Loc } from "../../node.js";
//#region src/v2/parser/scanner.d.ts
export type Token = {
  kind: 'identifier' | 'number' | 'string' | 'punctuator' | 'templateHead' | 'templateMiddle' | 'templateTail' | 'template' | 'eof';
  value: string | number;
  raw: string;
  start: number;
  end: number;
  loc: Loc;
  lineBreakBefore: boolean;
};
export declare class Scanner {
  private readonly source;
  private offset;
  private line;
  private column;
  private readonly templates;
  constructor(source: string);
  next(): Token;
  private position;
  private peek;
  private codePoint;
  private advance;
  private token;
  private skipTrivia;
  private readIdentifier;
  private readNumber;
  private digits;
  private readString;
  private readTemplate;
  private readEscape;
  private readUnicode;
  private readHex;
}
export declare function scan(source: string): Token[];
//#endregion
//# sourceMappingURL=scanner.d.ts.map