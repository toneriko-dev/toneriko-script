import { JsValue } from "../interpreter/util.js";
//#region src/parser/tson.d.ts
export declare class TSON {
  static parse(input: string): JsValue;
  private static stringifyWalk;
  static stringify(value: JsValue, _unused?: null, indent?: number | string): string;
}
//#endregion
//# sourceMappingURL=tson.d.ts.map