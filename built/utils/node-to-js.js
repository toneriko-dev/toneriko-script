//#region src/utils/node-to-js.ts
function nodeToJs(node) {
	switch (node.type) {
		case "arr": return node.value.map((item) => nodeToJs(item));
		case "bool": return node.value;
		case "null": return null;
		case "num": return node.value;
		case "obj": return Object.fromEntries([...node.value.entries()].map(([key, value]) => [key, nodeToJs(value)]));
		case "str": return node.value;
		default: return;
	}
}

//#endregion
export { nodeToJs };
//# sourceMappingURL=node-to-js.js.map