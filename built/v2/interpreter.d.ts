import { Program, ast_d_exports } from "./ast.js";
import { Value } from "./runtime/brands.js";
import { ServiceOptions } from "./stdlib/services.js";
import { ExecutionStopped, RuntimeError } from "./runtime/errors.js";
//#region src/v2/interpreter.d.ts
export type HostContext = {
  call(fn: Value, args: Value[]): Promise<Value>;
  signal: AbortSignal;
};
export declare function hostFunction(body: (args: Value[], context: HostContext) => unknown): (...args: Value[]) => unknown;
export type InterpreterOptions = ServiceOptions & {
  maxSteps?: number;
  /** 同時に実行するスクリプト関数の数を制限します。 */
  maxCallDepth?: number;
  maxBusyTime?: number;
  yieldInterval?: number;
  yieldToHost?: () => Promise<void>;
  /** 時計を注入すると、上限の境界を実時間の揺れなしに検査できます。 */
  now?: () => number;
};
export declare class Interpreter {
  private readonly options;
  stepCount: number;
  evaluationFrameCount: number;
  private synchronousNodes;
  private synchronousCallbacks;
  private readonly maxCallDepth;
  private readonly global;
  private readonly services;
  private readonly controller;
  private stopped;
  private readonly now;
  private readonly yieldInterval;
  private readonly maxBusyTime;
  private readonly yieldToHost;
  private lastClock;
  private lastYield;
  private busy;
  private yielding;
  private idleTickPending;
  private idle;
  private active;
  private readonly typePlan;
  private readonly runtimePatterns;
  private readonly functionReturns;
  private readonly simpleParameters;
  private readonly detachedFunctions;
  private checkedBinding;
  private typeExecution;
  private typesEnabled;
  private preparedWithoutTypes;
  constructor(globals?: Record<string, unknown>, options?: InterpreterOptions);
  exec(program: Program): Promise<void>;
  getGlobal(name: string): Value;
  call(fn: Value, args: Value[]): Promise<Value>;
  abort(): void;
  private execution;
  private stop;
  private tick;
  private resume;
  private armIdle;
  private checkTime;
  private wait;
  private run;
  /** 付加情報の getter や Proxy が失敗しても、例外の伝播を中断しない。 */
  private internalException;
  /** 初回だけ構文木を走査し、注釈なしの実行経路には型判定を追加しない。 */
  prepareProgram(program: Program): void;
  private tickTyped;
  private checkType;
  private installType;
  private registerPattern;
  private writeChecked;
  private checkBindingScalar;
  private writeScalar;
  private prepareTyped;
  private functionValueTyped;
  private bindTyped;
  private detachedFunction;
  private invokeTyped;
  private callbackTyped;
  private synchronousTyped;
  private evaluateTyped;
  private prepare;
  private functionValue;
  private sequence;
  private reference;
  private read;
  private write;
  private bindingReference;
  private bind;
  private text;
  private binary;
  private checkpoint;
  private prepared;
  private spread;
  private arguments;
  /** then プロパティは読まず、組み込みの then が持つ Promise の内部判定を使います。 */
  private promiseResult;
  /** 呼び出し全体が32ステップ以内なら、引数と本体のフレームを作らず同じ予算で評価します。 */
  private callback;
  private invokeHost;
  private invoke;
  private evaluate;
  /** 同期区間の構文は最大32ステップとし、深い構文や中断を伴う操作はスケジューラへ返します。 */
  private synchronous;
  private evaluateSuspending;
}
//#endregion
export { ExecutionStopped, RuntimeError, type Value };
//# sourceMappingURL=interpreter.d.ts.map