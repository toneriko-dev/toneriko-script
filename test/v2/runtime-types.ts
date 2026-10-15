import { describe, expect, test } from 'vitest';
import { Interpreter, RuntimeError, hostFunction } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { formatDiagnostic } from '../../src/v2/diagnostics.js';
import { TypePlan } from '../../src/v2/runtime/type-plan.js';
import { isComposite, type TypeCheck } from '../../src/v2/runtime/type-checks.js';
import type * as A from '../../src/v2/ast.js';

async function execute(source: string, globals: Record<string, unknown> = {}) {
	const output: unknown[] = [];
	const interpreter = new Interpreter({ out: (value: unknown) => output.push(value), ...globals });
	await interpreter.exec(parse(source).program);
	return { output, interpreter };
}

const accepted: [string, string, unknown[]][] = [
	['入れ子分割の既定値を適用して構造を検査', 'let {outer:{child:{x}={x:1}}}:{outer:{child:{x:number}}}={outer:{}};out(x);', [1]],
	['static computed stringのrest除外', 'let {["x"]:x,...rest}:{x:number,y:string}={x:1,y:"ok"};rest={y:"ok"};out(rest.y);', ['ok']],
	['static computed numberのrest除外', 'let {[1]:x,...rest}:{1:number,y:string}={1:1,y:"ok"};rest={y:"ok"};out(rest.y);', ['ok']],
	['dynamic computedのrestは型を確定しない', 'let key="x";let {[key]:x,...rest}:{x:number,y:string}={x:1,y:"ok"};rest={y:1};out(rest.y);', [1]],
	['配列object分割のlengthはnumber', 'let {length}:string[]=["a"];length=2;out(length);', [2]],
	['配列object分割の非indexはany', 'let {push}:string[]=["a"];push=1;out(push);', [1]],
	['不足配列要素は既定値の後に検査', 'let [a,b=2]:number[]=[1];out([a,b]);', [[1,2]]],
	['不足object要素は既定値の後に検査', 'let {child:{n=2}}:{child:{n:number}}={child:{}};out(n);', [2]],

	['原始型と合併型', 'let n:number=2; let s:string="x"; let b:boolean=true; let z:null=null; let u:string|null=null; u="a"; let a:any={}; out([n,s,b,z,u]);', [[2, 'x', true, null, 'a']]],
	['初期値を省いた変数', 'let n:number; n=2; let a:number[]; a=[2]; out([n,a]);', [[2, [2]]]],
	['関数型', 'let f:Function=()=>3; let h:Function=out; let s:Function=range; out(f());', [3]],
	['既定引数を適用して検査', 'function f(x:number=3):number{return x} out([f(),f(null),f(2)]);', [[3,3,2]]],
	['optional引数はnullも受け入れる', 'function f(x?:number):number|null{return x} out([f(),f(null),f(2)]);', [[null,null,2]]],
	['voidは値なしとnullを受け入れる', 'function a():void{} function b():void{return} function c():void{return null} out([a(),b(),c()]);', [[null,null,null]]],
	['finally後の最終戻り値', 'function f():number {try{return "bad"}finally{return 2}} out(f());', [2]],
	['オブジェクトは直下まで', 'let x:{items:number[]}={items:["bad"]}; let y:{child:{n:number}}={child:{n:"bad"}}; out(x.items[0]);', ['bad']],
	['配列は直下まで', 'let x:{n:number}[]=[{n:"bad"}]; let y:number[][]=[["bad"]]; out(y[0][0]);', ['bad']],
	['余剰プロパティとoptional欠如', 'let x:{n:number,s?:string}={n:1,extra:true}; out(x.n);', [1]],
	['合併の各枝は同じ深さ', 'let x:({n:number}|{s:string})={s:"a"}; let a:(number|string)[]=[1,"a"]; out([x.s,a]);', [['a',[1,'a']]]],
	['配列分割の投影', 'let [x,...xs]:number[]=[1,2,3]; x=4; xs=[5]; out([x,xs]);', [[4,[5]]]],
	['入れ子投影とrest', 'let {a:{x},...rest}:{a:{x:number},y:string}={a:{x:1},y:"a"}; x=2; rest={y:"b"}; out([x,rest.y]);', [[2,'b']]],
	['動的restから取得したキーを除く', 'let k="x";let {[k]:x,...rest}:{x:number,y:string}={x:1,y:"a"};rest={y:"b"};out(rest.y);', ['b']],
	['分割既定値', 'let {x=2}:{x?:number}={}; out(x);', [2]],
	['プロパティ更新は次の境界で検査', 'let x:number[]=[1]; x[0]="bad"; out(x[0]);', ['bad']],
	['型付きfor周回', 'let outFns=[]; for(let i:number=0;i<3;i++)outFns.push(()=>i); out([outFns[0](),outFns[1](),outFns[2]()]);', [[0,1,2]]],
	['標準関数のcallback', 'out([1,2].map((x:number):number=>x+1));', [[2,3]]],
	['rest引数', 'function f(...xs:number[]):number{return xs.length} out(f(1,2));', [2]],
	['同名の別スコープ', 'let x:number=2; {let x="a";x=true;out(x)} out(x);', [true,2]],
];

