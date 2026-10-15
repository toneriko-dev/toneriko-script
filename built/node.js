import { __exportAll } from "./_virtual/_rolldown/runtime.js";

//#region src/node.ts
var node_exports = /* @__PURE__ */ __exportAll({ isStatement: () => isStatement });
const statementTypes = /* @__PURE__ */ new Set([
	"def",
	"return",
	"each",
	"for",
	"loop",
	"break",
	"continue",
	"assign",
	"addAssign",
	"subAssign"
]);
function isStatement(x) {
	return statementTypes.has(x.type);
}

//#endregion
export { isStatement, node_exports };
//# sourceMappingURL=node.js.map