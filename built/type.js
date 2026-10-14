import { TonerikoScriptSyntaxError } from "./error.js";

//#region src/type.ts
function T_SIMPLE(name) {
	return {
		type: "simple",
		name
	};
}
function T_GENERIC(name, inners) {
	return {
		type: "generic",
		name,
		inners
	};
}
function T_FN(params, result) {
	return {
		type: "fn",
		params,
		result
	};
}
function T_PARAM(name) {
	return {
		type: "param",
		name
	};
}
function T_UNION(inners) {
	return {
		type: "union",
		inners
	};
}
function getTypeNameBySource(typeSource) {
	switch (typeSource.type) {
		case "namedTypeSource":
			if (typeSource.inner) {
				const inner = getTypeNameBySource(typeSource.inner);
				return `${typeSource.name}<${inner}>`;
			}
			return typeSource.name;
		case "fnTypeSource": return `@(${typeSource.params.map((param) => getTypeNameBySource(param)).join(", ")}) => ${getTypeNameBySource(typeSource.result)}`;
		case "unionTypeSource": return typeSource.inners.map((inner) => getTypeNameBySource(inner)).join(" | ");
	}
}
function getTypeBySource(typeSource, typeParams) {
	if (typeSource.type === "namedTypeSource") {
		const typeParam = typeParams?.find((param) => param.name === typeSource.name);
		if (typeParam != null && typeSource.inner == null) return T_PARAM(typeParam.name);
		switch (typeSource.name) {
			case "null":
			case "bool":
			case "num":
			case "str":
			case "error":
			case "never":
			case "any":
			case "void":
				if (typeSource.inner == null) return T_SIMPLE(typeSource.name);
				break;
			case "arr":
			case "obj": {
				let innerType;
				if (typeSource.inner != null) innerType = getTypeBySource(typeSource.inner, typeParams);
				else innerType = T_SIMPLE("any");
				return T_GENERIC(typeSource.name, [innerType]);
			}
		}
		throw new TonerikoScriptSyntaxError(`Unknown type: '${getTypeNameBySource(typeSource)}'`, typeSource.loc.start);
	} else if (typeSource.type === "fnTypeSource") {
		let fnTypeParams = typeSource.typeParams;
		if (typeParams != null) fnTypeParams = fnTypeParams.concat(typeParams);
		return T_FN(typeSource.params.map((param) => getTypeBySource(param, fnTypeParams)), getTypeBySource(typeSource.result, fnTypeParams));
	} else return T_UNION(typeSource.inners.map((inner) => getTypeBySource(inner, typeParams)));
}

//#endregion
export { T_FN, T_GENERIC, T_PARAM, T_SIMPLE, T_UNION, getTypeBySource, getTypeNameBySource };
//# sourceMappingURL=type.js.map