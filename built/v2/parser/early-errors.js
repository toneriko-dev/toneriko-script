import { syntaxError } from "../diagnostics.js";

//#region src/v2/parser/early-errors.ts
function names(pattern) {
	switch (pattern.type) {
		case "Identifier": return [pattern];
		case "AssignmentPattern": return names(pattern.left);
		case "RestElement": return names(pattern.argument);
		case "ArrayPattern": return pattern.elements.flatMap((element) => element ? names(element) : []);
		case "ObjectPattern": return pattern.properties.flatMap((property) => names(property.type === "RestElement" ? property.argument : property.value));
		case "MemberExpression": return [];
	}
}
function add(bindings, id) {
	checkBinding(id);
	if (bindings.has(id.name)) throw syntaxError("DUPLICATE_DECLARATION", id.loc.start, { name: id.name });
	bindings.add(id.name);
}
function checkBinding(id) {
	if (id.name === "eval" || id.name === "arguments") throw syntaxError(id.name === "eval" ? "EVAL" : "ARGUMENTS", id.loc.start);
}
function checkDirective(node) {
	if (node.body.type !== "BlockStatement" || node.params.every((param) => param.type === "Identifier")) return;
	for (const statement of node.body.body) {
		if (statement.type !== "ExpressionStatement" || statement.expression.type !== "Literal" || typeof statement.expression.value !== "string") break;
		const expression = statement.expression;
		if (statement.loc.start.line !== expression.loc.start.line || statement.loc.start.column !== expression.loc.start.column) break;
		if (expression.raw === "\"use strict\"" || expression.raw === "'use strict'") throw syntaxError("STRICT_NON_SIMPLE_PARAMETERS", expression.loc.start);
	}
}
function scope(body, parameters = [], functionBody = false) {
	const lexical = /* @__PURE__ */ new Set();
	for (const parameter of parameters) for (const id of names(parameter)) add(lexical, id);
	const functions = [];
	for (const statement of body) {
		const declaration = statement.type === "ExportMetaDeclaration" ? statement.declaration : statement;
		if (declaration.type === "VariableDeclaration") for (const item of declaration.declarations) for (const id of names(item.id)) add(lexical, id);
		else if (declaration.type === "FunctionDeclaration") {
			checkBinding(declaration.id);
			if (functionBody) functions.push(declaration.id);
			else add(lexical, declaration.id);
		}
	}
	if (functionBody) {
		const locals = new Set(body.flatMap((statement) => statement.type === "VariableDeclaration" ? statement.declarations.flatMap((item) => names(item.id).map((id) => id.name)) : []));
		for (const id of functions) if (locals.has(id.name)) throw syntaxError("DUPLICATE_DECLARATION", id.loc.start, { name: id.name });
	}
}
function checkEarlyErrors(program) {
	const pending = [program];
	const operatorScopes = [];
	while (pending.length) {
		while (operatorScopes.length && pending.length <= operatorScopes[operatorScopes.length - 1]) operatorScopes.pop();
		const node = pending.pop();
		if (node.type === "UnaryExpression" || node.type === "AwaitExpression" || node.type === "BinaryExpression" && node.operator === "**") {
			if (operatorScopes.length >= 1024) throw syntaxError("NESTING_TOO_DEEP", node.loc.start);
			operatorScopes.push(pending.length);
		}
		const begin = pending.length;
		switch (node.type) {
			case "Program":
				scope(node.body);
				break;
			case "BlockStatement":
				scope(node.body);
				break;
			case "SwitchStatement":
				scope(node.cases.flatMap((item) => item.consequent));
				break;
			case "FunctionDeclaration":
			case "ArrowFunctionExpression":
				checkDirective(node);
				scope(node.body.type === "BlockStatement" ? node.body.body : [], node.params, true);
				for (const param of node.params) pending.push(param);
				if (node.body.type === "BlockStatement") for (const statement of node.body.body) pending.push(statement);
				else pending.push(node.body);
				break;
			case "CatchClause":
				scope(node.body.body, node.param ? [node.param] : []);
				if (node.param) pending.push(node.param);
				for (const statement of node.body.body) pending.push(statement);
				break;
			case "ForStatement":
				if (node.init?.type === "VariableDeclaration") scope([node.init]);
				break;
			case "ForOfStatement": if (node.left.type === "VariableDeclaration") scope([node.left]);
		}
		if (node.type !== "FunctionDeclaration" && node.type !== "ArrowFunctionExpression" && node.type !== "CatchClause") for (const key in node) {
			if (key === "loc" || key === "typeAnnotation" || key === "returnType") continue;
			const value = node[key];
			if (Array.isArray(value)) {
				for (const child of value) if (child && typeof child === "object" && "type" in child) pending.push(child);
			} else if (value && typeof value === "object" && "type" in value) pending.push(value);
		}
		for (let left = begin, right = pending.length - 1; left < right; left++, right--) [pending[left], pending[right]] = [pending[right], pending[left]];
	}
}

//#endregion
export { checkEarlyErrors };
//# sourceMappingURL=early-errors.js.map