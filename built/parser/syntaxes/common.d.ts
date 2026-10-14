import { Expression, Fn, Statement, node_d_exports } from "../../node.js";
import { ITokenStream } from "../streams/token-stream.js";
//#region src/parser/syntaxes/common.d.ts
/**
 * ```abnf
 * Dest = IDENT / Expr
 * ```
 */
export declare function parseDest(s: ITokenStream): Expression;
/**
 * ```abnf
 * Params = "(" [Param *(SEP Param) [SEP]] ")"
 * Param = Dest ["?" / ("=" Expr)] [":" Type]
 * ```
 */
export declare function parseParams(s: ITokenStream): Fn['params'];
/**
 * ```abnf
 * Block = "{" *Statement "}"
 * ```
 */
export declare function parseBlock(s: ITokenStream): (Statement | Expression)[];
/**
 * ```abnf
 * Label = "#" IDENT
 * ```
 */
export declare function parseLabel(s: ITokenStream): string;
/**
 * ```abnf
 * OptionalSeparator = [SEP]
 * ```
 */
export declare function parseOptionalSeparator(s: ITokenStream): boolean;
//#endregion
//# sourceMappingURL=common.d.ts.map