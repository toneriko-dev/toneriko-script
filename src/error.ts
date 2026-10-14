import type { Pos } from './node.js';

export abstract class TonerikoScriptError extends Error {
	// Error.prototype.toString が参照するため、name を上書きする。
	public override name = 'TonerikoScript';
	public info: unknown;
	public pos?: Pos;

	constructor(message: string, info?: unknown) {
		super(message);

		this.info = info;

		// V8 のみ対応するため、利用可能な場合に発生箇所のスタックを保持する。
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, TonerikoScriptError);
		}
	}
}

export class NonTonerikoScriptError extends TonerikoScriptError {
	public override name = 'Internal';
	constructor(error: unknown) {
		const message = String(
			(error as { message?: unknown } | null | undefined)?.message ?? error,
		);
		super(message, error);
	}
}

export class TonerikoScriptSyntaxError extends TonerikoScriptError {
	public override name = 'Syntax';
	constructor(message: string, public override pos: Pos, info?: unknown) {
		super(`${message} (Line ${pos.line}, Column ${pos.column})`, info);
	}
}

export class TonerikoScriptUnexpectedEOFError extends TonerikoScriptSyntaxError {
	constructor(pos: Pos, info?: unknown) {
		super('unexpected EOF', pos, info);
	}
}

export class TonerikoScriptNamespaceError extends TonerikoScriptError {
	public override name = 'Namespace';
	constructor(message: string, public override pos: Pos, info?: unknown) {
		super(`${message} (Line ${pos.line}, Column ${pos.column})`, info);
	}
}

export class TonerikoScriptRuntimeError extends TonerikoScriptError {
	public override name = 'Runtime';
}
export class TonerikoScriptIndexOutOfRangeError extends TonerikoScriptRuntimeError {
}
export class TonerikoScriptUserError extends TonerikoScriptRuntimeError {
	public override name = '';
}
export class TonerikoScriptHostsideError extends TonerikoScriptError {
	public override name = 'Host';
}
