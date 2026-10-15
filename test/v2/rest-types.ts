import { describe, expect, test } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

describe('restで実際にコピーする値の型検査', () => {
	test.each([
		['親検査済みprefixの変異', 'let [...r]:number[]=h;', 0, 64],
		['prefix付きrestの変異', 'let [a,...r]:number[]=h;', 1, 64],
		['コピー中の未取得要素の変異', 'let [...r]:number[]=h;', 999, 1100],
	])('%sをコピー時に拒否する', async (_name, source, index, threshold) => {
		const h: unknown[] = Array(1000).fill(1);
		let clock = 0;
		let changed = false;
		const interpreter = new Interpreter({h}, {
			now:()=>clock++, yieldInterval:1, maxBusyTime:100000,
			yieldToHost:async()=>{if (!changed && interpreter.stepCount >= threshold) {changed=true;h[index]='bad';}},
		});
		await expect(interpreter.exec(parse(source).program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
		expect(changed).toBe(true);
	});

	test.each([
		['array rest', 'setTimeout(()=>{h[0]="x"},0);let [...r]:number[]=h;out(typeof r[0]);', ()=>({h:Array(150000).fill(1)})],
		['prefix付きarray rest', 'setTimeout(()=>{h[1]="x"},0);let [a,...r]:number[]=h;out(typeof r[0]);', ()=>({h:Array(150000).fill(1)})],
		['object rest', 'setTimeout(()=>{o.b="x"},0);let {k0,...r}:{k0:number,b:number}=o;out(typeof r.b);', ()=>({o:Object.assign(Object.fromEntries(Array.from({length:60000},(_,index)=>[`k${index}`,1])),{b:1})})],
	] as const)('setTimeoutによる%sの実コピー値の変異を拒否する', async (_name, source, globals) => {
		let clock = 0;
		const output: unknown[] = [];
		const interpreter = new Interpreter({...globals(),out:(value:unknown)=>output.push(value)}, {now:()=>clock++,yieldInterval:1,maxBusyTime:1000000});
		await expect(interpreter.exec(parse(source).program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
		expect(output).toEqual([]);
	});

	test('同じInterpreterの別execによるコピー中の変異を拒否する', async () => {
		let clock = 0;
		let changed = false;
		const interpreter = new Interpreter({h:Array(1000).fill(1)}, {
			now:()=>clock++, yieldInterval:1, maxBusyTime:100000,
			yieldToHost:async()=>{
				if (!changed && interpreter.stepCount >= 1100) {
					changed=true;
					await interpreter.exec(parse('h[999]="bad";').program);
				}
			},
		});
		await expect(interpreter.exec(parse('let [...r]:number[]=h;').program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
		expect(changed).toBe(true);
	});

	test('object restでコピー中に変化したpropertyを検査する', async () => {
		const o: Record<string, unknown> = Object.fromEntries(Array.from({length:1000},(_,index)=>[`k${index}`,1]));
		o['b']=1;
		let clock = 0;
		let changed = false;
		const interpreter = new Interpreter({o}, {
			now:()=>clock++, yieldInterval:1, maxBusyTime:100000,
			yieldToHost:async()=>{if (!changed) {changed=true;o['b']='bad';}},
		});
		await expect(interpreter.exec(parse('let {k0,...r}:{k0:number,b:number}=o;').program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH',params:{name:'r.b'}});
	});

	test.each([
		['スクリプトError', 'let {...r}:{message:string}=new Error("oops");', {}],
		['ホストError', 'let {...r}:{message:string}=error;', {error:new Error('oops')}],
	])('%sの非列挙propertyがコピーにないことを検出する', async (_name, source, globals) => {
		const interpreter = new Interpreter(globals);
		await expect(interpreter.exec(parse(source).program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH',params:{name:'r.message',actual:'missing'}});
	});

	test('array unionのどの枝にも合わない実コピー値を拒否する', async () => {
		const h: unknown[] = Array(60).fill(1);
		let clock = 0;
		let changed = false;
		const interpreter = new Interpreter({h}, {
			now:()=>clock++, yieldInterval:1, maxBusyTime:100000,
			yieldToHost:async()=>{if (!changed) {changed=true;h.fill(true,1);}},
		});
		await expect(interpreter.exec(parse('let [a,...r]:number[]|string[]=h;').program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH',params:{name:'r',expected:'number[] | string[]'}});
	});

	test('object unionのどの枝にも合わない実コピー値を拒否する', async () => {
		const o: Record<string, unknown> = Object.fromEntries(Array.from({length:100},(_,index)=>[`k${index}`,1]));
		o['a']=1;o['b']=1;
		let clock = 0;
		let changed = false;
		const interpreter = new Interpreter({o}, {
			now:()=>clock++, yieldInterval:1, maxBusyTime:100000,
			yieldToHost:async()=>{if (!changed) {changed=true;o['b']=true;}},
		});
		await expect(interpreter.exec(parse('let {a,...r}:({a:number,b:number}|{a:string,b:string})=o;').program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH',params:{name:'r'}});
	});

	test('optional欠如と既定値を含むunionのrestを受理する', async () => {
		const interpreter = new Interpreter();
		await interpreter.exec(parse('let {a=1,...r}:({a?:number,b:string}|{a?:number,b:boolean})={b:"s"};').program);
		expect(interpreter.getGlobal('a')).toBe(1);
		expect(interpreter.getGlobal('r')).toEqual({b:'s'});
	});
});
