import { expect, test } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

for (const options of [undefined, {}, { maxSteps: undefined }]) {
	test(`既定値は500000ステップ: ${JSON.stringify(options)}`, async () => {
		const interpreter = new Interpreter({}, options);
		await expect(interpreter.exec(parse('while(true){}').program)).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
		expect(interpreter.stepCount).toBe(500001);
	});
}

for (const limit of [0, 1, 100, 600000]) {
	test(`明示指定の上限を保つ: ${limit}`, async () => {
		const interpreter = new Interpreter({}, { maxSteps: limit });
		await expect(interpreter.exec(parse('while(true){}').program)).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
		expect(interpreter.stepCount).toBe(limit + 1);
	});
}

for (const maxSteps of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
	test(`不正な上限を拒否する: ${maxSteps}`, () => {
		expect(() => new Interpreter({}, { maxSteps })).toThrow(RangeError);
	});
}

for (const [name, source, expected, steps] of [
	['40000回ループ', 'let s=0;for(let i=0;i<40000;i++){s+=i;}out(s);', 799980000, 400017],
	['fib(18)', 'function fib(n){return n<2?n:fib(n-1)+fib(n-2);}out(fib(18));', 2584, 117058],
] as const) {
	test(`既定上限内で終了する: ${name}`, async () => {
		const output: unknown[] = [];
		const interpreter = new Interpreter({ out: (value: unknown) => output.push(value) });
		await interpreter.exec(parse(source).program);
		expect(output).toEqual([expected]);
		expect(interpreter.stepCount).toBe(steps);
	});
}

test('明示上限の境界は成功し、1ステップ少ないと停止する', async () => {
	const program = parse('let x=1;x+=2;').program;
	const measured = new Interpreter();
	await measured.exec(program);
	await expect(new Interpreter({}, { maxSteps: measured.stepCount }).exec(program)).resolves.toBeUndefined();
	await expect(new Interpreter({}, { maxSteps: measured.stepCount - 1 }).exec(program)).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
});
