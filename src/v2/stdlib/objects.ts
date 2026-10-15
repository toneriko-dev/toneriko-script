import { isArrayIterator } from './arrays.js';
import { type StdContext, type StdDefinition, type StdFrame, requireString } from './core.js';
import { runtimeError, createScriptError } from '../runtime/errors.js';
import { valueTypeof, scriptObject, type Value } from '../runtime/brands.js';

const arg = (name: string, type: string, optional = false) => ({ name, type, optional });
const def = (name: string, args: StdDefinition['args'], returns: string, ja: string, en: string, implementation: StdDefinition['implementation']): StdDefinition => ({ name, receiver: 'global', args, returns, description: { ja, en }, implementation });
function* step(ctx: StdContext): StdFrame { ctx.tick(); return yield ctx.checkpoint(); }
const dictionary = (): Record<string, Value> => scriptObject(Object.create(null));
const callable = (value: Value | undefined): boolean => value !== undefined && valueTypeof(value) === 'function';
function key(ctx: StdContext, value: Value): string {
	if (value === '__proto__') throw runtimeError('STDLIB_FORBIDDEN_KEY', ctx.pos, {}, 'TypeError');
	return ctx.properties.key(value, ctx.pos);
}
function requireCallback(ctx: StdContext, value: Value | undefined): Value {
	if (!callable(value)) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'Function' }, 'TypeError');
	return value!;
}
function* own(ctx: StdContext, value: Value): Generator<any, [string, Value][], any> {
	const result: [string, Value][] = [];
	if (value !== null && typeof value === 'object' && Object.hasOwn(value, '__proto__')) key(ctx, '__proto__');
	// 公開プロパティの入口を共有し、例外の内部情報や getter を列挙で漏らさない。
	for (const pair of ctx.properties.entriesIterator(value, ctx.pos)) { key(ctx, pair[0]); result.push(pair); yield* step(ctx); }
	return result;
}
function* iterable(ctx: StdContext, value: Value): Generator<any, Value[], any> {
	for (const _ of ctx.properties.prepare(value, ctx.pos, true)) yield ctx.checkpoint();
	const result: Value[] = [];
	for (const item of ctx.properties.iterableIterator(value, ctx.pos)) { result.push(item); yield* step(ctx); }
	return result;
}

