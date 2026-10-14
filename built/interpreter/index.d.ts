import { Node, node_d_exports } from "../node.js";
import { TonerikoScriptError } from "../error.js";
import { VFn, Value } from "./value.js";
import { Variable } from "./variable.js";
import { Scope } from "./scope.js";
import { JsValue } from "./util.js";
//#region src/interpreter/index.d.ts
export type LogObject = {
  scope?: string;
  var?: string;
  val?: Value | Variable;
};
export declare class Interpreter {
  private opts;
  stepCount: number;
  private stop;
  private pausing;
  scope: Scope;
  private abortHandlers;
  private pauseHandlers;
  private unpauseHandlers;
  private vars;
  private irqRate;
  private irqSleep;
  constructor(consts: Record<string, Value>, opts?: {
    in?(q: string): Promise<string>;
    out?(value: Value): void;
    err?(e: TonerikoScriptError): void;
    log?(type: string, params: LogObject): void;
    maxStep?: number;
    abortOnError?: boolean;
    irqRate?: number;
    irqSleep?: number | (() => Promise<void>);
  });
  exec(script?: Node[]): Promise<void>;
  execSync(script?: Node[]): Value | undefined;
  /**
   * Toneriko Script の関数を実行する。err が設定されていれば abortOnError に応じて abort を実行し、
   * err を呼び出して `error<func_failed>` を返す。未設定なら例外を送出する。
   */
  execFn(fn: VFn, args: Value[]): Promise<Value>;
  execFnSync(fn: VFn, args: Value[]): Value;
  /** Toneriko Script の関数を実行し、エラー時に err や abort を呼ばず例外をそのまま送出する。 */
  execFnSimple(fn: VFn, args: Value[]): Promise<Value>;
  static collectMetadata(script?: Node[]): Map<string | null, JsValue> | undefined;
  private handleError;
  private log;
  private collectNs;
  private collectNsSync;
  private collectNsMember;
  private collectNsMemberSync;
  private _fn;
  private _fnSync;
  private _evalClause;
  private _evalClauseSync;
  private _evalBinaryOperation;
  private _evalBinaryOperationSync;
  private _eval;
  private _evalSync;
  private __eval;
  private __evalSync;
  private _run;
  private _runSync;
  registerAbortHandler(handler: () => void): void;
  registerPauseHandler(handler: () => void): void;
  registerUnpauseHandler(handler: () => void): void;
  unregisterAbortHandler(handler: () => void): void;
  unregisterPauseHandler(handler: () => void): void;
  unregisterUnpauseHandler(handler: () => void): void;
  abort(): void;
  pause(): void;
  unpause(): void;
  private evalAndSetAttr;
  private evalAndSetAttrSync;
  private define;
  private getReference;
  private getReferenceSync;
}
//#endregion
//# sourceMappingURL=index.d.ts.map