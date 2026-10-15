//#region src/v2/type-projection.ts
/** 構文型と実行時型で、分割できない枝を同じ規則で除く。 */
function projectBranch(type, operation, adapter) {
	const kind = adapter.kind(type);
	if (kind === "any") return type;
	if (operation.kind === "array") {
		if (kind === "object") return adapter.keyword("any", type);
		if (kind === "array") return operation.rest ? type : adapter.element(type);
		if (kind === "string") return operation.rest ? adapter.array(type, type) : type;
		return;
	}
	if (kind === "null") return void 0;
	if (operation.kind === "objectRest") return adapter.objectRest(type, operation.excluded) ?? adapter.keyword("any", type);
	if (kind === "array") {
		if (/^(0|[1-9][0-9]*)$/.test(operation.key) && Number(operation.key) < 4294967295) return adapter.element(type);
		return adapter.keyword(operation.key === "length" ? "number" : "any", type);
	}
	return adapter.property(type, operation.key) ?? adapter.keyword("any", type);
}
function combineProjections(parts, adapter, union, operation) {
	const types = [];
	for (const part of parts) {
		if (part === void 0) continue;
		if (adapter.kind(part) === "any") return part;
		types.push(part);
	}
	if (types.length === 0) return void 0;
	if (types.length === 1) return types[0];
	if (operation?.kind === "array" && operation.rest) return adapter.array(union(types.map((type) => adapter.element(type))), types[0]);
	return union(types);
}

//#endregion
export { combineProjections, projectBranch };
//# sourceMappingURL=type-projection.js.map