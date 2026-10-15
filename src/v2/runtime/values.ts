import type * as AST from '../ast.js';
import { RuntimeError, runtimeError } from './errors.js';
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

function checkFunctionProperty(key: string, pos: AST.Pos): void {
	if (key === 'name' || key === 'length' || key === 'prototype') throw runtimeError('UNSUPPORTED_VALUE', pos, { key }, 'TypeError');
}

function opaqueFunction(value: unknown): boolean {
	return typeof value === 'function' || isScriptFunction(value) || isBuiltinMethod(value);
}

export const errorValue = (Error as ErrorConstructor & { isError(value: unknown): value is Error }).isError;

function publicErrorKey(value: Error, key: string): boolean {
	return key === 'name' || key === 'message' || key === 'cause' || (value instanceof RuntimeError && (key === 'code' || key === 'pos'));
}

/** エラーの標準名と文だけは標準の原型にあるデータも扱い、getter は実行しない。 */
function errorDescriptor(value: Error, key: string): PropertyDescriptor | undefined {
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
	private arrays = new WeakSet<object>();

	constructor(private readonly onStep: () => void = () => {}) { this.strings = new GraphemeCache(onStep); }

	clear(): void { this.strings.clear(); }

	/** ホストから制御が戻るときは、共有配列の密度を次の観測時に調べ直す。 */
	invalidateHostArrays(): void { this.arrays = new WeakSet<object>(); }

	normalize(value: unknown, pos: AST.Pos): Value {
		if (value === undefined) return null;
		if (typeof value === 'symbol' || typeof value === 'bigint') throw runtimeError('UNSUPPORTED_VALUE', pos, {}, 'TypeError');
		if (Array.isArray(value)) this.checkArray(value, pos);
		return value as Value;
	}

	private checkArray(value: unknown[], pos: AST.Pos): void {
		if (this.arrays.has(value)) return;
		for (const _pause of this.prepareArray(value, pos)) { /* 同期 API は中断地点まで含めて処理する。 */ }
	}

	private *prepareArray(value: unknown[], pos: AST.Pos): Generator<void, void> {
		if (this.arrays.has(value)) return;
		let indices = 0;
		for (const key of Reflect.ownKeys(value)) {
			if (key === 'length') continue;
			this.onStep();
			if (typeof key !== 'string' || indexOf(key) === null) throw runtimeError('INVALID_ARRAY_PROPERTY', pos, { key: String(key) });
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor) throw runtimeError('SPARSE_ARRAY', pos);
			if (!('value' in descriptor)) throw runtimeError('ACCESSOR_PROPERTY', pos, {}, 'TypeError');
			if (++indices % 64 === 0) yield;
		}
		if (indices !== value.length) throw runtimeError('SPARSE_ARRAY', pos);
		this.arrays.add(value);
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
		} else if (Array.isArray(value)) yield* this.prepareArray(value, pos);
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
			return methods.string[key] ?? null;
		}
		if (Array.isArray(value)) {
			this.checkArray(value, pos);
			const index = indexOf(key);
			if (index === null && (typeof property === 'number' || String(Number(key)) === key)) throw runtimeError('ARRAY_INDEX_OUT_OF_RANGE', pos, {}, 'RangeError');
			if (index !== null && index >= value.length) throw runtimeError('ARRAY_INDEX_OUT_OF_RANGE', pos, { index }, 'RangeError');
			if (index !== null && !Object.hasOwn(value, key)) throw runtimeError('SPARSE_ARRAY', pos);
			if (key !== 'length' && index === null) return methods.array[key] ?? null;
		}
		if (opaqueFunction(value)) {
			checkFunctionProperty(key, pos);
			return null;
		}
		const error = errorValue(value);
		if (error && !publicErrorKey(value, key)) return null;
		const descriptor = error ? errorDescriptor(value, key) : Object.getOwnPropertyDescriptor(Object(value), key);
		if (!descriptor) return null;
		if (!('value' in descriptor)) throw runtimeError('ACCESSOR_PROPERTY', pos, { key }, 'TypeError');
		return this.normalize(descriptor.value, pos);
	}

	set(value: unknown, property: unknown, next: unknown, pos: AST.Pos): Value {
		const key = this.key(property, pos);
		if (value === null || value === undefined) throw runtimeError('NULL_PROPERTY_ACCESS', pos, { key }, 'TypeError');
		if (typeof value !== 'object' || opaqueFunction(value) || (errorValue(value) && !publicErrorKey(value, key))) {
			throw runtimeError('READONLY_PROPERTY', pos, { key }, 'TypeError');
		}
		const normalized = this.normalize(next, pos);
		if (Array.isArray(value)) {
			this.checkArray(value, pos);
			if (key === 'length') {
				if (typeof normalized !== 'number' || !Number.isInteger(normalized) || normalized < 0 || normalized > 0xffffffff) throw runtimeError('INVALID_ARRAY_LENGTH', pos, {}, 'RangeError');
				if (normalized > value.length) throw runtimeError('ARRAY_LENGTH_GROWTH', pos);
			} else {
				const index = indexOf(key);
				if (index === null) throw runtimeError('INVALID_ARRAY_PROPERTY', pos, { key });
				if (index > value.length) throw runtimeError('ARRAY_GAP', pos, { index });
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
		if (opaqueFunction(value)) {
			checkFunctionProperty(key, pos);
			return false;
		}
		if (Array.isArray(value)) this.checkArray(value, pos);
		if (errorValue(value)) return publicErrorKey(value, key) && errorDescriptor(value, key) !== undefined;
		return Object.hasOwn(value, key);
	}

	delete(value: unknown, property: unknown, pos: AST.Pos): boolean {
		const key = this.key(property, pos);
		if (value === null || value === undefined) throw runtimeError('NULL_PROPERTY_ACCESS', pos, { key }, 'TypeError');
		if (opaqueFunction(value)) {
			checkFunctionProperty(key, pos);
			return true;
		}
		if (errorValue(value) && !publicErrorKey(value, key)) return true;
		if (Array.isArray(value)) this.checkArray(value, pos);
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
		if (opaqueFunction(value)) return;
		if (Array.isArray(value)) this.checkArray(value, pos);
		const error = errorValue(value);
		for (const key of Object.keys(Object(value))) {
			this.onStep();
			if (error && !publicErrorKey(value, key)) continue;
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
		this.checkArray(value, pos);
		for (let i = 0; i < value.length; i++) {
			this.onStep();
			yield this.get(value, i, pos);
		}
	}

	callMethod(method: BuiltinMethod, receiver: unknown, args: Value[], pos: AST.Pos): Value {
		if (method === arrayPush) {
			if (!Array.isArray(receiver)) throw runtimeError('INVALID_RECEIVER', pos, {}, 'TypeError');
			this.checkArray(receiver, pos);
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