const rejected: [string, string][] = [
	['投影後の配列束縛も直下まで検査', 'let {items}:{items:number[]}={items:["bad"]};'],
	['不足配列要素の束縛を検査', 'let [a,b]:number[]=[1];'],
	['不足object要素の束縛を検査', 'let {child:{n}}:{child:{n:number}}={child:{}};'],
	['配列object分割lengthの文字列を拒否', 'let {length}:string[]=["a"];length="bad";'],
	['配列object分割indexは要素型', 'let {0:x}:string[]=["a"];x=2;'],
	['static computed restの残存propertyを検査', 'let {["x"]:x,...rest}:{x:number,y:string}={x:1,y:"ok"};rest={y:1};'],

	['初期値', 'let x:number="bad";'],
	['単純代入', 'let x:number=1;x="bad";'],
	['複合代入', 'let x:number=1;x+="bad";'],
	['引数', 'function f(x:number){} f("bad");'],
	['既定引数', 'function f(x:number="bad"){} f();'],
	['戻り値', 'function f():number{return "bad"} f();'],
	['暗黙の戻り値', 'function f():number{} f();'],
	['式アローの戻り値', 'let f=():number=>"bad"; f();'],
	['finallyで上書きされた戻り値', 'function f():number{try{return 1}finally{return "bad"}} f();'],
	['voidの戻り値', 'function f():void{return 1} f();'],
	['optional引数の不正値', 'function f(x?:number){} f("bad");'],
	['配列要素', 'let x:number[]=[1,"bad"];'],
	['配列の再代入', 'let x:number[]=[1];x=["bad"];'],
	['オブジェクト直下の要素', 'let x:{a:number}={a:"bad"};'],
	['必須プロパティ欠如', 'let x:{a:any}={};'],
	['optionalの明示null', 'let x:{a?:number}={a:null};'],
	['オブジェクト型への配列', 'let x:{}=[];'],
	['配列型へのオブジェクト', 'let x:number[]={};'],
	['Function型', 'let x:Function={};'],
	['合併型', 'let x:number|string=true;'],
	['動的キー投影の再代入', 'let k="x";let {[k]:x}:{x:number,y:string}={x:1,y:"a"};x="bad";'],
	['リテラルcomputedキー投影', 'let {["x"]:x}:{x:number}={x:1};x="bad";'],
	['unionのrest投影', 'let {x,...rest}:({x:number,y:string}|{x:number,y:boolean})={x:1,y:true};rest={y:1};'],
	['入れ子分割初期値を投影型で検査', 'let {a:{x}}:{a:{x:string|boolean}}={a:{x:1}};x++;'],
	['ローカルの入れ子分割初期値を投影型で検査', 'function f(){let {a:{x}}:{a:{x:string|boolean}}={a:{x:1}};x++;}f();'],
	['分割後の再代入', 'let {x}:{x:number}={x:1};x="bad";'],
	['配列分割後の再代入', 'let [x]:number[]=[1];x="bad";'],
	['rest投影の再代入', 'let [x,...xs]:number[]=[1];xs=["bad"];'],
	['入れ子分割の既定値は構造全体も検査', 'let {child:{x}={x:1}}:{child?:{x:number,y:number}}={};'],
	['分割既定値の検査', 'let {x="bad"}:{x?:number}={};'],
	['for反復の型保持', 'for(let i:number=0;i<2;i++){i="bad";}'],
	['for ofの初期化', 'for(let x:number of [1,"bad"]){}'],
	['宣言なしfor of', 'let x:number=0;for(x of ["bad"]){}'],
	['分割代入の既存束縛', 'let x:number=0;[x]=["bad"];'],
	['callbackの引数', '["bad"].map((x:number)=>x);'],
	['callbackの戻り値', '[1].map((x):number=>"bad");'],
	['rest引数の要素', 'function f(...xs:number[]){} f(1,"bad");'],
	['次の境界で変異した配列を検査', 'let x:number[]=[1];x[0]="bad";function f(a:number[]){}f(x);'],
];

