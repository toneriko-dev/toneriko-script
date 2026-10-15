import { expect, test } from 'vitest';
import { parse } from '../../src/v2/parser/index.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { TypePlan } from '../../src/v2/runtime/type-plan.js';
import { parsedTypeAnnotations } from '../../src/v2/type-metadata.js';
import type * as A from '../../src/v2/ast.js';

for (const source of [
	'let n = 1; n += 2;',
	'const row = {x: 1}; function f(x) { return x; }',
	'const f = (x = {label: "number: string"}) => x;',
]) test(`注釈のない解析結果を記録する: ${source}`, () => {
	const { program } = parse(source);
	expect(parsedTypeAnnotations(program)).toBe(false);
	const plan = new TypePlan();
	expect(plan.prepare(program)).toBe(true);
	expect(plan.hasTypes).toBe(false);
	expect(plan.prepare(program)).toBe(false);
	expect(Object.keys(program).sort()).toEqual(['body', 'loc', 'sourceType', 'type']);
});

for (const source of [
	'let n: number = "bad";',
	'function f(n: number = "bad") {} f();',
	'const f = (): number => "bad"; f();',
	'let {n}: {n: number} = {n: "bad"};',
]) test(`注釈のある解析結果は検査を省略しない: ${source}`, async () => {
	const { program } = parse(source);
	expect(parsedTypeAnnotations(program)).toBe(true);
	await expect(new Interpreter().exec(program)).rejects.toMatchObject({ code: 'TYPE_ANNOTATION_MISMATCH' });
});

test('外部から渡された構文木も注釈を走査する', async () => {
	const program = structuredClone(parse('let n: number = "bad";').program);
	expect(parsedTypeAnnotations(program)).toBeUndefined();
	await expect(new Interpreter().exec(program)).rejects.toMatchObject({ code: 'TYPE_ANNOTATION_MISMATCH' });
});

test('解析結果の複製に型を追加した構文木も検査する', async () => {
	const original = parse('let n = "bad";').program;
	const program = structuredClone(original);
	const declaration = program.body[0] as A.VariableDeclaration;
	const id = declaration.declarations[0]!.id as A.Identifier;
	id.typeAnnotation = { type: 'KeywordTypeAnnotation', name: 'number', loc: id.loc };
	expect(parsedTypeAnnotations(original)).toBe(false);
	expect(parsedTypeAnnotations(program)).toBeUndefined();
	await expect(new Interpreter().exec(program)).rejects.toMatchObject({ code: 'TYPE_ANNOTATION_MISMATCH' });
	await expect(new Interpreter().exec(original)).resolves.toBeUndefined();
});


for (const source of [
	'a ? (b) : c;',
	'a ? (b) : number => b;',
	'a ? (b) : string => b;',
]) test(`採用しなかった戻り値型の試し読みは記録しない: ${source}`, () => {
	expect(parsedTypeAnnotations(parse(source).program)).toBe(false);
});

for (const source of [
	'const f = true ? (b): number => b : c; f("bad");',
	'const f = true ? (b: number): number => b : c; f("bad");',
	'const f = true ? (b): number => true ? (q): number => q : c : c; f(1);',
]) test(`採用した試し読みキャッシュの注釈は検査する: ${source}`, async () => {
	const program = parse(source).program;
	expect(parsedTypeAnnotations(program)).toBe(true);
	await expect(new Interpreter().exec(program)).rejects.toMatchObject({ code: 'TYPE_ANNOTATION_MISMATCH' });
});
