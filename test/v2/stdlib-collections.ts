import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { nodeExecutable } from '../../scripts/v2-node.mjs';
import { collectionDefinitions } from '../../src/v2/stdlib/collections.js';
import { makeFunction, validateArguments, type StdContext, type StdFrame } from '../../src/v2/stdlib/core.js';
import { PropertyAccess, type Value } from '../../src/v2/runtime/values.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

const position = { line: 7, column: 3 };
async function run(frame: StdFrame): Promise<Value> {
	let state = frame.next();
	while (!state.done) {
		try {
			const child = state.value;
			state = frame.next(child && typeof child.next === 'function' ? await run(child) : await child);
		} catch (error) { state = frame.throw(error); }
	}
	return state.value;
}
function context(onTick = () => {}, onCheckpoint = () => {}): StdContext {
	return {
		pos: position, properties: new PropertyAccess(), tick: onTick,
		*checkpoint() { onCheckpoint(); yield Promise.resolve(); return null; },
		*call(fn, args, receiver = null) { return yield Reflect.apply(fn as Function, receiver, args); },
	};
}
async function invoke(name: string, receiver: Value, args: Value[] = [], ctx = context()): Promise<Value> {
	const definition = collectionDefinitions.find(item => item.name === name)!;
	validateArguments(ctx, definition, args);
	return run(definition.implementation(ctx, receiver, args));
}
function expose(name: string, array: Value[]): Value[] {
	Object.defineProperty(array, 'operation', { value: makeFunction(collectionDefinitions.find(item => item.name === name)!) });
	return array;
}

const numeric = fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 40 });
const ascii = fc.array(fc.array(fc.integer({ min: 32, max: 126 }), { maxLength: 12 }).map(codes => String.fromCharCode(...codes)), { maxLength: 40 });

