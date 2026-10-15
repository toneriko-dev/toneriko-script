import { runtimeError } from "./errors.js";
import { isStdFunction } from "../stdlib/core.js";
import { isScriptFunction, valueTypeof } from "./brands.js";
import "./values.js";
import { combineProjections, projectBranch } from "../type-projection.js";

//#region src/v2/runtime/type-checks.ts
function objectCheck(properties) {
	return {
		kind: "object",
		properties,
		byKey: new Map(properties.map((property) => [property.key, property]))
	};
}
function compileType(annotation) {
	const compiled = /* @__PURE__ */ new Map();
	const pending = [{
		node: annotation,
		ready: false
	}];
	while (pending.length) {
		const { node, ready } = pending.pop();
		if (!ready) {
			pending.push({
				node,
				ready: true
			});
			const children = node.type === "ParenthesizedTypeAnnotation" ? [node.typeAnnotation] : node.type === "ArrayTypeAnnotation" ? [node.elementType] : node.type === "UnionTypeAnnotation" ? node.types : node.type === "ObjectTypeAnnotation" ? node.properties.map((property) => property.typeAnnotation) : [];
			for (const child of children) pending.push({
				node: child,
				ready: false
			});
			continue;
		}
		switch (node.type) {
			case "KeywordTypeAnnotation":
				compiled.set(node, { kind: node.name });
				break;
			case "FunctionTypeAnnotation":
				compiled.set(node, { kind: "function" });
				break;
			case "ParenthesizedTypeAnnotation":
				compiled.set(node, compiled.get(node.typeAnnotation));
				break;
			case "ArrayTypeAnnotation":
				compiled.set(node, {
					kind: "array",
					element: compiled.get(node.elementType)
				});
				break;
			case "UnionTypeAnnotation":
				compiled.set(node, {
					kind: "union",
					types: node.types.map((part) => compiled.get(part))
				});
				break;
			case "ObjectTypeAnnotation": compiled.set(node, objectCheck(node.properties.map((property) => ({
				key: property.key.type === "Identifier" ? property.key.name : String(property.key.value),
				optional: property.optional,
				check: compiled.get(property.typeAnnotation)
			}))));
		}
	}
	return compiled.get(annotation);
}
const projectionAdapter = {
	kind: (type) => type.kind,
	element: (type) => type.element,
	keyword: (kind) => ({ kind }),
	array: (element) => ({
		kind: "array",
		element
	}),
	property: (type, key) => {
		if (type.kind !== "object") return void 0;
		const property = type.byKey.get(key);
		return property ? property.optional ? {
			kind: "union",
			types: [property.check, { kind: "null" }]
		} : property.check : void 0;
	},
	objectRest: () => void 0
};
/** 投影の展開は検査時に限り、広い合併型や rest の作業も実行予算に含める。 */
function* resolveType(check, tick) {
	if (check.kind !== "projection") return check;
	if (check.resolved !== void 0) return check.resolved ?? void 0;
	if (tick()) yield;
	const source = yield* resolveType(check.source, tick);
	if (!source) {
		check.resolved = null;
		return;
	}
	const operation = check.operation.kind === "rest" ? {
		kind: "objectRest",
		excluded: check.operation.excluded
	} : check.operation.key === null ? {
		kind: "array",
		rest: check.operation.rest
	} : {
		kind: "property",
		key: check.operation.key
	};
	let result;
	if (source.kind === "union") {
		const types = [];
		for (const part of source.types) types.push(yield* resolveType({
			kind: "projection",
			source: part,
			operation: check.operation
		}, tick));
		result = combineProjections(types, projectionAdapter, (types) => ({
			kind: "union",
			types
		}), operation);
	} else {
		let rest;
		if (operation.kind === "objectRest" && source.kind === "object") {
			const properties = [];
			for (const property of source.properties) {
				if (!operation.excluded.has(property.key)) properties.push(property);
				if (tick()) yield;
			}
			rest = objectCheck(properties);
		}
		result = projectBranch(source, operation, {
			...projectionAdapter,
			objectRest: () => rest
		});
	}
	check.resolved = result ?? null;
	return result;
}
/** 動的キーで初めて必要になった射影の展開にも実行予算を使う。 */
function* prepareType(check, tick) {
	yield* resolveType(check, tick);
}
function resolvedType(check) {
	const iterator = resolveType(check, () => false);
	let result = iterator.next();
	while (!result.done) result = iterator.next();
	return result.value ?? { kind: "any" };
}
function typeName(check) {
	const parts = [];
	const pending = [check];
	while (pending.length) {
		const part = pending.pop();
		if (typeof part === "string") {
			parts.push(part);
			continue;
		}
		switch (part.kind) {
			case "projection":
				pending.push(resolvedType(part));
				break;
			case "array": {
				const element = part.element.kind === "projection" ? resolvedType(part.element) : part.element;
				if (element.kind === "union") pending.push(")[]", element, "(");
				else pending.push("[]", element);
				break;
			}
			case "object":
				pending.push(" }");
				for (let i = part.properties.length - 1; i >= 0; i--) {
					const property = part.properties[i];
					if (i < part.properties.length - 1) pending.push(", ");
					pending.push(property.check, `${property.key}${property.optional ? "?" : ""}: `);
				}
				pending.push("{ ");
				break;
			case "union":
				for (let i = part.types.length - 1; i >= 0; i--) {
					if (i < part.types.length - 1) pending.push(" | ");
					pending.push(part.types[i]);
				}
				break;
			case "function":
				parts.push("Function");
				break;
			default: parts.push(part.kind);
		}
	}
	return parts.join("");
}
function isComposite(check) {
	return check.kind === "array" || check.kind === "object" || check.kind === "union" || check.kind === "projection";
}
function matchesOuter(check, value) {
	switch (check.kind) {
		case "projection": return matchesOuter(resolvedType(check), value);
		case "any": return true;
		case "void":
		case "null": return value === null;
		case "function": return typeof value === "function" || isScriptFunction(value) || isStdFunction(value);
		case "array": return Array.isArray(value);
		case "object": return value !== null && typeof value === "object" && !Array.isArray(value) && !isScriptFunction(value) && !isStdFunction(value);
		case "union": return check.types.some((part) => matchesOuter(part, value));
		default: return typeof value === check.kind;
	}
}
function summary(value) {
	if (typeof value === "string") return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
	if (value === null) return "null";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return "[…]";
	return valueTypeof(value) === "function" || typeof value === "function" ? "Function" : "{…}";
}
function fail(failure, pos) {
	throw runtimeError("TYPE_ANNOTATION_MISMATCH", pos, {
		name: failure.name,
		expected: typeName(failure.check),
		actual: failure.missing ? "missing" : failure.value === null ? "null" : Array.isArray(failure.value) ? "array" : valueTypeof(failure.value),
		value: summary(failure.value)
	}, "TypeError");
}
function checkScalar(check, value, name, pos) {
	if (typeof value === check.kind || check.kind === "any" || (check.kind === "null" || check.kind === "void") && value === null) return;
	if (check.kind === "function" && matchesOuter(check, value)) return;
	fail({
		name,
		check,
		value
	}, pos);
}
/** コピー前に射影だけを展開し、同じコピーの走査内で要素を検査する。 */
function copiedArrayType(check) {
	const resolved = resolvedType(check);
	return resolved.kind === "array" ? resolved : void 0;
}
/** コピーの取得直後に外形を確かめ、途中で譲らず実際に束縛する値を守る。 */
function checkCopiedElement(check, value, name, index, pos, diagnosticName, tick) {
	if (!(check.kind === "union" || check.kind === "projection" ? matchesShallow(check, value, () => {
		tick();
		return false;
	}).next().value === true : matchesOuter(check, value))) fail({
		name: diagnosticName(`${name}[${index}]`),
		check,
		value
	}, pos);
}
/** 合併の枝にも同じ予算を使い、要素の検査では入れ子の外形までに留める。 */
function* matchesShallow(check, value, tick, state = { first: true }) {
	const resolved = yield* resolveType(check, tick);
	if (!resolved) return true;
	check = resolved;
	if (check.kind !== "union") {
		const pause = state.first ? false : tick();
		state.first = false;
		const matched = matchesOuter(check, value);
		if (pause) yield;
		return matched;
	}
	for (const part of check.types) if (yield* matchesShallow(part, value, tick, state)) return true;
	return false;
}
/** 入れ子の要素は外形だけを調べ、合併型の枝を選ぶときには深さを減らさない。 */
function* mismatch(check, value, name, properties, pos, tick) {
	const resolved = yield* resolveType(check, tick);
	if (!resolved) return null;
	check = resolved;
	if (check.kind === "union") {
		for (const part of check.types) {
			const pause = tick();
			const failure = yield* mismatch(part, value, name, properties, pos, tick);
			if (pause) yield;
			if (failure === null) return null;
		}
		return {
			name,
			check,
			value
		};
	}
	if (!matchesOuter(check, value)) return {
		name,
		check,
		value
	};
	if (check.kind === "array") {
		const length = value.length;
		for (let i = 0; i < length; i++) {
			const pause = tick();
			const item = properties.get(value, i, pos);
			if (!(check.element.kind === "union" || check.element.kind === "projection" ? yield* matchesShallow(check.element, item, tick) : matchesOuter(check.element, item))) return {
				name: `${name}[${i}]`,
				check: check.element,
				value: item
			};
			if (pause) yield;
		}
	} else if (check.kind === "object") for (const property of check.properties) {
		const pause = tick();
		if (!properties.has(value, property.key, pos)) {
			if (!property.optional) return {
				name: `${name}.${property.key}`,
				check: property.check,
				value: null,
				missing: true
			};
		} else {
			const item = properties.get(value, property.key, pos);
			if (!(property.check.kind === "union" || property.check.kind === "projection" ? yield* matchesShallow(property.check, item, tick) : matchesOuter(property.check, item))) return {
				name: `${name}.${property.key}`,
				check: property.check,
				value: item
			};
		}
		if (pause) yield;
	}
	return null;
}
function* checkValue(check, value, name, properties, pos, tick, diagnosticName) {
	let steps = 0;
	const step = () => {
		tick();
		return ++steps % 64 === 0;
	};
	if (check.kind === "projection") {
		const projected = yield* resolveType(check, step);
		if (!projected || projected.kind === "any") return;
		check = projected;
	}
	step();
	const failure = yield* mismatch(check, value, name, properties, pos, step);
	if (failure) {
		if (diagnosticName) failure.name = diagnosticName(failure.name);
		fail(failure, pos);
	}
}

//#endregion
export { checkCopiedElement, checkScalar, checkValue, compileType, copiedArrayType, isComposite, matchesOuter, objectCheck, prepareType, typeName };
//# sourceMappingURL=type-checks.js.map