import { test, expect } from 'vitest';
import { Interpreter, hostFunction } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

test('同期のループ本体は周回ごとに評価生成器を作らず、ステップ数を保つ', async () => {
	const output: unknown[] = [];
	const interpreter = new Interpreter({ out: (x: unknown) => { output.push(x); } });
	await interpreter.exec(parse('let s = 0; for (let i = 0; i < 40000; i++) { s += 1; } out(s);').program);
	expect(output).toEqual([40000]);
	expect(interpreter.stepCount).toBe(400017);
	expect(interpreter.evaluationFrameCount).toBeLessThan(20);
});

test('呼び出し深さの既定上限は10000で、RangeErrorをcatchできる', async () => {
	const output: unknown[] = [];
	const interpreter = new Interpreter({ out: (x: unknown) => { output.push(x); } });
	await interpreter.exec(parse('function f(n) { if (n === 0) return 1; return f(n - 1); } out(f(9999)); try { f(10000); } catch(e) { out(e.name); out(e.code); } out(f(1));').program);
	expect(output).toEqual([1, 'RangeError', 'CALL_DEPTH_EXCEEDED', 1]);
});

test('呼び出し深さの設定は例外の後に回復し、ホストのcallbackでも共有する', async () => {
	const output: unknown[] = [];
	const interpreter = new Interpreter({
		out: (x: unknown) => { output.push(x); },
		bridge: hostFunction(([fn], context) => context.call(fn!, [])),
	}, { maxCallDepth: 3 });
	await interpreter.exec(parse('function f(n) { if (n === 0) return 7; return f(n - 1); } out(f(2)); try { f(3); } catch(e) { out(e.name); } function g() { return bridge(() => g()); } try { g(); } catch(e) { out(e.name); } out(f(2));').program);
	expect(output).toEqual([7, 'RangeError', 'RangeError', 7]);
});

test.each([0, -1, 1.5, NaN, Infinity])('不正な呼び出し深さ設定を拒否する %s', maxCallDepth => {
	expect(() => new Interpreter({}, { maxCallDepth })).toThrow(RangeError);
});

test('同期評価と中断可能な評価は出力・位置・ステップ数を一致させる', async () => {
	for (const source of [
		'let x=0; while(x<30) { x++; } out(x);',
		'let x=0; do { x+=2; } while(x<30); out(x);',
		'let x=0; for(let i=0;i<20;i++) { if(i<4) continue; x+=i; if(i>10) break; } out(x);',
		'let x=null; x ??= 4; x ??= 5; x *= 2; out(x); out(typeof missing); out(!x);',
		'function f(x) { { let y=x; if(y>0) return -y; } return +x; } out(f(2)); out(f(0));',
		'out(0 && 9); out(3 || 7); out(null ?? 8); out(2>1 ? 4 : 5);',
		'try { { let x=x; } } catch(e) { out(e.name); out(e.pos); }',
	]) {
		const results = [];
		for (const synchronous of [false, true]) {
			const output: unknown[] = [];
			const interpreter = new Interpreter({ out: (x: unknown) => { output.push(x); } });
			if (!synchronous) Object.defineProperty(interpreter, 'synchronous', { value: () => null });
			await interpreter.exec(parse(source).program);
			results.push({ output, steps: interpreter.stepCount });
		}
		expect(results[1]).toEqual(results[0]);
	}
});

test('同期の無限ループでも制御を返し、abortでfinallyを実行しない', async () => {
	let clock = 0;
	let yields = 0;
	const output: unknown[] = [];
	const interpreter = new Interpreter({ out: (x: unknown) => { output.push(x); } }, {
		now: () => ++clock, yieldInterval: 1, maxBusyTime: 100000,
		yieldToHost: async () => { if (++yields === 3) interpreter.abort(); },
	});
	await expect(interpreter.exec(parse('try { let x=0; while(true) { x++; } } finally { out("finally"); }').program)).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' });
	expect(yields).toBe(3);
	expect(output).toEqual([]);
	expect(interpreter.stepCount).toBeLessThan(300);
});
