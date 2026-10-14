import * as assert from 'assert';
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { Parser, Interpreter, values, errors, utils, Ast } from '../src';
import { ARR, ERROR, FALSE, NUM, OBJ, STR, TRUE, Value } from '../src/interpreter/value';

let { FN_NATIVE } = values;
let { TonerikoScriptRuntimeError, TonerikoScriptIndexOutOfRangeError, TonerikoScriptHostsideError } = errors;

test('maxStep is applied per top-level execution', async () => {
	const parser = new Parser();
	const interpreter = new Interpreter({}, { maxStep: 10 });
	const script = parser.parse('<: 1');
	for (let i = 0; i < 20; i++) {
		await interpreter.exec(script);
	}
});

describe('value conversion', () => {
	test.concurrent('special object keys do not alter the prototype', () => {
		const value = OBJ(new Map([['__proto__', OBJ(new Map([['polluted', TRUE]]))]]));
		const result = utils.valToJs(value);

		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
		expect(Object.hasOwn(result as object, '__proto__')).toBe(true);
		expect((result as Record<string, unknown>).polluted).toBeUndefined();
		expect((result as Record<string, unknown>).__proto__).toEqual({ polluted: true });
	});

	test.concurrent('preserves circular and shared references when converting to JavaScript', () => {
		const source = OBJ(new Map());
		const shared = ARR([STR('shared')]);
		source.value.set('self', source);
		source.value.set('first', shared);
		source.value.set('second', shared);

		const result = utils.valToJs(source) as Record<string, unknown>;

		expect(result.self).toBe(result);
		expect(result.first).toBe(result.second);
	});

	test.concurrent('preserves circular and shared references when converting from JavaScript', () => {
		const shared = ['shared'];
		const sparse: unknown[] = [];
		sparse.length = 2;
		const source: Record<string, unknown> = { first: shared, second: shared, sparse };
		source.self = source;

		const result = utils.jsToVal(source);

		expect(result.type).toBe('obj');
		if (result.type !== 'obj') {
			return;
		}
		expect(result.value.get('self')).toBe(result);
		expect(result.value.get('first')).toBe(result.value.get('second'));
		const convertedSparse = result.value.get('sparse');
		expect(convertedSparse).toStrictEqual(ARR([values.NULL, values.NULL]));
	});

	test.concurrent('distinguishes circular references from repeated values in string representations', () => {
		const shared = ARR([NUM(1)]);
		const repeated = ARR([shared, shared]);
		const circular = ARR([]);
		circular.value.push(circular);

		expect(utils.reprValue(repeated)).toBe('[ [ 1 ], [ 1 ] ]');
		expect(utils.reprValue(circular)).toBe('[ ... ]');
		expect(utils.valToString(repeated, true)).toBe('[[1], [1]]');
		expect(utils.valToString(circular, true)).toBe('[...]');

		const sparse = ARR([]);
		sparse.value.length = 2;
		expect(utils.valToJs(sparse)).toEqual([null, null]);
		expect(utils.reprValue(sparse)).toBe('[ null, null ]');
		expect(utils.valToString(sparse, true)).toBe('[(null), (null)]');
	});

	test.concurrent('converts and displays error values', () => {
		const info = OBJ(new Map());
		const error = ERROR('oops', info);
		info.value.set('error', error);

		const result = utils.valToJs(error) as Record<string, unknown>;

		expect(result.name).toBe('oops');
		expect((result.info as Record<string, unknown>).error).toBe(result);
		expect(utils.valToString(error)).toBe('error<oops>');
		expect(utils.reprValue(error)).toBe('error<oops>');
	});

	test.concurrent('uses stable labels for every value kind', () => {
		expect(utils.valToString(NUM(1))).toBe('num<1>');
		expect(utils.valToString(TRUE)).toBe('bool<true>');
		expect(utils.valToString(STR('ai'))).toBe('str<"ai">');
		expect(utils.valToString(ARR([]))).toBe('arr<...>');
		expect(utils.valToString(OBJ(new Map()))).toBe('obj<...>');
		expect(utils.valToString(ERROR('oops'))).toBe('error<oops>');
		expect(utils.valToString(values.FN_NATIVE(() => {}))).toBe('fn<...>');
		expect(utils.valToString(values.NULL)).toBe('null<>');
	});

	test.concurrent('escapes strings used in value representations', () => {
		const text = 'line 1\nline 2\t"quote"\\slash\0';
		const literal = JSON.stringify(text);

		expect(utils.valToString(STR(text))).toBe(`str<${literal}>`);
		expect(utils.valToString(STR(text), true)).toBe(literal);
		expect(utils.reprValue(ARR([STR(text)]))).toBe(`[ ${literal} ]`);
		expect(
			utils.reprValue(
				OBJ(
					new Map([
						['foo-bar', STR(text)],
						['normal', NUM(1)],
					]),
				),
			),
		).toBe(`{ "foo-bar": ${literal}, normal: 1 }`);
	});
});

