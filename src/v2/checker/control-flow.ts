import type * as A from '../ast.js';

type Completion = string;
function sequence(statements: readonly A.Statement[]): Set<Completion> {
	let result = new Set(['normal']);
	for (const statement of statements) {
		if (!result.delete('normal')) break;
		result = new Set([...result, ...completions(statement)]);
	}
	return result;
}
// 値の読み取りや呼出しは例外になり得るため、確実に安全な文だけを除きます。
function mayThrow(node: A.Statement): boolean {
	switch (node.type) {
		case 'EmptyStatement': case 'BreakStatement': case 'ContinueStatement': case 'FunctionDeclaration': return false;
		case 'ReturnStatement': return node.argument !== null && node.argument.type !== 'Literal' && node.argument.type !== 'ArrowFunctionExpression';
		case 'ExpressionStatement': return node.expression.type !== 'Literal' && node.expression.type !== 'ArrowFunctionExpression';
		case 'BlockStatement': return node.body.some(mayThrow);
		case 'LabeledStatement': return mayThrow(node.body);
		case 'IfStatement': return node.test.type !== 'Literal' || mayThrow(node.consequent) || !!node.alternate && mayThrow(node.alternate);
		default: return true;
	}
}
function completions(node: A.Statement, labels: readonly string[] = []): Set<Completion> {
	switch (node.type) {
		case 'ReturnStatement': return new Set(['return']);
		case 'ThrowStatement': return new Set(['throw']);
		case 'BreakStatement': return new Set([`break:${node.label?.name ?? ''}`]);
		case 'ContinueStatement': return new Set([`continue:${node.label?.name ?? ''}`]);
		case 'BlockStatement': return sequence(node.body);
		case 'IfStatement': return new Set([...completions(node.consequent), ...(node.alternate ? completions(node.alternate) : ['normal'])]);
		case 'LabeledStatement': {
			const result = completions(node.body, [...labels, node.label.name]);
			if (result.delete(`break:${node.label.name}`)) result.add('normal');
			return result;
		}
		case 'WhileStatement': case 'ForStatement': case 'ForOfStatement': case 'DoWhileStatement': {
			const result = completions(node.body);
			const exits = result.delete('break:');
			let repeats = result.has('normal');
			if (result.delete('continue:')) repeats = true;
			for (const label of labels) if (result.delete(`continue:${label}`)) repeats = true;
			const test = node.type === 'ForOfStatement' ? undefined : node.test;
			const forever = node.type === 'ForStatement' && test === null || test?.type === 'Literal' && test.value === true;
			if (forever) result.delete('normal');
			if (exits || !forever && (node.type !== 'DoWhileStatement' || repeats)) result.add('normal');
			return result;
		}
		case 'SwitchStatement': {
			const result = new Set<Completion>();
			let suffix = new Set<Completion>(['normal']);
			for (let index = node.cases.length - 1; index >= 0; index--) {
				const current = sequence(node.cases[index]!.consequent);
				if (current.delete('normal')) for (const value of suffix) current.add(value);
				suffix = current;
				for (const value of current) result.add(value === 'break:' ? 'normal' : value);
			}
			if (!node.cases.some(item => item.test === null)) result.add('normal');
			return result;
		}
		case 'TryStatement': {
			const result = completions(node.block);
			if (node.handler && mayThrow(node.block)) {
				result.delete('throw');
				for (const value of completions(node.handler.body)) result.add(value);
			}
			if (!node.finalizer) return result;
			const final = completions(node.finalizer);
			if (!final.delete('normal')) return final;
			return new Set([...result, ...final]);
		}
		default: return new Set(['normal']);
	}
}
export function fallsThrough(statements: readonly A.Statement[]): boolean { return sequence(statements).has('normal'); }
