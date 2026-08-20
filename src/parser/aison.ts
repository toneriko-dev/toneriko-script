import { nodeToJs } from '../utils/node-to-js.js';
import { Scanner } from './scanner.js';
import { parseAiSonTopLevel } from './syntaxes/aison.js';
import { jsToVal, stringifyObjectKey } from '../interpreter/util.js';
import type { JsValue } from '../interpreter/util.js';
import type { Value } from '../interpreter/value.js';

export class AiSON {
	public static parse(input: string): JsValue {
		const scanner = new Scanner(input);
		const ast = parseAiSonTopLevel(scanner);

		return nodeToJs(ast);
	}

	private static stringifyWalk(value: Value, indent: string | null, currentIndent = '', processingObjects = new Set<object>()): string {
		switch (value.type) {
			case 'bool': return value.value ? 'true' : 'false';
			case 'null': return 'null';
			case 'num': {
				if (!Number.isFinite(value.value)) throw new TypeError('Cannot stringify non-finite number as AiSON.');
				return Object.is(value.value, -0) ? '-0' : value.value.toString();
			}
			case 'str': return JSON.stringify(value.value);
			case 'arr': {
				if (value.value.length === 0) return '[]';
				if (processingObjects.has(value.value)) throw new TypeError('Cannot stringify circular AiSON value.');
				processingObjects.add(value.value);
				try {
					const items = Array.from({ length: value.value.length }, (_, index) => {
						const item = value.value[index];
						return item === undefined
							? 'null'
							: this.stringifyWalk(item, indent, currentIndent + (indent ?? ''), processingObjects);
					});
					if (indent != null && indent !== '') {
						return `[\n${currentIndent + indent}${items.join(`,\n${currentIndent + indent}`)}\n${currentIndent}]`;
					} else {
						return `[${items.join(', ')}]`;
					}
				} finally {
					processingObjects.delete(value.value);
				}
			}
			case 'obj': {
				const keys = [...value.value.keys()];
				if (keys.length === 0) return '{}';
				if (processingObjects.has(value.value)) throw new TypeError('Cannot stringify circular AiSON value.');
				processingObjects.add(value.value);
				try {
					const items = keys.map(key => {
						const val = value.value.get(key)!;
						return `${stringifyObjectKey(key)}: ${this.stringifyWalk(val, indent, currentIndent + (indent ?? ''), processingObjects)}`;
					});
					if (indent != null && indent !== '') {
						return `{\n${currentIndent + indent}${items.join(`,\n${currentIndent + indent}`)}\n${currentIndent}}`;
					} else {
						return `{${items.join(', ')}}`;
					}
				} finally {
					processingObjects.delete(value.value);
				}
			}
			default:
				throw new Error(`Cannot stringify value of type: ${value.type}`);
		}
	}

	public static stringify(value: JsValue, _unused = null, indent: number | string = 0): string {
		let _indent: string | null = null;
		if (typeof indent === 'number') {
			const width = Math.min(10, Math.max(0, Math.trunc(indent)));
			if (width > 0) {
				_indent = ' '.repeat(width);
			}
		} else {
			const normalizedIndent = indent.slice(0, 10);
			if (normalizedIndent.length > 0) {
				_indent = normalizedIndent;
			}
		}

		const aisValue = jsToVal(value);

		return this.stringifyWalk(aisValue, _indent);
	}
}
