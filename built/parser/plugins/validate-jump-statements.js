import { TonerikoScriptSyntaxError } from "../../error.js";
import { visitNode } from "../visit.js";

//#region src/parser/plugins/validate-jump-statements.ts
function getClosestAncestorFunction(node, ancestors) {
	let child = node;
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const ancestor = ancestors[i];
		if (ancestor.type === "fn" && !ancestor.params.some((param) => param.default != null && param.default === child)) return ancestor;
		child = ancestor;
	}
}
function getCorrespondingBlock(ancestors, label) {
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const ancestor = ancestors[i];
		switch (ancestor.type) {
			case "loop":
			case "for":
			case "each":
				if (label != null && label !== ancestor.label) continue;
				return ancestor;
			case "if":
			case "match":
			case "block":
				if (label == null || label !== ancestor.label) continue;
				return ancestor;
			case "fn": return;
		}
	}
}
function validateNode(node, ancestors) {
	switch (node.type) {
		case "return":
			if (getClosestAncestorFunction(node, ancestors) === void 0) throw new TonerikoScriptSyntaxError("return must be inside function", node.loc.start);
			break;
		case "break": {
			const block = getCorrespondingBlock(ancestors, node.label);
			if (block == null) {
				if (node.label != null) throw new TonerikoScriptSyntaxError(`label "${node.label}" is not defined`, node.loc.start);
				throw new TonerikoScriptSyntaxError("unlabeled break must be inside for / each / while / do-while / loop", node.loc.start);
			}
			switch (block.type) {
				case "each":
					if (ancestors.includes(block.items)) throw new TonerikoScriptSyntaxError("break corresponding to each is not allowed in the target", node.loc.start);
					break;
				case "for":
					if (block.times != null && ancestors.includes(block.times)) throw new TonerikoScriptSyntaxError("break corresponding to for is not allowed in the count", node.loc.start);
					else if (ancestors.some((ancestor) => ancestor === block.from || ancestor === block.to)) throw new TonerikoScriptSyntaxError("break corresponding to for is not allowed in the range", node.loc.start);
					break;
				case "if":
					if (ancestors.includes(block.cond) || block.elseif.some(({ cond }) => ancestors.includes(cond))) throw new TonerikoScriptSyntaxError("break corresponding to if is not allowed in the condition", node.loc.start);
					break;
				case "match":
					if (ancestors.includes(block.about)) throw new TonerikoScriptSyntaxError("break corresponding to match is not allowed in the target", node.loc.start);
					if (block.qs.some(({ q }) => ancestors.includes(q))) throw new TonerikoScriptSyntaxError("break corresponding to match is not allowed in the pattern", node.loc.start);
			}
			if (node.expr != null) switch (block.type) {
				case "if":
				case "match":
				case "block": break;
				default: throw new TonerikoScriptSyntaxError("break corresponding to statement cannot include value", node.loc.start);
			}
			break;
		}
		case "continue": {
			const block = getCorrespondingBlock(ancestors, node.label);
			if (block == null) {
				if (node.label != null) throw new TonerikoScriptSyntaxError(`label "${node.label}" is not defined`, node.loc.start);
				throw new TonerikoScriptSyntaxError("continue must be inside for / each / while / do-while / loop", node.loc.start);
			} else switch (block.type) {
				case "each":
					if (ancestors.includes(block.items)) throw new TonerikoScriptSyntaxError("continue corresponding to each is not allowed in the target", node.loc.start);
					break;
				case "for":
					if (block.times != null && ancestors.includes(block.times)) throw new TonerikoScriptSyntaxError("continue corresponding to for is not allowed in the count", node.loc.start);
					else if (ancestors.some((ancestor) => ancestor === block.from || ancestor === block.to)) throw new TonerikoScriptSyntaxError("continue corresponding to for is not allowed in the range", node.loc.start);
					break;
				case "if": throw new TonerikoScriptSyntaxError("cannot use continue for if", node.loc.start);
				case "match": throw new TonerikoScriptSyntaxError("cannot use continue for match", node.loc.start);
				case "block": throw new TonerikoScriptSyntaxError("cannot use continue for eval", node.loc.start);
			}
			break;
		}
	}
	return node;
}
function validateJumpStatements(nodes) {
	for (const node of nodes) visitNode(node, validateNode);
	return nodes;
}

//#endregion
export { validateJumpStatements };
//# sourceMappingURL=validate-jump-statements.js.map