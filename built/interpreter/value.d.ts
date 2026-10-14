import { Expression, Node, TypeParam } from "../node.js";
import { Type } from "../type.js";
import { Scope } from "./scope.js";
declare namespace value_d_exports {
  export { ARR, Attr, BOOL, ERROR, FALSE, FN, FN_NATIVE, NULL, NUM, OBJ, STR, TRUE, VArr, VBool, VError, VFn, VFnParam, VNativeFn, VNull, VNum, VObj, VStr, VUserFn, Value };
}
export type VNull = {
  type: 'null';
};
export type VBool = {
  type: 'bool';
  value: boolean;
};
export type VNum = {
  type: 'num';
  value: number;
};
export type VStr = {
  type: 'str';
  value: string;
};
export type VArr = {
  type: 'arr';
  value: Value[];
};
export type VObj = {
  type: 'obj';
  value: Map<string, Value>;
};
export type VFn = VUserFn | VNativeFn;
type VFnBase = {
  type: 'fn';
};
export type VUserFn = VFnBase & {
  native?: undefined;
  name?: string;
  params: VFnParam[];
  typeParams: readonly TypeParam[];
  statements: Node[];
  scope: Scope;
};
export type VFnParam = {
  dest: Expression;
  type?: Type;
  default?: Value;
};
export type VNativeFn = VFnBase & {
  native: (args: (Value | undefined)[], opts: {
    call: (fn: VFn, args: Value[]) => Promise<Value>;
    topCall: (fn: VFn, args: Value[]) => Promise<Value>;
    registerAbortHandler: (handler: () => void) => void;
    registerPauseHandler: (handler: () => void) => void;
    registerUnpauseHandler: (handler: () => void) => void;
    unregisterAbortHandler: (handler: () => void) => void;
    unregisterPauseHandler: (handler: () => void) => void;
    unregisterUnpauseHandler: (handler: () => void) => void;
  }) => Value | Promise<Value> | void;
  nativeSync?: (args: (Value | undefined)[], opts: {
    call: (fn: VFn, args: Value[]) => Value;
    topCall: (fn: VFn, args: Value[]) => Value;
    registerAbortHandler: (handler: () => void) => void;
    registerPauseHandler: (handler: () => void) => void;
    registerUnpauseHandler: (handler: () => void) => void;
    unregisterAbortHandler: (handler: () => void) => void;
    unregisterPauseHandler: (handler: () => void) => void;
    unregisterUnpauseHandler: (handler: () => void) => void;
  }) => Value | void;
};
export type VError = {
  type: 'error';
  value: string;
  info?: Value;
};
export type Attr = {
  attr?: {
    name: string;
    value: Value;
  }[];
};
export type Value = (VNull | VBool | VNum | VStr | VArr | VObj | VFn | VError) & Attr;
export declare const NULL: {
  type: 'null';
};
export declare const TRUE: {
  type: 'bool';
  value: boolean;
};
export declare const FALSE: {
  type: 'bool';
  value: boolean;
};
export declare const NUM: (num: VNum['value']) => VNum;
export declare const STR: (str: VStr['value']) => VStr;
export declare const BOOL: (bool: VBool['value']) => VBool;
export declare const OBJ: (obj: VObj['value']) => VObj;
export declare const ARR: (arr: VArr['value']) => VArr;
export declare const FN: (params: VUserFn['params'], statements: VUserFn['statements'], scope: VUserFn['scope'], typeParams?: VUserFn['typeParams']) => VUserFn;
export declare const FN_NATIVE: (fn: VNativeFn['native'], fnSync?: VNativeFn['nativeSync']) => VNativeFn;
export declare const ERROR: (name: string, info?: Value) => VError;
//#endregion
export { value_d_exports };
//# sourceMappingURL=value.d.ts.map