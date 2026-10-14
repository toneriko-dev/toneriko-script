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
  private yieldInterval;
  private yieldToHost;
  private maxBusyTime;
  private lastYield;
  private clockSteps;
  /**
   * busy は、インタプリタが最後にホストを待って何もしていなかった時から動き続けた時間 (ms)。並行する実行や
   * map の関数の時間も合わせて数える。lastClock は前回時刻を確かめた時刻で、確かめるたびにその間の時間を busy に足す。
   * 自分が譲った後と一時停止の後は lastClock を進めて、その間を数えない。
   *
   * 何もしていなかったかは、イベントループの 1 周の境目 (マクロタスク) で見る。境目では動いている処理も積まれた
   * マイクロタスクも無いので、譲っている途中の実行 (yielding) が無ければ、どの実行もホストの何かを待っている。
   * 時刻を確かめるとき・譲った後・ホストの待ちから戻ったときに境目の確認を 1 つ予約し (idleTickPending)、
   * そこで何もしていなければ busy を 0 にして、何もしていなかったと記録する (resumedFromIdle)。
   * 何もしていない状態から戻るのは、ネイティブ関数が返した Promise の待ちが明けたとき、ネイティブ関数が渡された関数を
   * 呼び返したとき、実行が始まったとき、一時停止が解けたときなので、そこで lastClock を合わせ、何もしていなかった間を
   * 足さない (resumeFromHost)。
   * 何もしていない間は予約しないので、待つ間に CPU を使わない。作った直後は何もしていない状態から始める。
   * 譲っている途中に別の実行がホストを待ち明けた場合は数え直さない。
   */
  private busy;
  private lastClock;
  private yielding;
  private idleTickPending;
  private resumedFromIdle;
  /** 名前空間の初期化式を評価する実行。exec / execSync の始めに作り直す。根なので、エラーの位置の表示はトップレベルと同じになる。 */
  private nsCallStack;
  constructor(consts: Record<string, Value>, opts?: {
    in?(q: string): Promise<string>;
    out?(value: Value): void;
    err?(e: TonerikoScriptError): void;
    log?(type: string, params: LogObject): void;
    maxStep?: number;
    abortOnError?: boolean;
    /** この時間 (ms) 続けて動いたら、ホストに 1 回処理を譲る。0 なら譲らない。既定は 8。 */
    yieldInterval?: number;
    /** ホストに処理を譲る関数。既定は setImmediate (Node, Bun)、MessageChannel (ブラウザ)、setTimeout(0) の順に使えるもの。 */
    yieldToHost?: () => Promise<void>;
    /**
     * インタプリタがホストを待たずに動き続けてよい時間 (ms)。超えたら実行時エラーにする。既定は 5000。
     * 並行する実行の時間も合わせて数え、譲った間は含まない。Core:sleep や入力待ちのようにホストを待ち、
     * インタプリタに動ける処理が無くなったら 0 から数え直す。
     */
    maxBusyTime?: number;
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
  /** CLOCK_CHECK_STEPS 回に 1 回 true を返す。 */
  private clockDue;
  /** 動いた時間を確かめ、yieldInterval を過ぎていればホストに譲る。 */
  private onClock;
  private startExecution;
  /** 一時停止していた時間は、何もしていなかったと確かめられなくても動いた時間に数えない。 */
  private resumeFromPause;
  /**
   * ホストを待った後や実行の始めに呼ぶ。何もしていなかった状態から戻ったなら、ここから数え、譲るまでの時間も数え直す。
   * 別の実行が譲っている間に始まった実行 (Async:interval の関数など) は、譲っていた間のホストの時間 (描画など) も
   * 数える。その間かどうかを、マイクロタスクで並行して進む処理 (sort の比較など) と確実には見分けられないため。
   * このとき止まるのは、描画の時間を含めて maxBusyTime を超えて動き続けた場合だけで、暴走を見逃す方向には働かない。
   */
  private resumeFromHost;
  /** 前回の確認からの時間を busy に足し、ホストを待たずに maxBusyTime を超えて動いたら止める。 */
  private checkBusyTime;
  /** 次のマクロタスクの境目で、インタプリタが何もせずホストを待っているかを確かめる。 */
  private armIdleTick;
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