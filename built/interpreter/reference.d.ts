import { VArr, VObj, Value } from "./value.js";
import { Scope } from "./scope.js";
//#region src/interpreter/reference.d.ts
export interface Reference {
  type: 'reference';
  get(): Value;
  set(value: Value): void;
}
export declare function assertArrayIndex(index: number, length: number): void;
export declare const Reference: {
  variable(name: string, scope: Scope): Reference;
  index(target: VArr, index: number): Reference;
  prop(target: VObj, name: string): Reference;
  arr(dest: readonly Reference[]): Reference;
  obj(dest: ReadonlyMap<string, Reference>): Reference;
};
//#endregion
//# sourceMappingURL=reference.d.ts.map