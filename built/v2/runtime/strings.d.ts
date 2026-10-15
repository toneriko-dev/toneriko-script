//#region src/v2/runtime/strings.d.ts
export type GraphemeSearchInfo = {
  length: number;
  offsets: readonly number[] | null;
  boundaries: ReadonlyMap<number, number> | null;
};
export type GraphemeInfo = {
  search?: GraphemeSearchInfo;
  length: number;
  parts: readonly string[] | null;
  ascii: boolean;
  startsLF: boolean;
  endsCR: boolean;
  first: string;
  last: string;
};
export type GraphemeCacheLimits = {
  maxEntries?: number;
  maxCharacters?: number;
};
/** 長さが増える連結結果をハッシュせず、保持する文字数と件数を制限する。 */
export declare class GraphemeCache {
  private readonly onStep;
  private readonly recent;
  private readonly lengths;
  private stringComparisons;
  private characters;
  private scanned;
  private segmented;
  private readonly maxEntries;
  private readonly maxCharacters;
  private readonly segmenter;
  constructor(onStep?: () => void, limits?: GraphemeCacheLimits);
  get stats(): {
    cacheEntries: number;
    cacheCharacters: number;
    scannedCharacters: number;
    segmentedStrings: number;
    stringComparisons: number;
  };
  clear(): void;
  private find;
  private removeOldest;
  private remember;
  private split;
  prepare(value: string): Generator<void, GraphemeInfo>;
  info(value: string): GraphemeInfo;
  /** 添字用の配列は必要なときだけ作り、length の取得では作らない。 */
  prepareParts(value: string): Generator<void, GraphemeInfo>;
  /** 検索の位置変換は分割結果と一緒に保持し、同じ文字列の反復検索で作り直さない。 */
  prepareSearch(value: string): Generator<void, GraphemeSearchInfo>;
  at(value: string, index: number): string | undefined;
  /** 反復中は分割結果を保持し、キャッシュから消えても分割し直しません。 */
  units(value: string): string | readonly string[];
  graphemes(value: string): readonly string[];
  concat(left: string, right: string): string;
}
//#endregion
//# sourceMappingURL=strings.d.ts.map