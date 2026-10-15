//#region src/v2/checker/control-flow.ts
function sequence(statements) {
	let result = /* @__PURE__ */ new Set(["normal"]);
	for (const statement of statements) {
		if (!result.delete("normal")) break;
		result = /* @__PURE__ */ new Set([...result, ...completions(statement)]);
	}
	return result;
}
function mayThrow(node) {
	switch (node.type) {
		case "EmptyStatement":
		case "BreakStatement":
		case "ContinueStatement":
		case "FunctionDeclaration": return false;
		case "ReturnStatement": return node.argument !== null && node.argument.type !== "Literal" && node.argument.type !== "ArrowFunctionExpression";
		case "ExpressionStatement": return node.expression.type !== "Literal" && node.expression.type !== "ArrowFunctionExpression";
		case "BlockStatement": return node.body.some(mayThrow);
		case "LabeledStatement": return mayThrow(node.body);
		case "IfStatement": {
			let branch = node;
			while (branch?.type === "IfStatement") {
				if (branch.test.type !== "Literal" || mayThrow(branch.consequent)) return true;
				branch = branch.alternate;
			}
			return branch !== null && mayThrow(branch);
		}
		default: return true;
	}
}
function truthyLiteral(node) {
	if (node?.type === "Literal") return Boolean(node.value);
	return node?.type === "UnaryExpression" && (node.operator === "+" || node.operator === "-") && node.argument.type === "Literal" && typeof node.argument.value === "number" && Boolean(node.argument.value);
}
function completions(node, labels = []) {
	switch (node.type) {
		case "ReturnStatement": return /* @__PURE__ */ new Set(["return"]);
		case "ThrowStatement": return /* @__PURE__ */ new Set(["throw"]);
		case "BreakStatement": return /* @__PURE__ */ new Set([`break:${node.label?.name ?? ""}`]);
		case "ContinueStatement": return /* @__PURE__ */ new Set([`continue:${node.label?.name ?? ""}`]);
		case "BlockStatement": return sequence(node.body);
		case "IfStatement": {
			const result = /* @__PURE__ */ new Set();
			let branch = node;
			while (branch?.type === "IfStatement") {
				for (const value of completions(branch.consequent)) result.add(value);
				branch = branch.alternate;
			}
			for (const value of branch ? completions(branch) : ["normal"]) result.add(value);
			return result;
		}
		case "LabeledStatement": {
			const result = completions(node.body, [...labels, node.label.name]);
			if (result.delete(`break:${node.label.name}`)) result.add("normal");
			return result;
		}
		case "WhileStatement":
		case "ForStatement":
		case "ForOfStatement":
		case "DoWhileStatement": {
			const result = completions(node.body);
			const exits = result.delete("break:");
			let repeats = result.has("normal");
			if (result.delete("continue:")) repeats = true;
			for (const label of labels) if (result.delete(`continue:${label}`)) repeats = true;
			const test = node.type === "ForOfStatement" ? void 0 : node.test;
			const forever = node.type === "ForStatement" && test === null || truthyLiteral(test);
			if (forever) result.delete("normal");
			if (exits || !forever && (node.type !== "DoWhileStatement" || repeats)) result.add("normal");
			return result;
		}
		case "SwitchStatement": {
			const result = /* @__PURE__ */ new Set();
			let suffix = /* @__PURE__ */ new Set(["normal"]);
			for (let index = node.cases.length - 1; index >= 0; index--) {
				const current = sequence(node.cases[index].consequent);
				if (current.delete("normal")) for (const value of suffix) current.add(value);
				suffix = current;
				for (const value of current) result.add(value === "break:" ? "normal" : value);
			}
			if (!node.cases.some((item) => item.test === null)) result.add("normal");
			return result;
		}
		case "TryStatement": {
			const result = completions(node.block);
			if (node.handler && mayThrow(node.block)) {
				result.delete("throw");
				for (const value of completions(node.handler.body)) result.add(value);
			}
			if (!node.finalizer) return result;
			const final = completions(node.finalizer);
			if (!final.delete("normal")) return final;
			return /* @__PURE__ */ new Set([...result, ...final]);
		}
		default: return /* @__PURE__ */ new Set(["normal"]);
	}
}
function fallsThrough(statements) {
	return sequence(statements).has("normal");
}

//#endregion
export { fallsThrough };
//# sourceMappingURL=control-flow.js.map