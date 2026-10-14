import { TonerikoScriptSyntaxError } from "../../error.js";
import { visitNode } from "../visit.js";

//#region src/parser/plugins/validate-keyword.ts
const reservedWord = [
	"null",
	"true",
	"false",
	"each",
	"for",
	"loop",
	"do",
	"while",
	"break",
	"continue",
	"match",
	"case",
	"default",
	"if",
	"elif",
	"else",
	"return",
	"eval",
	"var",
	"let",
	"exists",
	"as",
	"async",
	"attr",
	"attribute",
	"await",
	"catch",
	"class",
	"component",
	"constructor",
	"dictionary",
	"enum",
	"export",
	"finally",
	"fn",
	"hash",
	"in",
	"interface",
	"out",
	"private",
	"public",
	"ref",
	"static",
	"struct",
	"table",
	"this",
	"throw",
	"trait",
	"try",
	"undefined",
	"use",
	"using",
	"when",
	"yield",
	"import",
	"is",
	"meta",
	"module",
	"namespace",
	"new"
];
function validateName(name, pos) {
	if (reservedWord.includes(name)) throwReservedWordError(name, pos);
}
function validateTypeName(name, pos) {
	if (name === "null") return;
	validateName(name, pos);
}
function throwReservedWordError(name, pos) {
	throw new TonerikoScriptSyntaxError(`Reserved word "${name}" cannot be used as variable name.`, pos);
}
function validateDest(node) {
	return visitNode(node, (node) => {
		switch (node.type) {
			case "null":
				throwReservedWordError(node.type, node.loc.start);
				break;
			case "bool":
				throwReservedWordError(`${node.value}`, node.loc.start);
				break;
			case "identifier": validateName(node.name, node.loc.start);
		}
		return node;
	});
}
function validateTypeParams(node) {
	for (const typeParam of node.typeParams) validateTypeName(typeParam.name, node.loc.start);
}
function validateNode(node) {
	switch (node.type) {
		case "def":
			validateDest(node.dest);
			break;
		case "ns":
		case "attr":
		case "identifier":
			validateName(node.name, node.loc.start);
			break;
		case "meta":
			if (node.name != null) validateName(node.name, node.loc.start);
			break;
		case "each":
			if (node.label != null) validateName(node.label, node.loc.start);
			validateDest(node.var);
			break;
		case "for":
			if (node.label != null) validateName(node.label, node.loc.start);
			if (node.var != null) validateName(node.var, node.loc.start);
			break;
		case "loop":
			if (node.label != null) validateName(node.label, node.loc.start);
			break;
		case "break":
			if (node.label != null) validateName(node.label, node.loc.start);
			break;
		case "continue":
			if (node.label != null) validateName(node.label, node.loc.start);
			break;
		case "fn":
			validateTypeParams(node);
			for (const param of node.params) validateDest(param.dest);
			break;
		case "namedTypeSource":
			validateTypeName(node.name, node.loc.start);
			break;
		case "fnTypeSource": validateTypeParams(node);
	}
	return node;
}
function validateKeyword(nodes) {
	for (const inner of nodes) visitNode(inner, validateNode);
	return nodes;
}

//#endregion
export { validateKeyword };
//# sourceMappingURL=validate-keyword.js.map