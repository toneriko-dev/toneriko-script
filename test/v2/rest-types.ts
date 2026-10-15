import { describe, expect, test } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import type { TypePlan } from '../../src/v2/runtime/type-plan.js';
import type * as A from '../../src/v2/ast.js';

describe('restで実際にコピーする値の型検査', () => {
	test.each(['loop','function'])('object内のrest射影は型と経路ごとに一度だけ展開する: %s', async mode => {
		const measure = async (width: number, repetitions: number) => {
			const annotation = ['{v:number[]}',...Array.from({length:width-1},(_,index)=>`{v:{k${index}:number}[]}`)].join('|');
			const source = mode === 'loop'
				? `for(let i=0;i<${repetitions};i++){let {v:[,...r]}:${annotation}={v:[1,2]};}`
				: `function f({v:[,...r]}:${annotation}){}for(let i=0;i<${repetitions};i++){f({v:[1,2]});}`;
			const program = parse(source).program;
			const interpreter = new Interpreter();
			interpreter.prepareProgram(program);
			const plan = (interpreter as unknown as {typePlan:TypePlan}).typePlan;
			const pending: A.Node[] = [program];
			let visits = 0;
			while (pending.length) {
				const node = pending.pop()!;
				if (node.type === 'ObjectPattern' && node.typeAnnotation) {
					const check = plan.patterns.get(node)!.check;
					if (check.kind !== 'union') throw new Error('union expected');
					check.types = new Proxy(check.types, {get(target,key,receiver) {
						if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) visits++;
						return Reflect.get(target,key,receiver);
					}});
				}
				for (const [key,value] of Object.entries(node)) {
					if (key === 'loc' || key === 'typeAnnotation') continue;
					if (Array.isArray(value)) {
						for (const child of value) if (child && typeof child === 'object' && 'type' in child) pending.push(child);
					} else if (value && typeof value === 'object' && 'type' in value) pending.push(value as A.Node);
				}
			}
			await interpreter.exec(program);
			return {visits,steps:interpreter.stepCount};
		};
		const once = await measure(100,1);
		const repeated = await measure(100,20);
		const wider = await measure(200,20);
		expect(repeated.visits - once.visits).toBe(19);
		expect(wider.visits - repeated.visits).toBe(100);
		expect(wider.steps).toBe(repeated.steps);
		const large = await measure(2000,500);
		expect(large.steps).toBe(mode === 'loop' ? 10508 : 12010);
		expect(large.visits).toBe(2500);
	});

	test('動的キーの束縛専用rest射影はキーごとに型を分離する', async () => {
		const interpreter = new Interpreter();
		await interpreter.exec(parse('function f(key,bad){let {[key]:[,...r]}:{a:number[],b:string[]}={a:[1,2],b:["x","y"]};if(bad)r=[true];return r;}let a=f("a",false);let b=f("b",false);let again=f("a",false);let rejected=0;try{f("a",true);}catch(e){rejected++;}try{f("b",true);}catch(e){rejected++;}').program);
		expect(interpreter.getGlobal('a')).toEqual([2]);
		expect(interpreter.getGlobal('b')).toEqual(['y']);
		expect(interpreter.getGlobal('again')).toEqual([2]);
		expect(interpreter.getGlobal('rejected')).toBe(2);
		await interpreter.exec(parse('function g(key,bad){let {[key]:{v:[,...r]}}:{a:{v:number[]},b:{v:string[]}}={a:{v:[1,2]},b:{v:["x","y"]}};if(bad)r=[true];return r;}let nestedA=g("a",false);let nestedB=g("b",false);let nestedAgain=g("a",false);let nestedRejected=0;try{g("a",true);}catch(e){nestedRejected++;}try{g("b",true);}catch(e){nestedRejected++;}').program);
		expect(interpreter.getGlobal('nestedA')).toEqual([2]);
		expect(interpreter.getGlobal('nestedB')).toEqual(['y']);
		expect(interpreter.getGlobal('nestedAgain')).toEqual([2]);
		expect(interpreter.getGlobal('nestedRejected')).toBe(2);
	});

	test.each([[200000,0],[200,1000000]])('動的キー射影を静的キャッシュへ保持しない: %s 回、長さ %s', async (count, length) => {
		const interpreter = new Interpreter({}, {now:()=>0});
		const plan = (interpreter as unknown as {typePlan:TypePlan}).typePlan;
		let cacheCalls = 0;
		const project = plan.project.bind(plan);
		plan.project = (...args) => { cacheCalls++; return project(...args); };
		await interpreter.exec(parse('function f(key){let {[key]:x}:{}={};}').program);
		const fn = interpreter.getGlobal('f');
		for (let index=0;index<count;index++) await interpreter.call(fn, ['x'.repeat(length)+index]);
		expect(cacheCalls).toBe(0);
	});

	test('1回のexecで使う長い動的キーも静的キャッシュ項目を増やさない', async () => {
		const interpreter = new Interpreter({makeKey:(index:number)=>({key:String(index).padStart(6,'0')+'x'.repeat(1048576-6)})});
		const program = parse('function g(i){let {[makeKey(i).key]:x}:{a:number}={a:1};return x;}let good=0;for(let i=0;i<200;i++){if(g(i)===null)good++;}').program;
		const plan = (interpreter as unknown as {typePlan:TypePlan}).typePlan;
		const cache = (plan as unknown as {projections:WeakMap<A.Node,unknown>}).projections;
		const fn = program.body[0] as A.FunctionDeclaration;
		const declaration = fn.body.body[0] as A.VariableDeclaration;
		const root = declaration.declarations[0].id as A.ObjectPattern;
		const target = (root.properties[0] as A.Property).value;
		let cacheCalls = 0;
		const project = plan.project.bind(plan);
		plan.project = (...args) => { cacheCalls++; return project(...args); };
		expect(cache.has(target)).toBe(false);
		await interpreter.exec(program);
		expect(interpreter.getGlobal('good')).toBe(200);
		expect(cacheCalls).toBe(0);
		expect(cache.has(target)).toBe(false);
	});

	test.each(['array','object'])('動的射影のパターン生成も64ステップごとに譲る: %s', mode => {
		const members = Array.from({length:128},(_,index)=>`x${index}`).join(',');
		const pattern = mode === 'array' ? `[${members}]` : `{${members}}`;
		const program = parse(`let {[key]:${pattern}}:{v:any}=h;`).program;
		const interpreter = new Interpreter();
		interpreter.prepareProgram(program);
		const plan = (interpreter as unknown as {typePlan:TypePlan}).typePlan;
		const declaration = program.body[0] as A.VariableDeclaration;
		const root = declaration.declarations[0].id as A.ObjectPattern;
		const target = (root.properties[0] as A.Property).value as A.Pattern;
		let ticks = 0;
		const pauses: number[] = [];
		for (const _ of plan.projectDynamic(target, plan.patterns.get(root)!.check, 'v', ()=>{ticks++;})) pauses.push(ticks);
		expect(ticks).toBeGreaterThan(256);
		expect(pauses).toEqual(Array.from({length:Math.floor(ticks/64)},(_,index)=>(index+1)*64));
	});

	test('動的射影内の入れ子objectは準備済みの束縛計画を再利用する', async () => {
		const width = 2000;
		const annotation = ['{v:number[]}',...Array.from({length:width-1},(_,index)=>`{v:{k${index}:number}[]}`)].join('|');
		const program = parse(`let key="a";let {[key]:{v:[,...r]}}:{a:(${annotation})}={a:{v:[1,2]}};`).program;
		const interpreter = new Interpreter();
		interpreter.prepareProgram(program);
		const plan = (interpreter as unknown as {typePlan:TypePlan}).typePlan;
		const declaration = program.body[1] as A.VariableDeclaration;
		const root = declaration.declarations[0].id;
		const check = plan.patterns.get(root)!.check;
		if (check.kind !== 'object') throw new Error('object expected');
		const union = check.byKey.get('a')!.check;
		if (union.kind !== 'union') throw new Error('union expected');
		let visits = 0;
		union.types = new Proxy(union.types, {get(target,key,receiver) {
			if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) visits++;
			return Reflect.get(target,key,receiver);
		}});
		let cacheCalls = 0;
		const project = plan.project.bind(plan);
		plan.project = (...args) => { cacheCalls++; return project(...args); };
		await interpreter.exec(program);
		expect(cacheCalls).toBe(0);
		expect(visits).toBe(width+1);
		expect(interpreter.stepCount).toBeGreaterThan(width*2);
		expect(interpreter.getGlobal('r')).toEqual([2]);
	});

	test('異なる動的キーの広い射影準備は実行予算に含める', async () => {
		const annotation = ['{v:number[]}',...Array.from({length:1999},(_,index)=>`{v:{k${index}:number}[]}`)].join('|');
		const h = Object.fromEntries([['v',[1,2]],...Array.from({length:20},(_,index)=>[`k${index}`,[1,2]])]);
		const interpreter = new Interpreter({h}, {maxSteps:10000,now:()=>0});
		await expect(interpreter.exec(parse(`for(let i=0;i<20;i++){let {["k"+i]:[,...r]}:${annotation}=h;}`).program)).rejects.toMatchObject({code:'STEP_LIMIT_EXCEEDED'});
		expect(interpreter.stepCount).toBe(10001);
	});

	test('動的キーの広い射影準備は途中で譲って中断する', async () => {
		const annotation = ['{v:number[]}',...Array.from({length:1999},(_,index)=>`{v:{k${index}:number}[]}`)].join('|');
		let clock = 0;
		let yielded = 0;
		const interpreter = new Interpreter({h:{v:[1,2]}}, {
			now:()=>clock++,yieldInterval:1,maxBusyTime:1000000,
			yieldToHost:async()=>{if (++yielded === 2) interpreter.abort();},
		});
		await expect(interpreter.exec(parse(`let key="v";let {[key]:[,...r]}:${annotation}=h;`).program)).rejects.toMatchObject({code:'EXECUTION_ABORTED'});
		expect(interpreter.stepCount).toBeLessThan(256);
	});

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
		await expect(interpreter.exec(parse('let [a,...r]:number[]|string[]=h;').program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH',params:{name:'r[0]',expected:'number | string'}});
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

	test.each([
		['optional配列の入れ子分割', 'let {a:[x,...r]}:{a?:number[]}={a:[1,"x"]};'],
		['nullable配列の入れ子分割', 'let [[x,...r]]:(number[]|null)[]=[[1,"x"]];'],
		['optional配列の引数分割', 'function f({a:[x,...r]}:{a?:number[]}){}f({a:[1,"x"]});'],
		['非反復の全種類を配列射影から除く', 'let [a,...r]:number[]|boolean|number|Function=[1,2];r="bad";'],
		['nullable配列restの後代入', 'let [a,...r]:number[]|null=[1];r="x";'],
		['stringのrestへのnumber配列代入', 'let [a,...r]:string="abc";r=[1];'],
		['明示rootのstring枝でarrayを受け入れない', 'let [...r]:number[]|string=["x"];'],
		['不足要素の束縛を検査する', 'let [a,b,...r]:(number|string)[]=[1];'],
		['不正な既定値を検査する', 'let [a,b=true,...r]:(number|string)[]=[1];'],
		['array合併の初期値全体を分割前に検査する', 'let [a,...r]:number[]|string[]=[1,"x"];'],
	])('分割合併型の不正値を拒否する: %s', async (_name, source) => {
		await expect(new Interpreter().exec(parse(source).program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
	});

	test.each([
		['非明示projectionは値から枝を狭めない', 'let {a:[...r]}:{a:number[]|string}={a:["x"]};', ['x']],
		['stringの初期rest内容', 'let [a,...r]:string="abc";', ['b','c']],
		['stringのrestはstring配列', 'let [a,...r]:string="abc";r=["x"];', ['x']],
		['anyを含む射影', 'let [a,...r]:number[]|any=[1];r=true;', true],
		['既定値と空rest', 'let [a=1,...r]:(number|string)[]=[];', []],
		['object分割ではnull枝を除く', 'let {a}:({a:number}|null)={a:1};a=2;let r=a;', 2],
	])('分割合併型の有効値を受理する: %s', async (_name, source, expected) => {
		const interpreter = new Interpreter();
		await interpreter.exec(parse(source).program);
		expect(interpreter.getGlobal('r')).toEqual(expected);
	});

	test.each([
		['要素unionの先頭string混在', '(number|string)[]', true, 300012, 350013, 100000],
		['要素unionの全number', '(number|string)[]', false, 200012, 300012, 100000],
		['入れ子unionの全number', '(number|string)[]|(number|boolean)[]', false, 40016, 60017, 20000],
		['array unionのnumber枝', 'number[]|string[]', false, 200015, 200016, 100000],
	])('union restの実照合枝をステップに含める: %s', async (_name, annotation, mixed, expectedSteps, ceiling, size) => {
		const h = Array.from({length:size},(_,index)=>mixed && index%2===0 ? 'x' : 1);
		const interpreter = new Interpreter({h});
		await interpreter.exec(parse(`let [a,...r]:${annotation}=h;`).program);
		expect(interpreter.stepCount).toBe(expectedSteps);
		expect(interpreter.stepCount).toBeLessThanOrEqual(ceiling);
		expect(interpreter.getGlobal('r')).toEqual(h.slice(1));
	});

	test.each([[5,120016],[10,220016]])('restコピーの広い合併は2つ目以降の照合枝を課金する: %s 枝', async (branches, expectedSteps) => {
		const annotation = [...Array.from({length:branches},(_,index)=>`{k${index}:number}`),'number'].join('|');
		const h = Array(20000).fill(1);
		const interpreter = new Interpreter({h});
		await interpreter.exec(parse(`let [[a,...r]]:(${annotation})[][]=[h];`).program);
		expect(interpreter.stepCount).toBe(expectedSteps);
		expect(interpreter.getGlobal('r')).toEqual(h.slice(1));
	});

	test('restコピーの巨大な合併は既定ステップ上限で停止する', async () => {
		const annotation = [...Array.from({length:5000},(_,index)=>`{k${index}:number}`),'number'].join('|');
		const interpreter = new Interpreter({h:Array(240000).fill(1)}, {now:()=>0});
		await expect(interpreter.exec(parse(`let [[a,...r]]:(${annotation})[][]=[h];`).program)).rejects.toMatchObject({code:'STEP_LIMIT_EXCEEDED'});
		expect(interpreter.stepCount).toBe(500001);
	});

	test.each([
		[1,21], ['x',31], [true,41],
	])('restコピーの入れ子合併は成功した枝で短絡する: %s', async (value, expectedSteps) => {
		const h = Array(10).fill(value);
		const interpreter = new Interpreter({h});
		await interpreter.exec(parse('let [[...r]]:(number|(string|boolean))[][]=[h];').program);
		expect(interpreter.stepCount).toBe(expectedSteps);
		expect(interpreter.getGlobal('r')).toEqual(h);
		const flat = new Interpreter({h});
		await flat.exec(parse('let [[...r]]:(number|string|boolean)[][]=[h];').program);
		expect(flat.stepCount).toBe(expectedSteps);
		expect(flat.getGlobal('r')).toEqual(h);
	});

	test('string分割は書記素単位で要素とrestを取り出す', async () => {
		const interpreter = new Interpreter();
		await interpreter.exec(parse('let [a,...r]:string="👨‍👩‍👧‍👦áz";').program);
		expect(interpreter.getGlobal('a')).toBe('👨‍👩‍👧‍👦');
		expect(interpreter.getGlobal('r')).toEqual(['á','z']);
	});

	test('広い合併の束縛射影も停止予算に含める', async () => {
		const annotation = Array(5000).fill('number[]').join('|');
		const interpreter = new Interpreter({h:Array(100).fill(1)}, {maxSteps:2000});
		await expect(interpreter.exec(parse(`let [x]:${annotation}=h;`).program)).rejects.toMatchObject({code:'STEP_LIMIT_EXCEEDED'});
		expect(interpreter.stepCount).toBe(2001);
	});

	test('広い合併の束縛射影も途中で譲る', async () => {
		const annotation = Array(5000).fill('number[]').join('|');
		let clock=0;
		let yielded=0;
		const interpreter = new Interpreter({h:[1]}, {
			now:()=>clock++,yieldInterval:1,maxBusyTime:1000000,
			yieldToHost:async()=>{if (++yielded===2) interpreter.abort();},
		});
		await expect(interpreter.exec(parse(`let [x]:${annotation}=h;`).program)).rejects.toMatchObject({code:'EXECUTION_ABORTED'});
		expect(interpreter.stepCount).toBeLessThan(256);
	});

	test('nullable配列restのtimer変異で不正な束縛を公開しない', async () => {
		let clock=0;
		const output: unknown[]=[];
		const interpreter = new Interpreter({h:Array(150000).fill(1),out:(value:unknown)=>output.push(value)}, {now:()=>clock++,yieldInterval:1,maxBusyTime:1000000});
		try {
			await interpreter.exec(parse('setTimeout(()=>{h[1]="x"},0);let [a,...r]:number[]|null=h;out(typeof r[0]);').program);
			expect(output).toEqual(['number']);
		} catch (error) { expect(error).toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'}); }
	});

	test('nullable配列restの未取得末尾が別execで変化したら拒否する', async () => {
		let clock=0;
		let changed=false;
		const interpreter = new Interpreter({h:Array(1000).fill(1)}, {
			now:()=>clock++,yieldInterval:1,maxBusyTime:1000000,
			yieldToHost:async()=>{if (!changed) {changed=true;await interpreter.exec(parse('h[999]="bad";').program);}},
		});
		await expect(interpreter.exec(parse('let [a,...r]:number[]|null=h;').program)).rejects.toMatchObject({code:'TYPE_ANNOTATION_MISMATCH'});
	});

	test.each([
		['next構造型/restあり', 'let [a,...r]:{next:Function}|string[]=["x"].entries();', true],
		['object型/restあり', 'let [a,...r]:{}|string[]=["x"].entries();', true],
		['next構造型/restなし', 'let [a]:{next:Function}|string[]=["x"].entries();', false],
		['object型/restなし', 'let [a]:{}|string[]=["x"].entries();', false],
	])('構造型のイテレータを分割できる: %s', async (_name, source, rest) => {
		const interpreter = new Interpreter();
		await interpreter.exec(parse(source).program);
		expect(interpreter.getGlobal('a')).toEqual([0,'x']);
		if (rest) expect(interpreter.getGlobal('r')).toEqual([]);
	});

	test('明示注釈は既定値の副作用より先に全体検査する', async () => {
		const output: unknown[]=[];
		const interpreter = new Interpreter({out:(value:unknown)=>output.push(value)});
		await interpreter.exec(parse('function f(){out("called");return 1;}try{let [{x=f()},...r]:{x?:number}[]|string[]=[{},"s"];}catch(e){out("caught");}').program);
		expect(output).toEqual(['caught']);
	});

	test('非明示の入れ子array unionは各束縛へ独立して射影する', async () => {
		const interpreter = new Interpreter();
		await interpreter.exec(parse('let {a:[b,...r]}:{a:number[]|string[]}={a:[1,"x"]};r=[2,"y"];').program);
		expect(interpreter.getGlobal('b')).toBe(1);
		expect(interpreter.getGlobal('r')).toEqual([2,'y']);
	});

	test('親検査後の既定値がrestを別の合法型へ変えても受理する', async () => {
		const interpreter = new Interpreter();
		await interpreter.exec(parse('let h=[{},{}];function f(){h[1]="x";return 1;}let [{x=f()},...r]:{x?:number}[]|string[]=h;').program);
		expect(interpreter.getGlobal('x')).toBe(1);
		expect(interpreter.getGlobal('r')).toEqual(['x']);
	});

	test('非明示array unionのrest自体が混在しても受理する', async () => {
		const interpreter = new Interpreter();
		await interpreter.exec(parse('let {a:[...r]}:{a:number[]|string[]}={a:[1,"x"]};').program);
		expect(interpreter.getGlobal('r')).toEqual([1,'x']);
	});

	test('親検査後の別execで各束縛が別の合法型になっても受理する', async () => {
		let clock=0;
		let changed=false;
		const interpreter = new Interpreter({h:Array(60).fill(1)}, {
			now:()=>clock++,yieldInterval:1,maxBusyTime:1000000,
			yieldToHost:async()=>{if (!changed) {changed=true;await interpreter.exec(parse('h[1]="x";').program);}},
		});
		await interpreter.exec(parse('let [a,b]:number[]|string[]=h;').program);
		expect(interpreter.getGlobal('a')).toBe(1);
		expect(interpreter.getGlobal('b')).toBe('x');
	});

	test('optional欠如と既定値を含むunionのrestを受理する', async () => {
		const interpreter = new Interpreter();
		await interpreter.exec(parse('let {a=1,...r}:({a?:number,b:string}|{a?:number,b:boolean})={b:"s"};').program);
		expect(interpreter.getGlobal('a')).toBe(1);
		expect(interpreter.getGlobal('r')).toEqual({b:'s'});
	});
});
