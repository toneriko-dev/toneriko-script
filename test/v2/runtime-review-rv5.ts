import { expect, test } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

async function output(source: string, globals: Record<string, unknown> = {}): Promise<unknown[]> {
	const values: unknown[] = [];
	await new Interpreter({ ...globals, out: (value: unknown) => { values.push(value); } }).exec(parse(source).program);
	return values;
}

test('AggregateError.errors と非列挙の own データを普通のホスト値と同じく読む', async () => {
	const e = new AggregateError([new Error('a'), new Error('b')], 'host');
	Object.defineProperty(e, 'details', { value: 'd', writable: true, configurable: true });
	expect(await output('out((e.errors ?? []).length);out(e.errors[1].message);out(e.details);out("details" in e);out({...e});e.details="changed";out(e.details);', { e })).toEqual([2, 'b', 'd', true, {}, 'changed']);
});

test.each([false, true])('ホスト Error の own accessor は列挙性によらず拒否する: %s', async enumerable => {
	let calls = 0;
	const e = new Error('host');
	Object.defineProperty(e, 'details', { get() { calls++; return 'd'; }, enumerable });
	expect(await output('try{out(e.details);}catch(c){out(c.code);}out("details" in e);', { e })).toEqual(['ACCESSOR_PROPERTY', true]);
	if (enumerable) expect(await output('try{out({...e});}catch(c){out(c.code);}', { e })).toEqual(['ACCESSOR_PROPERTY']);
	expect(calls).toBe(0);
});

test.each(['constructor', 'species'])('Promise の %s getter が投げたホスト例外の同一性を保つ', async kind => {
	let calls = 0;
	const prototype = Object.create(Error.prototype, { name: { get() { calls++; return 'HostError'; } } });
	const e = Object.assign(new Error('host'), { status: 503 });
	Object.setPrototypeOf(e, prototype);
	const f = () => {
		const promise = Promise.resolve(1);
		if (kind === 'constructor') Object.defineProperty(promise, 'constructor', { get() { throw e; } });
		else Object.defineProperty(promise, 'constructor', { value: Object.defineProperty({}, Symbol.species, { get() { throw e; } }) });
		return promise;
	};
	expect(await output('try{f();}catch(c){out(c===e);out(c.status);out(c.message);}finally{out("finally");}', { e, f })).toEqual([true, 503, 'host', 'finally']);
	expect(calls).toBe(0);
});

test.each(['name', 'message', 'classification'])('内部例外の %s 取得が失敗しても catch と finally を通る', async kind => {
	let calls = 0;
	const original = new RangeError('internal');
	if (kind !== 'classification') Object.defineProperty(original, kind, { get() { calls++; throw new Error('must not read'); } });
	const error = kind === 'classification' ? new Proxy(original, { getPrototypeOf() { throw new Error('trap'); } }) : original;
	const segment = Intl.Segmenter.prototype.segment;
	Intl.Segmenter.prototype.segment = () => { throw error; };
	try {
		expect(await output('try{out("あ".length);}catch(c){out(c.name);out(c.message);out(c.stack);}finally{out("finally");}')).toEqual([kind === 'classification' ? 'Error' : 'RangeError', '', null, 'finally']);
		expect(calls).toBe(0);
	} finally { Intl.Segmenter.prototype.segment = segment; }
});

test('ホスト Proxy の罠が投げた例外でも catch と finally を飛ばさない', async () => {
	let calls = 0;
	const e = new Error('trap error');
	Object.setPrototypeOf(e, Object.create(Error.prototype, { name: { get() { calls++; return 'TrapError'; } } }));
	let trapped = false;
	const object = new Proxy({}, { getOwnPropertyDescriptor(target, key) { if (trapped) throw e; return Reflect.getOwnPropertyDescriptor(target, key); } });
	expect(await output('arm();try{out(object.x);}catch(c){out(c.name);out(c.message);}finally{out("finally");}', { object, arm: () => { trapped = true; } })).toEqual(['Error', '', 'finally']);
	expect(calls).toBe(0);
});

test('Promise 判定中のホスト Proxy の罠が投げた例外も元の値で受ける', async () => {
	let calls = 0;
	const e = Object.assign(new Error('proxy'), { status: 503 });
	Object.setPrototypeOf(e, Object.create(Error.prototype, { name: { get() { calls++; return 'ProxyError'; } } }));
	const f = () => new Proxy({}, { getPrototypeOf() { throw e; } });
	expect(await output('try{f();}catch(c){out(c===e);out(c.status);}finally{out("finally");}', { e, f })).toEqual([true, 503, 'finally']);
	expect(calls).toBe(0);
});
