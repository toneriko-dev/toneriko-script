import { CatalogArgument } from "../catalog.js";
import { Value } from "../runtime/brands.js";
import { StdDefinition, StdFunction } from "./core.js";
//#region src/v2/stdlib/index.d.ts
export declare const definitions: readonly StdDefinition[];
export declare const constantDefinitions: {
  name: string;
  value: number;
  description: {
    ja: string;
    en: string;
  };
  receiver: 'global';
  kind: 'constant';
  args: never[];
  returns: string;
}[];
export declare const catalog: {
  name: string;
  receiver: 'global' | 'array' | 'string' | 'number' | 'iterator';
  args: readonly CatalogArgument[];
  returns: string;
  description: {
    ja: string;
    en: string;
  };
}[];
export declare function standardMethod(type: 'array' | 'string' | 'number' | 'iterator', name: string): StdFunction | null;
export declare function standardGlobals(): Record<string, Value>;
//#endregion
//# sourceMappingURL=index.d.ts.map