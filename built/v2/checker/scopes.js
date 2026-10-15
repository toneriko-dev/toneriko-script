import { combineProjections, projectBranch } from "../type-projection.js";

//#region src/v2/checker/scopes.ts
var Scope = class {
	parent;
	bindings = /* @__PURE__ */ new Map();
	constructor(parent) {
		this.parent = parent;
	}
	resolve(name) {
		for (let scope = this; scope; scope = scope.parent) {
			const binding = scope.bindings.get(name);
			if (binding) return binding;
		}
	}
	names() {
		const names = /* @__PURE__ */ new Set();
		for (let scope = this; scope; scope = scope.parent) for (const name of scope.bindings.keys()) names.add(name);
		return [...names];
	}
};
function propertyName(node) {
	return node.type === "Identifier" ? node.name : node.type === "Literal" ? String(node.value) : void 0;
}
const projectionAdapter = {
	kind: (type) => type.type === "ArrayTypeAnnotation" ? "array" : type.type === "ObjectTypeAnnotation" ? "object" : type.type === "KeywordTypeAnnotation" ? type.name : type.type === "FunctionTypeAnnotation" ? "function" : "union",
	element: (type) => type.elementType,
	keyword: (name, source) => ({
		type: "KeywordTypeAnnotation",
		name,
		loc: source.loc
	}),
	array: (elementType, source) => ({
		type: "ArrayTypeAnnotation",
		elementType,
		loc: source.loc
	}),
	property: (type, key) => {
		if (type.type !== "ObjectTypeAnnotation") return void 0;
		const property = type.properties.find((item) => propertyName(item.key) === key);
		if (!property) return void 0;
		return property.optional ? {
			type: "UnionTypeAnnotation",
			loc: property.loc,
			types: [property.typeAnnotation, {
				type: "KeywordTypeAnnotation",
				name: "null",
				loc: property.loc
			}]
		} : property.typeAnnotation;
	},
	objectRest: (type, excluded) => type.type === "ObjectTypeAnnotation" ? {
		...type,
		properties: type.properties.filter((property) => !excluded.has(propertyName(property.key)))
	} : void 0
};
function projectAnnotation(annotation, operation) {
	if (!annotation) return void 0;
	if (annotation.type === "ParenthesizedTypeAnnotation") return projectAnnotation(annotation.typeAnnotation, operation);
	if (annotation.type === "UnionTypeAnnotation") return combineProjections(annotation.types.map((type) => projectAnnotation(type, operation)), projectionAdapter, (types) => ({
		...annotation,
		types
	}), operation);
	return projectBranch(annotation, operation, projectionAdapter);
}
function project(annotation, key, array = false, rest = false) {
	return projectAnnotation(annotation, array ? {
		kind: "array",
		rest
	} : {
		kind: "property",
		key
	});
}
function objectRest(annotation, pattern) {
	if (!annotation || pattern.properties.some((item) => item.type === "Property" && item.computed && item.key.type !== "Literal")) return void 0;
	return projectAnnotation(annotation, {
		kind: "objectRest",
		excluded: new Set(pattern.properties.flatMap((item) => item.type === "RestElement" ? [] : [propertyName(item.key)]))
	});
}
function bindPattern(scope, pattern, mutable, inherited) {
	let annotation = "typeAnnotation" in pattern ? pattern.typeAnnotation ?? inherited : inherited;
	if (annotation && "optional" in pattern && pattern.optional) annotation = {
		type: "UnionTypeAnnotation",
		loc: annotation.loc,
		types: [annotation, {
			type: "KeywordTypeAnnotation",
			name: "null",
			loc: annotation.loc
		}]
	};
	switch (pattern.type) {
		case "Identifier":
			scope.bindings.set(pattern.name, {
				mutable,
				annotation
			});
			break;
		case "AssignmentPattern":
			bindPattern(scope, pattern.left, mutable, annotation);
			break;
		case "RestElement":
			bindPattern(scope, pattern.argument, mutable, annotation);
			break;
		case "ArrayPattern":
			for (const [index, item] of pattern.elements.entries()) if (item) bindPattern(scope, item, mutable, project(annotation, String(index), true, item.type === "RestElement"));
			break;
		case "ObjectPattern":
			if (!annotation) {
				for (const item of pattern.properties) bindPattern(scope, item.type === "RestElement" ? item : item.value, mutable);
				break;
			}
			for (const item of pattern.properties) if (item.type === "RestElement") bindPattern(scope, item, mutable, objectRest(annotation, pattern));
			else bindPattern(scope, item.value, mutable, !item.computed || item.key.type === "Literal" ? project(annotation, propertyName(item.key)) : void 0);
	}
}
function declare(scope, statements) {
	for (const item of statements) {
		const node = item.type === "ExportMetaDeclaration" ? item.declaration : item;
		if (node.type === "VariableDeclaration") for (const declaration of node.declarations) bindPattern(scope, declaration.id, node.kind === "let");
		if (node.type === "FunctionDeclaration") scope.bindings.set(node.id.name, { mutable: true });
	}
}

//#endregion
export { Scope, bindPattern, declare, objectRest, project, propertyName };
//# sourceMappingURL=scopes.js.map