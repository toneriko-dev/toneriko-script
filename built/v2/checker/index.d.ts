import { Program, ast_d_exports } from "../ast.js";
import { CatalogEntry } from "../catalog.js";
import { Diagnostic } from "../diagnostics.js";
//#region src/v2/checker/index.d.ts
export type CheckOptions = {
  globals?: readonly string[];
  hostCatalog?: readonly CatalogEntry[];
};
/** 明示された注釈と構文だけを検査し、変数の値から型や呼出し先を推論しません。 */
export declare function check(program: Program, options?: CheckOptions): Diagnostic[];
//#endregion
//# sourceMappingURL=index.d.ts.map