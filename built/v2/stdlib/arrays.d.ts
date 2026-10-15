import { Pos } from "../ast.js";
import { Value } from "../runtime/brands.js";
import { PropertyAccess } from "../runtime/values.js";
import { StdContext, StdDefinition, StdFunction } from "./core.js";
//#region src/v2/stdlib/arrays.d.ts
export declare function isArrayIterator(value: unknown): value is {
  readonly next: StdFunction;
};
export declare function nextArrayIterator(value: object, properties: PropertyAccess, pos: Pos): {
  value: Value;
  done: boolean;
};
export declare const iteratorDefinitions: StdDefinition[];
export declare function callable(ctx: StdContext, value: Value | undefined): Value;
export declare const arrayDefinitions: StdDefinition[];
//#endregion
//# sourceMappingURL=arrays.d.ts.map