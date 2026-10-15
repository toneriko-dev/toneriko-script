import { Loc, Pos } from "./ast.js";
import { DiagnosticCode } from "./messages.js";
//#region src/v2/diagnostics.d.ts
export type Diagnostic = {
  code: DiagnosticCode;
  params: Record<string, string | number>;
  pos: Pos;
  loc?: Loc;
  hint: string;
  severity: 'error' | 'warning';
};
export declare function formatDiagnostic(diagnostic: Diagnostic, language: 'ja' | 'en'): string;
export declare function diagnostic(code: DiagnosticCode, pos: Pos, params?: Diagnostic['params'], options?: {
  severity?: Diagnostic['severity'];
  loc?: Loc;
}): Diagnostic;
export declare class TonerikoScriptSyntaxError extends SyntaxError implements Diagnostic {
  readonly code: DiagnosticCode;
  readonly params: Diagnostic['params'];
  readonly pos: Pos;
  readonly hint: string;
  readonly severity: 'error';
  constructor(code: DiagnosticCode, pos: Pos, params?: Diagnostic['params']);
}
export declare function syntaxError(code: DiagnosticCode, pos: Pos, params?: Diagnostic['params']): TonerikoScriptSyntaxError;
//#endregion
export type { DiagnosticCode };
//# sourceMappingURL=diagnostics.d.ts.map