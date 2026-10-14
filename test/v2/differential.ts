import * as assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import * as fc from 'fast-check';
import ts from 'typescript-js';
import { parse } from '../../src/v2/parser/index.js';
import type { Node, Program } from '../../src/v2/ast.js';

function reference(source: string): Program {
	const file = ts.createSourceFile('input.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
	assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], source);
	const pos = (offset: number) => {
		const { line, character } = file.getLineAndCharacterOfPosition(offset);
		return { line: line + 1, column: character + 1 };
	};
	const loc = (node: ts.Node) => ({ start: pos(node.getStart(file)), end: pos(node.end) });
	const make = (node: ts.Node, type: string, fields: Record<string, unknown>): Node => ({ type, loc: loc(node), ...fields }) as Node;
	const expression = (node: ts.Expression): Node => convert(node);
	const modifier = (node: ts.Node, kind: ts.SyntaxKind) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === kind);
	const annotation = (node: ts.TypeNode | undefined) => node ? { typeAnnotation: convert(node) } : {};
	const returnType = (node: ts.TypeNode | undefined) => node ? { returnType: convert(node) } : {};
	function binding(node: ts.BindingName, type?: ts.TypeNode, optional?: ts.QuestionToken): Node {
		const result = convert(node);
		return { ...result, ...annotation(type), ...(optional ? { optional: true } : {}), loc: {
			start: pos(node.getStart(file)), end: pos(type?.end ?? optional?.end ?? node.end),
		} } as Node;
	}
	function parameter(node: ts.ParameterDeclaration): Node {
		let result = binding(node.name, node.type, node.questionToken);
		if (node.dotDotDotToken) result = make(node, 'RestElement', { argument: binding(node.name), ...annotation(node.type) });
		if (node.initializer) result = make(node, 'AssignmentPattern', { left: result, right: expression(node.initializer) });
		return result;
	}
	function property(node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment | ts.BindingElement): Node {
		if (ts.isBindingElement(node) && node.dotDotDotToken) return make(node, 'RestElement', { argument: convert(node.name) });
		const name = ts.isBindingElement(node) ? node.propertyName ?? node.name : node.name;
		const computed = ts.isComputedPropertyName(name);
		const key = computed ? expression(name.expression) : convert(name);
		const shorthand = ts.isShorthandPropertyAssignment(node) || (ts.isBindingElement(node) && !node.propertyName);
		let value = ts.isPropertyAssignment(node) ? expression(node.initializer) : convert(node.name);
		if (ts.isBindingElement(node) && node.initializer) {
			value = { ...make(node, 'AssignmentPattern', { left: value, right: expression(node.initializer) }), loc: {
				start: pos(node.name.getStart(file)), end: pos(node.initializer.end),
			} } as Node;
		}
		return make(node, 'Property', { key, value, kind: 'init', method: false, shorthand, computed });
	}
	function templateElement(node: ts.TemplateLiteralLikeNode, tail: boolean): Node {
		const raw = node.getText(file);
		// テンプレートの生の値でも、CR と CRLF は JavaScript の規則で LF になります。
		return make(node, 'TemplateElement', { value: { raw: raw.slice(1, tail ? -1 : -2).replace(/\r\n?/g, '\n'), cooked: node.text }, tail });
	}
	function chain(node: ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression, value: Node): Node {
		const chainFlag = (node.flags & ts.NodeFlags.OptionalChain) !== 0;
		const parent = node.parent;
		const continued = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) || ts.isCallExpression(parent))
			&& parent.expression === node && (parent.flags & ts.NodeFlags.OptionalChain) !== 0;
		return chainFlag && !continued ? make(node, 'ChainExpression', { expression: value }) : value;
	}
	function declaration(node: ts.VariableDeclarationList, end?: number): Node {
		const result = make(node, 'VariableDeclaration', {
			kind: node.flags & ts.NodeFlags.Const ? 'const' : 'let', declarations: node.declarations.map(convert),
		});
		if (end !== undefined) result.loc.end = pos(end);
		return result;
	}
	function assignmentPattern(node: ts.Expression): Node {
		if (ts.isParenthesizedExpression(node)) return assignmentPattern(node.expression);
		if (ts.isArrayLiteralExpression(node)) return make(node, 'ArrayPattern', { elements: node.elements.map(element => ts.isOmittedExpression(element) ? null : assignmentPattern(element)) });
		if (ts.isObjectLiteralExpression(node)) return make(node, 'ObjectPattern', { properties: node.properties.map(element => {
			if (ts.isSpreadAssignment(element)) return make(element, 'RestElement', { argument: assignmentPattern(element.expression) });
			assert.ok(ts.isPropertyAssignment(element) || ts.isShorthandPropertyAssignment(element));
			const result = property(element);
			let value = ts.isPropertyAssignment(element) ? assignmentPattern(element.initializer) : convert(element.name);
			if (ts.isShorthandPropertyAssignment(element) && element.objectAssignmentInitializer) value = make(element, 'AssignmentPattern', { left: value, right: expression(element.objectAssignmentInitializer) });
			return { ...result, value } as Node;
		}) });
		if (ts.isSpreadElement(node)) return make(node, 'RestElement', { argument: assignmentPattern(node.expression) });
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return make(node, 'AssignmentPattern', { left: assignmentPattern(node.left), right: expression(node.right) });
		return convert(node);
	}
	function convert(node: ts.Node): Node {
		if (ts.isSourceFile(node)) return {
			type: 'Program', sourceType: 'module', body: node.statements.map(convert), loc: { start: pos(0), end: pos(source.length) },
		} as Program;
		if (ts.isParenthesizedExpression(node)) return expression(node.expression);
		if (ts.isIdentifier(node)) return make(node, 'Identifier', { name: node.text });
		if (ts.isNumericLiteral(node) || ts.isStringLiteral(node)) return make(node, 'Literal', {
			value: ts.isNumericLiteral(node) ? Number(node.text) : node.text, raw: node.getText(file),
		});
		if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) {
			return make(node, 'Literal', { value: node.kind === ts.SyntaxKind.NullKeyword ? null : node.kind === ts.SyntaxKind.TrueKeyword, raw: node.getText(file) });
		}
		if (ts.isVariableStatement(node)) {
			const value = declaration(node.declarationList, node.end);
			return modifier(node, ts.SyntaxKind.ExportKeyword) ? make(node, 'ExportMetaDeclaration', { declaration: value }) : value;
		}
		if (ts.isVariableDeclarationList(node)) return declaration(node);
		if (ts.isVariableDeclaration(node)) return make(node, 'VariableDeclarator', { id: binding(node.name, node.type), init: node.initializer ? expression(node.initializer) : null });
		if (ts.isFunctionDeclaration(node)) return make(node, 'FunctionDeclaration', {
			id: convert(node.name!), params: node.parameters.map(parameter), body: convert(node.body!),
			async: modifier(node, ts.SyntaxKind.AsyncKeyword), generator: false, ...returnType(node.type),
		});
		if (ts.isArrowFunction(node)) return make(node, 'ArrowFunctionExpression', {
			params: node.parameters.map(parameter), body: convert(node.body), async: modifier(node, ts.SyntaxKind.AsyncKeyword),
			generator: false, expression: !ts.isBlock(node.body), ...returnType(node.type),
		});
		if (ts.isBlock(node)) return make(node, 'BlockStatement', { body: node.statements.map(convert) });
		if (ts.isExpressionStatement(node)) return make(node, 'ExpressionStatement', { expression: expression(node.expression) });
		if (ts.isReturnStatement(node)) return make(node, 'ReturnStatement', { argument: node.expression ? expression(node.expression) : null });
		if (ts.isThrowStatement(node)) return make(node, 'ThrowStatement', { argument: expression(node.expression) });
		if (ts.isIfStatement(node)) return make(node, 'IfStatement', { test: expression(node.expression), consequent: convert(node.thenStatement), alternate: node.elseStatement ? convert(node.elseStatement) : null });
		if (ts.isForStatement(node)) return make(node, 'ForStatement', {
			init: node.initializer ? convert(node.initializer) : null, test: node.condition ? expression(node.condition) : null,
			update: node.incrementor ? expression(node.incrementor) : null, body: convert(node.statement),
		});
		if (ts.isForOfStatement(node)) return make(node, 'ForOfStatement', { left: ts.isVariableDeclarationList(node.initializer) ? convert(node.initializer) : assignmentPattern(node.initializer), right: expression(node.expression), body: convert(node.statement), await: false });
		if (ts.isWhileStatement(node)) return make(node, 'WhileStatement', { test: expression(node.expression), body: convert(node.statement) });
		if (ts.isDoStatement(node)) return make(node, 'DoWhileStatement', { body: convert(node.statement), test: expression(node.expression) });
		if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) return make(node, ts.isBreakStatement(node) ? 'BreakStatement' : 'ContinueStatement', { label: node.label ? convert(node.label) : null });
		if (ts.isLabeledStatement(node)) return make(node, 'LabeledStatement', { label: convert(node.label), body: convert(node.statement) });
		if (ts.isSwitchStatement(node)) return make(node, 'SwitchStatement', { discriminant: expression(node.expression), cases: node.caseBlock.clauses.map(convert) });
		if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return make(node, 'SwitchCase', { test: ts.isCaseClause(node) ? expression(node.expression) : null, consequent: node.statements.map(convert) });
		if (ts.isTryStatement(node)) return make(node, 'TryStatement', { block: convert(node.tryBlock), handler: node.catchClause ? convert(node.catchClause) : null, finalizer: node.finallyBlock ? convert(node.finallyBlock) : null });
		if (ts.isCatchClause(node)) return make(node, 'CatchClause', { param: node.variableDeclaration ? convert(node.variableDeclaration.name) : null, body: convert(node.block) });
		if (ts.isArrayBindingPattern(node)) return make(node, 'ArrayPattern', { elements: node.elements.map(el => {
			if (ts.isOmittedExpression(el)) return null;
			if (el.dotDotDotToken) return make(el, 'RestElement', { argument: convert(el.name) });
			return el.initializer ? make(el, 'AssignmentPattern', { left: convert(el.name), right: expression(el.initializer) }) : convert(el.name);
		}) });
		if (ts.isObjectBindingPattern(node)) return make(node, 'ObjectPattern', { properties: node.elements.map(property) });
		if (ts.isArrayLiteralExpression(node)) return make(node, 'ArrayExpression', { elements: node.elements.map(el => ts.isOmittedExpression(el) ? null : convert(el)) });
		if (ts.isObjectLiteralExpression(node)) return make(node, 'ObjectExpression', { properties: node.properties.map(convert) });
		if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) return property(node);
		if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return make(node, 'SpreadElement', { argument: expression(node.expression) });
		if (ts.isNoSubstitutionTemplateLiteral(node)) return make(node, 'TemplateLiteral', { quasis: [templateElement(node, true)], expressions: [] });
		if (ts.isTemplateExpression(node)) return make(node, 'TemplateLiteral', {
			quasis: [templateElement(node.head, false), ...node.templateSpans.map((span, index) => templateElement(span.literal, index === node.templateSpans.length - 1))],
			expressions: node.templateSpans.map(span => expression(span.expression)),
		});
		if (ts.isConditionalExpression(node)) return make(node, 'ConditionalExpression', { test: expression(node.condition), consequent: expression(node.whenTrue), alternate: expression(node.whenFalse) });
		if (ts.isBinaryExpression(node)) {
			const operator = node.operatorToken.getText(file);
			const type = ['=', '+=', '-=', '*=', '/=', '%=', '**=', '??='].includes(operator) ? 'AssignmentExpression'
				: ['&&', '||', '??'].includes(operator) ? 'LogicalExpression' : 'BinaryExpression';
			return make(node, type, { operator, left: type === 'AssignmentExpression' ? assignmentPattern(node.left) : expression(node.left), right: expression(node.right) });
		}
		if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
			const operator = ts.tokenToString(node.operator)!;
			return make(node, ['++', '--'].includes(operator) ? 'UpdateExpression' : 'UnaryExpression', { operator, prefix: ts.isPrefixUnaryExpression(node), argument: expression(node.operand) });
		}
		if (ts.isTypeOfExpression(node) || ts.isDeleteExpression(node)) return make(node, 'UnaryExpression', { operator: ts.isTypeOfExpression(node) ? 'typeof' : 'delete', prefix: true, argument: expression(node.expression) });
		if (ts.isAwaitExpression(node)) return make(node, 'AwaitExpression', { argument: expression(node.expression) });
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return chain(node, make(node, 'MemberExpression', {
			object: expression(node.expression), property: ts.isPropertyAccessExpression(node) ? convert(node.name) : expression(node.argumentExpression),
			computed: ts.isElementAccessExpression(node), optional: !!node.questionDotToken,
		}));
		if (ts.isCallExpression(node)) return chain(node, make(node, 'CallExpression', { callee: expression(node.expression), arguments: node.arguments.map(expression), optional: !!node.questionDotToken }));
		if (ts.isNewExpression(node)) return make(node, 'NewExpression', { callee: expression(node.expression), arguments: node.arguments?.map(expression) ?? [] });
		if (ts.isArrayTypeNode(node)) return make(node, 'ArrayTypeAnnotation', { elementType: convert(node.elementType) });
		if (ts.isUnionTypeNode(node)) return make(node, 'UnionTypeAnnotation', { types: node.types.map(convert) });
		if (ts.isParenthesizedTypeNode(node)) return make(node, 'ParenthesizedTypeAnnotation', { typeAnnotation: convert(node.type) });
		if (ts.isTypeLiteralNode(node)) return make(node, 'ObjectTypeAnnotation', { properties: node.members.map(convert) });
		if (ts.isPropertySignature(node)) {
			const result = make(node, 'TypeProperty', { key: convert(node.name), optional: !!node.questionToken, typeAnnotation: convert(node.type!) });
			result.loc.end = pos(node.type!.end);
			return result;
		}
		if (ts.isTypeReferenceNode(node) && node.typeName.getText(file) === 'Function') return make(node, 'FunctionTypeAnnotation', {});
		if (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) return make(node, 'KeywordTypeAnnotation', { name: 'null' });
		if ([ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.StringKeyword, ts.SyntaxKind.BooleanKeyword, ts.SyntaxKind.AnyKeyword, ts.SyntaxKind.VoidKeyword].includes(node.kind)) return make(node, 'KeywordTypeAnnotation', { name: node.getText(file) });
		throw new Error(`未対応の参照構文: ${ts.SyntaxKind[node.kind]} (${node.getText(file)})`);
	}
	return convert(file) as Program;
}