/** 入力の深さはホストの呼び出しスタックを消費せず、トークンの途中でも制御を返す。 */
function* parseJson(ctx: StdContext, input: string, reviver?: Value): StdFrame {
	let index = 0;
	const syntax = (): never => { throw runtimeError('STDLIB_JSON_SYNTAX', ctx.pos, {}, 'SyntaxError'); };
	function* whitespace(): Generator<any, void, any> {
		while (index < input.length && /[\t\n\r ]/.test(input[index]!)) { index++; yield* step(ctx); }
	}
	function* quoted(): Generator<any, string, any> {
		if (input[index++] !== '"') return syntax();
		const pieces: string[] = [];
		while (index < input.length) {
			let char = input[index++]!; yield* step(ctx);
			if (char === '"') return pieces.join('');
			if (char.charCodeAt(0) < 32) return syntax();
			if (char === '\\') {
				char = input[index++]!;
				const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
				if (char === 'u') {
					const digits = input.slice(index, index + 4);
					if (!/^[0-9a-fA-F]{4}$/.test(digits)) return syntax();
					pieces.push(String.fromCharCode(parseInt(digits, 16))); index += 4;
				} else if (Object.hasOwn(escapes, char)) pieces.push(escapes[char]!);
				else return syntax();
			} else pieces.push(char);
		}
		return syntax();
	}
	type Source = { value: Value; source: string };
	const sources = new WeakMap<object, Map<string, Source>>();
	const root = dictionary();
	type Frame = { value: Record<string, Value> | Value[]; state: 'first' | 'key' | 'value' | 'after'; name: string };
	const stack: Frame[] = [{ value: root, state: 'value', name: '' }];
	let rootDone = false;
	while (stack.length) {
		yield* whitespace(); yield* step(ctx);
		const frame = stack.at(-1)!;
		if (frame.state === 'first' || frame.state === 'key') {
			const array = Array.isArray(frame.value);
			if (frame.state === 'first' && input[index] === (array ? ']' : '}')) { index++; stack.pop(); continue; }
			if (array) frame.name = String(frame.value.length);
			else { frame.name = key(ctx, yield* quoted()); yield* whitespace(); if (input[index++] !== ':') return syntax(); }
			frame.state = 'value'; continue;
		}
		if (frame.state === 'after') {
			if (frame.value === root) { rootDone = true; stack.pop(); continue; }
			const char = input[index++];
			if (char === (Array.isArray(frame.value) ? ']' : '}')) { stack.pop(); continue; }
			if (char !== ',') return syntax();
			frame.state = 'key'; continue;
		}
		const start = index;
		let value: Value;
		let child: Frame | undefined;
		const char = input[index];
		if (char === '{' || char === '[') {
			index++; value = char === '{' ? dictionary() : scriptObject([]);
			child = { value: value as Frame['value'], state: 'first', name: '' };
		} else if (char === '"') value = yield* quoted();
		else if (input.startsWith('true', index)) { index += 4; value = true; }
		else if (input.startsWith('false', index)) { index += 5; value = false; }
		else if (input.startsWith('null', index)) { index += 4; value = null; }
		else {
			while (index < input.length && /[0-9eE+.-]/.test(input[index]!)) { index++; yield* step(ctx); }
			const token = input.slice(start, index);
			if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token)) return syntax();
			value = Number(token);
		}
		Object.defineProperty(frame.value, frame.name, { value, writable: true, enumerable: true, configurable: true });
		if (!child) {
			let map = sources.get(frame.value); if (!map) sources.set(frame.value, map = new Map());
			map.set(frame.name, { value, source: input.slice(start, index) });
		}
		frame.state = 'after'; if (child) stack.push(child);
	}
	yield* whitespace(); if (!rootDone || index !== input.length) return syntax();
	if (!callable(reviver)) return root['']!;
	type Visit = { holder: Record<string, Value> | Value[]; name: string; entered: boolean; value?: Value };
	const visits: Visit[] = [{ holder: root, name: '', entered: false }];
	while (visits.length) {
		const visit = visits.pop()!; yield* step(ctx);
		if (!visit.entered) {
			const value = ctx.properties.get(visit.holder, visit.name, ctx.pos);
			visits.push({ ...visit, entered: true, value });
			if (value !== null && typeof value === 'object') {
				const keys = Object.keys(value);
				for (let i = keys.length - 1; i >= 0; i--) { visits.push({ holder: value as Visit['holder'], name: keys[i]!, entered: false }); yield* step(ctx); }
			}
		} else {
			const context = dictionary();
			const source = sources.get(visit.holder)?.get(visit.name);
			if (source && Object.is(source.value, visit.value)) context['source'] = source.source;
			const value = yield ctx.call(reviver!, [visit.name, visit.value!, context], visit.holder);
			ctx.properties.set(visit.holder, visit.name, value, ctx.pos);
		}
	}
	return root['']!;
}

function* quote(ctx: StdContext, text: string): Generator<any, string, any> {
	const result: string[] = ['"'];
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i), char = text[i]!; yield* step(ctx);
		if (char === '"' || char === '\\') result.push('\\' + char);
		else if (code < 32) {
			const short: Record<number, string> = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' };
			result.push(short[code] ?? '\\u' + code.toString(16).padStart(4, '0'));
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) result.push(char + text[++i]!);
			else result.push('\\u' + code.toString(16));
		} else if (code >= 0xdc00 && code <= 0xdfff) result.push('\\u' + code.toString(16));
		else result.push(char);
	}
	result.push('"'); return result.join('');
}

