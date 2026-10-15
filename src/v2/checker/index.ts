import type * as A from '../ast.js';
import type { CatalogEntry } from '../catalog.js';
import { diagnostic, type Diagnostic, type DiagnosticCode } from '../diagnostics.js';
import { catalog } from '../stdlib/index.js';
import { boundNames } from '../runtime/environment.js';
import { fallsThrough } from './control-flow.js';
import { Scope, bindPattern, declare, propertyName, objectRest, project } from './scopes.js';

export type CheckOptions = { globals?: readonly string[]; hostCatalog?: readonly CatalogEntry[] };
type Segment = string | number;
type LiteralMismatch = { annotation: A.TypeAnnotation; value?: A.Expression; at: A.Node; path: Segment[] };
type Match = true | undefined | LiteralMismatch;

function typeName(type: A.TypeAnnotation): string {
	const parts: string[] = [];
	const pending: (string | A.TypeAnnotation)[] = [type];
	// 配列型の後置記法は深く連ねられるため、診断の整形も再帰にしません。
	while (pending.length) {
		const item = pending.pop()!;
		if (typeof item === 'string') { parts.push(item); continue; }
		switch (item.type) {
			case 'KeywordTypeAnnotation': parts.push(item.name); break;
			case 'FunctionTypeAnnotation': parts.push('Function'); break;
			case 'ParenthesizedTypeAnnotation': pending.push(')', item.typeAnnotation, '('); break;
			case 'ArrayTypeAnnotation': pending.push('[]', item.elementType); break;
			case 'UnionTypeAnnotation':
				for (let index = item.types.length - 1; index >= 0; index--) {
					if (index < item.types.length - 1) pending.push(' | ');
					pending.push(item.types[index]!);
				}
				break;
			case 'ObjectTypeAnnotation':
				pending.push(' }');
				for (let index = item.properties.length - 1; index >= 0; index--) {
					const property = item.properties[index]!;
					if (index < item.properties.length - 1) pending.push(', ');
					pending.push(property.typeAnnotation, `${propertyName(property.key)}${property.optional ? '?' : ''}: `);
				}
				pending.push('{ ');
				break;
		}
	}
	return parts.join('');
}

