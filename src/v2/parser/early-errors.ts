import type * as A from '../ast.js';
import { syntaxError } from '../diagnostics.js';

function names(pattern: A.Pattern | A.MemberExpression): A.Identifier[] {
	switch (pattern.type) {
		case 'Identifier': return [pattern];
		case 'AssignmentPattern': return names(pattern.left);
		case 'RestElement': return names(pattern.argument);
		case 'ArrayPattern': return pattern.elements.flatMap(element => element ? names(element) : []);
		case 'ObjectPattern': return pattern.properties.flatMap(property => names(property.type === 'RestElement' ? property.argument : property.value as A.Pattern));
		case 'MemberExpression': return [];
	}
}

function add(bindings: Set<string>, id: A.Identifier): void {
	checkBinding(id);
	if (bindings.has(id.name)) throw syntaxError('DUPLICATE_DECLARATION', id.loc.start, { name: id.name });
	bindings.add(id.name);
}

function checkBinding(id: A.Identifier): void {
	if (id.name === 'eval' || id.name === 'arguments') throw syntaxError(id.name === 'eval' ? 'EVAL' : 'ARGUMENTS', id.loc.start);
}

function checkDirective(node: A.FunctionDeclaration | A.ArrowFunctionExpression): void {
	if (node.body.type !== 'BlockStatement' || node.params.every(param => param.type === 'Identifier')) return;
	for (const statement of node.body.body) {
		if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'Literal' || typeof statement.expression.value !== 'string') break;
		const expression = statement.expression;
		// 括弧付きの文字列は Directive Prologue に含めない。
		if (statement.loc.start.line !== expression.loc.start.line || statement.loc.start.column !== expression.loc.start.column) break;
		if (expression.raw === '"use strict"' || expression.raw === "'use strict'") throw syntaxError('STRICT_NON_SIMPLE_PARAMETERS', expression.loc.start);
	}
}

function scope(body: A.Statement[], parameters: A.Pattern[] = [], functionBody = false): void {
	const lexical = new Set<string>();
	for (const parameter of parameters) for (const id of names(parameter)) add(lexical, id);
	const functions: A.Identifier[] = [];
	for (const statement of body) {
		const declaration = statement.type === 'ExportMetaDeclaration' ? statement.declaration : statement;
		if (declaration.type === 'VariableDeclaration') {
			for (const item of declaration.declarations) for (const id of names(item.id)) add(lexical, id);
		} else if (declaration.type === 'FunctionDeclaration') {
			checkBinding(declaration.id);
			if (functionBody) functions.push(declaration.id);
			else add(lexical, declaration.id);
		}
	}
	if (functionBody) {
		// 関数本体の関数宣言は引数や他の関数宣言と同名にできますが、字句宣言とは衝突します。
		const locals = new Set(body.flatMap(statement => statement.type === 'VariableDeclaration' ? statement.declarations.flatMap(item => names(item.id).map(id => id.name)) : []));
		for (const id of functions) if (locals.has(id.name)) throw syntaxError('DUPLICATE_DECLARATION', id.loc.start, { name: id.name });
	}
}

export function checkEarlyErrors(program: A.Program): void {
	const pending: A.Node[] = [program];
	// 対象演算子の子を訪問し終える位置だけを積み、通常の節には深さの記録を作りません。
	const operatorScopes: number[] = [];
	while (pending.length) {
		while (operatorScopes.length && pending.length <= operatorScopes[operatorScopes.length - 1]!) operatorScopes.pop();
		const node = pending.pop()!;
		// 括弧を省いた AST の経路で数え、別々の枝や文の演算子は合算しません。
		if (node.type === 'UnaryExpression' || node.type === 'AwaitExpression' || (node.type === 'BinaryExpression' && node.operator === '**')) {
			if (operatorScopes.length >= 1024) throw syntaxError('NESTING_TOO_DEEP', node.loc.start);
			operatorScopes.push(pending.length);
		}
		const begin = pending.length;
		switch (node.type) {
			case 'Program': scope(node.body); break;
			case 'BlockStatement': scope(node.body); break;
			case 'SwitchStatement': scope(node.cases.flatMap(item => item.consequent)); break;
			case 'FunctionDeclaration':
			case 'ArrowFunctionExpression': {
				checkDirective(node);
				scope(node.body.type === 'BlockStatement' ? node.body.body : [], node.params, true);
				for (const param of node.params) pending.push(param);
				// 本体を通常のブロックとして再検査すると、許される関数宣言の重複も拒否してしまいます。
				if (node.body.type === 'BlockStatement') for (const statement of node.body.body) pending.push(statement);
				else pending.push(node.body);
				break;
			}
			case 'CatchClause':
				scope(node.body.body, node.param ? [node.param] : []);
				if (node.param) pending.push(node.param);
				for (const statement of node.body.body) pending.push(statement);
				break;
			case 'ForStatement':
				if (node.init?.type === 'VariableDeclaration') scope([node.init]);
				break;
			case 'ForOfStatement':
				if (node.left.type === 'VariableDeclaration') scope([node.left]);
				break;
		}
		if (node.type !== 'FunctionDeclaration' && node.type !== 'ArrowFunctionExpression' && node.type !== 'CatchClause') {
			for (const key in node) {
				if (key === 'loc' || key === 'typeAnnotation' || key === 'returnType') continue;
				const value = (node as unknown as Record<string, unknown>)[key];
				if (Array.isArray(value)) {
					for (const child of value) if (child && typeof child === 'object' && 'type' in child) pending.push(child as A.Node);
				} else if (value && typeof value === 'object' && 'type' in value) pending.push(value as A.Node);
			}
		}
		// 子は元の順で検査し、構文木の長い連鎖も再帰呼び出しにしません。
		for (let left = begin, right = pending.length - 1; left < right; left++, right--) {
			[pending[left], pending[right]] = [pending[right]!, pending[left]!];
		}
	}
}
