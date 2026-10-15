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
	for (const method of ['shift()', 'unshift(9)']) {
		for (const kind of ['get', 'set'] as const) test(`${method}: ホストが返した ${kind} を実行せず拒否する`, async () => {
			let calls = 0;
			const make = () => { const a = [1,2,3]; Object.defineProperty(a, '1', { [kind]: () => { calls++; return 77; }, configurable: true }); return a; };
			await expect(execute(`const a=make(); a.${method};`, { make })).rejects.toMatchObject({ code: 'ACCESSOR_PROPERTY' });
			expect(calls).toBe(0);
		});
		test(`${method}: ホストの穴のある配列を拒否する`, async () => {
			await expect(execute(`make().${method};`, { make: () => [1,,3] })).rejects.toMatchObject({ code: 'SPARSE_ARRAY' });
		});
		test(`${method}: 派生配列は添字で操作し原型の getter を呼ばない`, async () => {
			let calls = 0;
			class HostArray extends Array { get secret() { calls++; return 99; } }
			const array = new HostArray(1,2);
			expect((await execute(`out(a.${method}); out(a.slice()); out(a.secret);`, { a:array })).output).toEqual(method === 'shift()' ? [1,[2],null] : [3,[9,1,2],null]);
			expect(calls).toBe(0);
		});
		test(`${method}: 派生配列の原型の数値 accessor を呼ばない`, async () => {
			let calls = 0;
			class HostArray extends Array {}
			Object.defineProperty(HostArray.prototype, '1', { get:()=>{calls++;return 99;}, set:()=>{calls++;}, configurable:true });
			const a = new HostArray(3); Object.defineProperty(a,'0',{value:1,writable:true,configurable:true}); Object.defineProperty(a,'2',{value:3,writable:true,configurable:true});
			await expect(execute(`a.${method};`,{a})).rejects.toMatchObject({code:'SPARSE_ARRAY'});
			expect(calls).toBe(0);
		});
	}
	test('派生配列の unshift は新しい添字の原型 setter を呼ばない', async () => {
		let calls=0;
		class HostArray extends Array {}
		Object.defineProperty(HostArray.prototype,'2',{set:()=>{calls++;},configurable:true});
		await expect(execute('a.unshift(0);',{a:new HostArray(1,2)})).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
		expect(calls).toBe(0);
	});
	for (const route of ['nested','async','reenter','parallel','public-call','throw']) test(`${route}: ホストから受け取る accessor 配列は呼ばずに拒否する`, async () => {
		let calls = 0;
		const make = () => { const a = [1,2]; Object.defineProperty(a,'0',{ get: () => { calls++; return 7; }, configurable:true }); return a; };
		if (route === 'public-call') {
			const vm = new Interpreter();
			try {
				await vm.exec(parse('function take(a){return a.shift();}').program);
				await expect(vm.call(vm.getGlobal('take'), [make()])).rejects.toMatchObject({ code:'ACCESSOR_PROPERTY' });
			} finally { vm.abort(); }
		} else {
			const sources = {
				nested:'const box=make(); box.items.shift();',
				async:'make().shift();',
				reenter:'work(a=>a.shift());',
				parallel:'[0,1].mapConcurrent(()=>make().shift(),1);',
				throw:'try { make(); } catch(a) { a.shift(); }',
			};
			const hostMake = route === 'nested' ? () => ({items:make()}) : route === 'async' || route === 'parallel' ? async () => { await Promise.resolve(); return make(); } : route === 'throw' ? () => { throw make(); } : make;
			const work = hostFunction((args,ctx) => ctx.call(args[0]!,[make()]));
			await expect(execute(sources[route], {make:hostMake,work})).rejects.toMatchObject({ code:'ACCESSOR_PROPERTY' });
		}
		expect(calls).toBe(0);
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
	test('ホスト配列の undefined は null とし、未対応の値は拒否する', async () => {
		expect((await execute('out(a.shift());',{a:[undefined,1]})).output).toEqual([null]);
		await expect(execute('a.shift();',{a:[Symbol('value')]})).rejects.toMatchObject({code:'UNSUPPORTED_VALUE'});
	});
	test('変更できない添字と length は既存の検査で拒否する', async () => {
		const a=[1,2]; Object.defineProperty(a,'0',{writable:false});
		await expect(execute('a.shift();',{a})).rejects.toMatchObject({code:'READONLY_PROPERTY'});
		const fixed=[1,2]; Object.defineProperty(fixed,'length',{writable:false});
		await expect(execute('a.unshift();',{a:fixed})).rejects.toMatchObject({code:'READONLY_PROPERTY'});
	});
});

