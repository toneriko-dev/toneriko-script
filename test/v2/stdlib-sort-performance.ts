import { describe, expect, test } from 'vitest';
import { Interpreter, type InterpreterOptions } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

async function execute(source: string, synchronous: boolean, options: InterpreterOptions = {}, globals: Record<string, unknown> = {}) {
	const output: unknown[] = [];
	const vm = new Interpreter({ ...globals, out: (value: unknown) => { output.push(structuredClone(value)); } }, { now: () => 0, ...options });
	// 通常の呼び出し経路を対照にして、短いコールバックも同じ位置と予算を使うことを確かめます。
	if (!synchronous) Object.defineProperty(vm, 'callback', { value: Object.getOwnPropertyDescriptor(Interpreter.prototype, 'invoke')!.value });
	let failure: unknown = null;
	try { await vm.exec(parse(source).program); }
	catch (error) {
		const diagnostic = error as { name: string; code: string; pos: unknown; message: string };
		failure = { name: diagnostic.name, code: diagnostic.code, pos: diagnostic.pos, message: diagnostic.message };
	}
	finally { vm.abort(); }
	return { output, steps: vm.stepCount, failure };
}

const examples = [
	['式の比較関数', 'out([4,1,3,1,2].sort((a,b)=>a-b));', [[1,1,2,3,4]]],
	['短いブロックと外側の状態', 'let calls=0; out([4,1,3,2].sort((a,b)=>{ calls++; return a-b; })); out(calls);', [[1,2,3,4],5]],
	['入れ子のブロックの宣言', 'out([3,1,2].sort((a,b)=>{ { let delta=a-b; return delta; } }));', [[1,2,3]]],
	['本体の宣言の準備', 'out([3,1,2].sort((a,b)=>{ let delta=a-b; function f(){return delta;} return f(); }));', [[1,2,3]]],
	['既定引数', 'out([3,1,2].sort((a,b,delta=a-b)=>delta));', [[1,2,3]]],
	['既定引数の閉包と本体の環境', 'let outer=7; out([null].map((value=()=>outer)=>{let outer=9;return value();}));', [[7]]],
	['残余引数', 'out([3,1,2].sort((...args)=>args[0]-args[1]));', [[1,2,3]]],
	['分割代入の引数', 'out([{key:3},{key:1},{key:2}].sort(({key:a},{key:b})=>a-b).map(x=>x.key));', [[1,2,3]]],
	['閉包ごとの環境', 'const make=(sign)=>(a,b)=>sign*(a-b); const up=make(1); const down=make(-1); out([3,1,2].sort(up)); out([3,1,2].sort(down)); out([2,3,1].sort(up));', [[1,2,3],[3,2,1],[1,2,3]]],
	['引数への代入の独立', 'const cmp=(a,b)=>{a-=b;return a;}; out([5,1,3,2,4].sort(cmp)); out([4,2,1,3].sort(cmp));', [[1,2,3,4,5],[1,2,3,4]]],
	['同値の安定順と NaN', 'out([{key:1,id:0},{key:0,id:1},{key:1,id:2}].sort((a,b)=>a.key-b.key).map(x=>x.id)); out([3,1,2].sort(()=>0/0));', [[1,0,2],[3,1,2]]],
	['比較結果の型エラー', 'try {[2,1].sort(()=>"bad");} catch(e){out(e.code);out(e.name);} out([2,1].sort((a,b)=>a-b));', ['STDLIB_ARGUMENT_TYPE','TypeError',[1,2]]],
	['return のない関数', 'out([1,2].map(x=>{ x+1; }));', [[null,null]]],
] as const;