function compare(source: string): void {
	const actual = parse(source);
	assert.deepEqual(actual.warnings, []);
	assert.deepEqual(actual.program, reference(source), source);
}

const examples = [
	'const each = x => x; each(xs); const match = x => x; match(xs); match;',
	'const constructor = toString; constructor(); const o = { constructor, toString };',
	'([obj.x = 1, ...obj.rest] = xs); ({ a: obj.x, ...obj.rest } = data);',
	'([...[x = 1]] = arr);',
	'for ((async) of xs) {}',
	'', '// comment\nconst x = 1;\nlet y = x + 2;',
	'let x; const a = 1, b = 2;',
	'const xs = [1_000, 0xff, 0b11, 0o77, .5, 1., 1e-3, true, false, null, "a\\n", "\\u{1f600}"];',
	'const [a, , b = 2, ...xs] = arr; const { x, y: z = 1, ...rest } = obj;',
	'function f({ x }, [y = 1], z = 2, ...rest) { return x + y; }',
	'async function f(x) { return await g(x); }',
	'const f = x => x + 1; const g = (x, y = 1) => { return x + y; };',
	'const f = async x => await g(x); const g = async () => ({ value: 1 });',
	'if (x) f(); else if (y) { g(); } else h();',
	'for (let i = 0; i < 3; i++) { f(i); } for (;;) { break; }',
	'for (i = 0; i < 2; i += 1) f(i); for (const [k, v] of entries) f(k, v);',
	'outer: while (x) { if (y) continue outer; break outer; }',
	'outer: do { f(); break outer; } while (ok); block: { break block; }',
	'switch (x) { case 1: f(); break; case 2: case 3: g(); break; default: h(); }',
	'try { f(); } catch (e) { throw new Error(e.message); } finally { h(); }',
	'try { f(); } catch { g(); } try { f(); } finally { h(); }',
	'function f() { return; }',
	'const x = `a${b}c${`d${e}`}f`; const y = ``;',
	'const x = [1, , ...xs, 2,]; const o = { a: 1, b, [k]: v, "s": 2, 3: null, ...other };',
	'!a; -b; +c; typeof d; delete obj.x; i++; ++i; i--; --i;',
	'a + b * c ** d ** e / f % g - h; a === b; a !== b; a < b; a <= b; a > b; a >= b; "x" in obj;',
	'x == null; null != x; a && b || c; a ?? b; (a ?? b) || c; a ?? (b && c);',
	'a ? b:c; a ? b : c ? d : e; x = 1; x += 1; x -= 1; x *= 2; x /= 2; x %= 2; x **= 2; x ??= 1;',
	'f(1, ...xs); obj.f(x); obj[k](x); obj.x = 1; obj[k] += 1;',
	'([a, b = 1, ...rest] = xs); ({ x, y: z } = obj);',
	'obj?.x; obj?.[k]; f?.(x); obj?.x.y?.(x); (obj?.x).y;',
	'let n: number; let s: string; let b: boolean; let z: null; let a: any; let f: Function;',
	'let xs: (string | null)[]; let o: { a: number; b?: string; c: { x: boolean } };',
	'function f(x: number = 1, y?: string): string | null { return y; } function g(): void {}',
	'const f = (x: number): number => x; const g = (...xs: number[]): number => xs.length;',
	'export const meta = { name: "test", nested: { value: null }, tags: [1, "a"] };',
	'const x = 1\nconst y = 2\nf(x)\ng(y)',
	'const x = (a\n + b); f(\n x\n);',
	'outer: for (;;) { continue outer; }',
	'const 名前 = "😀"; const \\u0078 = 名前;\r\nf(x);',
	'const { [key]: value = 1, nested: { x } } = obj; try {} catch ({ message }) { f(message); }',
	'const o = { class: 1, return: true, null: false }; o.class;',
	'const x = "\\n\\r\\t\\b\\f\\v\\0\\x41\\u0042\\u{1f600}\\z"; const y = `line\r\nnext`;',
	'let x: { a: number\n b?: string }; let { a }: { a: number } = obj;',
	'const f = (x): number => x; const value = true ? (a) : b;',
	'const x = a ? b\n + c : d;',
	'const o = { ["__proto__"]: a, ["__proto__"]: b, __proto__ };',
	'const constructor = 1; const toString = 2; const hasOwnProperty = 3; f(constructor, toString, hasOwnProperty);',
	'true ? x => x : y => y; (x => x)();',
	'for ([a = 1] of xs) {} for ({ a = 1 } of xs) {}',
] as const;

