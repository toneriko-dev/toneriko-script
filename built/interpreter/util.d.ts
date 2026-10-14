import { VArr, VBool, VFn, VNull, VNum, VObj, VStr, Value } from "./value.js";
declare namespace util_d_exports {
  export { JsValue, assertArray, assertBoolean, assertFunction, assertNull, assertNumber, assertObject, assertString, eq, expectAny, getLangVersion, isArray, isBoolean, isFunction, isNull, isNumber, isObject, isString, jsToVal, reprValue, stringifyObjectKey, valToJs, valToString };
}
export declare function expectAny(val: Value | null | undefined): asserts val is Value;
export declare function isBoolean(val: Value): val is VBool;
export declare function isFunction(val: Value): val is VFn;
export declare function isString(val: Value): val is VStr;
export declare function isNumber(val: Value): val is VNum;
export declare function isObject(val: Value): val is VObj;
export declare function isArray(val: Value): val is VArr;
export declare function isNull(val: Value): val is VNull;
export declare function assertBoolean(val: Value | null | undefined): asserts val is VBool;
export declare function assertFunction(val: Value | null | undefined): asserts val is VFn;
export declare function assertString(val: Value | null | undefined): asserts val is VStr;
export declare function assertNumber(val: Value | null | undefined): asserts val is VNum;
export declare function assertObject(val: Value | null | undefined): asserts val is VObj;
export declare function assertArray(val: Value | null | undefined): asserts val is VArr;
export declare function assertNull(val: Value | null | undefined): asserts val is VNull;
export declare function eq(a: Value, b: Value): boolean;
export declare function valToString(val: Value, simple?: boolean, processingObjects?: Set<object>): string;
export type JsValue = {
  [key: string]: JsValue;
} | JsValue[] | string | number | boolean | null | undefined;
export declare function stringifyObjectKey(key: string): string;
export declare function valToJs(val: Value): JsValue;
export declare function jsToVal(val: unknown): Value;
export declare function getLangVersion(input: string): string | null;
export declare function reprValue(value: Value, literalLike?: boolean, processingObjects?: Set<object>): string;
//#endregion
export { util_d_exports };
//# sourceMappingURL=util.d.ts.map