for (const origin of ['script','host']) for (const mode of ['control','out','console','results','unshift']) {
	test(`${origin}/${mode}: ホストとのやり取りを挟むキューのステップは線形`, async () => {
		const steps: number[] = [];
		for (const size of mode === 'unshift' ? [2500,5000] : [5000,10000]) {
			const output: unknown[] = []; let final: unknown;
			const vm = new Interpreter({make:()=>Array.from({length:size},(_,i)=>i),out:(x:unknown)=>{output.push(x);},finish:(x:unknown)=>{final=x;}}, {onConsoleLog:args=>{output.push(args[0]);}, maxSteps:2000000});
			const source = mode === 'unshift'
				? `const st=${origin==='host'?'make()':'[]'}; for(let i=0;i<${size};i++){out(st);st.unshift(i);}finish(st);`
				: `const q=${origin==='host'?'make()':`range(0,${size})`}; const results=[];let sum=0;while(q.length){const x=q.shift();sum+=x;${mode==='out'?'out(x);':mode==='console'?'console.log(x);':mode==='results'?'out(x);results.push({x});':''}}finish([sum,q.length,results]);`;
			try { await vm.exec(parse(source).program); steps.push(vm.stepCount); }
			finally { vm.abort(); }
			if (mode === 'unshift') {
				expect(final).toEqual([...Array.from({length:size},(_,i)=>size-i-1),...(origin==='host'?Array.from({length:size},(_,i)=>i):[])]);
				expect(output.length).toBe(size); for(const value of output)expect(value).toBe(final);
			} else {
				expect(final).toEqual([size*(size-1)/2,0,mode==='results'?Array.from({length:size},(_,x)=>({x})):[]]);
				expect(output).toEqual(mode==='control'?[]:Array.from({length:size},(_,i)=>i));
			}
			expect(vm.stepCount).toBeLessThan(size*80);
		}
		expect(steps[1]!).toBeLessThan(steps[0]!*2.05);
	});
}

for (const route of ['Interpreter.call','HostContext.call']) {
	async function call(source: string, args: any[]) {
		const work = hostFunction((callbacks,ctx) => ctx.call(callbacks[0]!, args));
		const vm = new Interpreter({work});
		try {
			await vm.exec(parse(source + (route === 'HostContext.call' ? '; const result=work(sh);' : '')).program);
			return route === 'Interpreter.call' ? await vm.call(vm.getGlobal('sh'), args) : vm.getGlobal('result');
		} finally { vm.abort(); }
	}
	test(`${route}: 残余引数の穴を使用前に拒否する`, async () => {
		await expect(call('function sh(...xs){xs.shift();return xs.shift();}',[1,,3])).rejects.toMatchObject({code:'SPARSE_ARRAY'});
	});
	for (const declaration of ['function sh(x){return x;}', 'function sh(...xs){return xs.shift();}']) test(`${route}: ${declaration} の引数 getter を呼ばない`, async () => {
		let reads=0; const args=[1,2]; Object.defineProperty(args,'0',{get:()=>{reads++;return 99;}});
		await expect(call(declaration,args)).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
		expect(reads).toBe(0);
	});
	test(`${route}: 未使用の末尾引数の setter も呼び出し前に拒否する`, async () => {
		let calls=0; const args=[1,2]; Object.defineProperty(args,'1',{set:()=>{calls++;}});
		await expect(call('function sh(x){return x;}',args)).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
		expect(calls).toBe(0);
	});
	test(`${route}: 密な引数の順序と残余引数を保つ`, async () => {
		expect(await call('function sh(first,...xs){xs.shift();return [first,xs.shift()];}',[1,2,3])).toEqual([1,3]);
	});
}
