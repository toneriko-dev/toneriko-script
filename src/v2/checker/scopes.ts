import type * as A from '../ast.js';
import { projectBranch, combineProjections, type ProjectionAdapter, type ProjectionOperation } from '../type-projection.js';

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

const projectionAdapter: ProjectionAdapter<A.TypeAnnotation> = {
	kind: type => type.type === 'ArrayTypeAnnotation' ? 'array' : type.type === 'ObjectTypeAnnotation' ? 'object' : type.type === 'KeywordTypeAnnotation' ? type.name : type.type === 'FunctionTypeAnnotation' ? 'function' : 'union',
	element: type => (type as A.ArrayTypeAnnotation).elementType,
	keyword: (name, source) => ({ type: 'KeywordTypeAnnotation', name, loc: source.loc }),
	array: (elementType, source) => ({ type: 'ArrayTypeAnnotation', elementType, loc: source.loc }),
	property: (type, key) => {
		if (type.type !== 'ObjectTypeAnnotation') return undefined;
		const property = type.properties.find(item => propertyName(item.key) === key);
		if (!property) return undefined;
		return property.optional ? { type: 'UnionTypeAnnotation', loc: property.loc, types: [property.typeAnnotation, { type: 'KeywordTypeAnnotation', name: 'null', loc: property.loc }] } : property.typeAnnotation;
	},
	objectRest: (type, excluded) => type.type === 'ObjectTypeAnnotation' ? { ...type, properties: type.properties.filter(property => !excluded.has(propertyName(property.key)!)) } : undefined,
};

function projectAnnotation(annotation: A.TypeAnnotation | undefined, operation: ProjectionOperation): A.TypeAnnotation | undefined {
	if (!annotation) return undefined;
	if (annotation.type === 'ParenthesizedTypeAnnotation') return projectAnnotation(annotation.typeAnnotation, operation);
	if (annotation.type === 'UnionTypeAnnotation') {
		return combineProjections(annotation.types.map(type => projectAnnotation(type, operation)), projectionAdapter, types => ({ ...annotation, types }), operation);
	}
	return projectBranch(annotation, operation, projectionAdapter);
}

export function project(annotation: A.TypeAnnotation | undefined, key: string, array = false, rest = false): A.TypeAnnotation | undefined {
	return projectAnnotation(annotation, array ? { kind: 'array', rest } : { kind: 'property', key });
}

export function objectRest(annotation: A.TypeAnnotation | undefined, pattern: A.ObjectPattern): A.TypeAnnotation | undefined {
	if (!annotation || pattern.properties.some(item => item.type === 'Property' && item.computed && item.key.type !== 'Literal')) return undefined;
	const excluded = new Set(pattern.properties.flatMap(item => item.type === 'RestElement' ? [] : [propertyName(item.key)!]));
	return projectAnnotation(annotation, { kind: 'objectRest', excluded });
}

export function bindPattern(scope: Scope, pattern: A.Pattern | A.MemberExpression, mutable: boolean, inherited?: A.TypeAnnotation): void {
	let annotation = 'typeAnnotation' in pattern ? pattern.typeAnnotation ?? inherited : inherited;
	if (annotation && 'optional' in pattern && pattern.optional) annotation = { type: 'UnionTypeAnnotation', loc: annotation.loc, types: [annotation, { type: 'KeywordTypeAnnotation', name: 'null', loc: annotation.loc }] };
	switch (pattern.type) {
		case 'Identifier': scope.bindings.set(pattern.name, { mutable, annotation }); break;
		case 'AssignmentPattern': bindPattern(scope, pattern.left, mutable, annotation); break;
		case 'RestElement': bindPattern(scope, pattern.argument, mutable, annotation); break;
		case 'ArrayPattern':
			for (const [index, item] of pattern.elements.entries()) if (item) bindPattern(scope, item, mutable, project(annotation, String(index), true, item.type === 'RestElement'));
			break;
		case 'ObjectPattern': {
			if (!annotation) {
				for (const item of pattern.properties) bindPattern(scope, item.type === 'RestElement' ? item : item.value as A.Pattern, mutable);
				break;
			}
			for (const item of pattern.properties) {
				if (item.type === 'RestElement') bindPattern(scope, item, mutable, objectRest(annotation, pattern));
				else bindPattern(scope, item.value as A.Pattern, mutable, !item.computed || item.key.type === 'Literal' ? project(annotation, propertyName(item.key)!) : undefined);
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