const atom = fc.oneof(fc.integer({ min: 0, max: 10000 }).map(String), fc.constantFrom('x', 'y', 'true', 'false', 'null', '"text"'));
function generatedExpression(depth: number): fc.Arbitrary<string> {
	if (depth === 0) return atom;
	const child = generatedExpression(depth - 1);
	return fc.oneof(
		atom,
		fc.tuple(child, fc.constantFrom('+', '-', '*', '/', '%', '**', '===', '!==', '<', '<=', '>', '>=', '&&', '||', '??'), child).map(([a, op, b]) => `(${a} ${op} ${b})`),
		fc.tuple(fc.constantFrom('!', '-', '+', 'typeof'), child).map(([op, value]) => `(${op} (${value}))`),
		fc.tuple(child, child, child).map(([a, b, c]) => `(${a} ? ${b} : ${c})`),
		fc.array(child, { maxLength: 3 }).map(values => `[${values.join(', ')}]`),
		fc.tuple(child, child).map(([a, b]) => `({ a: ${a}, [key]: ${b} })`),
		fc.array(child, { maxLength: 3 }).map(values => `f(${values.join(', ')})`),
		child.map(value => `(x => ${value})`),
		child.map(value => `obj?.[${value}]`),
		child.map(value => '`head${' + value + '}tail`'),
	);
}

