//#region src/parser/streams/char-stream.d.ts
export declare class CharStream {
  private pages;
  private firstPageIndex;
  private lastPageIndex;
  private pageIndex;
  private address;
  private _char?;
  private line;
  private column;
  constructor(source: string, opts?: {
    line?: number;
    column?: number;
  });
  get eof(): boolean;
  get char(): string;
  getPos(): {
    line: number;
    column: number;
  };
  next(): void;
  prev(): void;
  private get isFirstPage();
  private get isLastPage();
  private get endOfPage();
  private get startOfFile();
  private moveNext;
  private incAddr;
  private movePrev;
  private decAddr;
  private loadChar;
  private loadPrevChar;
}
//#endregion
//# sourceMappingURL=char-stream.d.ts.map