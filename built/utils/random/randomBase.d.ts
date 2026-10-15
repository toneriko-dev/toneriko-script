//#region src/utils/random/randomBase.d.ts
export declare const safeIntegerBits: number;
export declare abstract class RandomBase {
  protected abstract generateBigUintByBytes(bytes: number): bigint;
  abstract generateBigUintByBits(bits: number): bigint;
  abstract generateBytes(array: Uint8Array): Uint8Array;
  generateNumber0To1(): number;
  generateUniform(maxInclusive: bigint): bigint;
  generateRandomIntegerInRange(min: number, max: number): number | null;
}
export declare function bitsToRepresent(num: bigint): number;
export declare function readBigUintLittleEndian(buffer: ArrayBufferLike): bigint | null;
//#endregion
//# sourceMappingURL=randomBase.d.ts.map