describe('短い配列コールバックの評価経路', () => {
	for (const [name, source, output] of examples) test(`${name}: 中断可能な呼び出しと意味・ステップが一致する`, async () => {
		const reference = await execute(source, false);
		const actual = await execute(source, true);
		expect(reference.failure).toBeNull();
		expect(reference.output).toEqual(output);
		expect(actual).toEqual(reference);
	});

	test('全ステップ境界で上限とエラー位置を保つ', async () => {
		const source = 'out([3,1,2].sort((a,b)=>a-b));';
		const completed = await execute(source, false);
		expect(completed.failure).toBeNull();
		let checked = 0;
		for (let maxSteps = 0; maxSteps <= completed.steps; maxSteps++) {
			const reference = await execute(source, false, { maxSteps });
			const actual = await execute(source, true, { maxSteps });
			expect(actual, `maxSteps=${maxSteps}`).toEqual(reference);
			if (maxSteps < completed.steps) expect(actual.failure).toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
			checked++;
		}
		expect(checked).toBe(completed.steps + 1);
		expect(checked).toBeGreaterThan(40);
	});

	test('同期の例外の位置を保ち、捕捉後に呼び出し深さが戻る', async () => {
		const source = 'function run(){\ntry { [2,1].sort((a,b)=>missing); } catch(e){ out(e.code);out(e.pos); }\nout([2,1].sort((a,b)=>a-b));\n}\nrun();';
		const reference = await execute(source, false, { maxCallDepth: 2 });
		expect(reference.failure).toBeNull();
		expect(reference.output[0]).toBe('UNBOUND_IDENTIFIER');
		expect(reference.output[1]).toMatchObject({ line: 2 });
		expect(reference.output[2]).toEqual([1,2]);
		expect(await execute(source, true, { maxCallDepth: 2 })).toEqual(reference);
	});

	test('呼び出し深さの上限を標準コールバックと共有する', async () => {
		const source = 'function run(){return [2,1].sort((a,b)=>a-b);} try {run();} catch(e){out(e.code);} out([2,1].sort((a,b)=>a-b));';
		const reference = await execute(source, false, { maxCallDepth: 1 });
		expect(reference.output).toEqual(['CALL_DEPTH_EXCEEDED',[1,2]]);
		expect(reference.failure).toBeNull();
		expect(await execute(source, true, { maxCallDepth: 1 })).toEqual(reference);
	});

	test('非同期の比較関数は一つずつ完了してから次を呼ぶ', async () => {
		for (const synchronous of [false, true]) {
			let active = 0, maximum = 0; const events: string[] = [];
			const compare = async (a: number, b: number) => {
				maximum = Math.max(maximum, ++active); events.push(`start:${a}:${b}`);
				await Promise.resolve(); events.push(`end:${a}:${b}`); active--; return a-b;
			};
			const actual = await execute('out([4,1,3,2].sort((a,b)=>compare(a,b)));', synchronous, {}, { compare });
			expect(actual.failure).toBeNull(); expect(actual.output).toEqual([[1,2,3,4]]); expect(maximum).toBe(1);
			expect(events.length).toBe(10);
			for (let i=0;i<events.length;i+=2) expect(events[i+1]).toBe(events[i]!.replace('start:','end:'));
		}
	});

	test('同期比較の途中もホストに譲り、中止を受け取る', async () => {
		let clock = 0, yields = 0;
		const vm = new Interpreter({ values: Array.from({length:256},(_,i)=>256-i) }, {
			now: () => ++clock, yieldInterval: 1, maxBusyTime: Infinity,
			yieldToHost: async () => { yields++; if ((vm.getGlobal('comparisons') as number) >= 10) vm.abort(); },
		});
		await expect(vm.exec(parse('let comparisons=0; values.sort((a,b)=>{comparisons++;return a-b;});').program)).rejects.toMatchObject({code:'EXECUTION_ABORTED'});
		expect(yields).toBeGreaterThan(0);
		expect(vm.getGlobal('comparisons')).toBeGreaterThanOrEqual(10);
	});
});

test('配列の書き戻しは要素の属性と length を保つ', async () => {
	const items = [3, 1, 2];
	Object.defineProperty(items, '0', { enumerable: false, configurable: false, writable: true });
	Object.defineProperty(items, 'length', { writable: false });
	const vm = new Interpreter({ items });
	await vm.exec(parse('items.sort((a,b)=>a-b);').program);
	expect([...items]).toEqual([1, 2, 3]);
	expect(Object.getOwnPropertyDescriptor(items, '0')).toEqual({ value: 1, enumerable: false, configurable: false, writable: true });
	expect(Object.getOwnPropertyDescriptor(items, 'length')).toMatchObject({ value: 3, writable: false });
});

test('配列の書き戻しは読み取り専用要素と accessor を拒否する', async () => {
	const readonly = [2, 1]; Object.defineProperty(readonly, '0', { writable: false });
	const getter = [2, 1]; let reads = 0; Object.defineProperty(getter, '0', { get: () => { reads++; return 2; } });
	for (const [items, code] of [[readonly, 'READONLY_PROPERTY'], [getter, 'ACCESSOR_PROPERTY']] as const) {
		await expect(new Interpreter({ items }).exec(parse('items.sort((a,b)=>a-b);').program)).rejects.toMatchObject({ code });
	}
	expect(readonly).toEqual([2, 1]);
	expect(reads).toBe(0);
});