describe('Scope', () => {
	test.concurrent('getAll', async () => {
		const interpreter = new Interpreter({});
		await interpreter.exec(
			Parser.parse(`
		let a = 1
		@b() {
			let x = a + 1
			x
		}
		if true {
			var y = 2
		}
		var c = true
		`),
		);
		const vars = interpreter.scope.getAll();
		assert.ok(vars.get('a') != null);
		assert.ok(vars.get('b') != null);
		assert.ok(vars.get('c') != null);
		assert.ok(vars.get('x') == null);
		assert.ok(vars.get('y') == null);
	});
});

describe('error handler', () => {
	test.concurrent('error from outside caller', async () => {
		let outsideCaller: () => Promise<void> = async () => {};
		let errCount: number = 0;
		const interpreter = new Interpreter(
			{
				emitError: FN_NATIVE((_args, _opts) => {
					throw Error('emitError');
				}),
				genOutsideCaller: FN_NATIVE(([fn], opts) => {
					utils.assertFunction(fn);
					outsideCaller = async () => {
						opts.topCall(fn, []);
					};
				}),
			},
			{
				err(e) {
					errCount++;
				},
			},
		);
		await interpreter.exec(
			Parser.parse(`
		genOutsideCaller(emitError)
		`),
		);
		assert.strictEqual(errCount, 0);
		await outsideCaller();
		assert.strictEqual(errCount, 1);
	});

	test.concurrent('array.map calls the handler just once', async () => {
		let errCount: number = 0;
		const interpreter = new Interpreter(
			{},
			{
				err(e) {
					errCount++;
				},
			},
		);
		await interpreter.exec(
			Parser.parse(`
		Core:range(1,5).map(@(){ hoge })
		`),
		);
		assert.strictEqual(errCount, 1);
	});
});

describe('Async timers', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		// 偽のタイマーは performance.now も止めるので、後のテストへ残さない
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test.each([
		['interval callback', 'Async:interval(100, @() { mark(); Core:abort("failure") })', 100],
		['immediate interval callback', 'Async:interval(100, @() { mark(); Core:abort("failure") }, true)', 0],
		['timeout callback', 'Async:timeout(100, @() { mark(); Core:abort("failure") })', 100],
	])('consumes rejection from %s', async (_name, source, delay) => {
		const mark = vi.fn();
		const interpreter = new Interpreter({
			mark: FN_NATIVE(mark),
		});

		await interpreter.exec(Parser.parse(source));
		await vi.advanceTimersByTimeAsync(delay);
		interpreter.abort();

		expect(mark).toHaveBeenCalledOnce();
	});

	test.each([
		['interval', 'Async:interval(100, @() { count() })'],
		['timeout', 'Async:timeout(100, @() { count() })'],
	])('does not restart a paused %s after abort', async (_name, source) => {
		const count = vi.fn();
		const interpreter = new Interpreter({
			count: FN_NATIVE(count),
		});

		await interpreter.exec(Parser.parse(source));
		expect(vi.getTimerCount()).toBe(1);
		interpreter.pause();
		expect(vi.getTimerCount()).toBe(0);
		interpreter.abort();
		interpreter.unpause();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(500);
		expect(count).not.toHaveBeenCalled();
	});
});

describe('error location', () => {
	const exeAndGetErrPos = (src: string): Promise<Ast.Pos | undefined> =>
		new Promise((ok, ng) => {
			const interpreter = new Interpreter(
				{
					emitError: FN_NATIVE((_args, _opts) => {
						throw Error('emitError');
					}),
				},
				{
					err(e) {
						ok(e.pos);
					},
				},
			);
			interpreter.exec(Parser.parse(src)).then(() => ng('error has not occured.'));
		});

	test.concurrent('Non-Toneriko Script error', async () => {
		return expect(
			exeAndGetErrPos(`/* (の位置
			*/
			emitError()
		`),
		).resolves.toEqual({ line: 3, column: 13 });
	});

	test.concurrent('No "var" in namespace declaration', async () => {
		return expect(
			exeAndGetErrPos(`// vの位置
			:: Ai {
				let chan = 'kawaii'
				var kun = '!?'
			}
		`),
		).resolves.toEqual({ line: 4, column: 5 });
	});

	test.concurrent('Index out of range', async () => {
		return expect(
			exeAndGetErrPos(`// [の位置
			let arr = []
			arr[0]
		`),
		).resolves.toEqual({ line: 3, column: 7 });
	});

	test.concurrent('Error in passed function', async () => {
		return expect(
			exeAndGetErrPos(`// (の位置
			[1, 2, 3].map(@(v){
				if v==1 Core:abort("error")
			})
		`),
		).resolves.toEqual({ line: 3, column: 23 });
	});

	test.concurrent('No such prop', async () => {
		return expect(
			exeAndGetErrPos(`// .の位置
			[].ai
		`),
		).resolves.toEqual({ line: 2, column: 6 });
	});
});

