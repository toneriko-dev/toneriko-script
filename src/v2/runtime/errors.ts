import type { Pos } from '../ast.js';
import { messages, type DiagnosticCode } from '../messages.js';

export class RuntimeError extends Error {
	readonly severity = 'error' as const;
	readonly hint: string;
	constructor(readonly code: DiagnosticCode, readonly pos: Pos, readonly params: Record<string, string | number> = {}, name = 'TonerikoScriptRuntimeError') {
		const text = messages[code].ja;
		const replace = (s: string) => s.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? key));
		super(replace(text.message));
		this.name = name;
		this.hint = replace(text.hint);
	}
}

export function runtimeError(code: DiagnosticCode, pos: Pos, params: Record<string, string | number> = {}, name?: string): RuntimeError {
	return new RuntimeError(code, pos, params, name);
}

// 停止はスクリプトの例外と区別し、catch と finally の評価に渡しません。
export class ExecutionStopped extends RuntimeError {}
