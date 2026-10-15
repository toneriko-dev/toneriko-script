//#region src/v2/type-projection.d.ts
export type ProjectionOperation = {
  kind: 'array';
  rest: boolean;
} | {
  kind: 'property';
  key: string;
} | {
  kind: 'objectRest';
  excluded: ReadonlySet<string>;
};
export type ProjectionAdapter<T> = {
  kind(type: T): string;
  element(type: T): T;
  keyword(name: 'any' | 'number', source: T): T;
  array(element: T, source: T): T;
  property(type: T, key: string): T | undefined;
  objectRest(type: T, excluded: ReadonlySet<string>): T | undefined;
};
/** 構文型と実行時型で、分割できない枝を同じ規則で除く。 */
export declare function projectBranch<T>(type: T, operation: ProjectionOperation, adapter: ProjectionAdapter<T>): T | undefined;
export declare function combineProjections<T>(parts: readonly (T | undefined)[], adapter: ProjectionAdapter<T>, union: (types: T[]) => T, operation?: ProjectionOperation): T | undefined;
//#endregion
//# sourceMappingURL=type-projection.d.ts.map