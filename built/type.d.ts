import { TypeParam, TypeSource, node_d_exports } from "./node.js";
//#region src/type.d.ts
export type TSimple<N extends string = string> = {
  type: 'simple';
  name: N;
};
export declare function T_SIMPLE<T extends string>(name: T): TSimple<T>;
export type TGeneric<N extends string = string> = {
  type: 'generic';
  name: N;
  inners: Type[];
};
export declare function T_GENERIC<N extends string>(name: N, inners: Type[]): TGeneric<N>;
export type TFn = {
  type: 'fn';
  params: Type[];
  result: Type;
};
export declare function T_FN(params: Type[], result: Type): TFn;
export type TParam = {
  type: 'param';
  name: string;
};
export declare function T_PARAM(name: string): TParam;
export type TUnion = {
  type: 'union';
  inners: Type[];
};
export declare function T_UNION(inners: Type[]): TUnion;
export type Type = TSimple | TGeneric | TFn | TParam | TUnion;
export declare function getTypeNameBySource(typeSource: TypeSource): string;
export declare function getTypeBySource(typeSource: TypeSource, typeParams?: readonly TypeParam[]): Type;
//#endregion
//# sourceMappingURL=type.d.ts.map