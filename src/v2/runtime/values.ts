import { isArrayIterator, nextArrayIterator } from '../stdlib/arrays.js';
import { standardMethod } from '../stdlib/index.js';
import { isStdFunction } from '../stdlib/core.js';
import type * as AST from '../ast.js';
import { runtimeError, isScriptErrorValue, scriptErrorName } from './errors.js';
import { GraphemeCache } from './strings.js';

import { isScriptFunction, scriptObjects, type Value } from './brands.js';
export { SCRIPT_FUNCTION, isScriptFunction, valueTypeof, scriptObject } from './brands.js';
export type { Value, ScriptFunction } from './brands.js';

function indexOf(key: string): number | null {
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key ? index : null;
}

function opaqueFunction(value: unknown): boolean {
	return typeof value === 'function' || isScriptFunction(value) || isStdFunction(value);
}

const domExceptionPrototype = typeof DOMException === 'undefined' ? undefined : DOMException.prototype;
const domExceptionName = domExceptionPrototype && Object.getOwnPropertyDescriptor(domExceptionPrototype, 'name')?.get;
// 固定名は配列で照合し、ホストのハッシュ表に由来する長い同期処理を避けます。
const hiddenErrorKeys = ['stack', 'sourceURL', 'line', 'column', 'originalLine', 'originalColumn', 'fileName', 'lineNumber', 'columnNumber'];

const errorConstructorNames = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError', 'DOMException']);
const errorPrototypes = new Set<object>([
	Error.prototype, TypeError.prototype, RangeError.prototype, ReferenceError.prototype,
	SyntaxError.prototype, EvalError.prototype, URIError.prototype, AggregateError.prototype,
]);
export function errorValue(value: unknown, pos: AST.Pos = { line: 1, column: 1 }): value is object {
	return classifyError(value, pos, 'detached');
}

/** 隠すキーでは、原型を外された DOMException のブランドも確かめます。 */
function propertyError(value: unknown, key: string, pos: AST.Pos): value is object {
	return classifyError(value, pos, hiddenErrorKeys.includes(key) ? 'all' : false);
}

/** 原型は毎回確かめ、利用者の toStringTag の getter は呼びません。 */
// ホスト値は JSON で表せる値・クラスのインスタンス・この realm の Error/DOMException・Promise を前提にします。
// 別 realm・Proxy・原型変更・エラー偽装はホストの責任で避け、前提外の値の判定結果は保証しません。
function classifyError(value: unknown, pos: AST.Pos, domProbe: false | 'detached' | 'all'): value is object {
	if (typeof value !== 'object' || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype === null && scriptObjects.has(value)) return false;
	if (isScriptErrorValue(value)) return true;
	let tag = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag);
	let object: object | null = prototype;
	let local = false;
	while (object) {
		if (errorPrototypes.has(object) || object === domExceptionPrototype) return true;
		tag ??= Object.getOwnPropertyDescriptor(object, Symbol.toStringTag);
		if (object === Object.prototype) { local = true; break; }
		object = Object.getPrototypeOf(object);
	}
	const brand = tag ? undefined : Object.prototype.toString.call(value);
	if (brand === '[object Error]' || brand === '[object DOMException]') return true;
	// 原型を外すとタグを失う DOMException は、境界と非公開キーでブランドを確かめます。
	// 普通のプロパティ操作では現在の原型を使い、例外を投げる検査を省きます。
	if (domExceptionName && (domProbe === 'all' || (prototype === null && (domProbe === 'detached' || tag)))) {
		try { Reflect.apply(domExceptionName, value, []); return true; } catch { /* ブランドを持たない値です。 */ }
	}
	// この realm の普通のクラスでは、例外を投げるブランド検査も関数の文字列化も不要です。
	// 別 realm の古い Error 子クラスは内部ブランドを持たないため、組み込みの原型も確認します。
	if (!local && prototype !== null) {
		object = prototype;
		while (object) {
			const constructor = Object.getOwnPropertyDescriptor(object, 'constructor');
			if (constructor && 'value' in constructor && typeof constructor.value === 'function') {
				const name = Object.getOwnPropertyDescriptor(constructor.value, 'name')?.value;
				if (!errorConstructorNames.has(name)) { object = Object.getPrototypeOf(object); continue; }
				const source = Function.prototype.toString.call(constructor.value);
				if (/^function\s+(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError|AggregateError|DOMException)\s*\(\s*\)\s*\{\s*\[native code\]\s*\}$/.test(source)) return true;
			}
			object = Object.getPrototypeOf(object);
		}
	}
	if (tag) {
		if ('value' in tag && (tag.value === 'Error' || tag.value === 'DOMException')) return true;
		// 原型とタグの両方を隠されたエラーらしい値も、内部情報を辞書として公開しません。
		if (Object.hasOwn(value, 'stack') || Object.hasOwn(value, 'message')) throw runtimeError('UNSUPPORTED_VALUE', pos, {}, 'TypeError');
		return false;
	}

	return false;
}

function hiddenErrorKey(value: object, key: string): boolean {
	return isScriptErrorValue(value) ? key === 'stack' : hiddenErrorKeys.includes(key);
}

function registeredMethod(type: 'array' | 'string' | 'number', key: string, pos: AST.Pos): Value {
	const method = standardMethod(type, key);
	if (method) return method;
	if (Object.hasOwn(type === 'array' ? Array.prototype : type === 'string' ? String.prototype : Number.prototype, key)) throw runtimeError('METHOD_NOT_AVAILABLE', pos, { key });
	return null;
}

