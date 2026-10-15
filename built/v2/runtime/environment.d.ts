import { MemberExpression, Pattern, Pos, ast_d_exports } from "../ast.js";
import { Value } from "./brands.js";
//#region src/v2/runtime/environment.d.ts
export type Binding = {
  initialized: boolean;
  mutable: boolean;
  value: Value;
};
export declare class Environment {
  readonly parent: Environment | null;
  readonly bindings: Map<string, Binding>;
  constructor(parent?: Environment | null);
  declare(name: string, mutable: boolean): void;
  resolve(name: string): Binding | undefined;
  read(name: string, pos: Pos): Value;
  write(name: string, value: Value, pos: Pos, initialize?: boolean): void;
  iteration(): Environment;
}
export declare function boundNames(pattern: Pattern | MemberExpression): string[];
//#endregion
//# sourceMappingURL=environment.d.ts.map