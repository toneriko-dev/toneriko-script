//#region src/interpreter/host-yield.d.ts
/**
 * ホスト (ブラウザなど) のイベントループへ 1 回処理を譲る関数を作る。
 *
 * - setImmediate のある環境 (Node, Bun): setImmediate はタイマーの後に回るので、譲るたびにタイマーも動く。
 *   MessageChannel で譲ると、処理中に送ったメッセージも同じ回で処理され、譲り続ける間タイマーが動かない。
 * - ブラウザ: MessageChannel のメッセージは setTimeout(0) と違って入れ子でも最短 4ms に延ばされない。
 *   Chromium では、譲った間に画面の更新とタイマーも回る。
 * - どちらも無い環境: setTimeout(0)。
 */
/** 既定の譲り方。MessageChannel の受け口は閉じないと残り続けるので、すべてのインタプリタで 1 つを使い回す。 */
export declare const defaultYieldToHost: () => Promise<void>;
/** 次のマクロタスクを待つ。受け口を残さないよう、すべてのインタプリタで 1 つを使い回す。 */
export declare const macrotaskTick: () => Promise<void>;
//#endregion
//# sourceMappingURL=host-yield.d.ts.map