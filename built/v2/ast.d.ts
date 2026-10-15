declare namespace ast_d_exports {
  export { ArrayExpression, ArrayPattern, ArrayTypeAnnotation, ArrowFunctionExpression, AssignmentExpression, AssignmentPattern, AwaitExpression, BinaryExpression, BlockStatement, BreakStatement, CallExpression, CatchClause, ChainExpression, ConditionalExpression, ContinueStatement, DoWhileStatement, EmptyStatement, ExportMetaDeclaration, Expression, ExpressionStatement, ForOfStatement, ForStatement, FunctionDeclaration, FunctionTypeAnnotation, Identifier, IfStatement, KeywordTypeAnnotation, LabeledStatement, Literal, Loc, LogicalExpression, MemberExpression, NewExpression, Node, NodeBase, ObjectExpression, ObjectPattern, ObjectTypeAnnotation, ParenthesizedTypeAnnotation, Pattern, Pos, Program, Property, RestElement, ReturnStatement, SpreadElement, Statement, SwitchCase, SwitchStatement, TemplateElement, TemplateLiteral, ThrowStatement, TryStatement, TypeAnnotation, TypeProperty, UnaryExpression, UnionTypeAnnotation, UpdateExpression, VariableDeclaration, VariableDeclarator, WhileStatement };
}
export type Pos = {
  line: number;
  column: number;
};
export type Loc = {
  start: Pos;
  end: Pos;
};
export type NodeBase = {
  loc: Loc;
};
type BindingAnnotation = {
  typeAnnotation?: TypeAnnotation;
  optional?: boolean;
};
export type Identifier = NodeBase & BindingAnnotation & {
  type: 'Identifier';
  name: string;
};
export type Literal = NodeBase & {
  type: 'Literal';
  value: number | string | boolean | null;
  raw: string;
};
export type Program = NodeBase & {
  type: 'Program';
  sourceType: 'module';
  body: Statement[];
};
export type VariableDeclarator = NodeBase & {
  type: 'VariableDeclarator';
  id: Pattern;
  init: Expression | null;
};
export type VariableDeclaration = NodeBase & {
  type: 'VariableDeclaration';
  kind: 'const' | 'let';
  declarations: VariableDeclarator[];
};
export type FunctionDeclaration = NodeBase & {
  type: 'FunctionDeclaration';
  id: Identifier;
  params: Pattern[];
  body: BlockStatement;
  async: boolean;
  generator: false;
  returnType?: TypeAnnotation;
};
export type ReturnStatement = NodeBase & {
  type: 'ReturnStatement';
  argument: Expression | null;
};
export type IfStatement = NodeBase & {
  type: 'IfStatement';
  test: Expression;
  consequent: Statement;
  alternate: Statement | null;
};
export type ForStatement = NodeBase & {
  type: 'ForStatement';
  init: VariableDeclaration | Expression | null;
  test: Expression | null;
  update: Expression | null;
  body: Statement;
};
export type ForOfStatement = NodeBase & {
  type: 'ForOfStatement';
  left: VariableDeclaration | Pattern | MemberExpression;
  right: Expression;
  body: Statement;
  await: false;
};
export type WhileStatement = NodeBase & {
  type: 'WhileStatement';
  test: Expression;
  body: Statement;
};
export type DoWhileStatement = NodeBase & {
  type: 'DoWhileStatement';
  body: Statement;
  test: Expression;
};
export type BreakStatement = NodeBase & {
  type: 'BreakStatement';
  label: Identifier | null;
};
export type ContinueStatement = NodeBase & {
  type: 'ContinueStatement';
  label: Identifier | null;
};
export type LabeledStatement = NodeBase & {
  type: 'LabeledStatement';
  label: Identifier;
  body: Statement;
};
export type SwitchCase = NodeBase & {
  type: 'SwitchCase';
  test: Expression | null;
  consequent: Statement[];
};
export type SwitchStatement = NodeBase & {
  type: 'SwitchStatement';
  discriminant: Expression;
  cases: SwitchCase[];
};
export type CatchClause = NodeBase & {
  type: 'CatchClause';
  param: Pattern | null;
  body: BlockStatement;
};
export type TryStatement = NodeBase & {
  type: 'TryStatement';
  block: BlockStatement;
  handler: CatchClause | null;
  finalizer: BlockStatement | null;
};
export type ThrowStatement = NodeBase & {
  type: 'ThrowStatement';
  argument: Expression;
};
export type BlockStatement = NodeBase & {
  type: 'BlockStatement';
  body: Statement[];
};
export type EmptyStatement = NodeBase & {
  type: 'EmptyStatement';
};
export type ExpressionStatement = NodeBase & {
  type: 'ExpressionStatement';
  expression: Expression;
};
export type ExportMetaDeclaration = NodeBase & {
  type: 'ExportMetaDeclaration';
  declaration: VariableDeclaration;
};
export type Statement = EmptyStatement | VariableDeclaration | FunctionDeclaration | ReturnStatement | IfStatement | ForStatement | ForOfStatement | WhileStatement | DoWhileStatement | BreakStatement | ContinueStatement | LabeledStatement | SwitchStatement | TryStatement | ThrowStatement | BlockStatement | ExpressionStatement | ExportMetaDeclaration;
export type TemplateElement = NodeBase & {
  type: 'TemplateElement';
  value: {
    raw: string;
    cooked: string;
  };
  tail: boolean;
};
export type TemplateLiteral = NodeBase & {
  type: 'TemplateLiteral';
  quasis: TemplateElement[];
  expressions: Expression[];
};
export type ArrayExpression = NodeBase & {
  type: 'ArrayExpression';
  elements: (Expression | SpreadElement | null)[];
};
export type Property = NodeBase & {
  type: 'Property';
  key: Identifier | Literal | Expression;
  value: Expression | Pattern;
  kind: 'init';
  method: false;
  shorthand: boolean;
  computed: boolean;
};
export type ObjectExpression = NodeBase & {
  type: 'ObjectExpression';
  properties: (Property | SpreadElement)[];
};
export type ArrowFunctionExpression = NodeBase & {
  type: 'ArrowFunctionExpression';
  params: Pattern[];
  body: BlockStatement | Expression;
  async: boolean;
  generator: false;
  expression: boolean;
  returnType?: TypeAnnotation;
};
export type UnaryExpression = NodeBase & {
  type: 'UnaryExpression';
  operator: '!' | '-' | '+' | 'typeof' | 'delete';
  prefix: true;
  argument: Expression;
};
export type UpdateExpression = NodeBase & {
  type: 'UpdateExpression';
  operator: '++' | '--';
  prefix: boolean;
  argument: Identifier | MemberExpression;
};
export type BinaryExpression = NodeBase & {
  type: 'BinaryExpression';
  operator: '+' | '-' | '*' | '/' | '%' | '**' | '===' | '!==' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in';
  left: Expression;
  right: Expression;
};
export type LogicalExpression = NodeBase & {
  type: 'LogicalExpression';
  operator: '&&' | '||' | '??';
  left: Expression;
  right: Expression;
};
export type ConditionalExpression = NodeBase & {
  type: 'ConditionalExpression';
  test: Expression;
  consequent: Expression;
  alternate: Expression;
};
export type AssignmentExpression = NodeBase & {
  type: 'AssignmentExpression';
  operator: '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '**=' | '??=';
  left: Pattern | MemberExpression;
  right: Expression;
};
export type CallExpression = NodeBase & {
  type: 'CallExpression';
  callee: Expression;
  arguments: (Expression | SpreadElement)[];
  optional: boolean;
};
export type MemberExpression = NodeBase & {
  type: 'MemberExpression';
  object: Expression;
  property: Expression;
  computed: boolean;
  optional: boolean;
};
export type ChainExpression = NodeBase & {
  type: 'ChainExpression';
  expression: MemberExpression | CallExpression;
};
export type NewExpression = NodeBase & {
  type: 'NewExpression';
  callee: Identifier;
  arguments: (Expression | SpreadElement)[];
};
export type AwaitExpression = NodeBase & {
  type: 'AwaitExpression';
  argument: Expression;
};
export type SpreadElement = NodeBase & {
  type: 'SpreadElement';
  argument: Expression;
};
export type Expression = Identifier | Literal | TemplateLiteral | ArrayExpression | ObjectExpression | ArrowFunctionExpression | UnaryExpression | UpdateExpression | BinaryExpression | LogicalExpression | ConditionalExpression | AssignmentExpression | CallExpression | MemberExpression | ChainExpression | NewExpression | AwaitExpression;
export type ArrayPattern = NodeBase & BindingAnnotation & {
  type: 'ArrayPattern';
  elements: (Pattern | MemberExpression | null)[];
};
export type ObjectPattern = NodeBase & BindingAnnotation & {
  type: 'ObjectPattern';
  properties: (Property | RestElement)[];
};
export type AssignmentPattern = NodeBase & {
  type: 'AssignmentPattern';
  left: Pattern | MemberExpression;
  right: Expression;
};
export type RestElement = NodeBase & BindingAnnotation & {
  type: 'RestElement';
  argument: Pattern | MemberExpression;
};
export type Pattern = Identifier | ArrayPattern | ObjectPattern | AssignmentPattern | RestElement;
export type KeywordTypeAnnotation = NodeBase & {
  type: 'KeywordTypeAnnotation';
  name: 'number' | 'string' | 'boolean' | 'null' | 'any' | 'void';
};
export type ArrayTypeAnnotation = NodeBase & {
  type: 'ArrayTypeAnnotation';
  elementType: TypeAnnotation;
};
export type TypeProperty = NodeBase & {
  type: 'TypeProperty';
  key: Identifier | Literal;
  optional: boolean;
  typeAnnotation: TypeAnnotation;
};
export type ObjectTypeAnnotation = NodeBase & {
  type: 'ObjectTypeAnnotation';
  properties: TypeProperty[];
};
export type FunctionTypeAnnotation = NodeBase & {
  type: 'FunctionTypeAnnotation';
};
export type UnionTypeAnnotation = NodeBase & {
  type: 'UnionTypeAnnotation';
  types: TypeAnnotation[];
};
export type ParenthesizedTypeAnnotation = NodeBase & {
  type: 'ParenthesizedTypeAnnotation';
  typeAnnotation: TypeAnnotation;
};
export type TypeAnnotation = KeywordTypeAnnotation | ArrayTypeAnnotation | ObjectTypeAnnotation | FunctionTypeAnnotation | UnionTypeAnnotation | ParenthesizedTypeAnnotation;
export type Node = Program | Statement | Expression | Pattern | TypeAnnotation | VariableDeclarator | Property | SpreadElement | TemplateElement | SwitchCase | CatchClause | TypeProperty;
//#endregion
export { ast_d_exports };
//# sourceMappingURL=ast.d.ts.map