describe('実行時の型注釈', () => {
	for (const [name, source, expected] of accepted) test(name, async () => expect((await execute(source)).output).toEqual(expected));
	for (const [name, source] of rejected) test(name, async () => await expect(execute(source)).rejects.toMatchObject({ code: 'TYPE_ANNOTATION_MISMATCH' }));

	test('失敗する代入では値を書き換えない', async () => {
		expect((await execute('let x:number=1;try{x="bad"}catch(e){out(e.code)}out(x);')).output).toEqual(['TYPE_ANNOTATION_MISMATCH',1]);
	});

	test('周回でコピーした束縛にも閉包からの書込み検査を保つ', async () => {
		const source = 'let getters=[];let setters=[];for(let i:number=0;i<2;i++){getters.push(()=>i);setters.push((v)=>{i=v;});}try{setters[1]("bad")}catch(e){out(e.code)}out([getters[0](),getters[1]()]);';
		expect((await execute(source)).output).toEqual(['TYPE_ANNOTATION_MISMATCH',[0,1]]);
	});

	test('書込み失敗後も型検査と元の値を保つ', async () => {
		const source = 'const c:number=1;let x:number=2;try{c=3}catch(e){out(e.code)}try{x="bad"}catch(e){out(e.code)}out([c,x]);';
		expect((await execute(source)).output).toEqual(['CONST_ASSIGNMENT','TYPE_ANNOTATION_MISMATCH',[1,2]]);
	});

	test('日英の診断と位置', async () => {
		try { await execute('\nlet x:number="bad";'); throw new Error('missing failure'); }
		catch (error) {
			expect(error).toBeInstanceOf(RuntimeError);
			const diagnostic = error as RuntimeError;
			expect(diagnostic.pos).toEqual({line:2,column:5});
			expect(formatDiagnostic(diagnostic, 'ja')).toContain('number');
			expect(formatDiagnostic(diagnostic, 'en')).toContain('string');
		}
	});

	test('複数execと既存の閉包', async () => {
		const interpreter = new Interpreter();
		await interpreter.exec(parse('function set(value){x=value}').program);
		await interpreter.exec(parse('let x:number=1;').program);
		await expect(interpreter.call(interpreter.getGlobal('set'), ['bad'])).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
		expect(interpreter.getGlobal('x')).toBe(1);
	});

	test('別Interpreterから受け取った関数の注釈を取り込まない', async () => {
		const owner = new Interpreter();
		await owner.exec(parse('function f(x:number):number{return x;}').program);
		const fn = owner.getGlobal('f');
		const plain = new Interpreter({f:fn});
		const typed = new Interpreter({f:fn});
		await typed.exec(parse('let own:number=1;').program);
		await plain.exec(parse('let result=f("bad");').program);
		await typed.exec(parse('let result=f("bad");').program);
		expect(plain.getGlobal('result')).toBe('bad');
		expect(typed.getGlobal('result')).toBe('bad');
		await expect(plain.call(fn,['bad'])).resolves.toBe('bad');
		await expect(typed.call(fn,['bad'])).resolves.toBe('bad');
		await expect(owner.call(fn,['bad'])).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
	});

	test.each([
		['引数と戻り値', 'function f(x:number):number{return x;}', 'foreign("bad")'],
		['戻り値', 'function f():number{return "bad";}', 'foreign()'],
		['既定引数', 'function f(x:number="bad"):number{return x;}', 'foreign()'],
		['rest引数', 'function f(...xs:number[]):number{return xs[0];}', 'foreign("bad")'],
		['本体の変数', 'function f(x){let local:number=x;return local;}', 'foreign("bad")'],
		['本体の閉包', 'function f(x){return (y:number):number=>x+y;}', 'foreign("b")("ad")'],
		['HostContext', 'function f(x:number):number{return x;}', 'invoke(foreign)'],
		['map', 'function f(x:number):number{return x;}', '["bad"].map(foreign)[0]'],
		['戻り注釈のないmap', 'function f(x:number){return x;}', '["bad"].map(foreign)[0]'],
	])('同じASTでも別Interpreterの注釈を取り込まない: %s', async (_name, source, expression) => {
		const program = parse(source).program;
		const owner = new Interpreter();
		await owner.exec(program);
		const receiver = new Interpreter({ foreign: owner.getGlobal('f'), invoke: hostFunction(async (args, context) => context.call(args[0]!, ['bad'])) });
		receiver.prepareProgram(program);
		await receiver.exec(program);
		await receiver.exec(parse(`let result=${expression};`).program);
		expect(receiver.getGlobal('result')).toBe('bad');
	});

	test('同じASTの関数でも所有側の引数検査は維持する', async () => {
		const program = parse('function f(x:number):number{return x;}').program;
		const owner = new Interpreter();
		const receiver = new Interpreter();
		await owner.exec(program);
		await receiver.exec(program);
		await expect(receiver.call(owner.getGlobal('f'), ['bad'])).resolves.toBe('bad');
		await expect(receiver.call(receiver.getGlobal('f'), ['bad'])).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
		await expect(owner.call(owner.getGlobal('f'), ['bad'])).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
	});

	test('別Interpreterの深い型を再帰せず取り除く', async () => {
		const program = parse(`function f(x:number${'[]'.repeat(20000)}){return x;}`).program;
		const owner = new Interpreter();
		const receiver = new Interpreter();
		await owner.exec(program);
		receiver.prepareProgram(program);
		await expect(receiver.call(owner.getGlobal('f'), ['bad'])).resolves.toBe('bad');
	});

	test('同じProgramをprepareした型ありInterpreterでは捕捉済み束縛も検査される', async () => {
		const program = parse('let x:number=1;function f(value){x=value;return x;}').program;
		const owner = new Interpreter();
		const receiver = new Interpreter();
		await owner.exec(program);
		receiver.prepareProgram(program);
		await expect(receiver.call(owner.getGlobal('f'), ['bad'])).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
		expect(owner.getGlobal('x')).toBe(1);
	});

	test('型なしの別Interpreterでは捕捉済み束縛の検査を保証しない', async () => {
		const owner = new Interpreter();
		await owner.exec(parse('let x:number=1;function f(value){x=value;return x;}').program);
		const receiver = new Interpreter();
		await expect(receiver.call(owner.getGlobal('f'), ['bad'])).resolves.toBe('bad');
		expect(owner.getGlobal('x')).toBe('bad');
	});

	test.each([
		['let [a,b]:number[]=[1];', 'b', 'number'],
		['let [a,...rest]:number[]=[1,2,"a"];', 'rest[1]', 'number'],
		['let {a,...rest}:{a:number,b:number}={a:1,b:"a"};', 'rest.b', 'number'],
		['let [a,b]:number[]=[1,"bad"];', 'b', 'number'],
		['let {a:x}:{a:number}={a:"bad"};', 'x', 'number'],
		['let {a:x}:{a:number}={};', 'x', 'number'],
		['let xs:number[]="bad";', 'xs', 'number[]'],
		['let xs:(number|string)[]="bad";', 'xs', '(number | string)[]'],
		['let xs:number[][]="bad";', 'xs', 'number[][]'],
	])('診断に束縛名と簡潔な型名を示す: %s', async (source, name, expected) => {
		await expect(execute(source)).rejects.toMatchObject({ code:'TYPE_ANNOTATION_MISMATCH', params:{name,expected} });
	});

	test('ホストからのcallとHostContext.call', async () => {
		const interpreter = new Interpreter({ invoke: hostFunction(async (args, context) => context.call(args[0]!, ['bad'])) });
		await interpreter.exec(parse('function f(x:number):number{return x}').program);
		await expect(interpreter.call(interpreter.getGlobal('f'), ['bad'])).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
		await expect(interpreter.exec(parse('invoke(f);').program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
	});

	test('最終return式の位置を返す', async () => {
		await expect(execute(`function f():number {
try{return 1}
finally{return "bad"}
}
f();`)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH',pos:{line:3,column:16}});
	});

	test('最初から型付きのVMでは旧同期区間用のsetterを追加しない', async () => {
		const interpreter=new Interpreter();
		const tick=(interpreter as any).tick;
		await interpreter.exec(parse('let x:number=1;').program);
		const binding=(interpreter as any).global.bindings.get('x');
		expect(Object.getOwnPropertyDescriptor(binding,'value')).toMatchObject({value:1});
		expect((interpreter as any).tick).toBe(tick);
		await expect(interpreter.exec(parse('x="bad";').program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
	});

	test('注釈なしの準備では評価メソッドを差し替えない', async () => {
		const interpreter=new Interpreter();
		const methods=['tick','prepare','bind','invoke','callback','synchronous','evaluateSuspending'] as const;
		const original=methods.map(name=>(interpreter as any)[name]);
		const program=parse('let x=1;for(let i=0;i<3;i++)x+=i;').program;
		interpreter.prepareProgram(program);
		expect(methods.map(name=>(interpreter as any)[name])).toEqual(original);
		await interpreter.exec(program);
		const binding=(interpreter as any).global.bindings.get('x');
		expect(Object.getOwnPropertyDescriptor(binding,'value')).toMatchObject({value:4});
		expect(interpreter.stepCount).toBe(39);
		expect(interpreter.evaluationFrameCount).toBe(1);
	});

	for (const shape of ['union', 'rest'] as const) test(`広い${shape}の準備で投影を展開しない`, () => {
		const counts: number[] = [];
		for (const width of [32, 64, 128]) {
			const source = shape === 'union'
				? `let {${Array.from({length:width},(_,i)=>`k${i}`).join(',')}}:(${Array(width).fill('{a:number}').join('|')})=input;`
				: `let {${Array.from({length:width},(_,i)=>`a:{...r${i}}`).join(',')}}:{a:{${Array.from({length:width},(_,i)=>`p${i}:number`).join(',')}}}=input;`;
			const program = parse(source).program;
			const plan = new TypePlan();
			plan.prepare(program);
			const nodes: A.Node[] = [program];
			const checks: TypeCheck[] = [];
			while (nodes.length) {
				const node = nodes.pop()!;
				const check = plan.patterns.get(node as A.Pattern)?.check;
				if (check) checks.push(check);
				for (const [key, value] of Object.entries(node)) {
					if (key === 'loc' || key === 'typeAnnotation') continue;
					if (Array.isArray(value)) { for (const child of value) if (child && typeof child === 'object' && 'type' in child) nodes.push(child); }
					else if (value && typeof value === 'object' && 'type' in value) nodes.push(value as A.Node);
				}
			}
			const seen = new Set<TypeCheck>();
			while (checks.length) {
				const check = checks.pop()!;
				if (seen.has(check)) continue;
				seen.add(check);
				if (check.kind === 'projection') { expect(check.resolved).toBeUndefined(); checks.push(check.source); }
				else if (check.kind === 'union') checks.push(...check.types);
				else if (check.kind === 'array') checks.push(check.element);
				else if (check.kind === 'object') checks.push(...check.properties.map(property=>property.check));
			}
			counts.push(seen.size);
			expect(seen.size).toBeLessThanOrEqual(width * 4);
		}
		expect(counts[1]!).toBeLessThanOrEqual(counts[0]! * 2);
		expect(counts[2]!).toBeLessThanOrEqual(counts[1]! * 2);
	});

	test('遅延した合併型の投影展開にも停止と譲りを適用する', async () => {
		let clock = 0;
		let yields = 0;
		let stop = false;
		const interpreter = new Interpreter({}, {
			now:()=>clock++, yieldInterval:1, maxBusyTime:100000, maxSteps:100000,
			yieldToHost:async()=>{if(stop && ++yields === 2)interpreter.abort();},
		});
		const union = Array(1000).fill('{a:number}').join('|');
		await interpreter.exec(parse(`let {a}:(${union})={a:1};`).program);
		const initialSteps = interpreter.stepCount;
		stop = true;
		await expect(interpreter.exec(parse('a="bad";').program)).rejects.toMatchObject({code:'EXECUTION_ABORTED'});
		expect(yields).toBe(2);
		expect(interpreter.stepCount - initialSteps).toBeLessThan(256);
		expect(interpreter.getGlobal('a')).toBe(1);
	});

	test('広い合併型の経路選択で引数展開を使わない', () => {
		const check: TypeCheck = {kind:'union',types:Array(150000).fill({kind:'number'})};
		expect(isComposite(check)).toBe(true);
	});

	for (const location of ['value','array','object'] as const) test(`合併型の枝を予算に課金する: ${location}`, async () => {
		const union = `${Array(2000).fill('number').join('|')}|string`;
		const source = location === 'value' ? `let x:(${union})="ok";` : location === 'array' ? `let x:(${union})[]=["ok"];` : `let x:{v:(${union})}={v:"ok"};`;
		const interpreter = new Interpreter({}, {maxSteps:100});
		await expect(interpreter.exec(parse(source).program)).rejects.toMatchObject({code:'STEP_LIMIT_EXCEEDED'});
		expect(interpreter.stepCount).toBe(101);
	});

	test('配列要素の合併型の検査中もホストへ譲れる', async () => {
		let clock=0;
		let yields=0;
		const interpreter=new Interpreter({}, {now:()=>clock++,yieldInterval:1,maxBusyTime:100000,maxSteps:100000,yieldToHost:async()=>{if(++yields===2)interpreter.abort();}});
		const union=Array(2000).fill('number').join('|');
		await expect(interpreter.exec(parse(`let x:(${union})[]=["bad"];`).program)).rejects.toMatchObject({code:'EXECUTION_ABORTED'});
		expect(yields).toBe(2);
		expect(interpreter.stepCount).toBeLessThan(256);
	});

	test('長い配列型も準備と診断でホストのスタックを使い切らない', async () => {
		await expect(execute(`let x:number${'[]'.repeat(20000)}=[];`)).resolves.toBeDefined();
		await expect(execute(`let x:number${'[]'.repeat(20000)}=1;`)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
	});

	test('getterを実行しない', async () => {
		let calls=0;
		const input = Object.defineProperty({}, 'x', {get(){calls++;return 1;},enumerable:true});
		await expect(execute('let x:{x:number}=input;', {input})).rejects.toMatchObject({code:'ACCESSOR_PROPERTY'});
		expect(calls).toBe(0);
	});

	test.each([
		['x="bad";let x:number=1;', 'TYPE_ANNOTATION_MISMATCH'],
		['x=2;let x:number=1;', 'TDZ_ACCESS'],
		['let n:number=1;missing=2;', 'UNBOUND_IDENTIFIER'],
		['const x:number=1;x="bad";', 'TYPE_ANNOTATION_MISMATCH'],
		['const x:number=1;x=2;', 'CONST_ASSIGNMENT'],
		['const x:number=1;x++;', 'CONST_ASSIGNMENT'],
	])('同期書込みのエラー順序を維持する: %s', async (source, code) => {
		await expect(execute(source)).rejects.toMatchObject({code});
	});

	test('循環値は直下だけ検査する', async () => {
		const input: Record<string, unknown>={}; input['self']=input;
		await expect(execute('let x:{self:{}}=input;', {input})).resolves.toBeDefined();
	});

	test('大きい検査を64要素以内の区間で譲り、中止できる', async () => {
		let clock=0;
		let yields=0;
		const interpreter = new Interpreter({ input: Array(10000).fill(1) }, {
			now:()=>clock++,yieldInterval:1,maxBusyTime:100000,maxSteps:100000,
			yieldToHost:async()=>{if(++yields===2)interpreter.abort();},
		});
		await expect(interpreter.exec(parse('let x:number[]=input;').program)).rejects.toMatchObject({code:'EXECUTION_ABORTED'});
		expect(yields).toBe(2);
		expect(interpreter.stepCount).toBeLessThan(256);
	});

	test('検査の要素数も実行予算へ課金する', async () => {
		const interpreter=new Interpreter({input:Array(1000).fill(1)},{maxSteps:100});
		await expect(interpreter.exec(parse('let x:number[]=input;').program)).rejects.toMatchObject({code:'STEP_LIMIT_EXCEEDED'});
		expect(interpreter.stepCount).toBe(101);
	});

	test('型ありの保持済み同期loopにも後から導入された複合型を適用する', async () => {
		let yielded!:()=>void;
		let resume!:()=>void;
		let once=false;
		const ready=new Promise<void>(resolve=>{yielded=resolve});
		const gate=new Promise<void>(resolve=>{resume=resolve});
		let clock=0;
		const interpreter=new Interpreter({input:['bad']}, {now:()=>clock++,yieldInterval:1,maxBusyTime:100000,yieldToHost:async()=>{if(!once){once=true;yielded();await gate}}});
		const first=interpreter.exec(parse('let n:number=0;while(n<100){n++;if(n>50)x=input;}').program);
		await ready;
		await interpreter.exec(parse('let x:number[]=[];').program);
		resume();
		await expect(first).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
		expect(interpreter.getGlobal('x')).toEqual([]);
	});

	test('切替前に保持した同期loopも新しい型付き束縛を検査する', async () => {
		let yielded!:()=>void;
		let resume!:()=>void;
		let once=false;
		const ready=new Promise<void>(resolve=>{yielded=resolve});
		const gate=new Promise<void>(resolve=>{resume=resolve});
		let clock=0;
		const interpreter=new Interpreter({}, {now:()=>clock++,yieldInterval:1,maxBusyTime:100000,yieldToHost:async()=>{if(!once){once=true;yielded();await gate}}});
		const first=interpreter.exec(parse('let i=0;while(i<100){i++;if(i>50)x="bad";}').program);
		await ready;
		await interpreter.exec(parse('let x:number=1;').program);
		resume();
		await expect(first).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
		expect(interpreter.getGlobal('x')).toBe(1);
	});
});
