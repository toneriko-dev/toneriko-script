import { Value } from "./value.js";
//#region src/interpreter/variable.d.ts
export type Variable = {
  isMutable: false;
  readonly value: Value;
} | {
  isMutable: true;
  value: Value;
};
export declare const Variable: {
  const(value: Value): Variable;
};
//#endregion
//# sourceMappingURL=variable.d.ts.map