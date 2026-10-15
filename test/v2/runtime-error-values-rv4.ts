import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { RuntimeError } from '../../src/v2/runtime/errors.js';
import { parse } from '../../src/v2/parser/index.js';

const hidden = ['stack', 'sourceURL', 'line', 'column', 'originalLine', 'originalColumn', 'fileName', 'lineNumber', 'columnNumber'];
async function output(source: string, globals: Record<string, unknown> = {}): Promise<unknown[]> {
	const values: unknown[] = [];
	await new Interpreter({ ...globals, out: (value: unknown) => { values.push(value); } }).exec(parse(source).program);
	return values;
}

test.each([false, true])('ホスト Error の位置情報を隠し非列挙のデータ値は読める: enumerable=%s', async enumerable => {
	const error = Object.assign(new Error('host', { cause: 7 }), { status: 503, code: 'E_HOST' });
	for (const key of hidden) Object.defineProperty(error, key, { value: '/private/host.js:17', enumerable, configurable: true });
	Object.defineProperty(error, 'secret', { value: 'private' });
	const source = hidden.map(key => `out(e.${key});out("${key}" in e);`).join('');
	expect(await output(`${source}out(e.secret);out("secret" in e);out(e.cause);out({...e});`, { e: error })).toEqual([
		...hidden.flatMap(() => [null, false]), 'private', true, 7, { status: 503, code: 'E_HOST' },
	]);
});

test.each([false, true])('古い Error 子クラスでも原型の名前を読み内部情報を隠す: 別 realm=%s', async foreign => {
	const error = foreign ? runInNewContext(`(() => { function LegacyError() { Error.captureStackTrace(this, LegacyError); this.message='legacy'; } LegacyError.prototype=Object.create(Error.prototype); LegacyError.prototype.name='LegacyError'; return new LegacyError(); })()`)
		: Object.create(Error.prototype, { name: { value: 'LegacyError' }, message: { value: 'legacy' }, stack: { value: 'private', enumerable: true } });
	expect(await output('try{fail();}catch(e){out(e.name);out(e.message);out(e.stack);out("stack" in e);out({...e});}', { fail: () => { throw error; } })).toEqual(['LegacyError', 'legacy', null, false, foreign ? { message: 'legacy' } : {}]);
});

test.each(['name', 'message'])('Error タグを偽装しても getter を呼ばない: %s', async key => {
	let calls = 0;
	const error = Object.create(Error.prototype, { [Symbol.toStringTag]: { value: 'Error' }, [key]: { get() { calls++; return 'fake'; } } });
	await expect(output(`out(e.${key});`, { e: error })).rejects.toMatchObject({ code: 'ACCESSOR_PROPERTY' });
	expect(calls).toBe(0);
});

test('Error の原型にある非文字列の name と message を正規化して返す', async () => {
	const error = new Error();
	Object.setPrototypeOf(error, Object.create(Error.prototype, { name: { value: 7 }, message: { value: undefined } }));
	expect(await output('out(e.name);out(e.message);', { e: error })).toEqual([7, null]);
});

test('DOMException の code を読み存在判定できる', async () => {
	expect(await output('out(e.name);out(e.message);out(e.code);out("code" in e);', { e: new DOMException('host', 'AbortError') })).toEqual(['AbortError', 'host', 20, true]);
});

test.each(['getter', 'setter', 'readonly', 'dom'])('ホストの原型上の accessor と読取専用値への代入を拒否する: %s', async kind => {
	let calls = 0;
	const e = kind === 'dom' ? new DOMException('host') : Object.create(null);
	if (kind !== 'dom') Object.setPrototypeOf(e, Object.create(null, { message: kind === 'readonly' ? { value: 'host', writable: false } : kind === 'getter' ? { get() { calls++; return 'host'; } } : { set() { calls++; } } }));
	expect(await output('try{e.message="x";}catch(c){out(c.name);}out(e.message);', { e })).toEqual(['TypeError', kind === 'dom' ? 'host' : null]);
	expect(Object.hasOwn(e, 'message')).toBe(false);
	expect(calls).toBe(0);
});

test('内部の JavaScript 例外を原型のないスクリプト Error に変換する', async () => {
	const original = Object.assign(new RangeError('internal range'), { status: 503, sourceURL: '/private/strings.ts' });
	const spy = vi.spyOn(Intl.Segmenter.prototype, 'segment').mockImplementation(() => { throw original; });
	try {
		const captured: object[] = [];
		expect(await output('try{out("あ".length);}catch(e){capture(e);out(e.name);out(e.message);out(e.status);out(e.sourceURL);out({...e});}', { capture: (e: object) => { captured.push(e); } })).toEqual(['RangeError', 'internal range', null, null, {}]);
		expect(captured).toHaveLength(1);
		expect(captured[0]).not.toBe(original);
		expect(Object.getPrototypeOf(captured[0])).toBeNull();
	} finally { spy.mockRestore(); }
});

test('ホスト関数からの JavaScript 例外だけは参照と利用者のプロパティを保つ', async () => {
	const e = Object.assign(new RangeError('host'), { code: 'E_HOST' });
	expect(await output('try{fail();}catch(c){out(c===e);out(c.code);}try{reject();}catch(c){out(c===e);out(c.code);}', { e, fail: () => { throw e; }, reject: () => Promise.reject(e) })).toEqual([true, 'E_HOST', true, 'E_HOST']);
});


test('ホスト自身が作った RuntimeError も元の値のまま catch に渡す', async () => {
	const e = new RuntimeError('NULL_PROPERTY_ACCESS', { line: 1, column: 1 }, { key: 'x' }, 'TypeError');
	expect(await output('try{fail();}catch(c){out(c===e);try{throw c;}catch(d){out(d===e);}}try{reject();}catch(c){out(c===e);}', { e, fail: () => { throw e; }, reject: () => Promise.reject(e) })).toEqual([true, true, true]);
});
