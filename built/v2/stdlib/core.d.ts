import { Pos } from "../ast.js";
import { CatalogArgument, CatalogFunction } from "../catalog.js";
import { Value } from "../runtime/brands.js";
import { PropertyAccess } from "../runtime/values.js";
import { RuntimeServices } from "./services.js";
//#region src/v2/stdlib/core.d.ts
export type StdFrame = Generator<any, Value, any>;
export interface StdContext {
  pos: Pos;
  services?: RuntimeServices;
  wait?(promise: PromiseLike<unknown>): StdFrame;
  parallel?(fn: Value, args: Value[]): Promise<Value>;
  properties: PropertyAccess;
  tick(): void;
  checkpoint(): StdFrame;
  call(fn: Value, args: Value[], receiver?: Value): StdFrame | {
    ready: Value;
  };
}
export interface StdDefinition extends CatalogFunction {
  implementation(ctx: StdContext, receiver: Value, args: Value[]): StdFrame;
}
export declare const STANDARD_FUNCTION: unique symbol;
export interface StdFunction {
  [STANDARD_FUNCTION]: StdDefinition;
}
export declare function isStdFunction(value: unknown): value is StdFunction;
export declare function makeFunction(definition: StdDefinition): StdFunction;
export declare function requireNumber(ctx: StdContext, value: unknown): number;
export declare function requireString(ctx: StdContext, value: unknown): string;
export declare function requireArray(ctx: StdContext, value: unknown): Value[];
export declare function validateArguments(ctx: StdContext, definition: StdDefinition, args: Value[]): void;
export declare function catalogOf(definitions: readonly StdDefinition[]): {
  name: string;
  receiver: 'global' | 'array' | 'string' | 'number' | 'iterator';
  args: readonly CatalogArgument[];
  returns: string;
  description: {
    ja: string;
    en: string;
  };
}[];
//#endregion
//# sourceMappingURL=core.d.ts.map