function* stringify(ctx: StdContext, initial: Value, replacer?: Value, space?: Value): StdFrame {
	let names: string[] | undefined;
	if (Array.isArray(replacer)) {
		names = []; const seen = new Set<string>();
		const length = replacer.length;
		for (let i = 0; i < length; i++) {
			const item = ctx.properties.get(replacer, i, ctx.pos);
			if (typeof item === 'string' || typeof item === 'number') { const name = key(ctx, String(item)); if (!seen.has(name)) { seen.add(name); names.push(name); } }
			yield* step(ctx);
		}
	}
	let gap = '';
	if (typeof space === 'number') gap = ' '.repeat(Math.min(10, Math.max(0, Math.trunc(space) || 0)));
	else if (typeof space === 'string') { for (const _ of ctx.properties.prepare(space, ctx.pos, true)) yield ctx.checkpoint(); gap = ctx.properties.graphemes(space).slice(0, 10).join(''); }
	const active = new Set<object>();
	type Task = { kind: 'value'; holder: Value; name: string; depth: number; array: boolean; prefix: string; parent?: { count: number } } | { kind: 'close'; value: object; depth: number; array: boolean; count: { count: number } };
	const root = dictionary(); root[''] = initial;
	const tasks: Task[] = [{ kind: 'value', holder: root, name: '', depth: 0, array: false, prefix: '' }];
	const output: string[] = [];
	while (tasks.length) {
		const task = tasks.pop()!; yield* step(ctx);
		if (task.kind === 'close') {
			if (gap && task.count.count) output.push('\n' + gap.repeat(task.depth));
			output.push(task.array ? ']' : '}'); active.delete(task.value); continue;
		}
		const missing = task.holder !== null && typeof task.holder === 'object' && !ctx.properties.has(task.holder, task.name, ctx.pos);
		if (missing && !task.array && !callable(replacer)) continue;
		let value = missing ? null : ctx.properties.get(task.holder, task.name, ctx.pos);
		if (value !== null && typeof value === 'object' && !callable(value)) {
			const prototype = Object.getPrototypeOf(value);
			if (!Array.isArray(value) && prototype !== null && prototype !== Object.prototype && !ctx.properties.errorValue(value, ctx.pos)) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'object | any[]' }, 'TypeError');
			const toJSON = ctx.properties.get(value, 'toJSON', ctx.pos);
			if (callable(toJSON)) value = yield ctx.call(toJSON, [task.name], value);
		}
		if (callable(replacer)) value = yield ctx.call(replacer!, [task.name, value], task.holder);
		if (callable(value)) { if (!task.array) continue; value = null; }
		if (task.parent) {
			if (task.parent.count++) output.push(',');
			if (gap) output.push('\n' + gap.repeat(task.depth));
		}
		output.push(task.prefix);
		if (value === null || typeof value === 'boolean') output.push(String(value));
		else if (typeof value === 'number') output.push(Number.isFinite(value) ? String(value) : 'null');
		else if (typeof value === 'string') output.push(yield* quote(ctx, value));
		else {
			if (active.has(value)) throw runtimeError('STDLIB_JSON_CYCLE', ctx.pos, {}, 'TypeError');
			active.add(value);
			const array = Array.isArray(value); const count = { count: 0 };
			output.push(array ? '[' : '{'); tasks.push({ kind: 'close', value, depth: task.depth, array, count });
			if (array) {
				for (let i = (value as Value[]).length - 1; i >= 0; i--) { tasks.push({ kind: 'value', holder: value, name: String(i), depth: task.depth + 1, array: true, prefix: '', parent: count }); yield* step(ctx); }
			} else {
				const entries = names ? names.map(name => [name, null] as [string, Value]) : yield* own(ctx, value);
				for (let i = entries.length - 1; i >= 0; i--) {
					const name = entries[i]![0]; key(ctx, name);
					if (names && !ctx.properties.has(value, name, ctx.pos)) continue;
					const prefix = (yield* quote(ctx, name)) + (gap ? ': ' : ':');
					tasks.push({ kind: 'value', holder: value, name, depth: task.depth + 1, array: false, prefix, parent: count }); yield* step(ctx);
				}
			}
		}
	}
	return output.length ? output.join('') : null;
}

