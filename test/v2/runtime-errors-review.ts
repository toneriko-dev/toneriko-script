import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

test('catch の位置を書き換えても構文木と次の実行を変更しない', async () => {
	const program = parse('for(let i=0;i<2;i++){try{null.x;}catch(e){out(e.pos.line);e.pos.line=999;}}').program;
	const snapshot = JSON.stringify(program);
	for (let run=0;run<2;run++) {
		const output: unknown[] = [];
		await new Interpreter({out:(x:unknown)=>{output.push(x);}}).exec(program);
		expect(output).toEqual([1,1]);
		expect(JSON.stringify(program)).toBe(snapshot);
	}
});

test.each(['try{null.x;}catch(e){check(e);}', 'check(new Error());', 'try{fail();}catch(e){check(e);}'])('公開エラーのプロパティを列挙しない: %s', async source => {
	const values: object[] = [];
	await new Interpreter({ check:(e:object)=>{values.push(e);}, fail:()=>{throw new RangeError('host');} }).exec(parse(source).program);
	expect(values).toHaveLength(1);
	expect(Object.keys(values[0]!)).toEqual([]);
	const output: unknown[] = [];
	await new Interpreter({ e:values[0], out:(x:unknown)=>{output.push(x);} }).exec(parse('out({...e});').program);
	expect(output).toEqual([{}]);
});

test('new Error() のmessageは空文字列', async () => {
	const output: unknown[]=[];
	await new Interpreter({out:(x:unknown)=>{output.push(x);}}).exec(parse('out(new Error().message);').program);
	expect(output).toEqual(['']);
});

test('Error は大域関数として new なしでも値を作る', async () => {
	const output: unknown[]=[];
	await new Interpreter({out:(x:unknown)=>{output.push(x);}}).exec(parse('out(typeof Error); const make=Error; out(make("x",{cause:7}).message); out(Error().message); out(Error("x",{cause:7}).cause);').program);
	expect(output).toEqual(['function','x','',7]);
});

test.each([new RangeError('host'), runInNewContext('new RangeError("host")')])('ホスト例外の原型にあるnameをコピーする', async error => {
	const output: unknown[]=[];
	await new Interpreter({fail:()=>{throw error;}, out:(x:unknown)=>{output.push(x);}}).exec(parse('try{fail();}catch(e){out(e.name);out(e.message);out(e.stack);}').program);
	expect(output).toEqual(['RangeError','host',null]);
});

test('then だけを持つ返却値を待たず同じオブジェクトとして使う', async () => {
	let thenCalls=0;
	const object={then:(resolve:(value:unknown)=>void)=>{thenCalls++;resolve(999);}};
	const output: unknown[]=[];
	await new Interpreter({object,id:(x:unknown)=>x,out:(x:unknown)=>{output.push(x);}}).exec(parse('out(id(object) === object);').program);
	expect(thenCalls).toBe(0);
	expect(output).toEqual([true]);
});

test('スクリプトのthenを持つオブジェクトをホストが返しても停止しない', async () => {
	const output: unknown[]=[];
	const interpreter=new Interpreter({id:(x:unknown)=>x,out:(x:unknown)=>{output.push(x);}});
	const watchdog=setTimeout(()=>interpreter.abort(),1000);
	try { await interpreter.exec(parse('const o={then:out};const r=id(o);out(r===o);out("after");').program); }
	finally { clearTimeout(watchdog); }
	expect(output).toEqual([true,'after']);
});

test('別realmの本物のPromiseを待つ', async () => {
	const output: unknown[]=[];
	await new Interpreter({f:()=>runInNewContext('Promise.resolve(42)'),out:(x:unknown)=>{output.push(x);}}).exec(parse('out(f());').program);
	expect(output).toEqual([42]);
});

test.each(['const x=2;', 'let x=2;', 'function x(){}'])('execをまたいで同じ宣言を上書きしない: %s', async second => {
	const interpreter=new Interpreter();
	await interpreter.exec(parse('const x=1;').program);
	await expect(interpreter.exec(parse(second).program)).rejects.toMatchObject({code:'DUPLICATE_DECLARATION',name:'SyntaxError'});
	expect(interpreter.getGlobal('x')).toBe(1);
});

