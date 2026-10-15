import type * as A from '../ast.js';

export type Binding = { mutable: boolean; annotation?: A.TypeAnnotation; global?: boolean };
export class Scope {
	readonly bindings = new Map<string, Binding>();
	constructor(readonly parent?: Scope) {}
	resolve(name: string): Binding | undefined {
		for (let scope: Scope | undefined = this; scope; scope = scope.parent) { const binding = scope.bindings.get(name); if (binding) return binding; }
		return undefined;
	}
	names(): string[] {
		const names = new Set<string>();
		for (let scope: Scope | undefined = this; scope; scope = scope.parent) for (const name of scope.bindings.keys()) names.add(name);
		return [...names];
	}
}

export function propertyName(node: A.Identifier | A.Literal | A.Expression): string | undefined {
	return node.type === 'Identifier' ? node.name : node.type === 'Literal' ? String(node.value) : undefined;
}

export function project(annotation: A.TypeAnnotation | undefined, key: string, array = false): A.TypeAnnotation | undefined {
	if (!annotation) return undefined;
	if (annotation.type === 'ParenthesizedTypeAnnotation') return project(annotation.typeAnnotation, key, array);
	if (annotation.type === 'UnionTypeAnnotation') {
		const types = annotation.types.map(type => project(type, key, array));
		return types.every((type): type is A.TypeAnnotation => !!type) ? { ...annotation, types } : undefined;
	}
	if (annotation.type === 'ArrayTypeAnnotation') {
		if (array || /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295) return annotation.elementType;
		return { type: 'KeywordTypeAnnotation', name: key === 'length' ? 'number' : 'any', loc: annotation.loc };
	}
	if (!array && annotation.type === 'ObjectTypeAnnotation') {
		const property = annotation.properties.find(item => propertyName(item.key) === key);
		if (!property) return undefined;
		return property.optional ? { type: 'UnionTypeAnnotation', loc: property.loc, types: [property.typeAnnotation, { type: 'KeywordTypeAnnotation', name: 'null', loc: property.loc }] } : property.typeAnnotation;
	}
	return annotation.type === 'KeywordTypeAnnotation' && annotation.name === 'any' ? annotation : undefined;
}

export function bindPattern(scope: Scope, pattern: A.Pattern | A.MemberExpression, mutable: boolean, inherited?: A.TypeAnnotation): void {
	let annotation = 'typeAnnotation' in pattern ? pattern.typeAnnotation ?? inherited : inherited;
	if (annotation && 'optional' in pattern && pattern.optional) annotation = { type: 'UnionTypeAnnotation', loc: annotation.loc, types: [annotation, { type: 'KeywordTypeAnnotation', name: 'null', loc: annotation.loc }] };
	switch (pattern.type) {
		case 'Identifier': scope.bindings.set(pattern.name, { mutable, annotation }); break;
		case 'AssignmentPattern': bindPattern(scope, pattern.left, mutable, annotation); break;
		case 'RestElement': bindPattern(scope, pattern.argument, mutable, annotation); break;
		case 'ArrayPattern':
			for (const [index, item] of pattern.elements.entries()) if (item) bindPattern(scope, item, mutable, item.type === 'RestElement' ? annotation : project(annotation, String(index), true));
			break;
		case 'ObjectPattern': {
			if (!annotation) {
				for (const item of pattern.properties) bindPattern(scope, item.type === 'RestElement' ? item : item.value as A.Pattern, mutable);
				break;
			}
			const dynamic = pattern.properties.some(item => item.type === 'Property' && item.computed && item.key.type !== 'Literal');
			const used = new Set(pattern.properties.filter(item => item.type === 'Property' && (!item.computed || item.key.type === 'Literal')).map(item => propertyName((item as A.Property).key)));
			for (const item of pattern.properties) {
				if (item.type === 'RestElement') {
					let rest = annotation;
					while (rest?.type === 'ParenthesizedTypeAnnotation') rest = rest.typeAnnotation;
					bindPattern(scope, item, mutable, !dynamic && rest?.type === 'ObjectTypeAnnotation' ? { ...rest, properties: rest.properties.filter(property => !used.has(propertyName(property.key))) } : undefined);
				} else bindPattern(scope, item.value as A.Pattern, mutable, !item.computed || item.key.type === 'Literal' ? project(annotation, propertyName(item.key)!) : undefined);
			}
			break;
		}
		case 'MemberExpression': break;
	}
}

export function declare(scope: Scope, statements: readonly A.Statement[]): void {
	for (const item of statements) {
		const node = item.type === 'ExportMetaDeclaration' ? item.declaration : item;
		if (node.type === 'VariableDeclaration') for (const declaration of node.declarations) bindPattern(scope, declaration.id, node.kind === 'let');
		if (node.type === 'FunctionDeclaration') scope.bindings.set(node.id.name, { mutable: true });
	}
}