function* clone(ctx: StdContext, original: Value): StdFrame {
	const memo = new Map<object, Value>();
	const root = dictionary();
	const tasks: { value: Value; target: object; name: string; enumerable?: boolean }[] = [{ value: original, target: root, name: '' }];
	while (tasks.length) {
		const { value, target, name, enumerable = true } = tasks.pop()!; yield* step(ctx); key(ctx, name);
		if (isArrayIterator(value)) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'cloneable value' }, 'DataCloneError');
		if (typeof DOMException !== 'undefined' && value instanceof DOMException) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'cloneable value' }, 'DataCloneError');
		if (callable(value)) throw runtimeError('STDLIB_CLONE_FUNCTION', ctx.pos, {}, 'DataCloneError');
		let copy = value;
		if (value !== null && typeof value === 'object') {
			if (memo.has(value)) copy = memo.get(value)!;
			else {
				if (ctx.properties.errorValue(value, ctx.pos)) {
					const name = ctx.properties.get(value, 'name', ctx.pos), message = ctx.properties.get(value, 'message', ctx.pos);
					const knownNames = ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError'];
					if ((message !== null && typeof message === 'object') || callable(message)) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'string | number | boolean | null' }, 'DataCloneError');
					copy = createScriptError(typeof name === 'string' && knownNames.includes(name) ? name : 'Error', Object.hasOwn(value, 'message') ? String(message) : undefined); memo.set(value, copy);
					// 例外の追加プロパティは複製しないが、禁止値は無視せず全ての深さで検査する。
					const ignored = dictionary();
					for (const [childKey, child] of yield* own(ctx, value)) { tasks.push({ value: child, target: ignored, name: childKey }); yield* step(ctx); }
					if (Object.hasOwn(value, 'cause')) tasks.push({ value: ctx.properties.get(value, 'cause', ctx.pos), target: copy as object, name: 'cause', enumerable: false });
				} else {
					if (Array.isArray(value)) for (let i = 0; i < value.length; i++) { if (!Object.getOwnPropertyDescriptor(value, i)?.enumerable) throw runtimeError('SPARSE_ARRAY', ctx.pos); yield* step(ctx); }
					const prototype = Object.getPrototypeOf(value);
					if (!Array.isArray(value) && prototype !== null && prototype !== Object.prototype) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'object | any[]' }, 'DataCloneError');
					copy = Array.isArray(value) ? scriptObject([]) : dictionary(); memo.set(value, copy);
					const entries = yield* own(ctx, value);
					for (let i = entries.length - 1; i >= 0; i--) { const [childKey, child] = entries[i]!; tasks.push({ value: child, target: copy as object, name: childKey }); yield* step(ctx); }
				}
			}
		}
		Object.defineProperty(target, name, { value: copy, writable: true, enumerable, configurable: true });
	}
	return root['']!;
}
function* deepEqual(ctx: StdContext, a: Value, b: Value): StdFrame {
	const pairs: [Value, Value][] = [[a, b]];
	const seen = new Map<object, Set<object>>();
	while (pairs.length) {
		const [left, right] = pairs.pop()!; yield* step(ctx);
		if (Object.is(left, right)) continue;
		if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || callable(left) || callable(right) || Array.isArray(left) !== Array.isArray(right)) return false;
		const leftError = ctx.properties.errorValue(left, ctx.pos), rightError = ctx.properties.errorValue(right, ctx.pos);
		if (leftError !== rightError) return false;
		const leftPrototype = Object.getPrototypeOf(left), rightPrototype = Object.getPrototypeOf(right);
		// 通常の辞書は内容で比べ、ホストのインスタンスは原型が異なれば別の種類とする。
		if ((leftPrototype !== null && leftPrototype !== Object.prototype || rightPrototype !== null && rightPrototype !== Object.prototype) && leftPrototype !== rightPrototype) return false;
		if (Array.isArray(left) && left.length !== (right as Value[]).length) return false;
		let rights = seen.get(left); if (rights?.has(right)) continue;
		if (!rights) seen.set(left, rights = new Set()); rights.add(right);
		if (leftError) {
			pairs.push([ctx.properties.get(left, 'name', ctx.pos), ctx.properties.get(right, 'name', ctx.pos)]);
			pairs.push([ctx.properties.get(left, 'message', ctx.pos), ctx.properties.get(right, 'message', ctx.pos)]);
		}
		const xs = yield* own(ctx, left), ys = yield* own(ctx, right);
		if (xs.length !== ys.length) return false;
		const other = new Map(ys);
		for (const [name, value] of xs) { if (!other.has(name)) return false; pairs.push([value, other.get(name)!]); yield* step(ctx); }
	}
	return true;
}