function literalKind(node: A.Expression): string | undefined {
	if (node.type === 'Literal') return node.value === null ? 'null' : typeof node.value;
	if (node.type === 'ArrayExpression') return 'array';
	if (node.type === 'ObjectExpression') return 'object';
	if (node.type === 'ArrowFunctionExpression') return 'Function';
	if (node.type === 'UnaryExpression' && (node.operator === '+' || node.operator === '-') && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return 'number';
	return undefined;
}
function literalMatch(type: A.TypeAnnotation, value: A.Expression, depth = 1, keys: Segment[] = []): Match {
	if (type.type === 'ParenthesizedTypeAnnotation') return literalMatch(type.typeAnnotation, value, depth, keys);
	if (type.type === 'UnionTypeAnnotation') {
		const matches = type.types.map(item => literalMatch(item, value, depth, keys));
		return matches.includes(true) ? true : matches.includes(undefined) ? undefined : { annotation: type, value, at: value, path: keys };
	}
	if (type.type === 'KeywordTypeAnnotation' && type.name === 'any') return true;
	const kind = literalKind(value);
	if (!kind) return undefined;
	const failure = { annotation: type, value, at: value, path: keys };
	if (type.type === 'KeywordTypeAnnotation') return kind === (type.name === 'void' ? 'null' : type.name) ? true : failure;
	if (type.type === 'FunctionTypeAnnotation') return kind === 'Function' ? true : failure;
	if (type.type === 'ArrayTypeAnnotation') {
		if (value.type !== 'ArrayExpression') return failure;
		if (!depth) return true;
		let knownIndex = true;
		for (const [index, item] of value.elements.entries()) {
			if (item?.type === 'SpreadElement') { knownIndex = false; continue; }
			if (item) {
				const result = literalMatch(type.elementType, item, depth - 1, [...keys, knownIndex ? index : '?']);
				if (result !== true && result !== undefined) return result;
			}
		}
		return true;
	}
	if (value.type !== 'ObjectExpression') return failure;
	if (!depth) return true;
	const { properties, uncertain } = literalProperties(value);
	for (const property of type.properties) {
		const key = propertyName(property.key)!;
		const item = properties.get(key);
		if (item) {
			const result = literalMatch(property.typeAnnotation, item, depth - 1, [...keys, key]);
			if (result !== true && result !== undefined) return result;
		} else if (!property.optional && !uncertain) return { annotation: property.typeAnnotation, at: value, path: [...keys, key] };
	}
	return true;
}
function literalProperties(value: A.ObjectExpression): { properties: Map<string, A.Expression>; uncertain: boolean } {
	const properties = new Map<string, A.Expression>();
	let uncertain = false;
	for (const item of value.properties) {
		if (item.type === 'SpreadElement' || (item.computed && item.key.type !== 'Literal')) {
			// 後の spread・計算キーは先行するリテラルを上書きできます。
			properties.clear(); uncertain = true;
		} else properties.set(propertyName(item.key)!, item.value as A.Expression);
	}
	return { properties, uncertain };
}
function patternName(pattern: A.Pattern | A.MemberExpression): string {
	if (pattern.type === 'Identifier') return pattern.name;
	if (pattern.type === 'AssignmentPattern') return patternName(pattern.left);
	if (pattern.type === 'RestElement') return patternName(pattern.argument);
	const names = boundNames(pattern).join(', ');
	return pattern.type === 'ArrayPattern' ? `[${names}]` : `{${names}}`;
}

function mismatchName(name: string, path: readonly Segment[], pattern?: A.Pattern | A.MemberExpression): string {
	const keys = [...path];
	let index = 0;
	while (pattern) {
		if (pattern.type === 'AssignmentPattern' || pattern.type === 'RestElement') { pattern = pattern.type === 'AssignmentPattern' ? pattern.left : pattern.argument; continue; }
		name = patternName(pattern);
		if (pattern.type === 'Identifier') break;
		if (index >= keys.length) break;
		const key = keys[index]!;
		let next: A.Pattern | A.MemberExpression | undefined | null;
		if (pattern.type === 'ArrayPattern' && typeof key === 'number') {
			const restIndex = pattern.elements.findIndex(item => item?.type === 'RestElement');
			if (restIndex >= 0 && key >= restIndex) { pattern = (pattern.elements[restIndex] as A.RestElement).argument; keys[index] = key - restIndex; continue; }
			next = pattern.elements[key];
		}
		else if (pattern.type === 'ObjectPattern') {
			const property = pattern.properties.find(item => item.type === 'Property' && (!item.computed || item.key.type === 'Literal') && propertyName(item.key) === String(key));
			if (property?.type === 'Property') next = property.value as A.Pattern;
			else { const rest = pattern.properties.find(item => item.type === 'RestElement'); if (rest?.type === 'RestElement') { pattern = rest.argument; continue; } }
		}
		if (!next) break;
		pattern = next; index++;
	}
	return name + keys.slice(index).map(key => typeof key === 'number' || key === '?' ? `[${key}]` : `.${key}`).join('');
}

function valueSummary(value: A.Expression): string {
	if (value.type === 'Literal') return JSON.stringify(value.value).slice(0, 120);
	if (value.type === 'UnaryExpression') return value.operator + valueSummary(value.argument);
	return value.type === 'ArrayExpression' ? '[…]' : value.type === 'ObjectExpression' ? '{…}' : 'Function';
}
function distance(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 0; i < left.length; i++) {
		const row = [i + 1];
		for (let j = 0; j < right.length; j++) row.push(Math.min(row[j]! + 1, previous[j + 1]! + 1, previous[j]! + (left[i] === right[j] ? 0 : 1)));
		previous = row;
	}
	return previous[right.length]!;
}
function path(node: A.Expression): string | undefined {
	const keys: string[] = [];
	while (node.type === 'MemberExpression') {
		const key = !node.computed || node.property.type === 'Literal' ? propertyName(node.property) : undefined;
		if (key === undefined) return undefined;
		keys.push(key); node = node.object;
	}
	if (node.type !== 'Identifier') return undefined;
	keys.push(node.name);
	return keys.reverse().join('.');
}

