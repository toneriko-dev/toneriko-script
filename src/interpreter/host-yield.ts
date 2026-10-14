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
export const defaultYieldToHost = createYieldToHost();

function createYieldToHost(): () => Promise<void> {
	if (typeof setImmediate === 'function') {
		return () => new Promise<void>((resolve) => setImmediate(resolve));
	}
	if (typeof MessageChannel === 'undefined') {
		return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	let sender: MessagePort | null = null;
	const waiting: (() => void)[] = [];
	return () =>
		new Promise<void>((resolve) => {
			if (sender == null) {
				const channel = new MessageChannel();
				channel.port1.onmessage = () => waiting.shift()?.();
				sender = channel.port2;
			}
			waiting.push(resolve);
			sender.postMessage(null);
		});
}

/**
 * 次のマクロタスクで解決する Promise を返す関数を作る。インタプリタが何もしていないかを、イベントループの 1 周の境目で
 * 確かめるのに使う。1 回ずつ使うものなので MessageChannel で足りる (譲り続けるときのようにタイマーを止めない)。
 * テストの偽のタイマーに止められず、タイマーとしても数えられない。受け口はプロセスを生かし続けないよう参照しない。
 * MessageChannel の無い環境では setTimeout(0)。
 */
function createMacrotaskTick(): () => Promise<void> {
	if (typeof MessageChannel === 'undefined') {
		return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	const channel = new MessageChannel();
	const waiting: (() => void)[] = [];
	channel.port1.onmessage = () => waiting.shift()?.();
	(channel.port1 as { unref?: () => void }).unref?.();
	return () =>
		new Promise<void>((resolve) => {
			waiting.push(resolve);
			channel.port2.postMessage(null);
		});
}

/** 次のマクロタスクを待つ。受け口を残さないよう、すべてのインタプリタで 1 つを使い回す。 */
export const macrotaskTick = createMacrotaskTick();
