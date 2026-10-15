import { spawnSync } from 'node:child_process';
import { nodeExecutable } from '../../scripts/v2-node.mjs';
import { describe, expect, test, vi } from 'vitest';
import fc from 'fast-check';
import { Interpreter, type InterpreterOptions } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { RuntimeServices } from '../../src/v2/stdlib/services.js';

async function execute(source: string, globals: Record<string, unknown> = {}, options: InterpreterOptions = {}) {
	const output: unknown[] = [];
	const vm = new Interpreter({ ...globals, out: (value: unknown) => { output.push(value); } }, options);
	await vm.exec(parse(source).program);
	return { output, vm };
}
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 5));

describe('時刻と実行サービス', () => {
	test('Date.format の全書式と固定オフセット・年越し', async () => {
		const t = Date.UTC(2024, 1, 29, 15, 4, 5, 6);
		const { output } = await execute('out(Date.format(t, "YYYY-MM-DD HH:mm:ss.SSS d ddd dddd Z ZZ [日付]")); out(Date.parts(t)); out(Date.format(0, "YYYY-MM-DD HH:mm", -60));', { t }, { dateOffsetMinutes: 540 });
		expect(output).toEqual(['2024-03-01 00:04:05.006 5 Fri Friday +09:00 +0900 日付', { year: 2024, month: 3, day: 1, hour: 0, minute: 4, second: 5, millisecond: 6, weekday: 5 }, '1969-12-31 23:00']);
		expect(Object.getPrototypeOf(output[1])).toBe(null);
	});
	test('Date.parts は指定時差で 500 件カレンダーと一致する', async () => {
		const rows = [11, 29, 73, 151, 257].flatMap(seed => fc.sample(fc.record({ t: fc.integer({ min: -2000000000000, max: 2000000000000 }), offset: fc.integer({ min: -840, max: 840 }) }), { seed, numRuns: 100 }));
		let reached = 0;
		const { output } = await execute('for (const row of rows) { hit(); out(Date.parts(row.t, row.offset)); }', { rows, hit: () => { reached++; } }, { dateOffsetMinutes: 0 });
		for (let i = 0; i < rows.length; i++) { const row = rows[i]!; const d = new Date(row.t + row.offset * 60000); expect(output[i]).toEqual({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), millisecond: d.getUTCMilliseconds(), weekday: d.getUTCDay() }); }
		expect([reached, output.length]).toEqual([500, 500]);
	});
	test('Date.now は制御したホスト時刻で Node と 500 件一致する', async () => {
		const times = fc.sample(fc.integer({ min: 0, max: 2000000000000 }), { seed: 151, numRuns: 500 });
		const node = spawnSync(nodeExecutable, ['--eval', 'const times=JSON.parse(process.argv[1]);let i=0;Date.now=()=>times[i++];process.stdout.write(JSON.stringify(times.map(()=>Date.now())));', JSON.stringify(times)], { encoding: 'utf8' });
		expect(node.status).toBe(0); let index = 0; let reached = 0;
		const spy = vi.spyOn(Date, 'now').mockImplementation(() => times[index++]!);
		try { const { output } = await execute('for(const t of times){hit();out(Date.now());}', { times, hit: () => { reached++; } }); expect(output).toEqual(JSON.parse(node.stdout)); expect([reached, index, output.length]).toEqual([500, 500, 500]); } finally { spy.mockRestore(); }
	});
	test('日時の不正な書式と時刻を診断する', async () => {
		for (const source of ['Date.format(0, "QQ");', 'Date.format(0, "[x");', 'Date.parts(1e20);', 'Date.parts(0, 0.5);']) await expect(execute(source)).rejects.toMatchObject({ name: 'RangeError', code: 'STDLIB_ARGUMENT_RANGE' });
	});
	test('console.log は参照を保った可変長の値を一度渡す', async () => {
		const logs: readonly unknown[][] = []; const mutable = logs as unknown[][];
		const { output } = await execute('const x={n:1}; out(console.log(x, "x", null)); x.n=2; out(x);', {}, { onConsoleLog: values => { mutable.push(values as unknown[]); } });
		expect(logs).toEqual([[{ n: 2 }, 'x', null]]); expect(output[0]).toBe(null); expect(logs[0]![0]).toBe(output[1]);
	});
	test('タイマーは本体終了後に動き、追加引数を渡せる', async () => {
		const { output, vm } = await execute('setTimeout((a,b)=>out(a+b), 0, 2, 3); out("body");');
		expect(output).toEqual(['body']); await turn(); expect(output).toEqual(['body', 5]); vm.abort();
	});
	test('interval は待機中に重なり、両方の clear 関数で解除する', async () => {
		let active = 0; let maximum = 0; let calls = 0;
		const pending: (() => void)[] = [];
		const { vm } = await execute('const id=setInterval(()=>work(), 1);', { work: () => { calls++; active++; maximum = Math.max(maximum, active); return new Promise<void>(resolve => pending.push(() => { active--; resolve(); })); } });
		for (let i = 0; i < 20 && calls < 3; i++) await turn();
		await vm.exec(parse('clearTimeout(id);').program); const stoppedAt = calls;
		for (const release of pending) release(); await turn();
		expect(maximum).toBeGreaterThanOrEqual(2); expect(calls).toBe(stoppedAt); vm.abort();
		const second = await execute('const id=setTimeout(()=>out(1),20); clearInterval(id);'); await new Promise(resolve => setTimeout(resolve, 25)); expect(second.output).toEqual([]); second.vm.abort();
	});
	test('未処理例外はホストへ渡し、abort でタイマーと sleep を止める', async () => {
		const errors: unknown[] = [];
		const first = await execute('setTimeout(()=>{throw new Error("timer");},0);', {}, { onUnhandledError: error => errors.push(error) });
		await turn(); expect(errors).toHaveLength(1); expect(errors[0]).toMatchObject({ message: 'timer' }); first.vm.abort();
		const vm = new Interpreter(); const run = vm.exec(parse('setInterval(()=>console.log(1),1000); sleep(100000);').program);
		vm.abort(); await expect(run).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' });
	});
	test('長い sleep は 32 bit 以下のタイマーに分け、中止できる', async () => {
		vi.useFakeTimers();
		try { const controller = new AbortController(); const service = new RuntimeServices({}, controller.signal, async () => null); let done = false; const waiting = service.sleep(2147483657).then(() => { done = true; }); await vi.advanceTimersByTimeAsync(2147483647); expect(done).toBe(false); await vi.advanceTimersByTimeAsync(10); await waiting; expect(done).toBe(true); const stopped = service.sleep(1e30); controller.abort(new Error('stopped')); await expect(stopped).rejects.toThrow('stopped'); expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); }
	});
	test('タイマーの各呼び出しは独立予算、本体の上限超過はすべて止める', async () => {
		let hits = 0;
		const vm = new Interpreter({ hit: () => { hits++; } }, { maxSteps: 80 });
		await vm.exec(parse('setInterval(()=>{let i=0; while(i<2){i++;} hit();},1);').program);
		for (let i = 0; i < 20 && hits < 5; i++) await turn();
		expect(hits).toBeGreaterThanOrEqual(5); vm.abort();
		const stopped = hits; await turn(); expect(hits).toBe(stopped);
	});
	test('mapConcurrent は既定 4、結果は入力順', async () => {
		let active = 0; let maximum = 0; const starts: number[] = [];
		const { output } = await execute('out([0,1,2,3,4,5,6,7].mapConcurrent(v=>work(v)));', { work: async (v: number) => { starts.push(v); maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 8 - v)); active--; return v * 2; } });
		expect(maximum).toBe(4); expect(starts).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); expect(output).toEqual([[0, 2, 4, 6, 8, 10, 12, 14]]);
	});
	test('mapConcurrent は最初の失敗で開始を止め、開始済みを待つ', async () => {
		const starts: number[] = []; const finishes: number[] = []; let settled = false;
		const run = execute('out([0,1,2,3,4,5].mapConcurrent(v=>work(v),2));', { work: async (v: number) => { starts.push(v); if (v === 0) throw new Error('first'); await turn(); finishes.push(v); return v; } }).finally(() => { settled = true; });
		await expect(run).rejects.toMatchObject({ message: 'first' }); expect(settled).toBe(true); expect(starts).toEqual([0, 1]); expect(finishes).toEqual([1]);
	});
	test('並行処理は親のステップ上限を共有する', async () => {
		await expect(execute('xs.mapConcurrent(v=>{let i=0;while(i<20){i++;}return v;});', { xs: Array.from({ length: 20 }, (_, i) => i) }, { maxSteps: 500 })).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
	});
	test('range は終端を含まず、方向と間隔を保つ 500 件', async () => {
		const rows = fc.sample(fc.record({ start: fc.integer({ min: -100, max: 100 }), count: fc.integer({ min: 0, max: 20 }), step: fc.integer({ min: 1, max: 10 }) }), { seed: 151, numRuns: 500 });
		const { output } = await execute('for(const r of rows){out(range(r.start,r.start+r.count*r.step,r.step));}', { rows });
		for (let i = 0; i < rows.length; i++) { const r = rows[i]!; expect(output[i]).toEqual(Array.from({ length: r.count }, (_, j) => r.start + j * r.step)); }
		expect(output).toHaveLength(500); expect((await execute('out(range(3,-1,-1));out(range(3,0));out(range(1,1));')).output).toEqual([[3, 2, 1, 0], [], []]);
		await expect(execute('range(0,3,0);')).rejects.toMatchObject({ code: 'STDLIB_ARGUMENT_RANGE' });
	});
});


test('タイマー内の実行上限はホストに一度通知して全体を停止する', async () => {
	const errors: unknown[] = [];
	let reported!: () => void;
	const notification = new Promise<void>(resolve => { reported = resolve; });
	const vm = new Interpreter({}, { maxSteps: 100, onUnhandledError(error) { errors.push(error); reported(); } });
	await vm.exec(parse('setTimeout(() => { while (true) {} }, 0);').program);
	await notification;
	expect(errors).toHaveLength(1);
	expect(errors[0]).toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
	await expect(vm.exec(parse('1;').program)).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
});

test('null と省略のタイマー解除は何もせず null を返す', async () => {
	const { output, vm } = await execute('let timer = null; out(clearTimeout(timer)); out(clearInterval(timer)); out(clearTimeout()); out(clearInterval());');
	expect(output).toEqual([null, null, null, null]);
	vm.abort();
});
