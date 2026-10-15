import { Pos } from "../ast.js";
import { DiagnosticCode } from "../messages.js";
//#region src/v2/runtime/errors.d.ts
export declare class RuntimeError extends Error {
  readonly code: DiagnosticCode;
  readonly pos: Pos;
  readonly params: Record<string, string | number>;
  readonly severity: 'error';
  readonly hint: string;
  constructor(code: DiagnosticCode, pos: Pos, params?: Record<string, string | number>, name?: string);
}
export declare function runtimeError(code: DiagnosticCode, pos: Pos, params?: Record<string, string | number>, name?: string): RuntimeError;
export declare class ExecutionStopped extends RuntimeError {}
export declare function scriptErrorDiagnostic(value: unknown): RuntimeError | undefined;
export declare function isScriptErrorValue(value: unknown): value is object;
export declare function scriptErrorName(value: object): string;
/** 原型の代わりに種類だけを保持し、message の省略と own property の列挙規則を保つ。 */
export declare function createScriptError(name?: string, message?: string, diagnostic?: RuntimeError): object;
//#endregion
//# sourceMappingURL=errors.d.ts.map