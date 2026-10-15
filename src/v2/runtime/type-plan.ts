import type * as A from '../ast.js';
import { parsedTypeAnnotations } from '../type-metadata.js';
import { compileType, isComposite, type TypeCheck } from './type-checks.js';

export type PatternCheck = { check: TypeCheck; explicit: boolean };
const nullable = (check: TypeCheck): TypeCheck => ({ kind: 'union', types: [check, { kind: 'null' }] });

export function projectType(check: TypeCheck, key: string | null, rest = false): TypeCheck {
	return { kind: 'projection', source: check, operation: { kind: 'key', key, rest } };
}

export function restType(check: TypeCheck, excluded: ReadonlySet<string>): TypeCheck {
	return { kind: 'projection', source: check, operation: { kind: 'rest', excluded } };
}

export class TypePlan {
	readonly patterns = new WeakMap<A.Pattern | A.MemberExpression, PatternCheck>();
	readonly returns = new WeakMap<A.FunctionDeclaration | A.ArrowFunctionExpression, TypeCheck>();
	readonly compositeNames = new Set<string>();
	private readonly programs = new WeakSet<A.Program>();
	hasTypes = false;

	/** 構文木は変更せず、明示注釈から得た型だけを束縛へ対応付ける。 */
	prepare(program: A.Program): boolean {
		if (this.programs.has(program)) return false;
		this.programs.add(program);
		if (parsedTypeAnnotations(program) === false) return true;
		const pending: A.Node[] = [program];
		while (pending.length) {
			const node = pending.pop()!;
			if (node.type === 'VariableDeclarator') this.pattern(node.id);
			if (node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression') {
				for (const parameter of node.params) this.pattern(parameter);
				if (node.returnType) { this.hasTypes = true; this.returns.set(node, compileType(node.returnType)); }
			}
			if (node.type === 'CatchClause' && node.param) this.pattern(node.param);
			for (const [key, value] of Object.entries(node)) {
				if (key === 'loc' || key === 'typeAnnotation' || key === 'returnType') continue;
				if (Array.isArray(value)) {
					for (const child of value) if (child && typeof child === 'object' && 'type' in child) pending.push(child);
				} else if (value && typeof value === 'object' && 'type' in value) pending.push(value as A.Node);
			}
		}
		return true;
	}

	project(pattern: A.Pattern | A.MemberExpression, check: TypeCheck): WeakMap<A.Pattern | A.MemberExpression, PatternCheck> {
		const projected = new TypePlan();
		projected.pattern(pattern, check);
		return projected.patterns;
	}

	private names(pattern: A.Pattern | A.MemberExpression): string[] {
		switch (pattern.type) {
			case 'Identifier': return [pattern.name];
			case 'MemberExpression': return [];
			case 'AssignmentPattern': return this.names(pattern.left);
			case 'RestElement': return this.names(pattern.argument);
			case 'ArrayPattern': return pattern.elements.flatMap(part => part ? this.names(part) : []);
			case 'ObjectPattern': return pattern.properties.flatMap(property => this.names(property.type === 'RestElement' ? property.argument : property.value as A.Pattern));
		}
	}

	private pattern(pattern: A.Pattern | A.MemberExpression, inherited?: TypeCheck): void {
		const annotation = 'typeAnnotation' in pattern ? pattern.typeAnnotation : undefined;
		let check = annotation ? compileType(annotation) : inherited;
		if (check && 'optional' in pattern && pattern.optional) check = nullable(check);
		if (check) {
			this.hasTypes = true;
			this.patterns.set(pattern, { check, explicit: !!annotation });
		}
		switch (pattern.type) {
			case 'Identifier': if (check && isComposite(check)) this.compositeNames.add(pattern.name); break;
			case 'AssignmentPattern': this.pattern(pattern.left, check); break;
			case 'RestElement': this.pattern(pattern.argument, check); break;
			case 'ArrayPattern':
				for (const part of pattern.elements) if (part) this.pattern(part, check ? projectType(check, null, part.type === 'RestElement') : undefined);
				break;
			case 'ObjectPattern': {
				const removed = new Set(pattern.properties.flatMap(property => property.type === 'RestElement' || property.computed ? [] : [property.key.type === 'Identifier' ? property.key.name : String((property.key as A.Literal).value)]));
				for (const property of pattern.properties) {
					if (property.type === 'RestElement') {
						const rest = check ? restType(check, removed) : undefined;
						this.pattern(property, rest);
					} else {
						const key = !property.computed ? property.key.type === 'Identifier' ? property.key.name : String((property.key as A.Literal).value) : property.key.type === 'Literal' ? String(property.key.value) : null;
						if (key === null) for (const name of this.names(property.value as A.Pattern)) this.compositeNames.add(name);
						this.pattern(property.value as A.Pattern, check ? projectType(check, key) : undefined);
					}
				}
				break;
			}
		}
	}
}
