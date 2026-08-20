import { AiScriptRuntimeError } from '../error.js';
import { STR, NUM, ARR, OBJ, NULL, BOOL } from './value.js';
import type { Value, VStr, VNum, VBool, VFn, VObj, VArr, VNull } from './value.js';

export function expectAny(val: Value | null | undefined): asserts val is Value {
	if (val == null) {
		throw new AiScriptRuntimeError('Expect anything, but got nothing.');
	}
}

export function isBoolean(val: Value): val is VBool {
	return val.type === 'bool';
}

export function isFunction(val: Value): val is VFn {
	return val.type === 'fn';
}

export function isString(val: Value): val is VStr {
	return val.type === 'str';
}

export function isNumber(val: Value): val is VNum {
	return val.type === 'num';
}

export function isObject(val: Value): val is VObj {
	return val.type === 'obj';
}

export function isArray(val: Value): val is VArr {
	return val.type === 'arr';
}

export function isNull(val: Value): val is VNull {
	return val.type === 'null';
}

export function assertBoolean(val: Value | null | undefined): asserts val is VBool {
	if (val == null) {
		throw new AiScriptRuntimeError('Expect boolean, but got nothing.');
	}
	if (!isBoolean(val)) {
		throw new AiScriptRuntimeError(`Expect boolean, but got ${val.type}.`);
	}
}

export function assertFunction(val: Value | null | undefined): asserts val is VFn {
	if (val == null) {
		throw new AiScriptRuntimeError('Expect function, but got nothing.');
	}
	if (!isFunction(val)) {
		throw new AiScriptRuntimeError(`Expect function, but got ${val.type}.`);
	}
}

export function assertString(val: Value | null | undefined): asserts val is VStr {
	if (val == null) {
		throw new AiScriptRuntimeError('Expect string, but got nothing.');
	}
	if (!isString(val)) {
		throw new AiScriptRuntimeError(`Expect string, but got ${val.type}.`);
	}
}

export function assertNumber(val: Value | null | undefined): asserts val is VNum {
	if (val == null) {
		throw new AiScriptRuntimeError('Expect number, but got nothing.');
	}
	if (!isNumber(val)) {
		throw new AiScriptRuntimeError(`Expect number, but got ${val.type}.`);
	}
}

export function assertObject(val: Value | null | undefined): asserts val is VObj {
	if (val == null) {
		throw new AiScriptRuntimeError('Expect object, but got nothing.');
	}
	if (!isObject(val)) {
		throw new AiScriptRuntimeError(`Expect object, but got ${val.type}.`);
	}
}

export function assertArray(val: Value | null | undefined): asserts val is VArr {
	if (val == null) {
		throw new AiScriptRuntimeError('Expect array, but got nothing.');
	}
	if (!isArray(val)) {
		throw new AiScriptRuntimeError(`Expect array, but got ${val.type}.`);
	}
}

export function assertNull(val: Value | null | undefined): asserts val is VNull {
	if (val == null) {
		throw new AiScriptRuntimeError('Expect null, but got nothing.');
	}
	if (!isNull(val)) {
		throw new AiScriptRuntimeError(`Expect null, but got ${val.type}.`);
	}
}

export function eq(a: Value, b: Value): boolean {
	if (a.type === 'fn' && b.type === 'fn') return a.native && b.native ? a.native === b.native : a === b;
	if (a.type === 'fn' || b.type === 'fn') return false;
	if (a.type === 'null' && b.type === 'null') return true;
	if (a.type === 'null' || b.type === 'null') return false;
	return (a.value === b.value);
}

export function valToString(val: Value, simple = false, processingObjects = new Set<object>()): string {
	if (simple) {
		if (val.type === 'num') return val.value.toString();
		if (val.type === 'bool') return val.value ? 'true' : 'false';
		if (val.type === 'str') return JSON.stringify(val.value);
		if (val.type === 'arr') {
			if (processingObjects.has(val.value)) return '...';
			processingObjects.add(val.value);
			const items = Array.from({ length: val.value.length }, (_, index) => {
				const item = val.value[index];
				return valToString(item ?? NULL, true, processingObjects);
			});
			const result = `[${items.join(', ')}]`;
			processingObjects.delete(val.value);
			return result;
		}
		if (val.type === 'null') return '(null)';
	}
	switch (val.type) {
		case 'num': return `num<${val.value}>`;
		case 'bool': return `bool<${val.value}>`;
		case 'str': return `str<${JSON.stringify(val.value)}>`;
		case 'fn': return 'fn<...>';
		case 'arr': return 'arr<...>';
		case 'obj': return 'obj<...>';
		case 'error': return `error<${val.value}>`;
		case 'null': return 'null<>';
	}
}

