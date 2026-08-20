import type { Pos } from './node.js';

export abstract class AiScriptError extends Error {
	// Error.prototype.toString が参照するため、name を上書きする。
	public override name = 'AiScript';
	public info: unknown;
	public pos?: Pos;

	constructor(message: string, info?: unknown) {
		super(message);

		this.info = info;

		// V8 のみ対応するため、利用可能な場合に発生箇所のスタックを保持する。
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, AiScriptError);
		}
	}
}

export class NonAiScriptError extends AiScriptError {
	public override name = 'Internal';
	constructor(error: unknown) {
		const message = String(
			(error as { message?: unknown } | null | undefined)?.message ?? error,
		);
		super(message, error);
	}
}

export class AiScriptSyntaxError extends AiScriptError {
	public override name = 'Syntax';
	constructor(message: string, public override pos: Pos, info?: unknown) {
		super(`${message} (Line ${pos.line}, Column ${pos.column})`, info);
	}
}

export class AiScriptUnexpectedEOFError extends AiScriptSyntaxError {
	constructor(pos: Pos, info?: unknown) {
		super('unexpected EOF', pos, info);
	}
}

export class AiScriptNamespaceError extends AiScriptError {
	public override name = 'Namespace';
	constructor(message: string, public override pos: Pos, info?: unknown) {
		super(`${message} (Line ${pos.line}, Column ${pos.column})`, info);
	}
}

export class AiScriptRuntimeError extends AiScriptError {
	public override name = 'Runtime';
}
export class AiScriptIndexOutOfRangeError extends AiScriptRuntimeError {
}
export class AiScriptUserError extends AiScriptRuntimeError {
	public override name = '';
}
export class AiScriptHostsideError extends AiScriptError {
	public override name = 'Host';
}
