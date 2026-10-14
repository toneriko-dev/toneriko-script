import { Pos } from "./node.js";
declare namespace error_d_exports {
  export { NonTonerikoScriptError, TonerikoScriptError, TonerikoScriptHostsideError, TonerikoScriptIndexOutOfRangeError, TonerikoScriptNamespaceError, TonerikoScriptRuntimeError, TonerikoScriptSyntaxError, TonerikoScriptUnexpectedEOFError, TonerikoScriptUserError };
}
export declare abstract class TonerikoScriptError extends Error {
  name: string;
  info: unknown;
  pos?: Pos;
  constructor(message: string, info?: unknown);
}
export declare class NonTonerikoScriptError extends TonerikoScriptError {
  name: string;
  constructor(error: unknown);
}
export declare class TonerikoScriptSyntaxError extends TonerikoScriptError {
  pos: Pos;
  name: string;
  constructor(message: string, pos: Pos, info?: unknown);
}
export declare class TonerikoScriptUnexpectedEOFError extends TonerikoScriptSyntaxError {
  constructor(pos: Pos, info?: unknown);
}
export declare class TonerikoScriptNamespaceError extends TonerikoScriptError {
  pos: Pos;
  name: string;
  constructor(message: string, pos: Pos, info?: unknown);
}
export declare class TonerikoScriptRuntimeError extends TonerikoScriptError {
  name: string;
}
export declare class TonerikoScriptIndexOutOfRangeError extends TonerikoScriptRuntimeError {}
export declare class TonerikoScriptUserError extends TonerikoScriptRuntimeError {
  name: string;
}
export declare class TonerikoScriptHostsideError extends TonerikoScriptError {
  name: string;
}
//#endregion
export { error_d_exports };
//# sourceMappingURL=error.d.ts.map