export type JsValue = { [key: string]: JsValue } | JsValue[] | string | number | boolean | null | undefined;

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function stringifyObjectKey(key: string): string {
	return identifierPattern.test(key) ? key : JSON.stringify(key);
}

function defineJsProperty(target: { [key: string]: JsValue }, key: string, value: JsValue): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function valToJsInternal(val: Value, converted: Map<object, JsValue>): JsValue {
	switch (val.type) {
		case 'fn': return '<function>';
		case 'arr': {
			const existing = converted.get(val.value);
			if (existing !== undefined) return existing;
			const result: JsValue[] = [];
			converted.set(val.value, result);
			result.length = val.value.length;
			for (let index = 0; index < val.value.length; index++) {
				const item = val.value[index];
				result[index] = item === undefined ? null : valToJsInternal(item, converted);
			}
			return result;
		}
		case 'bool': return val.value;
		case 'null': return null;
		case 'num': return val.value;
		case 'obj': {
			const existing = converted.get(val.value);
			if (existing !== undefined) return existing;
			const result: { [key: string]: JsValue } = {};
			converted.set(val.value, result);
			for (const [key, value] of val.value) {
				defineJsProperty(result, key, valToJsInternal(value, converted));
			}
			return result;
		}
		case 'error': {
			const existing = converted.get(val);
			if (existing !== undefined) return existing;
			const result: { [key: string]: JsValue } = {};
			converted.set(val, result);
			defineJsProperty(result, 'name', val.value);
			defineJsProperty(result, 'info', val.info == null ? null : valToJsInternal(val.info, converted));
			return result;
		}
		case 'str': return val.value;
	}
}

export function valToJs(val: Value): JsValue {
	return valToJsInternal(val, new Map());
}

function jsToValInternal(val: unknown, converted: WeakMap<object, Value>): Value {
	if (val === null) return NULL;
	if (typeof val === 'boolean') return BOOL(val);
	if (typeof val === 'string') return STR(val);
	if (typeof val === 'number') return NUM(val);
	if (Array.isArray(val)) {
		const existing = converted.get(val);
		if (existing !== undefined) return existing;
		const result = ARR([]);
		converted.set(val, result);
		result.value.length = val.length;
		for (let index = 0; index < val.length; index++) {
			result.value[index] = jsToValInternal(val[index], converted);
		}
		return result;
	}
	if (typeof val === 'object') {
		const existing = converted.get(val);
		if (existing !== undefined) return existing;
		const result = OBJ(new Map());
		converted.set(val, result);
		for (const [k, v] of Object.entries(val)) {
			result.value.set(k, jsToValInternal(v, converted));
		}
		return result;
	}
	return NULL;
}

export function jsToVal(val: unknown): Value {
	return jsToValInternal(val, new WeakMap());
}

export function getLangVersion(input: string): string | null {
	const match = /^\s*\/\/\/\s*@\s*([A-Z0-9_.-]+)(?:[\r\n][\s\S]*)?$/i.exec(input);
	return (match != null) ? match[1]! : null;
}

export function reprValue(value: Value, literalLike = false, processingObjects = new Set<object>()): string {
	if ((value.type === 'arr' || value.type === 'obj') && processingObjects.has(value.value)) {
		return '...';
	}

	if (literalLike && value.type === 'str') return JSON.stringify(value.value);
	if (value.type === 'str') return value.value;
	if (value.type === 'num') return value.value.toString();
	if (value.type === 'arr') {
		processingObjects.add(value.value);
		const content = [];

		for (let index = 0; index < value.value.length; index++) {
			content.push(reprValue(value.value[index] ?? NULL, true, processingObjects));
		}

		processingObjects.delete(value.value);
		return '[ ' + content.join(', ') + ' ]';
	}
	if (value.type === 'obj') {
		processingObjects.add(value.value);
		const content = [];

		for (const [key, val] of value.value) {
			content.push(`${stringifyObjectKey(key)}: ${reprValue(val, true, processingObjects)}`);
		}

		processingObjects.delete(value.value);
		return '{ ' + content.join(', ') + ' }';
	}
	if (value.type === 'bool') return value.value.toString();
	if (value.type === 'null') return 'null';
	if (value.type === 'error') return `error<${value.value}>`;
	if (value.type === 'fn') {
		if (value.native) {
			return '@( ?? ) { native code }';
		} else {
			return `@( ${(value.params.map(v => v.dest.type === 'identifier' ? v.dest.name : '?')).join(', ')} ) { ... }`;
		}
	}

	value satisfies never;
	throw new TypeError('Unrecognized AiScript value type.');
}
