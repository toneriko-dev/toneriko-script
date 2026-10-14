import { Definition, Expression, Statement, node_d_exports } from "../../node.js";
import { ITokenStream } from "../streams/token-stream.js";
//#region src/parser/syntaxes/statements.d.ts
export declare function parseStatement(s: ITokenStream): Statement | Expression;
/**
 * ```abnf
 * DefStatement = VarDef / FnDef
 * ```
 */
export declare function parseDefStatement(s: ITokenStream): Definition;
/**
 * ```abnf
 * BlockOrStatement = Block / Statement
 * ```
 */
export declare function parseBlockOrStatement(s: ITokenStream): Statement | Expression;
/**
 * ```abnf
 * StatementWithAttr = *(Attr NewLine) DefStatement
 * ```
 */
export declare function parseStatementWithAttr(s: ITokenStream): Definition;
//#endregion
//# sourceMappingURL=statements.d.ts.map