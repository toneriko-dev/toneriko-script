import { Value } from "./value.js";
import { Reference } from "./reference.js";
//#region src/interpreter/control.d.ts
export type CReturn = {
  type: 'return';
  value: Value;
};
export type CBreak = {
  type: 'break';
  label?: string;
  value?: Value;
};
export type CContinue = {
  type: 'continue';
  label?: string;
  value: null;
};
export type Control = CReturn | CBreak | CContinue;
export declare const RETURN: (v: CReturn['value']) => CReturn;
export declare const BREAK: (label?: string, value?: CBreak['value']) => CBreak;
export declare const CONTINUE: (label?: string) => CContinue;
export declare function unWrapLabeledBreak(v: Value | Control, label: string | undefined): Value | Control;
export declare function unWrapRet(v: Value | Control): Value;
export declare function assertValue(v: Value | Control): asserts v is Value;
export declare function isControl(v: Value | Control | Reference): v is Control;
//#endregion
//# sourceMappingURL=control.d.ts.map