describe('callstack', () => {
	const exeAndGetErrMessage = (src: string): Promise<string> =>
		new Promise((ok, ng) => {
			const interpreter = new Interpreter(
				{
					emitError: FN_NATIVE((_args, _opts) => {
						throw Error('emitError');
					}),
				},
				{
					err(e) {
						ok(e.message);
					},
				},
			);
			interpreter.exec(Parser.parse(src)).then(() => ng('error has not occurred.'));
		});

	test('error in function', async () => {
		const result = await exeAndGetErrMessage(`
			@function1() { emitError() }
			@function2() { function1() }
			function2()
		`);
		expect(result).toMatchInlineSnapshot(`
			"emitError
			  at function1 (Line 2, Column 28)
			  at function2 (Line 3, Column 28)
			  at <root> (Line 4, Column 13)"
		`);
	});
	test('error in function in namespace', async () => {
		const result = await exeAndGetErrMessage(`
			:: Ai {
				@function() { emitError() }
			}
			Ai:function()
		`);
		expect(result).toMatchInlineSnapshot(`
			"emitError
			  at Ai:function (Line 3, Column 28)
			  at <root> (Line 5, Column 15)"
		`);
	});
	test('error in anonymous function', async () => {
		const result = await exeAndGetErrMessage(`
			(@() { emitError() })()
		`);
		expect(result).toMatchInlineSnapshot(`
			"emitError
			  at <anonymous> (Line 2, Column 20)
			  at <root> (Line 2, Column 25)"
		`);
	});
});

