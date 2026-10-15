import { parsedTypeAnnotations } from "../type-metadata.js";
import { compileType, isComposite, prepareType } from "./type-checks.js";

//#region src/v2/runtime/type-plan.ts
const nullable = (check) => ({
	kind: "union",
	types: [check, { kind: "null" }]
});
function projectType(check, key, rest = false) {
	return {
		kind: "projection",
		source: check,
		operation: {
			kind: "key",
			key,
			rest
		}
	};
}
function restType(check, excluded) {
	return {
		kind: "projection",
		source: check,
		operation: {
			kind: "rest",
			excluded
		}
	};
}
var TypePlan = class TypePlan {
	patterns = /* @__PURE__ */ new WeakMap();
	returns = /* @__PURE__ */ new WeakMap();
	compositeNames = /* @__PURE__ */ new Set();
	programs = /* @__PURE__ */ new WeakSet();
	projections = /* @__PURE__ */ new WeakMap();
	hasTypes = false;
	/** 構文木は変更せず、明示注釈から得た型だけを束縛へ対応付ける。 */
	prepare(program) {
		if (this.programs.has(program)) return false;
		this.programs.add(program);
		if (parsedTypeAnnotations(program) === false) return true;
		const pending = [program];
		while (pending.length) {
			const node = pending.pop();
			if (node.type === "VariableDeclarator") this.pattern(node.id);
			if (node.type === "FunctionDeclaration" || node.type === "ArrowFunctionExpression") {
				for (const parameter of node.params) this.pattern(parameter);
				if (node.returnType) {
					this.hasTypes = true;
					this.returns.set(node, compileType(node.returnType));
				}
			}
			if (node.type === "CatchClause" && node.param) this.pattern(node.param);
			for (const [key, value] of Object.entries(node)) {
				if (key === "loc" || key === "typeAnnotation" || key === "returnType") continue;
				if (Array.isArray(value)) {
					for (const child of value) if (child && typeof child === "object" && "type" in child) pending.push(child);
				} else if (value && typeof value === "object" && "type" in value) pending.push(value);
			}
		}
		return true;
	}
	project(pattern, source, key) {
		let sources = this.projections.get(pattern);
		if (!sources) {
			sources = /* @__PURE__ */ new WeakMap();
			this.projections.set(pattern, sources);
		}
		let paths = sources.get(source);
		if (!paths) {
			paths = /* @__PURE__ */ new Map();
			sources.set(source, paths);
		}
		const path = typeof key === "string" ? key : null;
		const cached = paths.get(path);
		if (cached) return cached;
		const projected = new TypePlan();
		projected.pattern(pattern, typeof key === "string" ? projectType(source, key) : restType(source, key));
		paths.set(path, projected.patterns);
		return projected.patterns;
	}
	*projectDynamic(pattern, source, key, tick) {
		const projection = /* @__PURE__ */ new WeakMap();
		let steps = 0;
		const step = () => {
			tick();
			return ++steps % 64 === 0;
		};
		const original = this.patterns;
		function* build(part, inherited) {
			if (step()) yield;
			const annotation = "typeAnnotation" in part ? part.typeAnnotation : void 0;
			let check = annotation ? original.get(part)?.check : inherited;
			if (!annotation && check && "optional" in part && part.optional) check = nullable(check);
			if (check) {
				projection.set(part, {
					check,
					explicit: !!annotation,
					transient: true
				});
				yield* prepareType(check, step);
			}
			if (!check) return;
			if (part.type === "AssignmentPattern") yield* build(part.left, check);
			else if (part.type === "RestElement") yield* build(part.argument, check);
			else if (part.type === "ArrayPattern") {
				for (const item of part.elements) if (item) yield* build(item, check ? projectType(check, null, item.type === "RestElement") : void 0);
				else if (step()) yield;
			} else if (part.type === "ObjectPattern") {
				let dynamic = false;
				const removed = /* @__PURE__ */ new Set();
				for (const property of part.properties) {
					if (step()) yield;
					if (property.type === "RestElement") continue;
					if (property.computed && property.key.type !== "Literal") dynamic = true;
					else removed.add(property.key.type === "Identifier" ? property.key.name : String(property.key.value));
				}
				for (const property of part.properties) if (property.type === "RestElement") yield* build(property, check && !dynamic ? restType(check, removed) : void 0);
				else {
					const dynamicKey = property.computed && property.key.type !== "Literal";
					const key = property.key.type === "Identifier" ? property.key.name : String(property.key.value);
					yield* build(property.value, check && !dynamicKey ? projectType(check, key) : void 0);
				}
			}
		}
		yield* build(pattern, projectType(source, key));
		return projection;
	}
	names(pattern) {
		switch (pattern.type) {
			case "Identifier": return [pattern.name];
			case "MemberExpression": return [];
			case "AssignmentPattern": return this.names(pattern.left);
			case "RestElement": return this.names(pattern.argument);
			case "ArrayPattern": return pattern.elements.flatMap((part) => part ? this.names(part) : []);
			case "ObjectPattern": return pattern.properties.flatMap((property) => this.names(property.type === "RestElement" ? property.argument : property.value));
		}
	}
	pattern(pattern, inherited) {
		const annotation = "typeAnnotation" in pattern ? pattern.typeAnnotation : void 0;
		let check = annotation ? compileType(annotation) : inherited;
		if (check && "optional" in pattern && pattern.optional) check = nullable(check);
		if (check) {
			this.hasTypes = true;
			this.patterns.set(pattern, {
				check,
				explicit: !!annotation
			});
		}
		switch (pattern.type) {
			case "Identifier":
				if (check && isComposite(check)) this.compositeNames.add(pattern.name);
				break;
			case "AssignmentPattern":
				this.pattern(pattern.left, check);
				break;
			case "RestElement":
				this.pattern(pattern.argument, check);
				break;
			case "ArrayPattern":
				for (const part of pattern.elements) if (part) this.pattern(part, check ? projectType(check, null, part.type === "RestElement") : void 0);
				break;
			case "ObjectPattern": {
				const dynamic = pattern.properties.some((property) => property.type !== "RestElement" && property.computed && property.key.type !== "Literal");
				const removed = new Set(pattern.properties.flatMap((property) => property.type === "RestElement" || property.computed && property.key.type !== "Literal" ? [] : [property.key.type === "Identifier" ? property.key.name : String(property.key.value)]));
				for (const property of pattern.properties) if (property.type === "RestElement") {
					const rest = check && !dynamic ? restType(check, removed) : void 0;
					this.pattern(property, rest);
				} else {
					const key = !property.computed ? property.key.type === "Identifier" ? property.key.name : String(property.key.value) : property.key.type === "Literal" ? String(property.key.value) : null;
					if (key === null) for (const name of this.names(property.value)) this.compositeNames.add(name);
					this.pattern(property.value, check ? projectType(check, key) : void 0);
				}
				break;
			}
		}
	}
};

//#endregion
export { TypePlan, projectType, restType };
//# sourceMappingURL=type-plan.js.map