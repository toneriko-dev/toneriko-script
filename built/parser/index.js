import { Scanner } from "./scanner.js";
import { parseTopLevel } from "./syntaxes/toplevel.js";
import { validateJumpStatements } from "./plugins/validate-jump-statements.js";
import { validateKeyword } from "./plugins/validate-keyword.js";
import { validateType } from "./plugins/validate-type.js";

//#region src/parser/index.ts
var Parser = class Parser {
	static instance;
	plugins;
	constructor() {
		this.plugins = {
			validate: [
				validateKeyword,
				validateType,
				validateJumpStatements
			],
			transform: []
		};
	}
	static parse(input) {
		if (Parser.instance == null) Parser.instance = new Parser();
		return Parser.instance.parse(input);
	}
	addPlugin(type, plugin) {
		switch (type) {
			case "validate":
				this.plugins.validate.push(plugin);
				break;
			case "transform":
				this.plugins.transform.push(plugin);
				break;
			default: throw new Error("unknown plugin type");
		}
	}
	parse(input) {
		let nodes;
		const scanner = new Scanner(input);
		nodes = parseTopLevel(scanner);
		for (const plugin of this.plugins.validate) nodes = plugin(nodes);
		for (const plugin of this.plugins.transform) nodes = plugin(nodes);
		return nodes;
	}
};

//#endregion
export { Parser };
//# sourceMappingURL=index.js.map