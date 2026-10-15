import type * as AST from '../ast.js';
import { runtimeError, isScriptErrorValue, scriptErrorName } from './errors.js';
import { GraphemeCache } from './strings.js';

export type Value = null | boolean | number | string | object;
export const SCRIPT_FUNCTION = Symbol('script function');
export interface ScriptFunction {
	[SCRIPT_FUNCTION]: true;
	name?: string;
	params: AST.Pattern[];
	body: AST.BlockStatement | AST.Expression;
	environment: unknown;
}
export const BUILTIN_METHOD = Symbol('builtin method');
export interface BuiltinMethod {
	[BUILTIN_METHOD]: true;
	receiverType: 'array' | 'string';
	name: string;
}
export function isScriptFunction(value: unknown): value is ScriptFunction {
	return typeof value === 'object' && value !== null && Object.getOwnPropertyDescriptor(value, SCRIPT_FUNCTION)?.value === true;
}
export function isBuiltinMethod(value: unknown): value is BuiltinMethod {
	return typeof value === 'object' && value !== null && Object.getOwnPropertyDescriptor(value, BUILTIN_METHOD)?.value === true;
}
export function valueTypeof(value: Value): string {
	return isScriptFunction(value) || isBuiltinMethod(value) ? 'function' : typeof value;
}

const arrayPush: BuiltinMethod = Object.freeze({ [BUILTIN_METHOD]: true as const, receiverType: 'array', name: 'push' });
const stringAt: BuiltinMethod = Object.freeze({ [BUILTIN_METHOD]: true as const, receiverType: 'string', name: 'at' });
const methods: Record<'array' | 'string', Readonly<Record<string, BuiltinMethod>>> = {
	array: Object.assign(Object.create(null), { push: arrayPush }),
	string: Object.assign(Object.create(null), { at: stringAt }),
};

function indexOf(key: string): number | null {
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key ? index : null;
}

function opaqueFunction(value: unknown): boolean {
	return typeof value === 'function' || isScriptFunction(value) || isBuiltinMethod(value);
}

const domExceptionName = typeof DOMException === 'undefined' ? undefined : Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get;

/** 別 realm のエラーも扱い、利用者が定義した toStringTag の getter は実行しない。 */
export function errorValue(value: unknown, pos: AST.Pos = { line: 1, column: 1 }): value is object {
	if (isScriptErrorValue(value)) return true;
	if (typeof value !== 'object' || value === null) return false;
	if (!(Symbol.toStringTag in value)) return Object.prototype.toString.call(value) === '[object Error]';
	if (value instanceof Error) return true;
	// DOMException の組み込み getter に内部の型を確かめさせ、利用者の getter は呼ばない。
	if (domExceptionName) {
		try { Reflect.apply(domExceptionName, value, []); return true; } catch { /* DOMException 以外は通常の判別を続ける。 */ }
	}
	let prototype: object | null = Object.getPrototypeOf(value);
	while (prototype) {
		const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
		if (constructor && 'value' in constructor && typeof constructor.value === 'function') {
			const source = Function.prototype.toString.call(constructor.value);
			if (/^function\s+(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError|AggregateError)\s*\(\s*\)\s*\{\s*\[native code\]\s*\}$/.test(source)) return true;
		}
		prototype = Object.getPrototypeOf(prototype);
	}
	// タグで標準の判別が隠されたエラーらしい値は、内部情報を辞書として公開しない。
	if (Object.hasOwn(value, 'stack') || Object.hasOwn(value, 'message')) throw runtimeError('UNSUPPORTED_VALUE', pos, {}, 'TypeError');
	return false;
}

/** getter の許可には、原型の一致だけでなく Error のタグか DOMException の内部型を使う。 */
function errorGetterAllowed(value: object): boolean {
	if (domExceptionName) {
		try { Reflect.apply(domExceptionName, value, []); return true; } catch { /* 通常の Error 判定を続ける。 */ }
	}
	let prototype: object | null = value;
	while (prototype) {
		const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag);
		if (tag) {
			if (!('value' in tag)) return false;
			break;
		}
		prototype = Object.getPrototypeOf(prototype);
	}
	return Object.prototype.toString.call(value) === '[object Error]';
}

function registeredMethod(type: 'array' | 'string', key: string, pos: AST.Pos): BuiltinMethod | null {
	const method = methods[type][key];
	if (method) return method;
	if (Object.hasOwn(type === 'array' ? Array.prototype : String.prototype, key)) throw runtimeError('METHOD_NOT_AVAILABLE', pos, { key });
	return null;
}

/** name と message だけはエラーの原型上の既定値も参照する。 */
function errorDescriptor(value: object, key: string): PropertyDescriptor | undefined {
	let object: object | null = value;
	while (object) {
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		if (descriptor) return descriptor;
		if (key !== 'name' && key !== 'message') return undefined;
		object = Object.getPrototypeOf(object);
	}
	return undefined;
}