const generatedStatement = fc.oneof(
	generatedExpression(3).map(value => `const value = ${value};`),
	generatedExpression(2).map(value => `x = ${value};`),
	generatedExpression(2).map(value => `function f(x) { return ${value}; }`),
	fc.tuple(generatedExpression(2), generatedExpression(2)).map(([a, b]) => `if (${a}) { f(${b}); } else { g(); }`),
	generatedExpression(2).map(value => `for (let i = 0; i < 3; i++) { f(${value}); }`),
	generatedExpression(2).map(value => `for (const x of xs) { f(${value}); }`),
	generatedExpression(2).map(value => `while (ok) { f(${value}); break; }`),
	generatedExpression(2).map(value => `try { f(${value}); } catch (e) { g(e); }`),
);

function generatedType(depth: number): fc.Arbitrary<string> {
	const simple = fc.constantFrom('number', 'string', 'boolean', 'null', 'any', 'void', 'Function');
	if (depth === 0) return simple;
	const child = generatedType(depth - 1);
	return fc.oneof(
		simple,
		child.map(type => `(${type})[]`),
		fc.tuple(child, child).map(([a, b]) => `${a} | ${b}`),
		fc.tuple(child, child).map(([a, b]) => `{ a: ${a}; b?: ${b} }`),
	);
}

