import { RandomBase } from "./randomBase.js";
//#region src/utils/random/CryptoGen.d.ts
export declare class CryptoGen extends RandomBase {
  private static _instance;
  static get instance(): CryptoGen;
  private constructor();
  protected generateBigUintByBytes(bytes: number): bigint;
  generateBigUintByBits(bits: number): bigint;
  generateBytes(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}
//#endregion
//# sourceMappingURL=CryptoGen.d.ts.map