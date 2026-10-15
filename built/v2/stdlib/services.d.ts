import { Pos } from "../ast.js";
import { Value } from "../runtime/brands.js";
import { StdDefinition } from "./core.js";
//#region src/v2/stdlib/services.d.ts
export interface ServiceOptions {
  dateOffsetMinutes?: number;
  onConsoleLog?: (values: readonly Value[]) => void;
  onUnhandledError?: (error: unknown) => void;
}
/** タイマーの寿命は本体の評価ではなくインタプリタに属します。 */
export declare class RuntimeServices {
  readonly options: ServiceOptions;
  readonly signal: AbortSignal;
  private readonly invoke;
  private nextId;
  private reportedStop;
  private readonly timers;
  constructor(options: ServiceOptions, signal: AbortSignal, invoke: (fn: Value, args: Value[], pos: Pos) => Promise<Value>);
  timer(fn: Value, args: Value[], delay: number, repeat: boolean, pos: Pos): number;
  clear(id: number): void;
  sleep(delay: number): Promise<null>;
}
export declare const serviceDefinitions: StdDefinition[];
//#endregion
//# sourceMappingURL=services.d.ts.map