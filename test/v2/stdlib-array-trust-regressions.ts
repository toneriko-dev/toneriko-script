import { describe, expect, test } from 'vitest';
import { Interpreter, hostFunction, type InterpreterOptions } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

async function execute(source: string, globals: Record<string, unknown> = {}, options: InterpreterOptions = {}) {
	const output: unknown[] = [];
	const vm = new Interpreter({...globals,out:(value: unknown)=>{output.push(structuredClone(value));}},options);
	try { await vm.exec(parse(source).program); return {output,steps:vm.stepCount}; }
	finally { vm.abort(); }
}

describe('配列の組み込み操作とホスト境界', () => {
	test('shift と unshift は別名から呼んでも受け手の同名プロパティを参照しない', async () => {
		expect((await execute('const a=[1,2]; a.take=a.shift; a.shift=0; out(a.take()); a.put=a.unshift; a.unshift=0; out(a.put(3,4)); out(a.slice());')).output).toEqual([1,3,[3,4,2]]);
	});
	test('20 万個の unshift 引数はスタック上限を超えず順序と配列の同一性を保つ', async () => {
		const {output}=await execute('const a=[-1,-2]; const alias=a; out(a.unshift(...range(0,200000))); out(a===alias); out(a);',{}, {maxSteps:2000000});
		expect(output).toEqual([200002,true,[...Array.from({length:200000},(_,i)=>i),-1,-2]]);
	});
	for (const method of ['shift()', 'unshift(9)']) test(`${method}: ホストが追加した getter と setter を実行しない`, async () => {
		for(const kind of ['get','set'] as const){
			let calls=0;
			const mutate=(a: unknown[])=>{Object.defineProperty(a,'1',{[kind]:()=>{calls++;return 77;},configurable:true});return a;};
			await expect(execute(`const a=[1,2,3]; mutate(a); a.${method};`,{mutate})).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
			expect(calls).toBe(0);
		}
	});
	test('別名・入れ子・保持済みの参照がホストで変わっても印を失効する', async () => {
		let saved: any, reads=0;
		const save=(box: any)=>{saved=box.items;};
		const mutate=()=>{Object.defineProperty(saved,'0',{get(){reads++;return 7;},configurable:true});};
		await expect(execute('const a=[1,2]; save({items:a}); a.unshift(3); mutate(); a.shift();',{save,mutate})).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
		expect(reads).toBe(0);
	});
	test('console のホスト処理が追加した accessor を実行しない', async () => {
		let reads=0;
		await expect(execute('const a=[1,2]; console.log(a); a.shift();',{}, {onConsoleLog:values=>{Object.defineProperty(values[0],'0',{get(){reads++;return 7;},configurable:true});}})).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
		expect(reads).toBe(0);
	});
	test('非同期のホスト処理とスクリプトへの再入でも印を失効する', async () => {
		let reads=0;
		const poison=(a: any)=>Object.defineProperty(a,'0',{get(){reads++;return 7;},configurable:true});
		await expect(execute('const a=[1,2]; work(a); a.shift();',{work:async(a:any)=>{await Promise.resolve();poison(a);}})).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
		const reenter=hostFunction(async(args,ctx)=>{poison(args[0]);return ctx.call(args[1]!,[]);});
		await expect(execute('const a=[1,2]; work(a,()=>a.shift());',{work:reenter})).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
		expect(reads).toBe(0);
	});
	test('ホストへ譲った後の保持済み配列の変更を検査する', async () => {
		let saved: any, reads=0, poisoned=false;
		await expect(execute('const a=[1,2]; save(a); for(let i=0;i<1000;i++){} a.shift();',{save:(a:any)=>{saved=a;}}, {yieldInterval:0.000001,yieldToHost:async()=>{if(saved&&!poisoned){poisoned=true;Object.defineProperty(saved,'0',{get(){reads++;return 7;},configurable:true});}}})).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
		expect(poisoned).toBe(true); expect(reads).toBe(0);
	});
	test('検査の途中にホストへ譲ると検査済みの添字も信用しない', async () => {
		let reads=0, poisoned=false;
		const a=Array.from({length:10000},(_,i)=>i);
		await expect(execute('a.shift();',{a},{yieldInterval:0.000001,yieldToHost:async()=>{if(!poisoned){poisoned=true;Object.defineProperty(a,'0',{get(){reads++;return 7;},configurable:true});}}})).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
		expect(reads).toBe(0);
	});
	test('ホスト配列は一度の検査でキューの速い経路に乗る', async () => {
		const steps:number[]=[];
		for(const size of [500,5000]) {
			const a=Array.from({length:size},(_,i)=>i);
			const result=await execute('for(let i=0;i<200;i++){const x=a.shift();a.unshift(x);} out(a);',{a},{yieldInterval:0});
			expect(result.output).toEqual([Array.from({length:size},(_,i)=>i)]); steps.push(result.steps);
		}
		expect(steps[1]! - steps[0]!).toBe(4500);
	});
	test('ホストの入れ物へ公開した配列は待機中の変更後に再検査する', async () => {
		for (const array of [false,true]) {
			const box:any=array?[]:{}; let reads=0;
			const timer=setTimeout(()=>{const a=array?box[0]:box.a; Object.defineProperty(a,'0',{get(){reads++;return 7;},configurable:true});},0);
			try {
				await expect(execute(`${array?'box.unshift([1,2]);':'box.a=[1,2];'} sleep(10); ${array?'box[0]':'box.a'}.shift();`,{box})).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
			} finally { clearTimeout(timer); }
			expect(reads).toBe(0);
		}
	});
	test('public call が返した配列は次の実行で再検査する', async () => {
		const vm=new Interpreter(); let reads=0;
		try {
			await vm.exec(parse('let saved; function create(){saved=[1,2];return saved;}').program);
			const a=await vm.call(vm.getGlobal('create'),[]);
			Object.defineProperty(a,'0',{get(){reads++;return 7;},configurable:true});
			await expect(vm.exec(parse('saved.shift();').program)).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
			expect(reads).toBe(0);
		} finally { vm.abort(); }
	});
	test('ホスト配列の undefined は null とし、未対応の値は拒否する', async () => {
		expect((await execute('out(a.shift());',{a:[undefined,1]})).output).toEqual([null]);
		await expect(execute('a.shift();',{a:[Symbol('value')]})).rejects.toMatchObject({code:'UNSUPPORTED_VALUE'});
	});
	test('原型の数値 setter を呼ばず、属性が特殊な配列は既存の検査を使う', async () => {
		let calls=0;
		try {
			Object.defineProperty(Array.prototype,'5001',{set(){calls++;},configurable:true});
			await expect(execute('const a=range(0,5000); a.unshift(1,2);')).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
		} finally { delete (Array.prototype as any)[5001]; }
		expect(calls).toBe(0);
		const a=[1,2];Object.defineProperty(a,'0',{writable:false});
		await expect(execute('a.shift();',{a})).rejects.toMatchObject({code:'READONLY_PROPERTY'});
		const fixed=[1,2]; Object.defineProperty(fixed,'length',{writable:false});
		await expect(execute('a.unshift();',{a:fixed})).rejects.toMatchObject({code:'READONLY_PROPERTY'});
	});
});

test('exec の例外で公開した配列も再検査する', async () => {
	const vm = new Interpreter(); let calls = 0;
	try {
		let thrown: any;
		try { await vm.exec(parse('const a=[1,2]; throw a;').program); } catch (error) { thrown = error; }
		Object.defineProperty(thrown.thrownValue, '0', { get: () => { calls++; return 99; }, configurable: true });
		await expect(vm.exec(parse('a.shift();').program)).rejects.toMatchObject({ code: 'ACCESSOR_PROPERTY' });
		expect(calls).toBe(0);
	} finally { vm.abort(); }
});
