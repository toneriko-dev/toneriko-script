import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

async function output(source: string, globals: Record<string, unknown> = {}): Promise<unknown[]> {
	const values: unknown[] = [];
	await new Interpreter({ ...globals, out: (value: unknown) => { values.push(value); } }).exec(parse(source).program);
	return values;
}

test.each([false, true])('Error の原型だけを持つ通常オブジェクトの getter を呼ばない: タグ=%s', async tagged => {
	let calls = 0;
	const value = Object.create(Error.prototype, { name: { get() { calls++; return 'fake'; } } });
	if (tagged) Object.defineProperty(value, Symbol.toStringTag, { value: 'Other' });
	await expect(output('out(e.name);', { e: value })).rejects.toMatchObject({ code: 'ACCESSOR_PROPERTY' });
	expect(calls).toBe(0);
});

test.each(['AbortError', 'TimeoutError'])('DOMException の name と message の getter を読める: %s', async name => {
	const error = new DOMException('host message', name);
	const values = await output('out(e.name);out(e.message);try{fail();}catch(c){out(c===e);out(c.name);out(c.message);}try{reject();}catch(c){out(c===e);out(c.name);out(c.message);}', {
		e: error,
		fail: () => { throw error; },
		reject: () => Promise.reject(error),
	});
	expect(values).toEqual([name, 'host message', true, name, 'host message', true, name, 'host message']);
});

test.each([false, true])('ホスト Error の独自プロパティと経路をまたぐ同一性を保つ: 別 realm=%s', async foreign => {
	const error: Error & { code: string; status: number } = foreign
		? runInNewContext('Object.assign(new TypeError("host"), {code:"E1",status:503})')
		: Object.assign(new TypeError('host'), { code: 'E1', status: 503 });
	const values = await output('out(e===box.e);out(e===get());out(e.code);out(e.status);out("code" in e);out({...e});e.status=504;out(box.e.status);try{fail();}catch(c){out(c===e);out(c.code);out(c.status);}', {
		e: error, box: { e: error }, get: () => error, fail: () => { throw error; },
	});
	expect(values).toEqual([true, true, 'E1', 503, true, { code: 'E1', status: 503 }, 504, true, 'E1', 504]);
	expect(error.status).toBe(504);
});

test('exec をまたいでもホスト Error の参照と書き換えを保つ', async () => {
	const error = new TypeError('original');
	const values: unknown[] = [];
	const interpreter = new Interpreter({ e: error, box: { e: error }, get: () => error, out: (value: unknown) => { values.push(value); } });
	await interpreter.exec(parse('const saved=e;e.message="changed";e.status=7;out(e===box.e);').program);
	await interpreter.exec(parse('out(saved===e);out(e===box.e);out(e===get());out(e.message);out(e.status);').program);
	expect(values).toEqual([true, true, true, true, 'changed', 7]);
	expect(error.message).toBe('changed');
	expect(Object.getOwnPropertyDescriptor(error, 'status')?.value).toBe(7);
});

test.each(['data', 'getter', 'absent'])('ホスト Error の stack を読む・存在判定・列挙から隠す: %s', async kind => {
	const error = Object.assign(new Error('x'), { status: 7 });
	let calls = 0;
	Reflect.deleteProperty(error, 'stack');
	if (kind === 'data') Object.defineProperty(error, 'stack', { value: '/private/host.ts', enumerable: true });
	if (kind === 'getter') Object.defineProperty(error, 'stack', { get() { calls++; return '/private/host.ts'; }, enumerable: true });
	expect(await output('out(e.stack);out("stack" in e);out({...e});out(e.toString);out(e.constructor);', { e: error })).toEqual([null, false, { status: 7 }, null, null]);
	expect(calls).toBe(0);
});

test('Error の name と message の利用者の原型 getter を拒否する', async () => {
	let calls = 0;
	const prototype = Object.create(Error.prototype);
	Object.defineProperties(prototype, {
		name: { get() { calls++; return 'CustomError'; } },
		message: { get() { calls++; return 'custom message'; } },
		status: { get() { throw new Error('must not read'); } },
	});
	const error = new Error();
	Object.setPrototypeOf(error, prototype);
	await expect(output('out(e.name);', { e: error })).rejects.toMatchObject({ code: 'ACCESSOR_PROPERTY' });
	await expect(output('out(e.message);', { e: error })).rejects.toMatchObject({ code: 'ACCESSOR_PROPERTY' });
	expect(calls).toBe(0);
});

test('Error の原型の name と message のデータ値を正規化して返す', async () => {
	const error = new Error();
	Object.setPrototypeOf(error, Object.create(Error.prototype, { name: { value: 7 }, message: { value: { secret: true } } }));
	expect(await output('out(e.name);out(e.message);', { e: error })).toEqual([7, { secret: true }]);
});

test('ホスト Error の own データ値は name と message もそのまま扱う', async () => {
	const error = new Error();
	Object.defineProperties(error, { name: { value: 7, writable: true }, message: { value: false, writable: true } });
	expect(await output('out(e.name);out(e.message);e.name=null;e.message=42;out(e.name);out(e.message);', { e: error })).toEqual([7, false, null, 42]);
	expect(error.name).toBeNull();
	expect(error.message).toBe(42);
});