export const objectDefinitions: StdDefinition[] = [
	...['keys', 'values', 'entries'].map(name => def('Object.' + name, [arg('value', 'any')], name === 'keys' ? 'string[]' : 'any[]', '自身の列挙可能なプロパティを返す。', 'Return own enumerable properties.', function* (ctx, _receiver, args) {
		if (args[0] === null) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'object' }, 'TypeError');
		for (const _ of ctx.properties.prepare(args[0], ctx.pos, true)) yield ctx.checkpoint();
		const result: Value[] = [];
		for (const [nameOfKey, value] of yield* own(ctx, args[0]!)) { result.push(name === 'keys' ? nameOfKey : name === 'values' ? value : scriptObject([nameOfKey, value])); yield* step(ctx); }
		return scriptObject(result);
	})),
	def('Object.fromEntries', [arg('entries', 'any')], 'any', 'キーと値の組から原型のない辞書を作る。', 'Create a prototype-free dictionary from entries.', function* (ctx, _receiver, args) {
		const result = dictionary();
		for (const entry of yield* iterable(ctx, args[0]!)) {
			if (entry === null || typeof entry !== 'object') throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'object' }, 'TypeError');
			const name = key(ctx, ctx.properties.get(entry, 0, ctx.pos));
			const value = Array.isArray(entry) && entry.length < 2 ? null : ctx.properties.get(entry, 1, ctx.pos);
			result[name] = value; yield* step(ctx);
		}
		return result;
	}),
	def('Object.groupBy', [arg('items', 'any'), arg('callback', 'Function')], 'any', '関数の返す数・文字列・真偽値のキーで要素をまとめる。', 'Group items by numeric, string, or boolean callback keys.', function* (ctx, _receiver, args) {
		const callback = requireCallback(ctx, args[1]), result = dictionary();
		let index = 0;
		for (const _ of ctx.properties.prepare(args[0], ctx.pos, true)) yield ctx.checkpoint();
		for (const value of ctx.properties.iterableIterator(args[0]!, ctx.pos)) {
			const resultKey = yield ctx.call(callback, [value, index++]);
			const name = key(ctx, typeof resultKey === 'boolean' ? String(resultKey) : resultKey);
			const group = result[name] as Value[] | undefined;
			if (group) group.push(value); else result[name] = scriptObject([value]); yield* step(ctx);
		}
		return result;
	}),
	def('JSON.parse', [arg('text', 'string'), arg('reviver', 'Function', true)], 'any', 'JSON を原型のない値へ読み込む。', 'Parse JSON into prototype-free values.', function* (ctx, _receiver, args) { return yield* parseJson(ctx, requireString(ctx, args[0]), args[1]); }),
	def('JSON.stringify', [arg('value', 'any'), arg('replacer', 'Function | any[] | null', true), arg('space', 'number | string', true)], 'string | null', '値を JSON の文字列に変換する。', 'Serialize a value to JSON.', function* (ctx, _receiver, args) { return yield* stringify(ctx, args[0]!, args[1], args[2]); }),
	def('structuredClone', [arg('value', 'any'), arg('options', 'any', true)], 'any', '循環と共有参照を保って値を複製する。', 'Clone values preserving cycles and shared references.', function* (ctx, _receiver, args) {
		if (args[1] !== undefined && args[1] !== null) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'null' }, 'TypeError');
		return yield* clone(ctx, args[0]!);
	}),
	def('deepEqual', [arg('left', 'any'), arg('right', 'any')], 'boolean', '循環を扱い値の内容を比較する。', 'Compare value contents including cycles.', function* (ctx, _receiver, args) { return yield* deepEqual(ctx, args[0]!, args[1]!); }),
];
