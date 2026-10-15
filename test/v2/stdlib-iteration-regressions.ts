import { describe, expect, test } from 'vitest';
import { Interpreter, type InterpreterOptions } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { PropertyAccess } from '../../src/v2/runtime/values.js';

async function execute(source: string, globals: Record<string, unknown> = {}, options: InterpreterOptions = {}) {
	const output: unknown[] = [];
	const vm = new Interpreter({ ...globals, out: (value: unknown) => { output.push(structuredClone(value)); } }, options);
	try { await vm.exec(parse(source).program); return { output, steps: vm.stepCount }; }
	finally { vm.abort(); }
}

describe('標準ライブラリの反復の回帰', () => {
	test('entries の分割代入は必要な要素だけ進める', async () => {
		expect((await execute('const it=[10,20,30].entries(); const [first]=it; out(first); out(it.next()); const []=it; out(it.next());')).output).toEqual([[0,10], { value:[1,20],done:false }, {value:[2,30],done:false}]);
		expect((await execute('const it=[10,20,30,40].entries(); let first; [,first]=it; out(first); out(it.next()); const [...rest]=it; out(rest); out(it.next());')).output).toEqual([[1,20],{value:[2,30],done:false},[[3,40]],{value:null,done:true}]);
	});
	test('分割代入の空パターンも反復可能性を検査し、既定値は消費の間に評価する', async () => {
		await expect(execute('const [] = {};')).rejects.toMatchObject({code:'NOT_ITERABLE'});
		expect((await execute('const a=[null,20]; const add=()=>{a.push(30);return 10;}; const [first=add(), ...rest]=a; out([first,rest]);')).output).toEqual([[10,[20,30]]]);
	});
	test('文字列の反復子はキャッシュを消しても分割結果を保持する', () => {
		for (const value of ['a'.repeat(1000), 'e\u0301👩‍💻\r\n'.repeat(100)]) {
			for (const entries of [false,true]) {
				let steps=0; const properties=new PropertyAccess(()=>{steps++;});
				const pos={line:1,column:1};
				const it=entries ? properties.entriesIterator(value,pos) : properties.iterableIterator(value,pos);
				const expected=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value),p=>p.segment);
				const actual: unknown[]=[];
				for(const item of it){ actual.push(entries ? (item as [string,unknown])[1] : item); properties.clear(); }
				expect(actual).toEqual(expected);
				expect(steps).toBeLessThan(value.length*4);
			}
		}
	});
	test('20 万字の for-of は連結でキャッシュが追い出されても線形のステップ数', async () => {
		const {output,steps}=await execute('let result=""; for(const c of s){result=result+c+c;} out(result);',{s:'a'.repeat(200000)},{maxSteps:7000000});
		expect(output).toEqual(['a'.repeat(400000)]); expect(steps).toBeLessThan(6500000);
	});
	test('Array.from と groupBy の文字列反復はコールバックがキャッシュを埋めても線形', async () => {
		for(const method of ['Array.from(s,f)', 'Object.groupBy(s,f)']) {
			const {output,steps}=await execute(`let result=""; const f=c=>{result=result+c+c;return c;}; ${method}; out(result);`,{s:'a'.repeat(150000)},{maxSteps:8000000});
			expect(output).toEqual(['a'.repeat(300000)]); expect(steps).toBeLessThan(8000000);
		}
	});
	test('Object.keys の文字列経路は書記素ごとに添字を返す', async () => {
		expect((await execute('out(Object.keys("é👩‍💻\\r\\n"));')).output).toEqual([['0','1','2']]);
	});
	test('shift と unshift のステップ数は配列の長さに依存しない', async () => {
		for(const operation of ['q.shift()', 'q.unshift(9,8)']) {
			const measured: number[]=[];
			for(const n of [1,5000]) {
				const vm=new Interpreter(); await vm.exec(parse(`const q=range(0,${n});`).program);
				const before=vm.stepCount; await vm.exec(parse(`${operation};`).program); measured.push(vm.stepCount-before); vm.abort();
			}
			expect(measured[0]).toBe(measured[1]);
		}
	});
	test('5000 件のキューを上限内で空にでき、先頭追加の順序も保持する', async () => {
		const result=await execute('const q=range(0,5000); let total=0; while(q.length){total+=q.shift();} out([q.length,total]); q.unshift(1,2); q.unshift(3,4); out(q);',{}, {maxSteps:200000});
		expect(result.output).toEqual([[0,12497500],[3,4,1,2]]);
	});
	test('ホスト配列の shift と unshift は添字 getter を呼ばない', async () => {
		for(const method of ['shift()', 'unshift(9)']) {
			let reads=0; const array=[1,2]; Object.defineProperty(array,'1',{get(){reads++;return 2;}});
			await expect(execute(`array.${method};`,{array})).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
			expect(reads).toBe(0);
		}
	});
	test('Array.from はホストの反復可能値や配列状インスタンスを拒否する', async () => {
		let calls=0; class Items {length=1; 0=7; *[Symbol.iterator](){calls++;yield 7;} }
		for(const value of [new Set([1]),new Map([[1,2]]),new Items(),{length:1,0:7}, {[Symbol.iterator](){calls++;return [1][Symbol.iterator]();}}]) {
			await expect(execute('Array.from(value);',{value})).rejects.toMatchObject({code:'NOT_ITERABLE'});
		}
		expect(calls).toBe(0);
		expect((await execute('out(Array.from({length:3,0:7},(x,i)=>x===null?i:x));')).output).toEqual([[7,1,2]]);
	});
});
