import { TypeParam, TypeSource, node_d_exports } from "../../node.js";
import { ITokenStream } from "../streams/token-stream.js";
//#region src/parser/syntaxes/types.d.ts
/**
 * ```abnf
 * Type = UnionType
 * ```
 */
export declare function parseType(s: ITokenStream): TypeSource;
/**
 * ```abnf
 * TypeParams = "<" TypeParam *(SEP TypeParam) [SEP] ">"
 * ```
 */
export declare function parseTypeParams(s: ITokenStream): TypeParam[];
//#endregion
//# sourceMappingURL=types.d.ts.map