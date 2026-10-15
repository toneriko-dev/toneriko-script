import type { Pos, Loc } from './ast.js';
import { messages, type DiagnosticCode } from './messages.js';

export type { DiagnosticCode } from './messages.js';

export type Diagnostic = {
	code: DiagnosticCode;
	params: Record<string, string | number>;
	pos: Pos;
	loc?: Loc;
	hint: string;
	severity: 'error' | 'warning';
};

function interpolate(text: string, params: Diagnostic['params']): string {
	return text.replace(/\{(\w+)\}/g, (placeholder, key: string) => String(params[key] ?? placeholder));
}

export function formatDiagnostic(diagnostic: Diagnostic, language: 'ja' | 'en'): string {
	const translation = messages[diagnostic.code][language];
	const position = language === 'ja' ? `(${diagnostic.pos.line} 行目、${diagnostic.pos.column} 列目)` : `(line ${diagnostic.pos.line}, column ${diagnostic.pos.column})`;
	return `${interpolate(translation.message, diagnostic.params)} ${position} ${interpolate(translation.hint, diagnostic.params)}`;
}

export function diagnostic(code: DiagnosticCode, pos: Pos, params: Diagnostic['params'] = {}, options: { severity?: Diagnostic['severity']; loc?: Loc } = {}): Diagnostic {
	return { code, params, pos, hint: interpolate(messages[code].ja.hint, params), severity: options.severity ?? 'error', ...(options.loc ? { loc: options.loc } : {}) };
}

export class TonerikoScriptSyntaxError extends SyntaxError implements Diagnostic {
	readonly code: DiagnosticCode;
	readonly params: Diagnostic['params'];
	readonly pos: Pos;
	readonly hint: string;
	readonly severity = 'error' as const;

	constructor(code: DiagnosticCode, pos: Pos, params: Diagnostic['params'] = {}) {
		const value = diagnostic(code, pos, params);
		super(formatDiagnostic(value, 'ja'));
		this.name = 'TonerikoScriptSyntaxError';
		this.code = code;
		this.params = params;
		this.pos = pos;
		this.hint = value.hint;
	}
}

export function syntaxError(code: DiagnosticCode, pos: Pos, params: Diagnostic['params'] = {}): TonerikoScriptSyntaxError {
	return new TonerikoScriptSyntaxError(code, pos, params);
}
