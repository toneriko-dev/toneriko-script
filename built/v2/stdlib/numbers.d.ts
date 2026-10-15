import { StdDefinition } from "./core.js";
//#region src/v2/stdlib/numbers.d.ts
export declare const mathConstants: Readonly<{
  E: number;
  LN10: number;
  LN2: number;
  LOG10E: number;
  LOG2E: number;
  PI: number;
  SQRT1_2: number;
  SQRT2: number;
}>;
/** 種の byte 順と演算の桁あふれは、実行環境に依存しない乱数列の仕様です。 */
export declare function seededRandom(seed: string | number): () => number;
export declare const numberDefinitions: StdDefinition[];
//#endregion
//# sourceMappingURL=numbers.d.ts.map