import type { Pos } from '../ast.js';
import type { Value } from '../runtime/brands.js';
import { scriptObject } from '../runtime/brands.js';
import { runtimeError } from '../runtime/errors.js';
import { type StdDefinition, type StdContext, requireArray, requireNumber, requireString } from './core.js';
import { callable } from './arrays.js';

export interface ServiceOptions {
	dateOffsetMinutes?: number;
	onConsoleLog?: (values: readonly Value[]) => void;
	onUnhandledError?: (error: unknown) => void;
}
/** タイマーの寿命は本体の評価ではなくインタプリタに属します。 */
export class RuntimeServices {
	private nextId = 1;
	private reportedStop = false;
	private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
	constructor(readonly options: ServiceOptions, readonly signal: AbortSignal, private readonly invoke: (fn: Value, args: Value[], pos: Pos) => Promise<Value>) {
		signal.addEventListener('abort', () => { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }, { once: true });
	}
	timer(fn: Value, args: Value[], delay: number, repeat: boolean, pos: Pos): number {
		if (this.signal.aborted) throw this.signal.reason;
		const id = this.nextId++;
		const fire = () => {
			if (!this.timers.has(id) || this.signal.aborted) return;
			if (!repeat) this.timers.delete(id);
			void this.invoke(fn, args, pos).catch(error => {
				if (this.signal.aborted) {
					if (this.signal.reason?.code === 'EXECUTION_ABORTED' || this.reportedStop) return;
					this.reportedStop = true;
				}
				(this.options.onUnhandledError ?? console.error)(error);
			});
		};
		this.timers.set(id, repeat ? setInterval(fire, delay) : setTimeout(fire, delay));
		return id;
	}
	clear(id: number): void { const timer = this.timers.get(id); if (timer !== undefined) clearTimeout(timer); this.timers.delete(id); }
	sleep(delay: number): Promise<null> {
		return new Promise((resolve, reject) => {
			if (this.signal.aborted) { reject(this.signal.reason); return; }
			let timer: ReturnType<typeof setTimeout>;
			let remaining = delay;
			const aborted = () => { clearTimeout(timer); reject(this.signal.reason); };
			// ホストの 32 bit 遅延上限を超える待機は、短いタイマーへ分割します。
			const schedule = () => {
				const chunk = Math.min(remaining, 2147483647);
				timer = setTimeout(() => {
					remaining -= chunk;
					if (remaining > 0) schedule();
					else { this.signal.removeEventListener('abort', aborted); resolve(null); }
				}, chunk);
			};
			schedule();
			this.signal.addEventListener('abort', aborted, { once: true });
		});
	}
}
const arg = (name: string, type: string, optional = false) => ({ name, type, ...(optional ? { optional } : {}) });
function rangeError(ctx: StdContext): never { throw runtimeError('STDLIB_ARGUMENT_RANGE', ctx.pos, {}, 'RangeError'); }
function finite(ctx: StdContext, value: unknown): number { const n = requireNumber(ctx, value); if (!Number.isFinite(n)) rangeError(ctx); return n; }
function parts(ctx: StdContext, timestamp: Value | undefined, offset: Value | undefined): { [key: string]: number } {
	const time = finite(ctx, timestamp); const date = new Date(time); if (Number.isNaN(date.getTime())) rangeError(ctx);
	const minutes = offset === undefined ? ctx.services!.options.dateOffsetMinutes ?? -date.getTimezoneOffset() : finite(ctx, offset);
	if (!Number.isInteger(minutes)) rangeError(ctx);
	const shifted = new Date(time + minutes * 60000); if (Number.isNaN(shifted.getTime())) rangeError(ctx);
	return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds(), millisecond: shifted.getUTCMilliseconds(), weekday: shifted.getUTCDay(), offset: minutes };
}
export const serviceDefinitions: StdDefinition[] = [
	{ name: 'Date.now', receiver: 'global', args: [], returns: 'number', description: { ja: '現在の Unix 時刻をミリ秒で返します。', en: 'Returns the current Unix time in milliseconds.' }, *implementation() { return Date.now(); } },
	{ name: 'Date.parts', receiver: 'global', args: [arg('t', 'number'), arg('offset', 'number', true)], returns: '{ year: number, month: number, day: number, hour: number, minute: number, second: number, millisecond: number, weekday: number }', description: { ja: '時刻を年月日・時分秒・曜日に分けます。', en: 'Returns calendar components and the weekday of a timestamp.' }, *implementation(ctx, _r, args) {
		const { offset: _, ...values } = parts(ctx, args[0], args[1]); return scriptObject(Object.assign(Object.create(null), values));
	} },
	{ name: 'Date.format', receiver: 'global', args: [arg('t', 'number'), arg('format', 'string'), arg('offset', 'number', true)], returns: 'string', description: { ja: '指定した書式で時刻を文字列にします。', en: 'Formats a timestamp using the specified pattern.' }, *implementation(ctx, _r, args) {
		const p = parts(ctx, args[0], args[2]); const format = requireString(ctx, args[1]); const pad = (n: number, size = 2) => String(n).padStart(size, '0');
		const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
		const zone = (colon: string) => (p['offset']! < 0 ? '-' : '+') + pad(Math.floor(Math.abs(p['offset']!) / 60)) + colon + pad(Math.abs(p['offset']!) % 60);
		const year = p['year']!; const names: Record<string, string> = { YYYY: year >= 0 && year <= 9999 ? pad(year, 4) : (year < 0 ? '-' : '+') + pad(Math.abs(year), 6), MM: pad(p['month']!), DD: pad(p['day']!), HH: pad(p['hour']!), mm: pad(p['minute']!), ss: pad(p['second']!), SSS: pad(p['millisecond']!, 3), d: String(p['weekday']), ddd: weekdays[p['weekday']!]!.slice(0, 3), dddd: weekdays[p['weekday']!]!, Z: zone(':'), ZZ: zone('') };
		const tokens = Object.keys(names).sort((a, b) => b.length - a.length); const out: string[] = [];
		for (let i = 0; i < format.length;) {
			ctx.tick(); if (i % 64 === 0) yield ctx.checkpoint();
			if (format[i] === '[') { let end = i + 1; for (; end < format.length && format[end] !== ']'; end++) { ctx.tick(); if (end % 64 === 0) yield ctx.checkpoint(); } if (end === format.length) rangeError(ctx); out.push(format.slice(i + 1, end)); i = end + 1; continue; }
			const token = tokens.find(token => format.startsWith(token, i)); if (token) { out.push(names[token]!); i += token.length; }
			else { if (/[A-Za-z\]]/.test(format[i]!)) rangeError(ctx); out.push(format[i++]!); }
		} return out.join('');
	} },
	{ name: 'console.log', receiver: 'global', args: [{ name: 'values', type: 'any[]', rest: true }], returns: 'void', description: { ja: '値を文字列化せずホストの出力へ渡します。', en: 'Passes values to the host output without stringifying them.' }, *implementation(ctx, _r, args) { const handler = ctx.services!.options.onConsoleLog; if (handler) handler(args); else console.log(...args); return null; } },
	{ name: 'sleep', receiver: 'global', args: [arg('ms', 'number')], returns: 'void', description: { ja: '指定したミリ秒だけ待ちます。', en: 'Waits for the specified number of milliseconds.' }, *implementation(ctx, _r, args) { const ms = finite(ctx, args[0]); if (ms < 0) rangeError(ctx); return yield ctx.wait!(ctx.services!.sleep(ms)); } },
	{ name: 'range', receiver: 'global', args: [arg('start', 'number'), arg('end', 'number'), arg('step', 'number', true)], returns: 'number[]', description: { ja: '終端を含まない整数の範囲を配列にします。', en: 'Creates an integer range excluding the end.' }, *implementation(ctx, _r, args) {
		const start = requireNumber(ctx, args[0]), end = requireNumber(ctx, args[1]), step = args[2] === undefined ? 1 : requireNumber(ctx, args[2]);
		if (![start, end, step].every(Number.isSafeInteger) || step === 0) rangeError(ctx);
		const out: number[] = []; let i = 0;
		for (let value = start; step > 0 ? value < end : value > end;) {
			out.push(value); ctx.tick(); if (++i % 64 === 0) yield ctx.checkpoint(); const next = value + step;
			if (!Number.isSafeInteger(next)) { if (step > 0 ? next >= end : next <= end) break; rangeError(ctx); } value = next;
		} return scriptObject(out);
	} },
	...(['setTimeout', 'setInterval'] as const).map((name): StdDefinition => ({ name, receiver: 'global', args: [arg('callback', 'Function'), arg('delay', 'number', true), { name: 'args', type: 'any[]', rest: true }], returns: 'number', description: { ja: name === 'setTimeout' ? '遅延後に関数を一度呼びます。' : '指定した間隔で関数を呼びます。', en: name === 'setTimeout' ? 'Schedules a callback once after a delay.' : 'Schedules a callback at regular intervals.' }, *implementation(ctx, _r, args) {
		const fn = callable(ctx, args[0]); const delay = args[1] === undefined ? 0 : requireNumber(ctx, args[1]);
		return ctx.services!.timer(fn, args.slice(2), delay, name === 'setInterval', ctx.pos);
	} })),
	...(['clearTimeout', 'clearInterval'] as const).map((name): StdDefinition => ({ name, receiver: 'global', args: [arg('id', 'number | null', true)], returns: 'void', description: { ja: '登録したタイマーを解除します。', en: 'Cancels a registered timer.' }, *implementation(ctx, _r, args) { if (args.length && args[0] !== null) ctx.services!.clear(requireNumber(ctx, args[0])); return null; } })),
	{ name: 'mapConcurrent', receiver: 'array', args: [arg('callback', 'Function'), arg('limit', 'number', true)], returns: 'any[]', description: { ja: '同時実行数を制限し、元の順序で結果を返します。', en: 'Maps with bounded concurrency and preserves result order.' }, *implementation(ctx, receiver, args) {
		const xs = requireArray(ctx, receiver), fn = callable(ctx, args[0]), limit = args[1] === undefined ? 4 : requireNumber(ctx, args[1]);
		if (!Number.isSafeInteger(limit) || limit <= 0) rangeError(ctx);
		const length = xs.length, out: Value[] = []; let next = 0, failed = false; let firstError: unknown;
		const worker = async () => {
			while (!failed && next < length && !ctx.services!.signal.aborted) {
				const index = next++;
				try { ctx.tick(); const value = ctx.properties.get(xs, index, ctx.pos); out[index] = await ctx.parallel!(fn, [value, index, xs]); }
				catch (error) { if (!failed) { failed = true; firstError = error; } }
			}
		};
		const workers: Promise<void>[] = [];
		for (let i = 0; i < Math.min(limit, length) && !failed; i++) { workers.push(worker()); ctx.tick(); if (i % 64 === 63) yield ctx.checkpoint(); }
		const work = Promise.all(workers).then(() => { if (failed) throw firstError; return scriptObject(out); });
		return yield ctx.wait!(work);
	} },
];
