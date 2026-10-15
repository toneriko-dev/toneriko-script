import { Pos, TypeAnnotation, ast_d_exports } from "../ast.js";
import { Value } from "./brands.js";
import { PropertyAccess } from "./values.js";
//#region src/v2/runtime/type-checks.d.ts
export type TypePropertyCheck = {
  key: string;
  optional: boolean;
  check: TypeCheck;
};
export type TypeCheck = {
  kind: 'number' | 'string' | 'boolean' | 'null' | 'any' | 'void' | 'function';
} | {
  kind: 'array';
  element: TypeCheck;
} | {
  kind: 'object';
  properties: TypePropertyCheck[];
  byKey: ReadonlyMap<string, TypePropertyCheck>;
} | {
  kind: 'union';
  types: TypeCheck[];
} | {
  kind: 'projection';
  source: TypeCheck;
  operation: {
    kind: 'key';
    key: string | null;
    rest: boolean;
  } | {
    kind: 'rest';
    excluded: ReadonlySet<string>;
  };
  resolved?: TypeCheck | null;
};
export declare function objectCheck(properties: TypePropertyCheck[]): TypeCheck;
export declare function compileType(annotation: TypeAnnotation): TypeCheck;
/** 動的キーで初めて必要になった射影の展開にも実行予算を使う。 */
export declare function prepareType(check: TypeCheck, tick: () => boolean): Generator<void, void>;
export declare function typeName(check: TypeCheck): string;
export declare function isComposite(check: TypeCheck): boolean;
export declare function matchesOuter(check: TypeCheck, value: Value): boolean;
export declare function checkScalar(check: TypeCheck, value: Value, name: string, pos: Pos): void;
/** コピー前に射影だけを展開し、同じコピーの走査内で要素を検査する。 */
export declare function copiedArrayType(check: TypeCheck): Extract<TypeCheck, {
  kind: 'array';
}> | undefined;
/** コピーの取得直後に外形を確かめ、途中で譲らず実際に束縛する値を守る。 */
export declare function checkCopiedElement(check: TypeCheck, value: Value, name: string, index: number, pos: Pos, diagnosticName: (name: string) => string, tick: () => void): void;
export declare function checkValue(check: TypeCheck, value: Value, name: string, properties: PropertyAccess, pos: Pos, tick: () => void, diagnosticName?: (name: string) => string): Generator<void, void>;
//#endregion
//# sourceMappingURL=type-checks.d.ts.map