describe('標準配列の並べ替え', () => {
	for (const name of ['sort', 'toSorted']) for (const kind of ['number', 'string']) {
		test(`${name}/${kind}: Node と 5 seed × 100 件を実際に比較する`, async () => {
			const inputs = [131, 227, 349, 457, 569].flatMap(seed => fc.sample(kind === 'number' ? numeric : ascii, { seed, numRuns: 100 }));
			const child = spawnSync(nodeExecutable, ['--input-type=module', '-e', `let text='';for await(const chunk of process.stdin)text+=chunk;const inputs=JSON.parse(text);process.stdout.write(JSON.stringify(inputs.map(a=>{const out=a.${name}(${kind === 'number' ? '(a,b)=>a-b' : ''});return {out,input:a,same:out===a};})));`], { input: JSON.stringify(inputs), encoding: 'utf8' });
			expect(child.status, child.stderr).toBe(0);
			const reference = JSON.parse(child.stdout); let reached = 0, completed = 0, compared = 0;
			const actual: unknown[] = [];
			const program = parse(`for (const input of inputs) { reached(); const out = input.${name}(${kind === 'number' ? '(a,b)=>a-b' : ''}); emit({out, input, same:out===input}); }`).program;
			await new Interpreter({ inputs, reached: () => { reached++; }, emit: (value: unknown) => { actual.push(structuredClone(value)); completed++; } }, { maxSteps: 2_000_000 }).exec(program);
			for (let i = 0; i < inputs.length; i++) { expect(actual[i]).toEqual(reference[i]); compared++; }
			expect([inputs.length, reached, completed, compared]).toEqual([500, 500, 500, 500]);
		});
	}

	test('同値の順序を保ち、NaN の比較結果を同値として扱う', async () => {
		const values = Array.from({ length: 65 }, (_, i) => ({ key: i % 3, i }));
		const expected = [...values].sort((a, b) => a.key - b.key);
		expect(await invoke('sort', [...values], [(a: { key: number }, b: { key: number }) => a.key - b.key])).toEqual(expected);
		expect(await invoke('sort', [...values], [() => NaN])).toEqual(values);
	});

	test('sortBy はキーを添字順に一度ずつ待ち、複合キーでも安定', async () => {
		const values = [{ k: [1, 'b'], i: 0 }, { k: [1, 'a'], i: 1 }, { k: [1, 'b'], i: 2 }, { k: [0, 'z'], i: 3 }];
		const events: string[] = []; let active = 0, maximum = 0;
		const out = await invoke('sortBy', values, [async (value: typeof values[number], i: number, original: unknown) => {
			expect(original).toBe(values); events.push(`start:${i}`); maximum = Math.max(maximum, ++active);
			await Promise.resolve(); active--; events.push(`end:${i}`); return value.k;
		}]);
		expect(out).toBe(values); expect(values.map(v => v.i)).toEqual([3, 1, 0, 2]);
		expect(maximum).toBe(1); expect(events).toEqual([0, 1, 2, 3].flatMap(i => [`start:${i}`, `end:${i}`]));
	});

	test('長い文字列比較を UTF-16 順で分割して譲る', async () => {
		let ticks = 0, checkpoints = 0;
		const prefix = 'a'.repeat(20000), input = [prefix + '😀', prefix + '\uffff', prefix + 'a'];
		expect(await invoke('sort', [...input], [], context(() => { ticks++; }, () => { checkpoints++; }))).toEqual([...input].sort());
		expect(ticks).toBeGreaterThan(20000); expect(checkpoints).toBeGreaterThan(300);
	});

	test('比較関数なしの非文字列、誤った比較関数、キー混在を拒否する', async () => {
		for (const value of [1, null, true, {}, []]) await expect(invoke('sort', [value])).rejects.toMatchObject({ code: 'STDLIB_SORT_COMPARATOR_REQUIRED', name: 'TypeError', pos: position });
		await expect(invoke('toSorted', [1])).rejects.toMatchObject({ code: 'STDLIB_SORT_COMPARATOR_REQUIRED' });
		await expect(invoke('sort', [], [null])).rejects.toMatchObject({ name: 'TypeError' });
		await expect(invoke('sort', [2, 1], [() => 'wrong'])).rejects.toMatchObject({ name: 'TypeError' });
		for (const keys of [[1, 'a'], [NaN], [[1], ['1']], [[1], 1], [[[1]]]]) await expect(invoke('sortBy', keys, [(x: Value) => x])).rejects.toMatchObject({ name: expect.stringMatching(/TypeError|RangeError/) });
	});

	test('比較関数は同時に一つだけ動く', async () => {
		let active = 0, maximum = 0;
		expect(await invoke('sort', [4, 1, 3, 2], [async (a: number, b: number) => {
			maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return a - b;
		}])).toEqual([1, 2, 3, 4]);
		expect(maximum).toBe(1);
	});

	test('実評価器で比較関数の実行予算を共有する', async () => {
		const interpreter = new Interpreter({ items: expose('sort', [3, 2, 1]) }, { maxSteps: 1000, now: () => 0 });
		await expect(interpreter.exec(parse('items.operation((a, b) => { while (true) {} return a - b; });').program)).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
	});

	test('比較処理の途中にもホストへ譲り abort を受ける', async () => {
		let now = 0, comparisons = 0, yieldedDuringSort = false;
		const interpreter = new Interpreter({ items: expose('sort', Array.from({ length: 5000 }, (_, i) => 5000 - i)), compare: (a: number, b: number) => { comparisons++; return a - b; } }, {
			now: () => ++now, yieldInterval: 1, maxBusyTime: Infinity,
			yieldToHost: async () => { if (comparisons >= 100) { yieldedDuringSort = true; interpreter.abort(); } },
		});
		await expect(interpreter.exec(parse('items.operation(compare);').program)).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' });
		expect(comparisons).toBeGreaterThanOrEqual(100); expect(yieldedDuringSort).toBe(true);
	});

	test('実評価器がコピー途中でホストに譲り abort を受ける', async () => {
		let now = 0, yields = 0;
		const interpreter = new Interpreter({ items: expose('sort', Array.from({ length: 10000 }, () => 'a')) }, {
			now: () => ++now, yieldInterval: 1, maxBusyTime: Infinity,
			yieldToHost: async () => { if (++yields === 3) interpreter.abort(); },
		});
		await expect(interpreter.exec(parse('items.operation();').program)).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' });
		expect(yields).toBe(3);
	});
});

