import { BlockStatement, Expression, Pattern, ast_d_exports } from "../ast.js";
//#region src/v2/runtime/brands.d.ts
export type Value = null | boolean | number | string | object;
export declare const SCRIPT_FUNCTION: unique symbol;
export interface ScriptFunction {
  [SCRIPT_FUNCTION]: true;
  name?: string;
  params: Pattern[];
  body: BlockStatement | Expression;
  environment: unknown;
}
export declare function isScriptFunction(value: unknown): value is ScriptFunction;
export declare function valueTypeof(value: Value): string;
export declare const scriptObjects: WeakSet<object>;
/** 通常の辞書と配列の作成元だけを記録し、ホストへ渡した後も現在の原型を別に確かめます。 */
export declare function scriptObject<T extends object>(value: T): T;
//#endregion
//# sourceMappingURL=brands.d.ts.map