const generatedPattern = fc.oneof(
	fc.constant('value'),
	generatedExpression(1).map(value => `[first, , second = ${value}, ...remaining]`),
	generatedExpression(1).map(value => `{ first, second: renamed = ${value}, ...remaining }`),
	generatedExpression(1).map(value => `{ [key]: renamed = ${value}, nested: [first, ...remaining] }`),
	generatedExpression(1).map(value => `[{ first = ${value} }, [second], ...remaining]`),
);

const generatedBindingProgram = fc.tuple(generatedPattern, generatedType(2), generatedExpression(2)).map(([pattern, type, value]) => [
	`const ${pattern}: ${type} = ${value};`,
	`function consume(${pattern}: ${type}, optional?: ${type}): ${type} { return ${value}; }`,
	`const arrow = (${pattern}: ${type}): ${type} => (${value});`,
	`function collect(...remaining: (${type})[]): void { consume(...remaining); }`,
].join('\n'));

const generatedSpreadProgram = fc.tuple(generatedExpression(2), generatedExpression(2), generatedPattern).map(([a, b, pattern]) => [
	`const array = [${a}, ...xs, , ${b}, ...ys];`,
	`const object = { ...left, value: ${a}, [key]: ${b}, shorthand, ...right };`,
	`f(${a}, ...xs, ${b}, ...ys);`,
	`const fn = async (${pattern}, ...rest) => { return await f(${a}, ...rest); };`,
	`([first, second = ${a}, ...remaining] = xs);`,
	`({ first = ${b}, second: renamed, ...remaining } = object);`,
].join('\n'));

