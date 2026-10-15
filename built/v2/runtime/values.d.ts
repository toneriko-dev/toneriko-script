import { Pos, ast_d_exports } from "../ast.js";
import { SCRIPT_FUNCTION, ScriptFunction, Value, isScriptFunction, scriptObject, valueTypeof } from "./brands.js";
import { GraphemeSearchInfo } from "./strings.js";
//#region src/v2/runtime/values.d.ts
export declare function errorValue(value: unknown, pos?: Pos): value is object;
/** プロパティ操作は原型を参照せず、書記素のキャッシュを実行単位で共有する。 */
export declare class PropertyAccess {
  private readonly onStep;
  private readonly strings;
  errorValue(value: unknown, pos: Pos): boolean;
  constructor(onStep?: () => void);
  clear(): void;
  normalize(value: unknown, pos: Pos): Value;
  key(value: unknown, pos: Pos): string;
  private stringInfo;
  /** 64 要素以下の区間で制御を返し、評価器が時間の上限と譲る時刻を確認できるようにする。 */
  prepare(value: unknown, pos: Pos, parts?: boolean): Generator<void, void>;
  prepareSearch(value: string): Generator<void, GraphemeSearchInfo>;
  concat(left: string, right: string): string;
  graphemes(value: string): readonly string[];
  get(value: unknown, property: unknown, pos: Pos): Value;
  set(value: unknown, property: unknown, next: unknown, pos: Pos): Value;
  has(value: unknown, property: unknown, pos: Pos): boolean;
  delete(value: unknown, property: unknown, pos: Pos): boolean;
  entries(value: unknown, pos: Pos): [string, Value][];
  entriesIterator(value: unknown, pos: Pos): Generator<[string, Value], void>;
  iterable(value: unknown, pos: Pos): Value[];
  iterableIterator(value: unknown, pos: Pos): Generator<Value, void>;
  private iterate;
}
//#endregion
export { SCRIPT_FUNCTION, type ScriptFunction, type Value, isScriptFunction, scriptObject, valueTypeof };
//# sourceMappingURL=values.d.ts.map