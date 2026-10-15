import type { Pos } from '../ast.js';
import { messages, type DiagnosticCode } from '../messages.js';

export class RuntimeError extends Error {
	readonly severity = 'error' as const;
	readonly hint: string;
	constructor(readonly code: DiagnosticCode, readonly pos: Pos, readonly params: Record<string, string | number> = {}, name = 'TonerikoScriptRuntimeError') {
		const text = messages[code].ja;
		const replace = (s: string) => s.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? key));
		super(replace(text.message));
		this.pos = { line: pos.line, column: pos.column };
		this.name = name;
		this.hint = replace(text.hint);
	}
}

export function runtimeError(code: DiagnosticCode, pos: Pos, params: Record<string, string | number> = {}, name?: string): RuntimeError {
	return new RuntimeError(code, pos, params, name);
}

// 停止はスクリプトの例外と区別し、catch と finally の評価に渡しません。
export class ExecutionStopped extends RuntimeError {}

const scriptErrorValues = new WeakSet<Error>();
const scriptDiagnostics = new WeakMap<object, RuntimeError>();
export function scriptErrorDiagnostic(value: unknown): RuntimeError | undefined {
	return value !== null && typeof value === 'object' ? scriptDiagnostics.get(value) : undefined;
}
export function isScriptErrorValue(value: Error): boolean { return scriptErrorValues.has(value); }

/** スクリプトに渡す値は内部診断を共有せず、標準のエラーと同じ非列挙のプロパティを持つ。 */
export function copyScriptError(value: Error, read: (key: string) => unknown): Error {
	if (isScriptErrorValue(value)) return value;
	const result = new Error();
	Reflect.deleteProperty(result, 'stack');
	const define = (key: string, next: unknown) => Object.defineProperty(result, key, { value: next, writable: true, configurable: true, enumerable: false });
	const name = read('name');
	const message = read('message');
	define('name', name === undefined ? 'Error' : name);
	define('message', message === undefined ? '' : message);
	if (Object.hasOwn(value, 'cause')) define('cause', read('cause'));
	if (value instanceof RuntimeError) {
		scriptDiagnostics.set(result, value);
		define('code', value.code);
		define('pos', { line: value.pos.line, column: value.pos.column });
	}
	scriptErrorValues.add(result);
	return result;
}