function generatedControlStatement(depth: number): fc.Arbitrary<string> {
	if (depth === 0) return generatedStatement;
	const child = generatedControlStatement(depth - 1);
	const expression = generatedExpression(1);
	return fc.oneof(
		child,
		fc.tuple(child, child, expression).map(([a, b, condition]) => `if (${condition}) { ${a} } else { ${b} }`),
		fc.tuple(child, expression).map(([body, condition]) => `while (${condition}) { ${body} break; }`),
		fc.tuple(child, expression).map(([body, condition]) => `do { ${body} } while (${condition});`),
		child.map(body => `for (let i = 0; i < 2; i++) { ${body} }`),
		child.map(body => `for (const { value } of values) { ${body} }`),
		fc.tuple(child, child, child).map(([a, b, c]) => `try { ${a} } catch ({ message }) { ${b} } finally { ${c} }`),
		fc.tuple(child, child, expression).map(([a, b, value]) => `switch (${value}) { case 1: { ${a} } break; default: { ${b} } }`),
		child.map(body => `{ ${body} }`),
	);
}

describe('v2 parser: TypeScript パーサーとの差分', () => {
	for (const [index, source] of examples.entries()) {
		test(`手書きの構文 ${index + 1}`, () => compare(source));
	}
	test('生成した式を含む文と文の組み合わせ', () => {
		let compared = 0;
		const numRuns = 400;
		fc.assert(fc.property(fc.array(generatedStatement, { minLength: 1, maxLength: 5 }), statements => {
			compare(statements.join('\n'));
			compared++;
		}), { numRuns, seed: 2042026 });
		assert.ok(compared >= numRuns, `${compared} / ${numRuns}`);
	});
	for (const [name, arbitrary, seeds] of [
		['型注釈と束縛と関数', generatedBindingProgram, [2042027, 2042028]],
		['スプレッドと既定値と分割代入', generatedSpreadProgram, [2042029, 2042030]],
		['入れ子の制御文と例外処理', generatedControlStatement(2), [2042031, 2042032]],
	] as const) {
		test(name, () => {
			let compared = 0;
			const numRuns = 200;
			for (const seed of seeds) {
				fc.assert(fc.property(arbitrary, source => {
					compare(source);
					compared++;
				}), { numRuns, seed });
			}
			assert.ok(compared >= numRuns * seeds.length, `${compared} / ${numRuns * seeds.length}`);
		});
	}
});
