import { ArrowFunctionExpression, FunctionDeclaration, MemberExpression, Pattern, Program, ast_d_exports } from "../ast.js";
import { TypeCheck } from "./type-checks.js";
//#region src/v2/runtime/type-plan.d.ts
export type PatternCheck = {
  check: TypeCheck;
  explicit: boolean;
  transient?: boolean;
};
export declare function projectType(check: TypeCheck, key: string | null, rest?: boolean): TypeCheck;
export declare function restType(check: TypeCheck, excluded: ReadonlySet<string>): TypeCheck;
export declare class TypePlan {
  readonly patterns: WeakMap<Pattern | MemberExpression, PatternCheck>;
  readonly returns: WeakMap<ArrowFunctionExpression | FunctionDeclaration, TypeCheck>;
  readonly compositeNames: Set<string>;
  private readonly programs;
  private readonly projections;
  hasTypes: boolean;
  /** 構文木は変更せず、明示注釈から得た型だけを束縛へ対応付ける。 */
  prepare(program: Program): boolean;
  project(pattern: Pattern | MemberExpression, source: TypeCheck, key: string | ReadonlySet<string>): WeakMap<Pattern | MemberExpression, PatternCheck>;
  projectDynamic(pattern: Pattern | MemberExpression, source: TypeCheck, key: string, tick: () => void): Generator<void, WeakMap<Pattern | MemberExpression, PatternCheck>>;
  private names;
  private pattern;
}
//#endregion
//# sourceMappingURL=type-plan.d.ts.map