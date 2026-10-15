import type { Pos } from '../ast.js';
import { diagnosticTranslation, type DiagnosticCode } from '../messages.js';

export class RuntimeError extends Error {
	readonly severity = 'error' as const;
	readonly hint: string;
	constructor(readonly code: DiagnosticCode, readonly pos: Pos, readonly params: Record<string, string | number> = {}, name = 'TonerikoScriptRuntimeError') {
		const text = diagnosticTranslation(code, 'ja', params);
		const replace = (s: string) => s.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? key));
		super(replace(text.message) + (code === 'TYPE_ANNOTATION_MISMATCH' ? ` (${pos.line} 行目、${pos.column} 列目)` : ''));
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

type ScriptErrorKind = { name: string; diagnostic?: RuntimeError };
const scriptErrorKinds = new WeakMap<object, ScriptErrorKind>();
export function scriptErrorDiagnostic(value: unknown): RuntimeError | undefined {
	return value !== null && typeof value === 'object' ? scriptErrorKinds.get(value)?.diagnostic : undefined;
}
export function isScriptErrorValue(value: unknown): value is object {
	return value !== null && typeof value === 'object' && scriptErrorKinds.has(value);
}
export function scriptErrorName(value: object): string { return scriptErrorKinds.get(value)!.name; }

/** 原型の代わりに種類だけを保持し、message の省略と own property の列挙規則を保つ。 */
export function createScriptError(name = 'Error', message?: string, diagnostic?: RuntimeError): object {
	const result = Object.create(null) as object;
	scriptErrorKinds.set(result, { name, diagnostic });
	const define = (key: string, value: unknown) => Object.defineProperty(result, key, { value, writable: true, configurable: true, enumerable: false });
	if (message !== undefined) define('message', message);
	if (diagnostic) {
		define('code', diagnostic.code);
		define('pos', { line: diagnostic.pos.line, column: diagnostic.pos.column });
	}
	return result;
}
