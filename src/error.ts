import type { Pos } from './node.js';

export abstract class AiScriptError extends Error {
	// name is read by Error.prototype.toString
	public override name = 'AiScript';
	public info: unknown;
	public pos?: Pos;

	constructor(message: string, info?: unknown) {
		super(message);

		this.info = info;

		// Maintains proper stack trace for where our error was thrown (only available on V8)
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, AiScriptError);
		}
	}
}

/**
 * Wrapper for non-AiScript errors.
 */
export class NonAiScriptError extends AiScriptError {
	public override name = 'Internal';
	constructor(error: unknown) {
		const message = String(
			(error as { message?: unknown } | null | undefined)?.message ?? error,
		);
		super(message, error);
	}
}

/**
 * Parse-time errors.
 */
export class AiScriptSyntaxError extends AiScriptError {
	public override name = 'Syntax';
	constructor(message: string, public override pos: Pos, info?: unknown) {
		super(`${message} (Line ${pos.line}, Column ${pos.column})`, info);
	}
}

/**
 * Unexpected EOF errors.
 */
export class AiScriptUnexpectedEOFError extends AiScriptSyntaxError {
	constructor(pos: Pos, info?: unknown) {
		super('unexpected EOF', pos, info);
	}
}

/**
 * Namespace collection errors.
 */
export class AiScriptNamespaceError extends AiScriptError {
	public override name = 'Namespace';
	constructor(message: string, public override pos: Pos, info?: unknown) {
		super(`${message} (Line ${pos.line}, Column ${pos.column})`, info);
	}
}

/**
 * Interpret-time errors.
 */
export class AiScriptRuntimeError extends AiScriptError {
	public override name = 'Runtime';
}
/**
 * RuntimeError for illegal access to arrays.
 */
export class AiScriptIndexOutOfRangeError extends AiScriptRuntimeError {
}
/**
 * Errors thrown by users.
 */
export class AiScriptUserError extends AiScriptRuntimeError {
	public override name = '';
}
/**
 * Host side configuration errors.
 */
export class AiScriptHostsideError extends AiScriptError {
	public override name = 'Host';
}