/** 明示された注釈と構文だけを検査し、変数の値から型や呼出し先を推論しません。 */
export function check(program: A.Program, options: CheckOptions = {}): Diagnostic[] {
	const output: Diagnostic[] = [];
	const reportedMismatches = new Set<string>();
	const pending: (() => void)[] = [];
	const entries = new Map<string, CatalogEntry>();
	const overridden = new Set([...(options.globals ?? []), ...(options.hostCatalog ?? []).filter(entry => entry.receiver === 'global').map(entry => entry.name.split('.')[0]!)]);
	for (const entry of catalog) if (entry.receiver !== 'global' || !overridden.has(entry.name.split('.')[0]!)) entries.set(`${entry.receiver}:${entry.name}`, entry);
	for (const entry of options.hostCatalog ?? []) entries.set(`${entry.receiver}:${entry.name}`, entry);
	const globals = new Scope();
	for (const entry of [...catalog, ...(options.hostCatalog ?? [])]) if (entry.receiver === 'global') globals.bindings.set(entry.name.split('.')[0]!, { mutable: false, global: true });
	for (const name of options.globals ?? []) globals.bindings.set(name, { mutable: false, global: true });
	const unsafe = new Set<string>();
	let collecting = true;
	function emit(code: DiagnosticCode, node: A.Node, params: Diagnostic['params'] = {}, severity: Diagnostic['severity'] = 'error'): void {
		if (!collecting) output.push(diagnostic(code, node.loc.start, params, { loc: node.loc, severity }));
	}
	function reference(node: A.Identifier, scope: Scope): void {
		if (collecting || scope.resolve(node.name)) return;
		const threshold = node.name.length < 4 ? 1 : 2;
		const candidates = scope.names().filter(name => Math.abs(name.length - node.name.length) <= threshold && name.length <= 128 && node.name.length <= 128).map(name => ({ name, difference: distance(name, node.name) })).filter(item => item.difference <= threshold).sort((a, b) => a.difference - b.difference || a.name.localeCompare(b.name));
		if (candidates[0]) emit('UNBOUND_IDENTIFIER_SUGGESTION', node, { name: node.name, suggestion: candidates[0].name });
		else emit('UNBOUND_IDENTIFIER', node, { name: node.name });
	}
	function invalidate(node: A.Expression, scope: Scope): void {
		while (node.type === 'MemberExpression' || node.type === 'ChainExpression') node = node.type === 'MemberExpression' ? node.object : node.expression;
		if (node.type === 'Identifier' && scope.resolve(node.name)?.global) unsafe.add(node.name);
	}
	function mismatch(type: A.TypeAnnotation | undefined, value: A.Expression, name: string, pattern?: A.Pattern | A.MemberExpression): boolean {
		if (collecting || !type) return false;
		const result = literalMatch(type, value);
		if (result === true || result === undefined) return false;
		const params = { name: mismatchName(name, result.path, pattern), expected: typeName(result.annotation), actual: result.value ? literalKind(result.value)! : 'missing', value: result.value ? valueSummary(result.value) : 'null' };
		const key = JSON.stringify([result.at.loc.start, params]);
		if (!reportedMismatches.has(key)) { reportedMismatches.add(key); emit('TYPE_ANNOTATION_MISMATCH', result.at, params); }
		return true;
	}

	function bindingExpressions(pattern: A.Pattern | A.MemberExpression, scope: Scope, inherited?: A.TypeAnnotation): void {
		const annotation = 'typeAnnotation' in pattern ? pattern.typeAnnotation ?? inherited : inherited;
		switch (pattern.type) {
			case 'AssignmentPattern': {
				const type = annotation ?? ('typeAnnotation' in pattern.left ? pattern.left.typeAnnotation : undefined);
				const failed = !collecting && type ? mismatch(type, pattern.right, patternName(pattern.left), pattern.left) : false;
				if (!failed && pattern.left.type !== 'Identifier') initialBindings(pattern.left, pattern.right, scope);
				expression(pattern.right, scope); bindingExpressions(pattern.left, scope, annotation); break;
			}
			case 'RestElement': bindingExpressions(pattern.argument, scope, annotation); break;
			case 'ArrayPattern': for (const [index, item] of pattern.elements.entries()) if (item) bindingExpressions(item, scope, project(annotation, String(index), true, item.type === 'RestElement')); break;
			case 'ObjectPattern': for (const item of pattern.properties) {
				if (item.type === 'RestElement') bindingExpressions(item.argument, scope, objectRest(annotation, pattern));
				else { if (item.computed) expression(item.key as A.Expression, scope); bindingExpressions(item.value as A.Pattern, scope, annotation && (!item.computed || item.key.type === 'Literal') ? project(annotation, propertyName(item.key)!) : undefined); }
			} break;
			case 'MemberExpression': expression(pattern, scope); break;
			case 'Identifier': break;
		}
	}
	function initialBindings(pattern: A.Pattern | A.MemberExpression, value: A.Expression | undefined, scope: Scope): void {
		if (!value || collecting) return;
		// 注釈のない分割は値を取り出す必要がありません。代入先の既存の注釈もここで調べます。
		const pending: (A.Pattern | A.MemberExpression)[] = [pattern];
		while (pending.length) {
			const part = pending.pop()!;
			if (part.type === 'Identifier') {
				if (scope.resolve(part.name)?.annotation) { checkedInitialBindings(pattern, value, scope); return; }
			} else if (part.type === 'AssignmentPattern') pending.push(part.left);
			else if (part.type === 'RestElement') pending.push(part.argument);
			else if (part.type === 'ArrayPattern') { for (const item of part.elements) if (item) pending.push(item); }
			else if (part.type === 'ObjectPattern') { for (const item of part.properties) pending.push(item.type === 'RestElement' ? item.argument : item.value as A.Pattern); }
		}
	}
	function checkedInitialBindings(pattern: A.Pattern | A.MemberExpression, value: A.Expression | undefined, scope: Scope): void {
		if (!value || collecting) return;
		const absent = (node: A.Node): A.Literal => ({ type: 'Literal', value: null, raw: 'null', loc: node.loc });
		switch (pattern.type) {
			case 'Identifier': mismatch(scope.resolve(pattern.name)?.annotation, value, pattern.name); break;
			case 'AssignmentPattern': checkedInitialBindings(pattern.left, value.type === 'Literal' && value.value === null ? pattern.right : value, scope); break;
			case 'RestElement': checkedInitialBindings(pattern.argument, value, scope); break;
			case 'MemberExpression': break;
			case 'ArrayPattern': {
				if (value.type !== 'ArrayExpression') break;
				let known = true;
				for (const [index, item] of pattern.elements.entries()) {
					const element = value.elements[index];
					if (element?.type === 'SpreadElement') known = false;
					if (!item || !known) continue;
					if (item.type === 'RestElement') {
						const elements = value.elements.slice(index);
						if (!elements.some(part => part?.type === 'SpreadElement')) checkedInitialBindings(item.argument, { ...value, elements }, scope);
					} else checkedInitialBindings(item, element && element.type !== 'SpreadElement' ? element : absent(item), scope);
				}
				break;
			}
			case 'ObjectPattern': {
				const literal = value.type === 'ObjectExpression' ? literalProperties(value) : undefined;
				// すべての添字で同じ spread 境界を使い、各要素までの再走査を避けます。
				const firstSpread = value.type === 'ArrayExpression' ? value.elements.findIndex(part => part?.type === 'SpreadElement') : -1;
				const excluded = new Set<string>();
				let dynamic = false;
				for (const item of pattern.properties) {
					if (item.type === 'RestElement') {
						if (literal && !literal.uncertain && !dynamic) {
							const properties: A.Property[] = [...literal.properties].filter(([key]) => !excluded.has(key)).map(([key, child]) => ({ type: 'Property', key: { type: 'Literal', value: key, raw: JSON.stringify(key), loc: value.loc }, value: child, kind: 'init', method: false, shorthand: false, computed: false, loc: value.loc }));
							checkedInitialBindings(item.argument, { type: 'ObjectExpression', properties, loc: value.loc }, scope);
						}
						continue;
					}
					const key = !item.computed || item.key.type === 'Literal' ? propertyName(item.key) : undefined;
					if (key === undefined) { dynamic = true; continue; }
					excluded.add(key);
					let child: A.Expression | undefined;
					if (literal) child = literal.properties.get(key) ?? (literal.uncertain ? undefined : absent(item.value));
					else if (value.type === 'ArrayExpression') {
						if (key === 'length' && firstSpread < 0) child = { type: 'Literal', value: value.elements.length, raw: String(value.elements.length), loc: value.loc };
						else if (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295) {
							const index = Number(key);
							if (firstSpread < 0 || index < firstSpread) {
								const element = value.elements[index];
								child = element && element.type !== 'SpreadElement' ? element : absent(item.value);
							}
						}
					}
					checkedInitialBindings(item.value as A.Pattern, child, scope);
				}
				break;
			}
		}
	}
	function write(pattern: A.Pattern | A.MemberExpression, scope: Scope): void {
		switch (pattern.type) {
			case 'Identifier': {
				reference(pattern, scope);
				const binding = scope.resolve(pattern.name);
				if (binding && !binding.mutable) emit('CONST_ASSIGNMENT', pattern, { name: pattern.name });
				invalidate(pattern, scope);
				break;
			}
			case 'MemberExpression': invalidate(pattern, scope); expression(pattern.object, scope, true); if (pattern.computed) expression(pattern.property, scope); break;
			case 'AssignmentPattern': expression(pattern.right, scope); write(pattern.left, scope); break;
			case 'RestElement': write(pattern.argument, scope); break;
			case 'ArrayPattern': for (const item of pattern.elements) if (item) write(item, scope); break;
			case 'ObjectPattern': for (const item of pattern.properties) {
				if (item.type === 'RestElement') write(item.argument, scope);
				else { if (item.computed) expression(item.key as A.Expression, scope); write(item.value as A.Pattern, scope); }
			} break;
		}
	}

	function arity(node: A.CallExpression | A.NewExpression, scope: Scope): void {
		if (collecting) return;
		let definition: CatalogEntry | undefined;
		const name = path(node.callee);
		if (name) {
			const root = name.split('.')[0]!;
			if (scope.resolve(root)?.global && !unsafe.has(root)) definition = entries.get(`global:${name}`);
		}
		if (!definition && node.callee.type === 'MemberExpression') {
			let receiver = literalKind(node.callee.object);
			if (node.callee.object.type === 'Identifier') {
				let type = scope.resolve(node.callee.object.name)?.annotation;
				while (type?.type === 'ParenthesizedTypeAnnotation') type = type.typeAnnotation;
				if (type?.type === 'KeywordTypeAnnotation' && (type.name === 'string' || type.name === 'number')) receiver = type.name;
			}
			const key = !node.callee.computed || node.callee.property.type === 'Literal' ? propertyName(node.callee.property) : undefined;
			if (receiver && key) definition = entries.get(`${receiver}:${key}`);
		}
		if (!definition || 'kind' in definition) return;
		let count = 0;
		for (const arg of node.arguments) {
			if (arg.type !== 'SpreadElement') count++;
			else if (arg.argument.type === 'ArrayExpression' && arg.argument.elements.every(item => item && item.type !== 'SpreadElement')) count += arg.argument.elements.length;
			else return;
		}
		const minimum = definition.args.filter(arg => !arg.optional && !arg.rest).length;
		const maximum = definition.args.some(arg => arg.rest) ? Infinity : definition.args.length;
		if (count < minimum || count > maximum) emit('ARGUMENT_COUNT', node, { name: definition.name, min: minimum, max: maximum === Infinity ? '∞' : maximum, actual: count });
	}
	function functionBody(node: A.FunctionDeclaration | A.ArrowFunctionExpression, parent: Scope): void {
		const scope = new Scope(parent);
		for (const param of node.params) bindPattern(scope, param, true);
		// 引数の既定値から本体内の宣言は見えません。
		for (const param of node.params) bindingExpressions(param, scope);
		if (node.body.type === 'BlockStatement') block(node.body.body, scope);
		else expression(node.body, scope);
	}
	function expression(node: A.Expression, scope: Scope, direct = false): void { pending.push(() => visitExpression(node, scope, direct)); }
	function visitExpression(node: A.Expression, scope: Scope, direct: boolean): void {
		switch (node.type) {
			case 'Identifier': reference(node, scope); if (!direct) invalidate(node, scope); break;
			case 'Literal': break;
			case 'ArrowFunctionExpression': functionBody(node, scope); break;
			case 'ArrayExpression': for (const item of node.elements) if (item) expression(item.type === 'SpreadElement' ? item.argument : item, scope); break;
			case 'ObjectExpression': for (const item of node.properties) { if (item.type === 'SpreadElement') expression(item.argument, scope); else { if (item.computed) expression(item.key as A.Expression, scope); expression(item.value as A.Expression, scope); } } break;
			case 'TemplateLiteral': for (const item of node.expressions) expression(item, scope); break;
			case 'AssignmentExpression': write(node.left, scope); if (node.operator === '=') initialBindings(node.left, node.right, scope); expression(node.right, scope); break;
			case 'UpdateExpression': write(node.argument, scope); break;
			case 'MemberExpression': if (!direct && !entries.has(`global:${path(node)}`)) invalidate(node, scope); expression(node.object, scope, true); if (node.computed) expression(node.property, scope); break;
			case 'CallExpression': case 'NewExpression': arity(node, scope); expression(node.callee, scope, true); for (const arg of node.arguments) expression(arg.type === 'SpreadElement' ? arg.argument : arg, scope); break;
			case 'UnaryExpression': if (node.operator === 'typeof' && node.argument.type === 'Identifier') break; if (node.operator === 'delete') invalidate(node.argument, scope); expression(node.argument, scope); break;
			case 'AwaitExpression': expression(node.argument, scope); break;
			case 'ChainExpression': expression(node.expression, scope, direct); break;
			case 'BinaryExpression': case 'LogicalExpression': expression(node.left, scope); expression(node.right, scope); break;
			case 'ConditionalExpression': expression(node.test, scope); expression(node.consequent, scope); expression(node.alternate, scope); break;
		}
	}
	function block(body: readonly A.Statement[], parent: Scope): void { const scope = new Scope(parent); declare(scope, body); for (const item of body) statement(item, scope); }
	function statement(node: A.Statement, scope: Scope): void { pending.push(() => visitStatement(node, scope)); }
	function visitStatement(node: A.Statement, scope: Scope): void {
		switch (node.type) {
			case 'EmptyStatement': case 'BreakStatement': case 'ContinueStatement': break;
			case 'ExpressionStatement': expression(node.expression, scope); break;
			case 'VariableDeclaration': for (const item of node.declarations) {
				bindingExpressions(item.id, scope);
				if (item.init) {
					const type = 'typeAnnotation' in item.id ? item.id.typeAnnotation : undefined;
					const failed = !collecting && type ? mismatch(type, item.init, patternName(item.id), item.id) : false;
					if (!failed && item.id.type !== 'Identifier') initialBindings(item.id, item.init, scope);
					expression(item.init, scope);
				}
			} break;
			case 'FunctionDeclaration': functionBody(node, scope); break;
			case 'BlockStatement': block(node.body, scope); break;
			case 'ExportMetaDeclaration': statement(node.declaration, scope); break;
			case 'ReturnStatement': if (node.argument) expression(node.argument, scope); break;
			case 'ThrowStatement': expression(node.argument, scope); break;
			case 'LabeledStatement': statement(node.body, scope); break;
			case 'IfStatement': expression(node.test, scope); statement(node.consequent, scope); if (node.alternate) statement(node.alternate, scope); break;
			case 'WhileStatement': case 'DoWhileStatement': expression(node.test, scope); statement(node.body, scope); break;
			case 'ForStatement': {
				const loop = new Scope(scope);
				if (node.init?.type === 'VariableDeclaration') { declare(loop, [node.init]); statement(node.init, loop); } else if (node.init) expression(node.init, loop);
				if (node.test) expression(node.test, loop);
				if (node.update) expression(node.update, loop);
				statement(node.body, loop); break;
			}
			case 'ForOfStatement': {
				const loop = new Scope(scope);
				if (node.left.type === 'VariableDeclaration') { declare(loop, [node.left]); statement(node.left, loop); } else write(node.left, loop);
				expression(node.right, loop); statement(node.body, loop); break;
			}
			case 'SwitchStatement': {
				expression(node.discriminant, scope);
				const cases = new Scope(scope); declare(cases, node.cases.flatMap(item => item.consequent));
				for (const [index, item] of node.cases.entries()) {
					if (item.test) expression(item.test, cases);
					for (const child of item.consequent) statement(child, cases);
					if (index < node.cases.length - 1 && item.consequent.some(child => child.type !== 'EmptyStatement') && fallsThrough(item.consequent)) emit('CASE_FALLTHROUGH', item, {}, 'warning');
				} break;
			}
			case 'TryStatement': {
				statement(node.block, scope);
				if (node.handler) {
					const caught = new Scope(scope);
					if (node.handler.param) { bindPattern(caught, node.handler.param, true); bindingExpressions(node.handler.param, caught); }
					block(node.handler.body.body, caught);
				}
				if (node.finalizer) statement(node.finalizer, scope); break;
			}
		}
	}
	// 名前空間の変更は閉包や後続の文にもあり得るため、診断より先に全体を調べます。
	block(program.body, globals);
	while (pending.length) pending.pop()!();
	collecting = false;
	block(program.body, globals);
	while (pending.length) pending.pop()!();
	return output.sort((a, b) => a.pos.line - b.pos.line || a.pos.column - b.pos.column);
}
