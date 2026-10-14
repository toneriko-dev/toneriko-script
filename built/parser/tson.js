import { nodeToJs } from "../utils/node-to-js.js";
import { jsToVal, stringifyObjectKey } from "../interpreter/util.js";
import { Scanner } from "./scanner.js";
import { parseTsonTopLevel } from "./syntaxes/tson.js";

//#region src/parser/tson.ts
var TSON = class {
	static parse(input) {
		const scanner = new Scanner(input);
		const ast = parseTsonTopLevel(scanner);
		return nodeToJs(ast);
	}
	static stringifyWalk(value, indent, currentIndent = "", processingObjects = /* @__PURE__ */ new Set()) {
		switch (value.type) {
			case "bool": return value.value ? "true" : "false";
			case "null": return "null";
			case "num":
				if (!Number.isFinite(value.value)) throw new TypeError("Cannot stringify non-finite number as TSON.");
				return Object.is(value.value, -0) ? "-0" : value.value.toString();
			case "str": return JSON.stringify(value.value);
			case "arr":
				if (value.value.length === 0) return "[]";
				if (processingObjects.has(value.value)) throw new TypeError("Cannot stringify circular TSON value.");
				processingObjects.add(value.value);
				try {
					const items = Array.from({ length: value.value.length }, (_, index) => {
						const item = value.value[index];
						return item === void 0 ? "null" : this.stringifyWalk(item, indent, currentIndent + (indent ?? ""), processingObjects);
					});
					if (indent != null && indent !== "") return `[\n${currentIndent + indent}${items.join(`,\n${currentIndent + indent}`)}\n${currentIndent}]`;
					return `[${items.join(", ")}]`;
				} finally {
					processingObjects.delete(value.value);
				}
			case "obj": {
				const keys = [...value.value.keys()];
				if (keys.length === 0) return "{}";
				if (processingObjects.has(value.value)) throw new TypeError("Cannot stringify circular TSON value.");
				processingObjects.add(value.value);
				try {
					const items = keys.map((key) => {
						const val = value.value.get(key);
						return `${stringifyObjectKey(key)}: ${this.stringifyWalk(val, indent, currentIndent + (indent ?? ""), processingObjects)}`;
					});
					if (indent != null && indent !== "") return `{\n${currentIndent + indent}${items.join(`,\n${currentIndent + indent}`)}\n${currentIndent}}`;
					return `{${items.join(", ")}}`;
				} finally {
					processingObjects.delete(value.value);
				}
			}
			default: throw new Error(`Cannot stringify value of type: ${value.type}`);
		}
	}
	static stringify(value, _unused = null, indent = 0) {
		let _indent = null;
		if (typeof indent === "number") {
			const width = Math.min(10, Math.max(0, Math.trunc(indent)));
			if (width > 0) _indent = " ".repeat(width);
		} else {
			const normalizedIndent = indent.slice(0, 10);
			if (normalizedIndent.length > 0) _indent = normalizedIndent;
		}
		const aisValue = jsToVal(value);
		return this.stringifyWalk(aisValue, _indent);
	}
};

//#endregion
export { TSON };
//# sourceMappingURL=tson.js.map