/** getter の許可は値のタグではなく、この realm の組み込み原型の同一性で決める。 */
function inheritedErrorDescriptor(value: object, key: string): { owner: object; descriptor: PropertyDescriptor } | undefined {
	let owner: object | null = Object.getPrototypeOf(value);
	while (owner) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor) {
			if (key === 'name' || key === 'message' || (key === 'code' && owner === domExceptionPrototype)) return { owner, descriptor };
			return undefined;
		}
		owner = Object.getPrototypeOf(owner);
	}
	return undefined;
}

/** プロパティ操作は原型を参照せず、書記素のキャッシュを実行単位で共有する。 */
export class PropertyAccess {
	private readonly strings: GraphemeCache;

	errorValue(value: unknown, pos: AST.Pos): boolean { return errorValue(value, pos); }

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
		if (typeof value === 'number') return registeredMethod('number', key, pos);
		if (isStdFunction(value)) {
			const own = Object.getOwnPropertyDescriptor(value, key);
			if (own && 'value' in own) return this.normalize(own.value, pos);
			throw runtimeError('UNSUPPORTED_VALUE', pos, { key }, 'TypeError');
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
		const error = propertyError(value, key, pos);
		if (error && hiddenErrorKey(value, key)) return null;
		const own = Object.getOwnPropertyDescriptor(Object(value), key);
		if (own) {
			if ('value' in own) return this.normalize(own.value, pos);
			throw runtimeError('ACCESSOR_PROPERTY', pos, { key }, 'TypeError');
		}
		if (error) {
			if (isScriptErrorValue(value) && (key === 'name' || key === 'message')) return key === 'name' ? scriptErrorName(value) : '';
			const inherited = inheritedErrorDescriptor(value, key);
			if (inherited) {
				const { owner, descriptor } = inherited;
				if ('value' in descriptor) return this.normalize(descriptor.value, pos);
				if (owner !== domExceptionPrototype) throw runtimeError('ACCESSOR_PROPERTY', pos, { key }, 'TypeError');
				return this.normalize(descriptor.get?.call(value), pos);
			}
		}
		return null;
	}

	set(value: unknown, property: unknown, next: unknown, pos: AST.Pos): Value {
		const key = this.key(property, pos);
		if (value === null || value === undefined) throw runtimeError('NULL_PROPERTY_ACCESS', pos, { key }, 'TypeError');
		if (opaqueFunction(value)) throw runtimeError('UNSUPPORTED_VALUE', pos, { key }, 'TypeError');
		if (typeof value !== 'object' || (propertyError(value, key, pos) && hiddenErrorKey(value, key))) {
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
		// 既存の書き込み可能な要素は属性も length も変えず、数値添字で更新できます。
		// 文字列キーでの属性定義に伴う、ホスト内部の長い同期処理を避けます。
		const arrayIndex = Array.isArray(value) ? indexOf(key) : null;
		if (arrayIndex !== null && descriptor) {
			(value as Value[])[arrayIndex] = normalized;
			return normalized;
		}
		if (!descriptor) {
			let prototype = Object.getPrototypeOf(value);
			while (prototype) {
				const inherited = Object.getOwnPropertyDescriptor(prototype, key);
				if (inherited) {
					if (!('value' in inherited)) throw runtimeError('ACCESSOR_PROPERTY', pos, { key }, 'TypeError');
					if (!inherited.writable) throw runtimeError('READONLY_PROPERTY', pos, { key }, 'TypeError');
					break;
				}
				prototype = Object.getPrototypeOf(prototype);
			}
		}
		const result = Reflect.defineProperty(value, key, descriptor ? { value: normalized } : { value: normalized, writable: true, enumerable: true, configurable: true });
		if (!result) throw runtimeError('READONLY_PROPERTY', pos, { key }, 'TypeError');
		return normalized;
	}

	has(value: unknown, property: unknown, pos: AST.Pos): boolean {
		const key = this.key(property, pos);
		if (value === null || (typeof value !== 'object' && typeof value !== 'function')) throw runtimeError('INVALID_RECEIVER', pos, {}, 'TypeError');
		if (opaqueFunction(value)) throw runtimeError('UNSUPPORTED_VALUE', pos, { key }, 'TypeError');
		if (Array.isArray(value) && !Object.hasOwn(value, key)) return registeredMethod('array', key, pos) !== null;
		if (propertyError(value, key, pos)) {
			if (hiddenErrorKey(value, key)) return false;
			if (isScriptErrorValue(value) && (key === 'name' || key === 'message')) return true;
			const own = Object.getOwnPropertyDescriptor(value, key);
			return own !== undefined || inheritedErrorDescriptor(value, key) !== undefined;
		}
		return Object.hasOwn(value, key);
	}

	delete(value: unknown, property: unknown, pos: AST.Pos): boolean {
		const key = this.key(property, pos);
		if (value === null || value === undefined) throw runtimeError('NULL_PROPERTY_ACCESS', pos, { key }, 'TypeError');
		if (opaqueFunction(value)) throw runtimeError('UNSUPPORTED_VALUE', pos, { key }, 'TypeError');
		if (propertyError(value, key, pos) && hiddenErrorKey(value, key)) return true;
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
		errorValue(value, pos);
		for (const key of Object.keys(Object(value))) {
			this.onStep();
			if (hiddenErrorKeys.includes(key) && propertyError(value, key, pos) && hiddenErrorKey(value, key)) continue;
			this.key(key, pos);
			yield [key, this.get(value, key, pos)];
		}
	}

	iterable(value: unknown, pos: AST.Pos): Value[] {
		return [...this.iterableIterator(value, pos)];
	}

	*iterableIterator(value: unknown, pos: AST.Pos): Generator<Value, void> {
		if (isArrayIterator(value)) {
			while (true) { this.onStep(); const item = nextArrayIterator(value, this, pos); if (item.done) return; yield item.value; }
		}
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

}
