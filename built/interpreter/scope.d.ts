import { TypeParam } from "../node.js";
import { Value } from "./value.js";
import { Variable } from "./variable.js";
import { LogObject } from "./index.js";
//#region src/interpreter/scope.d.ts
export declare class Scope {
  private typeParams;
  private parent?;
  private states;
  name: string;
  opts: {
    log?(type: string, params: LogObject): void;
    onUpdated?(name: string, value: Value): void;
  };
  nsName?: string;
  constructor(states?: Map<string, Variable>, parent?: Scope, name?: Scope['name'], nsName?: string, typeParams?: readonly TypeParam[]);
  private log;
  private onUpdated;
  createChildScope(states?: Map<string, Variable>, name?: Scope['name'], typeParams?: readonly TypeParam[]): Scope;
  createChildNamespaceScope(nsName: string, states?: Map<string, Variable>, name?: Scope['name']): Scope;
  getTypeParams(): TypeParam[];
  get(name: string): Value;
  getNsPrefix(): string;
  exists(name: string): boolean;
  getAll(): Map<string, Variable>;
  add(name: string, variable: Variable): void;
  assign(name: string, val: Value): void;
  update(name: string, updater: (current: Value) => Value): void;
  private getLayerdStates;
}
//#endregion
//# sourceMappingURL=scope.d.ts.map