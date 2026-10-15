import type * as AST from '../ast.js';
import { runtimeError } from './errors.js';

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

type GraphemeInfo = { length: number; parts: readonly string[] | null };

/** プロパティ操作は原型を参照せず、書記素のキャッシュを実行単位で共有する。 */
export class PropertyAccess {
	private readonly strings = new Map<string, GraphemeInfo>();
	private arrays = new WeakSet<object>();
	private readonly segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

	constructor(private readonly onStep: () => void = () => {}) {}

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
		for (let i = 0; i < value.length; i++) {
			this.onStep();
			const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
			if (!descriptor) throw runtimeError('SPARSE_ARRAY', pos);
			if (!('value' in descriptor)) throw runtimeError('ACCESSOR_PROPERTY', pos, {}, 'TypeError');
			if ((i + 1) % 64 === 0) yield;
		}
		this.arrays.add(value);
	}

	key(value: unknown, pos: AST.Pos): string {
		if (typeof value !== 'string' && typeof value !== 'number') throw runtimeError('INVALID_PROPERTY_KEY', pos, {}, 'TypeError');
		const key = String(value);
		if (key === '__proto__') throw runtimeError('FORBIDDEN_PROPERTY', pos, { key });
		return key;
	}

	private stringInfo(value: string): GraphemeInfo {
		const cached = this.strings.get(value);
		if (cached) return cached;
		for (const _pause of this.prepareString(value)) { /* 同期 API は中断地点まで含めて処理する。 */ }
		return this.strings.get(value)!;
	}

	/** 64 要素以下の区間で制御を返し、評価器が時間の上限と譲る時刻を確認できるようにする。 */
	*prepare(value: unknown, pos: AST.Pos): Generator<void, void> {
		if (typeof value === 'string') yield* this.prepareString(value);
		else if (Array.isArray(value)) yield* this.prepareArray(value, pos);
	}

	private *prepareString(value: string): Generator<void, void> {
		const cached = this.strings.get(value);
		if (cached) return;
		let ascii = true;
		for (let i = 0; i < value.length; i++) {
			this.onStep();
			if (value.charCodeAt(i) > 127 || (value.charCodeAt(i) === 13 && value.charCodeAt(i + 1) === 10)) {
				ascii = false;
				break;
			}
			if ((i + 1) % 64 === 0) yield;
		}
		let info: GraphemeInfo;
		if (ascii) {
			info = { length: value.length, parts: null };
		} else {
			const parts: string[] = [];
			for (const part of this.segmenter.segment(value)) {
				this.onStep();
				parts.push(part.segment);
				if (parts.length % 64 === 0) yield;
			}
			info = { length: parts.length, parts };
		}
		this.strings.set(value, info);
	}

	graphemes(value: string): readonly string[] {
		const info = this.stringInfo(value);
		return info.parts ?? value.split('');
	}

	get(value: unknown, property: unknown, pos: AST.Pos): Value {
		const key = this.key(property, pos);
		if (value === null || value === undefined) throw runtimeError('NULL_PROPERTY_ACCESS', pos, { key }, 'TypeError');
		if (typeof value === 'string') {
			const info = this.stringInfo(value);
			if (key === 'length') return info.length;
			const index = indexOf(key);
			if (index !== null) return (info.parts ? info.parts[index] : value[index]) ?? null;
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
		if (isScriptFunction(value) || isBuiltinMethod(value)) {
			checkFunctionProperty(key, pos);
			return null;
		}
		const descriptor = Object.getOwnPropertyDescriptor(Object(value), key);
		if (!descriptor) return null;
		if (!('value' in descriptor)) throw runtimeError('ACCESSOR_PROPERTY', pos, { key }, 'TypeError');
		return this.normalize(descriptor.value, pos);
	}

	set(value: unknown, property: unknown, next: unknown, pos: AST.Pos): Value {
		const key = this.key(property, pos);
		if (value === null || value === undefined) throw runtimeError('NULL_PROPERTY_ACCESS', pos, { key }, 'TypeError');
		if ((typeof value !== 'object' && typeof value !== 'function') || isScriptFunction(value) || isBuiltinMethod(value)) {
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
		if (isScriptFunction(value) || isBuiltinMethod(value)) {
			checkFunctionProperty(key, pos);
			return false;
		}
		return Object.hasOwn(value, key);
	}

	delete(value: unknown, property: unknown, pos: AST.Pos): boolean {
		const key = this.key(property, pos);
		if (value === null || value === undefined) throw runtimeError('NULL_PROPERTY_ACCESS', pos, { key }, 'TypeError');
		if (isScriptFunction(value) || isBuiltinMethod(value)) {
			checkFunctionProperty(key, pos);
			return true;
		}
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
				yield [String(i), (info.parts ? info.parts[i] : value[i])!];
			}
			return;
		}
		if (isScriptFunction(value) || isBuiltinMethod(value)) return;
		if (Array.isArray(value)) this.checkArray(value, pos);
		for (const key of Object.keys(Object(value))) {
			this.onStep();
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
				yield (info.parts ? info.parts[i] : value[i])!;
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
			return (info.parts ? info.parts[index] : receiver[index]) ?? null;
		}
		throw runtimeError('INVALID_RECEIVER', pos, {}, 'TypeError');
	}
}