/** プロパティ操作は原型を参照せず、書記素のキャッシュを実行単位で共有する。 */
export class PropertyAccess {
	private readonly strings: GraphemeCache;

	constructor(private readonly onStep: () => void = () => {}) { this.strings = new GraphemeCache(onStep); }

	clear(): void { this.strings.clear(); }

	normalize(value: unknown, pos: AST.Pos): Value {
		if (value === undefined) return null;
		if (typeof value === 'symbol' || typeof value === 'bigint') throw runtimeError('UNSUPPORTED_VALUE', pos, {}, 'TypeError');
		errorValue(value, pos);
		return value as Value;
	}

	key(value: unknown, pos: AST.Pos): string {
		if (typeof value !== 'string' && typeof value !== 'number') throw runtimeError('INVALID_PROPERTY_KEY', pos, {}, 'TypeError');
		const key = String(value);
		if (key === '__proto__') throw runtimeError('FORBIDDEN_PROPERTY', pos, { key });
		return key;
	}

	private stringInfo(value: string) { return this.strings.info(value); }

	/** 64 要素以下の区間で制御を返し、評価器が時間の上限と譲る時刻を確認できるようにする。 */
	*prepare(value: unknown, pos: AST.Pos, parts = false): Generator<void, void> {
		if (typeof value === 'string') {
			if (parts) yield* this.strings.prepareParts(value);
			else yield* this.strings.prepare(value);
		}
	}

	concat(left: string, right: string): string { return this.strings.concat(left, right); }
	graphemes(value: string): readonly string[] { return this.strings.graphemes(value); }

	get(value: unknown, property: unknown, pos: AST.Pos): Value {
		const key = this.key(property, pos);
		if (value === null || value === undefined) throw runtimeError('NULL_PROPERTY_ACCESS', pos, { key }, 'TypeError');
		if (typeof value === 'string') {
			const info = this.stringInfo(value);
			if (key === 'length') return info.length;
			const index = indexOf(key);
			if (index !== null) return this.strings.at(value, index) ?? null;
			return registeredMethod('string', key, pos);
		}
		if (Array.isArray(value)) {
			const index = indexOf(key);
			const own = Object.hasOwn(value, key);
			if (!own && index === null && (typeof property === 'number' || String(Number(key)) === key)) throw runtimeError('ARRAY_INDEX_OUT_OF_RANGE', pos, {}, 'RangeError');
			if (index !== null && index >= value.length) throw runtimeError('ARRAY_INDEX_OUT_OF_RANGE', pos, { index }, 'RangeError');
			if (index !== null && !own) throw runtimeError('SPARSE_ARRAY', pos);
			if (!own && key !== 'length' && index === null) return registeredMethod('array', key, pos);
		}
		if (opaqueFunction(value)) throw runtimeError('UNSUPPORTED_VALUE', pos, { key }, 'TypeError');
		const error = errorValue(value, pos);
		if (error && key === 'stack') return null;
		const own = Object.getOwnPropertyDescriptor(Object(value), key);
		if (own && 'value' in own) return this.normalize(own.value, pos);
		if (error && (key === 'name' || key === 'message')) {
			if (isScriptErrorValue(value) && !own) return key === 'name' ? scriptErrorName(value) : '';
			const descriptor = own ?? errorDescriptor(value, key);
			if (descriptor && !('value' in descriptor) && !errorGetterAllowed(value)) throw runtimeError('ACCESSOR_PROPERTY', pos, { key }, 'TypeError');
			const result = descriptor && ('value' in descriptor ? descriptor.value : descriptor.get?.call(value));
			return typeof result === 'string' ? result : null;
		}
		if (own) throw runtimeError('ACCESSOR_PROPERTY', pos, { key }, 'TypeError');
		return null;
	}

	set(value: unknown, property: unknown, next: unknown, pos: AST.Pos): Value {
		const key = this.key(property, pos);
		if (value === null || value === undefined) throw runtimeError('NULL_PROPERTY_ACCESS', pos, { key }, 'TypeError');
		if (opaqueFunction(value)) throw runtimeError('UNSUPPORTED_VALUE', pos, { key }, 'TypeError');
		if (typeof value !== 'object' || (errorValue(value, pos) && key === 'stack')) {
			throw runtimeError('READONLY_PROPERTY', pos, { key }, 'TypeError');
		}
		const normalized = this.normalize(next, pos);
		if (Array.isArray(value)) {
			if (key === 'length') {
				if (typeof normalized !== 'number' || !Number.isInteger(normalized) || normalized < 0 || normalized > 0xffffffff) throw runtimeError('INVALID_ARRAY_LENGTH', pos, {}, 'RangeError');
				if (normalized > value.length) throw runtimeError('ARRAY_LENGTH_GROWTH', pos);
			} else {
				const index = indexOf(key);
				if (index !== null && index > value.length) throw runtimeError('ARRAY_GAP', pos, { index });
			}
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && !('value' in descriptor)) throw runtimeError('ACCESSOR_PROPERTY', pos, { key }, 'TypeError');
		if (descriptor?.writable === false) throw runtimeError('READONLY_PROPERTY', pos, { key }, 'TypeError');
		const result = Reflect.defineProperty(value, key, descriptor ? { value: normalized } : { value: normalized, writable: true, enumerable: true, configurable: true });
		if (!result) throw runtimeError('READONLY_PROPERTY', pos, { key }, 'TypeError');
		return normalized;
	}