describe('yield and busy time', () => {
	// 実行する環境に左右されない重い処理。ms だけ同期で CPU を使う
	const burn = FN_NATIVE(([ms]) => {
		const until = performance.now() + (ms as values.VNum).value;
		while (performance.now() < until);
	});

	// 上限を計算の時間から決めるテスト用。最初の数回は JIT が温まらず遅いので、何回か動かした中で最も短い時間を使う
	async function soloTime(source: string): Promise<number> {
		let min = Infinity;
		for (let i = 0; i < 4; i++) {
			const start = performance.now();
			await new Interpreter({}).exec(Parser.parse(source));
			min = Math.min(min, performance.now() - start);
		}
		return min;
	}

	test('yields to the host after running for yieldInterval', async () => {
		let yields = 0;
		const interpreter = new Interpreter({}, { yieldInterval: 5, yieldToHost: async () => void yields++ });
		const start = performance.now();
		await interpreter.exec(Parser.parse('var s = 0\nfor (let i, 100000) { s += 1 }'));
		const elapsed = performance.now() - start;
		// 5ms ごとに 1 回なので、経過時間から見込める回数を超えない
		expect(yields).toBeGreaterThanOrEqual(1);
		expect(yields).toBeLessThanOrEqual(Math.ceil(elapsed / 5) + 1);
	});

	test('never yields when yieldInterval is 0', async () => {
		let yields = 0;
		const interpreter = new Interpreter({}, { yieldInterval: 0, yieldToHost: async () => void yields++ });
		await interpreter.exec(Parser.parse('var s = 0\nfor (let i, 100000) { s += 1 }'));
		expect(yields).toBe(0);
	});

	test('runs to the end with the default yield', async () => {
		const interpreter = new Interpreter({}, { yieldInterval: 1 });
		await interpreter.exec(Parser.parse('var s = 0\nfor (let i, 50000) { s += 1 }'));
	});

	test.each([-1, NaN])('rejects yieldInterval %d', (yieldInterval) => {
		expect(() => new Interpreter({}, { yieldInterval })).toThrow(TonerikoScriptHostsideError);
	});

	test.each([0, -1, NaN])('rejects maxBusyTime %d', (maxBusyTime) => {
		expect(() => new Interpreter({}, { maxBusyTime })).toThrow(TonerikoScriptHostsideError);
	});

	test('stops an execution that runs without waiting for longer than maxBusyTime', async () => {
		const interpreter = new Interpreter({}, { maxBusyTime: 50 });
		await expect(interpreter.exec(Parser.parse('loop {}'))).rejects.toThrow(/busy time exceeded/);
	});

	test('stops a synchronous execution after maxBusyTime', () => {
		const interpreter = new Interpreter({}, { maxBusyTime: 50 });
		expect(() => interpreter.execSync(Parser.parse('loop {}'))).toThrow(/busy time exceeded/);
	});

	test('abort stops a loop with an empty body', async () => {
		const interpreter = new Interpreter({}, { maxBusyTime: 60_000 });
		const execution = interpreter.exec(Parser.parse('loop {}'));
		setTimeout(() => interpreter.abort(), 20);
		await execution;
	});

	test('waiting with Core:sleep starts the busy time over', async () => {
		const interpreter = new Interpreter({}, { maxBusyTime: 50 });
		const start = performance.now();
		await interpreter.exec(Parser.parse('for (let i, 20) { Core:sleep(10) }'));
		expect(performance.now() - start).toBeGreaterThan(150);
	});

	test('waiting for callbacks of map does not start the busy time over', async () => {
		// map は渡した関数を呼ぶ間 Promise を返すが、その間も実行は進んでいるのでホストを待ったことにならない
		const interpreter = new Interpreter({}, { maxBusyTime: 50 });
		const start = performance.now();
		await expect(interpreter.exec(Parser.parse('loop { [1, 2, 3].map(@(x) { x * 2 }) }'))).rejects.toThrow(
			/busy time exceeded/,
		);
		// map から戻るたびに動いた時間を捨てると、上限に届くまでに何倍もかかる
		expect(performance.now() - start).toBeLessThan(200);
	});

	test('stops a namespace initializer that runs without waiting', async () => {
		const source = ':: Ns {\n\tlet x = eval { loop {} }\n}';
		await expect(new Interpreter({}, { maxBusyTime: 50 }).exec(Parser.parse(source))).rejects.toThrow(/busy time exceeded/);
		expect(() => new Interpreter({}, { maxBusyTime: 50 }).execSync(Parser.parse(source))).toThrow(/busy time exceeded/);
	});

	test('time spent paused is not busy time', async () => {
		const interpreter = new Interpreter({}, { maxBusyTime: 50 });
		interpreter.pause();
		const execution = interpreter.exec(Parser.parse('for (let i, 100) { 1 }'));
		await new Promise((resolve) => setTimeout(resolve, 100));
		interpreter.unpause();
		await execution;
	});

	test('sleeps in callbacks of map running side by side start the busy time over', async () => {
		// map は渡した関数を並行して動かす。片方が待つ間にもう片方が進んでも、待ちは待ちとして数える
		const interpreter = new Interpreter({}, { maxBusyTime: 50 });
		await interpreter.exec(Parser.parse('[1, 2].map(@(x) {\n\tCore:sleep(x * 100)\n\tfor (let i, 100) { 1 }\n})'));
	});

	test('waiting for a promise from another realm starts the busy time over', async () => {
		const vm = await import('node:vm');
		const interpreter = new Interpreter(
			{
				wait: FN_NATIVE(() => vm.runInNewContext('new Promise((resolve) => setTimeout(resolve, 100))', { setTimeout })),
			},
			{ maxBusyTime: 50 },
		);
		await interpreter.exec(Parser.parse('wait()\nfor (let i, 100) { 1 }'));
	});

	describe('executions running side by side', () => {
		// 単独で動かした時間の 1.6 倍を上限にする。2 つ分を合わせると上限を超える
		const source = 'var s = 0\nfor (let i, 100000) { s += 1 }';

		test('another interpreter does not add to the busy time', async () => {
			const maxBusyTime = (await soloTime(source)) * 1.6;
			await Promise.all([
				new Interpreter({}, { maxBusyTime }).exec(Parser.parse(source)),
				new Interpreter({}, { maxBusyTime }).exec(Parser.parse(source)),
			]);
		});

		test('executions of one interpreter add up', async () => {
			// 1 つのインタプリタ (ページのスクリプト) がホストを待たずに使った時間を合わせて数える
			const maxBusyTime = (await soloTime(source)) * 1.6;
			const interpreter = new Interpreter({}, { maxBusyTime });
			await interpreter.exec(Parser.parse(`@work() {\n${source}\n}`));
			const work = interpreter.scope.get('work') as values.VFn;
			const results = await Promise.allSettled([interpreter.execFnSimple(work, []), interpreter.execFnSimple(work, [])]);
			expect(results.some((r) => r.status === 'rejected' && /busy time exceeded/.test(String(r.reason)))).toBe(true);
		});
	});

	test('waiting inside a function called from a namespace initializer starts the busy time over', async () => {
		const source = ':: Ns {\n\t@w() { Core:sleep(5) }\n\tlet x = eval { for (let i, 40) { w() } }\n}';
		await new Interpreter({}, { maxBusyTime: 50 }).exec(Parser.parse(source));
	});

	test('waiting after calling back is not busy time', async () => {
		// 表示時に関数を呼び、押されるまで待つダイアログのような関数
		const interpreter = new Interpreter(
			{
				callThenWait: FN_NATIVE(async ([callback], opts) => {
					await opts.call(callback as values.VFn, []);
					await new Promise((resolve) => setTimeout(resolve, 100));
				}),
			},
			{ maxBusyTime: 50 },
		);
		await interpreter.exec(Parser.parse('callThenWait(@() { 1 })\nfor (let i, 100) { 1 }'));
	});

	test.each([
		['callbacks of map that all run away', '[1, 2].map(@(x) { loop {} })'],
		['many callbacks of map that run away', 'Arr:create(50, 0).map(@(x) { loop { 1 } })'],
		['callbacks of map that call quick functions', 'let a = Arr:create(20000, 0)\nloop { a.map(@(x) { [].map(@(y) { y })\nfor (let i, 20) { 1 } }) }'],
	])('stops %s', async (_name, source) => {
		const interpreter = new Interpreter({}, { maxBusyTime: 50 });
		const start = performance.now();
		try {
			await expect(interpreter.exec(Parser.parse(source))).rejects.toThrow(/busy time exceeded/);
		} finally {
			interpreter.abort();
		}
		expect(performance.now() - start).toBeLessThan(1000);
	});

	test('a sleeping callback of map does not start a runaway callback over', async () => {
		const interpreter = new Interpreter({}, { maxBusyTime: 30 });
		try {
			await expect(
				interpreter.exec(Parser.parse('[1, 2].map(@(x) { if x == 1 { loop { Core:sleep(1) } } else { loop {} } })')),
			).rejects.toThrow(/busy time exceeded/);
		} finally {
			interpreter.abort();
		}
	});

	test('waiting in callbacks of map starts the caller over', async () => {
		// 毎回 map の中で待つアニメーションのようなループは、呼んだ側の時間が積み上がって止まってはいけない。
		// 1 周の計算の 3 倍を上限にし、10 周で積み上がれば止まる
		const work = 'for (let j, 20000) { 1 }';
		const maxBusyTime = (await soloTime(work)) * 3;
		const interpreter = new Interpreter({}, { maxBusyTime });
		await interpreter.exec(Parser.parse(`for (let i, 10) {\n${work}\n[1].map(@(x) { Core:sleep(5) })\n}`));
	});

	test('time of callbacks of map is busy time of the caller', async () => {
		// 呼び返した関数の中で計算を繰り返す暴走は、呼んだ側に時間が積み上がって止まる
		const interpreter = new Interpreter({}, { maxBusyTime: 50 });
		const start = performance.now();
		await expect(
			interpreter.exec(Parser.parse('loop { [1].map(@(x) { for (let i, 1000) { 1 } }) }')),
		).rejects.toThrow(/busy time exceeded/);
		expect(performance.now() - start).toBeLessThan(300);
	});

	test('waiting before calling back is not busy time', async () => {
		const interpreter = new Interpreter(
			{
				later: FN_NATIVE(async ([callback], opts) => {
					await new Promise((resolve) => setTimeout(resolve, 100));
					return opts.call(callback as values.VFn, []);
				}),
			},
			{ maxBusyTime: 50 },
		);
		// 呼び返した関数は時刻を確かめるところまで動く。待っていた 100ms を数えると、その確認で止まる
		await interpreter.exec(Parser.parse('later(@() { for (let i, 2000) { 1 } })'));
	});

	test('callbacks called one after another add up', async () => {
		// reduce は 1 つずつ呼び返す。1 回ずつは短くても、合計が上限を超えたところで止まる
		const interpreter = new Interpreter({}, { maxBusyTime: 30 });
		const start = performance.now();
		await expect(
			interpreter.exec(Parser.parse('Core:range(1, 100000).reduce(@(acc, x) { for (let i, 100) { 1 }\nacc }, 0)')),
		).rejects.toThrow(/busy time exceeded/);
		expect(performance.now() - start).toBeLessThan(300);
	});

	test('recursion through map adds up', async () => {
		const interpreter = new Interpreter({}, { maxBusyTime: 30 });
		const start = performance.now();
		await expect(
			interpreter.exec(Parser.parse('@f() {\n\tfor (let i, 300) { 1 }\n\t[1].map(@(x) { f() })\n}\nf()')),
		).rejects.toThrow(/busy time exceeded/);
		expect(performance.now() - start).toBeLessThan(300);
	});

	test('computation after a wait in a callback counts toward the caller', async () => {
		// 子が待った後の計算と、戻ってからの呼んだ側の計算はどちらも待っていない。1 回の計算の 1.6 倍を上限にすると、2 回分で止まる
		const work = 'for (let i, 30000) { 1 }';
		const maxBusyTime = (await soloTime(work)) * 1.6;
		const interpreter = new Interpreter({}, { maxBusyTime });
		await expect(
			interpreter.exec(Parser.parse(`[1].map(@(x) {\nCore:sleep(5)\n${work}\n})\n${work}`)),
		).rejects.toThrow(/busy time exceeded/);
	});

	describe('a function that calls back and waits starts the caller over', () => {
		// 計算 1 回分の 2.5 倍を上限にする。関数の中の待ちで数え直さないと、5 回分が積み上がって止まる
		const work = 'for (let i, 30000) { 1 }';
		const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
		test.each([
			['waits before calling back', async (callback: values.VFn, call: (fn: values.VFn, args: Value[]) => Promise<Value>) => {
				await wait();
				return call(callback, []);
			}],
			['waits after calling back', async (callback: values.VFn, call: (fn: values.VFn, args: Value[]) => Promise<Value>) => {
				await call(callback, []);
				await wait();
			}],
		])('%s', async (_name, body) => {
			const maxBusyTime = (await soloTime(work)) * 2.5;
			const interpreter = new Interpreter(
				{ callAndWait: FN_NATIVE(([callback], opts) => body(callback as values.VFn, opts.call)) },
				{ maxBusyTime },
			);
			await interpreter.exec(Parser.parse(`for (let n, 5) {\n${work}\ncallAndWait(@() { 1 })\n}`));
		});
	});

	test('a wait that ends while another execution yields does not start a runaway execution over', async () => {
		// 譲っている間 (ブラウザで画面を描く間など) に、別の実行が待ち明けて動く
		let other: values.VFn | undefined;
		let runningOther = false;
		const interpreter: Interpreter = new Interpreter(
			{},
			{
				maxBusyTime: 50,
				yieldInterval: 1,
				yieldToHost: async () => {
					// 別の実行の中でまた譲ったときは、重ねて動かさない
					if (other == null || runningOther) return;
					runningOther = true;
					try {
						await interpreter.execFnSimple(other, []);
					} finally {
						runningOther = false;
					}
				},
			},
		);
		await interpreter.exec(Parser.parse('@other() {\n\tCore:sleep(2)\n\tfor (let i, 200) { 1 }\n}'));
		other = interpreter.scope.get('other') as values.VFn;
		const start = performance.now();
		await expect(interpreter.exec(Parser.parse('loop {}'))).rejects.toThrow(/busy time exceeded/);
		expect(performance.now() - start).toBeLessThan(1000);
	});

	test('time spent in synchronous host functions is busy time', async () => {
		// ホストを待たない関数がいくら時間を使っても、待ったことにはならない
		const interpreter = new Interpreter({ burn }, { maxBusyTime: 50 });
		const start = performance.now();
		await expect(interpreter.exec(Parser.parse('loop { burn(2) }'))).rejects.toThrow(/busy time exceeded/);
		expect(performance.now() - start).toBeLessThan(1000);
	});

	test.each([
		['map', 'loop { [1].map(@(x) { s.replace("a", "bb") }) }'],
		['reduce', 'loop { [1, 2].reduce(@(acc, x) { s.replace("a", "bb") }, 0) }'],
		['an execution started on the spot', 'loop {\n\ts.replace("a", "bb")\n\tlet cancel = Async:interval(100000, @() {}, true)\n\tcancel()\n}'],
	])('heavy synchronous work in %s is busy time', async (_name, body) => {
		// 置き換えは 1 回で 1ms を超える。時刻の確認の間隔が空いても、ホストを待ったことにはならない
		const interpreter = new Interpreter({}, { maxBusyTime: 30 });
		const start = performance.now();
		try {
			await expect(
				interpreter.exec(Parser.parse(`let s = Arr:create(200000, "a").join()\n${body}`)),
			).rejects.toThrow(/busy time exceeded/);
		} finally {
			interpreter.abort();
		}
		expect(performance.now() - start).toBeLessThan(1000);
	});

	test.each([
		['at the start of an execution', ''],
		['after a wait', 'Core:sleep(5)\n'],
	])('heavy work right after resuming %s is busy time', async (_name, prefix) => {
		const interpreter = new Interpreter({ burn }, { maxBusyTime: 30 });
		const source = `${prefix}burn(40)\nfor (let i, 100) { 1 }`;
		await expect(interpreter.exec(Parser.parse(source))).rejects.toThrow(/busy time exceeded/);
	});

	test('heavy work right after unpausing is busy time', async () => {
		const interpreter = new Interpreter({ burn }, { maxBusyTime: 30 });
		interpreter.pause();
		const execution = interpreter.exec(Parser.parse('burn(40)\nfor (let i, 100) { 1 }'));
		await new Promise((resolve) => setTimeout(resolve, 20));
		interpreter.unpause();
		await expect(execution).rejects.toThrow(/busy time exceeded/);
	});

	test('heavy work in a function called back after a wait is busy time', async () => {
		const interpreter = new Interpreter(
			{
				burn,
				later: FN_NATIVE(async ([callback], opts) => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return opts.call(callback as values.VFn, []);
				}),
			},
			{ maxBusyTime: 30 },
		);
		const source = 'later(@() {\n\tburn(40)\n\tfor (let i, 100) { 1 }\n})';
		await expect(interpreter.exec(Parser.parse(source))).rejects.toThrow(/busy time exceeded/);
	});

	test('callbacks that are native functions are checked', async () => {
		// Core:sub を渡した sort はノードを評価せずに比較を繰り返す。その途中でも時間を確かめて止める
		const interpreter = new Interpreter({}, { maxBusyTime: 30 });
		await expect(interpreter.exec(Parser.parse('let a = Arr:create(20000, 1)\na.sort(Core:sub)'))).rejects.toThrow(
			/busy time exceeded/,
		);
	});

	test('callbacks that are native functions are checked in a synchronous execution', () => {
		const interpreter = new Interpreter({}, { maxBusyTime: 30 });
		expect(() => interpreter.execSync(Parser.parse('Core:range(1, 200000).sort(Core:sub)'))).toThrow(/busy time exceeded/);
	});

	test('an execution that starts after the interpreter was idle does not yield right away', async () => {
		let yields = 0;
		const interpreter = new Interpreter({}, { yieldToHost: async () => void yields++ });
		await interpreter.exec(Parser.parse('@work() { for (let i, 40) { 1 } }'));
		await new Promise((resolve) => setTimeout(resolve, 50));
		await interpreter.execFnSimple(interpreter.scope.get('work') as values.VFn, []);
		expect(yields).toBe(0);
	});

	test('an execution that starts after the interpreter was idle starts over', async () => {
		const work = 'for (let i, 30000) { 1 }';
		const maxBusyTime = (await soloTime(work)) * 1.6;
		const interpreter = new Interpreter({}, { maxBusyTime });
		await interpreter.exec(Parser.parse(`@work() {\n${work}\n}\nwork()`));
		await new Promise((resolve) => setTimeout(resolve, 20));
		await interpreter.execFnSimple(interpreter.scope.get('work') as values.VFn, []);
	});

	test('callbacks from Async:interval do not start the busy time of another execution over', async () => {
		const interpreter = new Interpreter({}, { maxBusyTime: 100 });
		try {
			await expect(
				interpreter.exec(Parser.parse('Async:interval(5, @() { Core:sleep(1) })\nloop {}')),
			).rejects.toThrow(/busy time exceeded/);
		} finally {
			interpreter.abort();
		}
	});
});