test.each(['new Error()', 'Error()'])('引数なし Error は message を持たず、代入した message は列挙される: %s', async expression => {
	const captured: object[] = [];
	const values = await output(`const e=${expression};check(e);out(e.name);out(e.message);e.message="x";out({...e});out(e.stack);out(e.toString);out(e.constructor);`, {
		check: (e: object) => { expect(Object.getPrototypeOf(e)).toBeNull(); expect(Object.hasOwn(e, 'message')).toBe(false); captured.push(e); },
	});
	expect(values).toEqual(['Error', '', { message: 'x' }, null, null, null]);
	expect(captured).toHaveLength(1);
	expect(Object.keys(captured[0]!)).toEqual(['message']);
});

test.each(['new Error("x",{cause:7})', 'Error("x",{cause:7})'])('引数あり Error の message と cause は非列挙で種類の既定値を持つ: %s', async expression => {
	const values = await output(`const e=${expression};check(e);out({...e});out(e.message);out(e.cause);e.name="Custom";delete e.name;delete e.message;out(e.name);out(e.message);`, {
		check: (e: object) => {
			expect(Object.getPrototypeOf(e)).toBeNull();
			expect(Object.keys(e)).toEqual([]);
			expect(Object.getOwnPropertyDescriptor(e, 'message')).toMatchObject({ value: 'x', enumerable: false });
			expect(Object.getOwnPropertyDescriptor(e, 'cause')).toMatchObject({ value: 7, enumerable: false });
		},
	});
	expect(values).toEqual([{}, 'x', 7, 'Error', '']);
});

test('実行時 Error は原型を持たず位置を写し、name の削除後に種類の既定値を返す', async () => {
	const source = 'try{null.x;}catch(e){check(e);out({...e});e.pos.line=999;e.name="Custom";delete e.name;out(e.name);delete e.message;out(e.message);}';
	const program = parse(source).program;
	const before = JSON.stringify(program);
	const values: unknown[] = [];
	await new Interpreter({
		out: (value: unknown) => { values.push(value); },
		check: (e: object) => {
			expect(Object.getPrototypeOf(e)).toBeNull();
			expect(Object.keys(e)).toEqual([]);
			expect(Object.getOwnPropertyDescriptor(e, 'code')).toMatchObject({ value: 'NULL_PROPERTY_ACCESS', enumerable: false });
			expect(Object.getOwnPropertyDescriptor(e, 'pos')?.enumerable).toBe(false);
		},
	}).exec(program);
	expect(values).toEqual([{}, 'TypeError', '']);
	expect(JSON.stringify(program)).toBe(before);
});

test.each(['e.name=null;', 'e.message=[1];', 'e.name={};e.message=null;'])('非文字列のエラー情報でも投げた値を失わず報告する: %s', async mutation => {
	let thrown: unknown;
	const interpreter = new Interpreter({ capture: (e: unknown) => { thrown = e; } });
	await expect(interpreter.exec(parse(`const e=new Error("x");${mutation}capture(e);throw e;`).program)).rejects.toMatchObject({ code: 'UNCAUGHT_EXCEPTION' });
	try {
		await new Interpreter({ e: thrown }).exec(parse('throw e;').program);
		expect.fail('例外を報告する必要があります');
	} catch (error) {
		expect(error).toMatchObject({ code: 'UNCAUGHT_EXCEPTION' });
		expect((error as { thrownValue: unknown }).thrownValue).toBe(thrown);
	}
});

test('実行時エラーの name が非文字列でも再送出した値を付けて報告する', async () => {
	let thrown: unknown;
	const interpreter = new Interpreter({ capture: (e: unknown) => { thrown = e; } });
	try {
		await interpreter.exec(parse('try{null.x;}catch(e){e.name=null;capture(e);throw e;}').program);
		expect.fail('例外を報告する必要があります');
	} catch (reported) {
		expect(reported).toMatchObject({ code: 'UNCAUGHT_EXCEPTION' });
		expect((reported as { thrownValue: unknown }).thrownValue).toBe(thrown);
	}
});

test('Error の own の name と message の getter は呼ばない', async () => {
	const error = new Error();
	let calls = 0;
	Object.defineProperties(error, {
		name: { get() { calls++; return 'OwnError'; } },
		message: { get() { calls++; return 42; } },
	});
	await expect(output('out(e.name);', { e: error })).rejects.toMatchObject({ code: 'ACCESSOR_PROPERTY' });
	await expect(output('out(e.message);', { e: error })).rejects.toMatchObject({ code: 'ACCESSOR_PROPERTY' });
	expect(calls).toBe(0);
});

test.each([false, true])('ホスト例外の非文字列 metadata でも元の値を付けて報告する: 別 realm=%s', async foreign => {
	const error = foreign ? runInNewContext('new Error("host")') : new Error('host');
	Object.defineProperties(error, { name: { value: null }, message: { value: [1] } });
	try {
		await new Interpreter({ fail: () => { throw error; } }).exec(parse('fail();').program);
		expect.fail('例外を報告する必要があります');
	} catch (reported) {
		expect(reported).toMatchObject({ code: 'UNCAUGHT_EXCEPTION' });
		expect((reported as { thrownValue: unknown }).thrownValue).toBe(error);
	}
});
