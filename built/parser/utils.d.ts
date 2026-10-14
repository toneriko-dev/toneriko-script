import { Call, Expression, Node, Pos, node_d_exports } from "../node.js";
import { TonerikoScriptError } from "../error.js";
import { TokenKind } from "./token.js";
//#region src/parser/utils.d.ts
export declare function NODE<T extends Node['type']>(type: T, params: Omit<Extract<Node, {
  type: T;
}>, 'type' | 'loc'>, start: Pos, end: Pos): Extract<Node, {
  type: T;
}>;
export declare function CALL_NODE(name: string, args: Expression[], start: Pos, end: Pos): Call;
export declare function unexpectedTokenError(token: TokenKind, pos: Pos, info?: unknown): TonerikoScriptError;
//#endregion
//# sourceMappingURL=utils.d.ts.map