test.each(['items', '[...items]'])('毎周ホストを呼んでも配列を再走査しない: %s', async source => {
	const steps:number[]=[];
	for (const call of ['', 'h();']) {
		const output:unknown[]=[];
		const interpreter=new Interpreter({items:Array.from({length:1000},(_,i)=>i), h:()=>null,out:(x:unknown)=>{output.push(x);}}, {maxSteps:100000});
		await interpreter.exec(parse(`const a=${source};let k=0;for(const it of a){${call} k+=it;}out(k);`).program);
		expect(output).toEqual([499500]);
		steps.push(interpreter.stepCount);
	}
	expect(steps[1]).toBe(steps[0]!+4000);
});

test('配列の独自pushとtagを呼び出しとspreadでも保持する', async () => {
	const a=Object.assign([],{push:()=>123,tag:7});
	const output:unknown[]=[];
	await new Interpreter({a,out:(x:unknown)=>{output.push(x);}}).exec(parse('out(a.push(1));out(a.length);out(a.tag);out({...a}.tag);out("push" in []);out(typeof [].push);out(typeof "x".at);').program);
	expect(output).toEqual([123,0,7,7,true,'function','function']);
});

test('ホストが反復の途中に開けた穴を読んだ所で止める', async () => {
	const a=[1,2];
	const output:unknown[]=[];
	await expect(new Interpreter({a,h:()=>{delete a[1];},out:(x:unknown)=>{output.push(x);}}).exec(parse('for(const x of a){out(x);h();}').program)).rejects.toMatchObject({code:'SPARSE_ARRAY'});
	expect(output).toEqual([1]);
});

test('then getterを持つオブジェクトを待たない', async () => {
	let calls=0;
	for(const value of [{get then(){calls++;return ()=>{};}}]) {
		const output:unknown[]=[];
		await new Interpreter({value,id:(x:unknown)=>x,out:(x:unknown)=>{output.push(x);}}).exec(parse('out(id(value) === value);').program);
		expect(output).toEqual([true]);
	}
	expect(calls).toBe(0);
});

test('再送出したエラーは同一性を保ち、内部診断の位置を共有しない', async () => {
	const output:unknown[]=[];
	const interpreter=new Interpreter({out:(x:unknown)=>{output.push(x);}});
	await expect(interpreter.exec(parse('try{null.x;}catch(a){try{throw a;}catch(b){out(a===b);b.message="changed";throw b;}}').program)).rejects.toMatchObject({code:'NULL_PROPERTY_ACCESS',pos:{line:1,column:5},message:'changed'});
	expect(output).toEqual([true]);
});


test('Error.isError が無い環境でもホストと別realmの例外を扱う', () => {
	const source = `
		delete Error.isError;
		const {Interpreter} = await import('./src/v2/interpreter.ts');
		const {parse} = await import('./src/v2/parser/index.ts');
		const {runInNewContext} = await import('node:vm');
		const out=[];
		await new Interpreter({fail:()=>{throw runInNewContext('new RangeError("x")');},out:x=>{out.push(x);}}).exec(parse('try{fail();}catch(e){out(e.name);out(e.message);out(e.stack);}').program);
		console.log(JSON.stringify(out));
	`;
	const child=spawnSync('bun',['--eval',source],{encoding:'utf8',timeout:10000});
	expect(child.status,child.stderr).toBe(0);
	expect(JSON.parse(child.stdout)).toEqual(['RangeError','x',null]);
});


test.each([false,true])('Promise の constructor の TypeError を握りつぶさない: realm=%s', async foreign => {
	const promise=foreign ? runInNewContext('Promise.resolve(42)') : Promise.resolve(42);
	Object.defineProperty(promise,'constructor',{get(){throw new TypeError('constructor');}});
	await expect(new Interpreter({f:()=>promise}).exec(parse('f();').program)).rejects.toMatchObject({name:'TypeError',message:'constructor'});
});

test('ホスト経由で再送出したスクリプトのエラーも同一性を保つ', async () => {
	const output:unknown[]=[];
	await new Interpreter({bounce:(e:unknown)=>{throw e;},out:(x:unknown)=>{output.push(x);}}).exec(parse('try{null.x;}catch(a){try{bounce(a);}catch(b){out(a===b);out(b.code);}}').program);
	expect(output).toEqual([true,'NULL_PROPERTY_ACCESS']);
});
