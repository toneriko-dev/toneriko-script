import { Meta, Namespace, Node, node_d_exports } from "../../node.js";
import { ITokenStream } from "../streams/token-stream.js";
//#region src/parser/syntaxes/toplevel.d.ts
/**
 * ```abnf
 * TopLevel = *(Namespace / Meta / Statement)
 * ```
 */
export declare function parseTopLevel(s: ITokenStream): Node[];
/**
 * ```abnf
 * Namespace = "::" IDENT "{" *(DefStatement / StatementWithAttr / Namespace) "}"
 * ```
 */
export declare function parseNamespace(s: ITokenStream): Namespace;
/**
 * ```abnf
 * Meta = "###" [IDENT] StaticExpr
 * ```
 */
export declare function parseMeta(s: ITokenStream): Meta;
//#endregion
//# sourceMappingURL=toplevel.d.ts.map