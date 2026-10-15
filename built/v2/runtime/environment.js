import { runtimeError } from "./errors.js";

//#region src/v2/runtime/environment.ts
var Environment = class Environment {
	parent;
	bindings = /* @__PURE__ */ new Map();
	constructor(parent = null) {
		this.parent = parent;
	}
	declare(name, mutable) {
		if (!this.bindings.has(name)) this.bindings.set(name, {
			initialized: false,
			mutable,
			value: null
		});
	}
	resolve(name) {
		return this.bindings.get(name) ?? this.parent?.resolve(name);
	}
	read(name, pos) {
		const binding = this.resolve(name);
		if (!binding) throw runtimeError("UNBOUND_IDENTIFIER", pos, { name }, "ReferenceError");
		if (!binding.initialized) throw runtimeError("TDZ_ACCESS", pos, { name }, "ReferenceError");
		return binding.value;
	}
	write(name, value, pos, initialize = false) {
		const binding = initialize ? this.bindings.get(name) : this.resolve(name);
		if (!binding) throw runtimeError("UNBOUND_IDENTIFIER", pos, { name }, "ReferenceError");
		if (!initialize && !binding.initialized) throw runtimeError("TDZ_ACCESS", pos, { name }, "ReferenceError");
		if (!initialize && !binding.mutable) throw runtimeError("CONST_ASSIGNMENT", pos, { name }, "TypeError");
		binding.value = value;
		binding.initialized = true;
	}
	iteration() {
		const next = new Environment(this.parent);
		for (const [name, binding] of this.bindings) next.bindings.set(name, { ...binding });
		return next;
	}
};
function boundNames(pattern) {
	switch (pattern.type) {
		case "Identifier": return [pattern.name];
		case "MemberExpression": return [];
		case "AssignmentPattern": return boundNames(pattern.left);
		case "RestElement": return boundNames(pattern.argument);
		case "ArrayPattern": return pattern.elements.flatMap((p) => p ? boundNames(p) : []);
		case "ObjectPattern": return pattern.properties.flatMap((p) => boundNames(p.type === "RestElement" ? p.argument : p.value));
	}
}

//#endregion
export { Environment, boundNames };
//# sourceMappingURL=environment.js.map