	has(value: unknown, property: unknown, pos: AST.Pos): boolean {
		const key = this.key(property, pos);
		if (value === null || (typeof value !== 'object' && typeof value !== 'function')) throw runtimeError('INVALID_RECEIVER', pos, {}, 'TypeError');
		if (opaqueFunction(value)) throw runtimeError('UNSUPPORTED_VALUE', pos, { key }, 'TypeError');
		if (Array.isArray(value) && !Object.hasOwn(value, key)) return registeredMethod('array', key, pos) !== null;
		if (errorValue(value, pos)) {
			if (key === 'stack') return false;
			if (isScriptErrorValue(value) && (key === 'name' || key === 'message')) return true;
			return errorDescriptor(value, key) !== undefined;
		}
		return Object.hasOwn(value, key);
	}

	delete(value: unknown, property: unknown, pos: AST.Pos): boolean {
		const key = this.key(property, pos);
		if (value === null || value === undefined) throw runtimeError('NULL_PROPERTY_ACCESS', pos, { key }, 'TypeError');
		if (opaqueFunction(value)) throw runtimeError('UNSUPPORTED_VALUE', pos, { key }, 'TypeError');
		if (errorValue(value, pos) && key === 'stack') return true;
		if (Array.isArray(value) && (indexOf(key) !== null || key === 'length')) throw runtimeError('ARRAY_DELETE', pos);
		if (typeof value === 'string' && (indexOf(key) !== null || key === 'length')) throw runtimeError('READONLY_PROPERTY', pos, { key }, 'TypeError');
		if (!Reflect.deleteProperty(Object(value), key)) throw runtimeError('READONLY_PROPERTY', pos, { key }, 'TypeError');
		return true;
	}

	entries(value: unknown, pos: AST.Pos): [string, Value][] {
		return [...this.entriesIterator(value, pos)];
	}

	*entriesIterator(value: unknown, pos: AST.Pos): Generator<[string, Value], void> {
		if (value === null || value === undefined) return;
		if (typeof value === 'string') {
			const info = this.stringInfo(value);
			for (let i = 0; i < info.length; i++) {
				this.onStep();
				yield [String(i), this.strings.at(value, i)!];
			}
			return;
		}
		if (opaqueFunction(value)) throw runtimeError('UNSUPPORTED_VALUE', pos, {}, 'TypeError');
		const error = errorValue(value, pos);
		for (const key of Object.keys(Object(value))) {
			this.onStep();
			if (error && key === 'stack') continue;
			this.key(key, pos);
			yield [key, this.get(value, key, pos)];
		}
	}

	iterable(value: unknown, pos: AST.Pos): Value[] {
		return [...this.iterableIterator(value, pos)];
	}

	*iterableIterator(value: unknown, pos: AST.Pos): Generator<Value, void> {
		if (typeof value === 'string') {
			const info = this.stringInfo(value);
			for (let i = 0; i < info.length; i++) {
				this.onStep();
				yield this.strings.at(value, i)!;
			}
			return;
		}
		if (!Array.isArray(value)) throw runtimeError('NOT_ITERABLE', pos, {}, 'TypeError');
		for (let i = 0; i < value.length; i++) {
			this.onStep();
			yield this.get(value, i, pos);
		}
	}

	callMethod(method: BuiltinMethod, receiver: unknown, args: Value[], pos: AST.Pos): Value {
		if (method === arrayPush) {
			if (!Array.isArray(receiver)) throw runtimeError('INVALID_RECEIVER', pos, {}, 'TypeError');
			for (const value of args) {
				this.onStep();
				this.set(receiver, receiver.length, value, pos);
			}
			return receiver.length;
		}
		if (method === stringAt) {
			if (typeof receiver !== 'string') throw runtimeError('INVALID_RECEIVER', pos, {}, 'TypeError');
			const input = args[0] ?? 0;
			if (typeof input !== 'number') throw runtimeError('INVALID_PROPERTY_KEY', pos, {}, 'TypeError');
			const info = this.stringInfo(receiver);
			const integer = Number.isNaN(input) ? 0 : Math.trunc(input);
			const index = integer < 0 ? info.length + integer : integer;
			return this.strings.at(receiver, index) ?? null;
		}
		throw runtimeError('INVALID_RECEIVER', pos, {}, 'TypeError');
	}
}