describe('pause', () => {
	async function exePausable() {
		let count = 0;

		const interpreter = new Interpreter(
			{
				count: values.FN_NATIVE(() => {
					count++;
				}),
			},
			// 譲る処理も偽のタイマーで進むので、時刻を進め終えた時点で残った譲りが回数の確認とずれないよう譲らない
			{ yieldInterval: 0 },
		);

		await interpreter.exec(Parser.parse(`Async:interval(100, @() { count() })`));

		return {
			pause: interpreter.pause,
			unpause: interpreter.unpause,
			getCount: () => count,
			resetCount: () => (count = 0),
		};
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		// 偽のタイマーは performance.now も止めるので、後のテストへ残さない
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test('basic', async () => {
		const p = await exePausable();
		await vi.advanceTimersByTimeAsync(500);
		p.pause();
		await vi.advanceTimersByTimeAsync(400);
		return expect(p.getCount()).toEqual(5);
	});

	test('unpause', async () => {
		const p = await exePausable();
		await vi.advanceTimersByTimeAsync(500);
		p.pause();
		await vi.advanceTimersByTimeAsync(400);
		p.unpause();
		await vi.advanceTimersByTimeAsync(300);
		return expect(p.getCount()).toEqual(8);
	});

	describe('randomly scheduled pausing', () => {
		function rnd(min: number, max: number): number {
			return Math.floor(min + Math.random() * (max - min + 1));
		}
		const schedule = Array(rnd(2, 10))
			.fill(0)
			.map(() => rnd(1, 10) * 100);
		const title = schedule.map((v, i) => `${i % 2 ? 'un' : ''}pause ${v}`).join(', ');

		test(title, async () => {
			const p = await exePausable();
			let answer = 0;
			for (const [i, v] of schedule.entries()) {
				if (i % 2) {
					p.unpause();
					answer += v / 100;
				} else {
					p.pause();
				}
				await vi.advanceTimersByTimeAsync(v);
			}
			return expect(p.getCount()).toEqual(answer);
		});
	});
});

describe('Attribute', () => {
	const getAttr = async (
		name: string,
		script: string,
		expectedAst?: { type: string; name: string; value: { type: string; value: unknown } }[],
	): Promise<Value['attr']> => {
		const parser = new Parser();
		const interpreter = new Interpreter({});
		const ast = parser.parse(script);
		if (expectedAst) {
			expect(ast).toHaveLength(1);
			const root = ast[0];
			const definition = root.type === 'ns' ? root.members[0] : root;
			if (root.type === 'ns') {
				expect(root.name).toBe(name.split(':')[0]);
				expect(root.members).toHaveLength(1);
			}
			assert.equal(definition.type, 'def');
			if (definition.type !== 'def') assert.fail();
			expect(definition.dest).toMatchObject({ type: 'identifier', name: name.split(':').at(-1) });
			expect(definition.attr.map(attr => ({
				type: attr.type,
				name: attr.name,
				value: { type: attr.value.type, value: 'value' in attr.value ? attr.value.value : undefined },
			}))).toEqual(expectedAst);
		}
		await interpreter.exec(ast);
		const value = interpreter.scope.get(name);
		return value.attr;
	};

	test.concurrent('no attribute', async () => {
		const attr = await getAttr(
			'f',
			`
		@f() {}
		`,
		);
		expect(attr).toBeUndefined();
	});

	test.concurrent('single attribute', async () => {
		const attr = await getAttr(
			'f',
			`
		#[x 42]
		@f() {}
		`,
		);
		expect(attr).toStrictEqual([{ name: 'x', value: NUM(42) }]);
	});

	test.concurrent('attribute with a negative number', async () => {
		const attr = await getAttr(
			'f',
			`
		#[x -42]
		@f() {}
		`,
		);
		expect(attr).toStrictEqual([{ name: 'x', value: NUM(-42) }]);
	});

	test.concurrent('multiple attributes', async () => {
		const attr = await getAttr(
			'f',
			`
		#[o { a: 1, b: 2 }]
		#[s "ai"]
		#[b false]
		@f() {}
		`,
			[
				{ type: 'attr', name: 'o', value: { type: 'obj', value: new Map([
					['a', expect.objectContaining({ type: 'num', value: 1 })],
					['b', expect.objectContaining({ type: 'num', value: 2 })],
				]) } },
				{ type: 'attr', name: 's', value: { type: 'str', value: 'ai' } },
				{ type: 'attr', name: 'b', value: { type: 'bool', value: false } },
			],
		);
		expect(attr).toStrictEqual([
			{
				name: 'o',
				value: OBJ(
					new Map([
						['a', NUM(1)],
						['b', NUM(2)],
					]),
				),
			},
			{ name: 's', value: STR('ai') },
			{ name: 'b', value: FALSE },
		]);
	});

	test.concurrent('single attribute without value', async () => {
		const attr = await getAttr(
			'f',
			`
		#[x]
		@f() {}
		`,
			[{ type: 'attr', name: 'x', value: { type: 'bool', value: true } }],
		);
		expect(attr).toStrictEqual([{ name: 'x', value: TRUE }]);
	});

	test.concurrent('attribute under namespace', async () => {
		const attr = await getAttr(
			'Ns:f',
			`
		:: Ns {
			#[x 42]
			@f() {}
		}
		`,
			[{ type: 'attr', name: 'x', value: { type: 'num', value: 42 } }],
		);
		expect(attr).toStrictEqual([{ name: 'x', value: NUM(42) }]);
	});

	test.concurrent('attribute on a singleton value (null) does not leak to other uses of it', async () => {
		const parser = new Parser();
		const interpreter = new Interpreter({});
		const ast = parser.parse(`
		#[x 1]
		let a = null
		let b = null
		`);
		await interpreter.exec(ast);
		expect(interpreter.scope.get('a').attr).toStrictEqual([{ name: 'x', value: NUM(1) }]);
		expect(interpreter.scope.get('b').attr).toBeUndefined();
	});

	test.concurrent('attribute on a singleton value (bool) does not leak to other uses of it', async () => {
		const parser = new Parser();
		const interpreter = new Interpreter({});
		const ast = parser.parse(`
		#[x 1]
		let a = true
		let b = true
		let c = false
		`);
		await interpreter.exec(ast);
		expect(interpreter.scope.get('a').attr).toStrictEqual([{ name: 'x', value: NUM(1) }]);
		expect(interpreter.scope.get('b').attr).toBeUndefined();
		expect(interpreter.scope.get('c').attr).toBeUndefined();
	});
});
