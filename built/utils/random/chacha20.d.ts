import { RandomBase } from "./randomBase.js";
//#region src/utils/random/chacha20.d.ts
export declare class ChaCha20 extends RandomBase {
  private keynonce;
  private state;
  private buffer;
  private filledBuffer;
  private counter;
  constructor(seed?: Uint8Array | undefined);
  private fillBuffer;
  private fillBufferDirect;
  protected generateBigUintByBytes(bytes: number): bigint;
  generateBigUintByBits(bits: number): bigint;
  generateBytes(array: Uint8Array): Uint8Array;
}
//#endregion
//# sourceMappingURL=chacha20.d.ts.map