describe('追加した配列メソッド', () => {
	for (const [name, expression, expected] of [
		['sortBy', '[{k:2,id:0},{k:1,id:1},{k:2,id:2}].sortBy(x=>x.k)', [{k:1,id:1},{k:2,id:0},{k:2,id:2}]],
		['unique', '[1,2,1].unique()', [1,2]],
		['uniqueBy', '[{k:[1,"a"],id:1},{k:[1,"a"],id:2}].uniqueBy(x=>x.k)', [{k:[1,'a'],id:1}]],
		['sum', '[1,2,3].sum()', 6],
		['minBy', '[{k:1,id:1},{k:1,id:2}].minBy(x=>x.k)', {k:1,id:1}],
		['maxBy', '[{k:1,id:1},{k:2,id:2}].maxBy(x=>x.k)', {k:2,id:2}],
		['countBy', '[1,1,2].countBy(x=>x)', {'1':2,'2':1}],
		['shuffle', '[1,2,3].shuffle(()=>0)', [2,3,1]],
		['sample', '[1,2,3].sample(()=>0)', 1],
		['sampleBy', '[1,2,3].sampleBy(x=>x===2?1:0,()=>0)', 2],
	] as const) test(`${name}: パーサーから公開メソッドに到達して結果を確かめる`, async () => {
		let reached = 0, completed = 0; const output: unknown[] = [];
		await new Interpreter({ reached: () => { reached++; }, emit: (value: unknown) => { completed++; output.push(structuredClone(value)); } }).exec(parse(`reached(); emit(${expression});`).program);
		expect([reached, completed]).toEqual([1,1]); expect(output).toEqual([expected]);
	});

	test('unique の SameValueZero と参照同一性、uniqueBy の複合キー', async () => {
		const object = {}, other = {};
		expect(await invoke('unique', [NaN, NaN, 0, -0, object, object, other])).toEqual([NaN, 0, object, other]);
		const values = [{ k: [1, 'a'], id: 1 }, { k: [1, 'a'], id: 2 }, { k: [1], id: 3 }, { k: [], id: 4 }, { k: [], id: 5 }];
		expect(await invoke('uniqueBy', values, [(x: typeof values[number]) => x.k])).toEqual([values[0], values[2], values[3]]);
	});

	test('sum は左から加算し、空配列を 0 とする', async () => {
		expect(await invoke('sum', [])).toBe(0);
		expect(await invoke('sum', [1e20, -1e20, 3])).toBe(3);
		await expect(invoke('sum', [1, '2'])).rejects.toMatchObject({ name: 'TypeError' });
	});

	test('minBy/maxBy は複合キーを比較し同値なら最初、空なら null', async () => {
		const a = { k: [1, 'a'], id: 1 }, b = { k: [1, 'a'], id: 2 }, c = { k: [1, 'b'], id: 3 };
		expect(await invoke('minBy', [a, b, c], [(x: typeof a) => x.k])).toBe(a);
		expect(await invoke('maxBy', [a, b, c], [(x: typeof a) => x.k])).toBe(c);
		for (const name of ['minBy', 'maxBy']) expect(await invoke(name, [], [(x: Value) => x])).toBeNull();
	});

	test('countBy は原型なしで数と文字列を集計し禁止キーと配列キーを拒否する', async () => {
		const result = await invoke('countBy', [1, '1', 'constructor', 'toString'], [(x: Value) => x]);
		expect(Object.getPrototypeOf(result)).toBeNull(); expect(result).toEqual({ 1: 2, constructor: 1, toString: 1 });
		await expect(invoke('countBy', [1], [() => '__proto__'])).rejects.toMatchObject({ code: 'FORBIDDEN_PROPERTY' });
		await expect(invoke('countBy', [1], [() => [1]])).rejects.toMatchObject({ name: 'TypeError' });
	});

	test('キー関数は各メソッドで添字順に一回ずつ呼ぶ', async () => {
		for (const name of ['uniqueBy', 'minBy', 'maxBy', 'countBy', 'sampleBy']) {
			const seen: number[] = []; let active = 0, maximum = 0;
			await invoke(name, [3, 1, 2], [async (_value: Value, index: number) => {
				seen.push(index); maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return index + 1;
			}]);
			expect(seen, name).toEqual([0, 1, 2]); expect(maximum, name).toBe(1);
		}
	});

	test('shuffle/sample/sampleBy の境界と乱数の検査', async () => {
		const array = [1, 2, 3]; expect(await invoke('shuffle', array, [() => 0])).toBe(array); expect(array).toEqual([2, 3, 1]);
		expect(await invoke('sample', [], [() => { throw new Error('unused'); }])).toBeNull();
		expect(await invoke('sample', [1, 2, 3], [() => 0])).toBe(1);
		expect(await invoke('sample', [1, 2, 3], [() => 1 - Number.EPSILON])).toBe(3);
		expect(await invoke('sampleBy', [1, 2, 3], [(x: number) => x === 2 ? 1 : 0, () => 0])).toBe(2);
		expect(await invoke('sampleBy', [1, 2], [() => Number.MAX_VALUE, () => 0.75])).toBe(2);
		expect(await invoke('sampleBy', [], [() => 0])).toBeNull();
		for (const weight of [-1, NaN, Infinity, 0]) await expect(invoke('sampleBy', [1], [() => weight])).rejects.toMatchObject({ name: 'RangeError' });
		for (const rng of [() => -1, () => 1, () => NaN, () => Infinity]) for (const name of ['shuffle', 'sample', 'sampleBy']) await expect(invoke(name, [1, 2], name === 'sampleBy' ? [() => 1, rng] : [rng])).rejects.toMatchObject({ name: 'RangeError' });
	});

	test('shuffle は多重集合を保ち、unique は冪等、sortBy は安定', async () => {
		let compared = 0;
		await fc.assert(fc.asyncProperty(numeric, async input => {
			const shuffled = await invoke('shuffle', [...input], [() => 0.375]) as number[];
			expect([...shuffled].sort((a, b) => a - b)).toEqual([...input].sort((a, b) => a - b));
			const unique = await invoke('unique', input) as number[];
			expect(await invoke('unique', unique)).toEqual(unique);
			const values = input.map((key, index) => ({ key, index }));
			expect(await invoke('sortBy', [...values], [(x: typeof values[number]) => x.key])).toEqual([...values].sort((a, b) => a.key - b.key));
			compared++;
		}), { seed: 81723, numRuns: 500 });
		expect(compared).toBe(500);
	});
});
