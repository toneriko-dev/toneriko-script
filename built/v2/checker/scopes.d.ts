import { Expression, Identifier, Literal, MemberExpression, ObjectPattern, Pattern, Statement, TypeAnnotation, ast_d_exports } from "../ast.js";
//#region src/v2/checker/scopes.d.ts
export type Binding = {
  mutable: boolean;
  annotation?: TypeAnnotation;
  global?: boolean;
};
export declare class Scope {
  readonly parent?: Scope | undefined;
  readonly bindings: Map<string, Binding>;
  constructor(parent?: Scope | undefined);
  resolve(name: string): Binding | undefined;
  names(): string[];
}
export declare function propertyName(node: Identifier | Literal | Expression): string | undefined;
export declare function project(annotation: TypeAnnotation | undefined, key: string, array?: boolean, rest?: boolean): TypeAnnotation | undefined;
export declare function objectRest(annotation: TypeAnnotation | undefined, pattern: ObjectPattern): TypeAnnotation | undefined;
export declare function bindPattern(scope: Scope, pattern: Pattern | MemberExpression, mutable: boolean, inherited?: TypeAnnotation): void;
export declare function declare(scope: Scope, statements: readonly Statement[]): void;
//#endregion
//# sourceMappingURL=scopes.d.ts.map