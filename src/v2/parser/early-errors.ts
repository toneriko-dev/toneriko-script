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
	if (bindings.has(id.name)) throw syntaxError('DUPLICATE_DECLARATION', id.loc.start, { name: id.name });
	bindings.add(id.name);
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
	function visit(node: A.Node): void {
		switch (node.type) {
			case 'Program': scope(node.body); break;
			case 'BlockStatement': scope(node.body); break;
			case 'SwitchStatement': scope(node.cases.flatMap(item => item.consequent)); break;
			case 'FunctionDeclaration':
			case 'ArrowFunctionExpression': {
				scope(node.body.type === 'BlockStatement' ? node.body.body : [], node.params, true);
				for (const param of node.params) visit(param);
				// 本体を通常のブロックとして再検査すると、許される関数宣言の重複も拒否してしまいます。
				if (node.body.type === 'BlockStatement') for (const statement of node.body.body) visit(statement);
				else visit(node.body);
				return;
			}
			case 'CatchClause':
				scope(node.body.body, node.param ? [node.param] : []);
				if (node.param) visit(node.param);
				for (const statement of node.body.body) visit(statement);
				return;
			case 'ForStatement':
				if (node.init?.type === 'VariableDeclaration') scope([node.init]);
				break;
			case 'ForOfStatement':
				if (node.left.type === 'VariableDeclaration') scope([node.left]);
				break;
		}
		for (const [key, value] of Object.entries(node)) {
			if (key === 'loc' || key === 'typeAnnotation' || key === 'returnType') continue;
			if (Array.isArray(value)) {
				for (const child of value) if (child && typeof child === 'object' && 'type' in child) visit(child as A.Node);
			} else if (value && typeof value === 'object' && 'type' in value) visit(value as A.Node);
		}
	}
	visit(program);
}
