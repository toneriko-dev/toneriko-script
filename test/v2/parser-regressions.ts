import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { nodeExecutable } from '../../scripts/v2-node.mjs';
import { parse } from '../../src/v2/parser/index.js';

describe('欠如値の比較の案内', () => {
	for (const operator of ['===', '!==', '==', '!=']) {
		for (const text of ['"undefined"', "'undefined'", '`undefined`', '"undef\\u0069ned"']) {
			for (const source of [`t ${operator} ${text}`, `${text} ${operator} t`]) {
				test(source, () => expect(() => parse(source)).toThrow(expect.objectContaining({ code: 'TYPEOF_UNDEFINED_COMPARISON' })));
			}
		}
	}
	for (const value of ['"undefined"', '`undefined`', '("undefined")']) {
		test(`case ${value}`, () => expect(() => parse(`switch (t) { case ${value}: break; }`)).toThrow(expect.objectContaining({ code: 'TYPEOF_UNDEFINED_COMPARISON' })));
	}
	for (const source of ['const text = "undefined";', 'const o = { undefined: 1 };', 't === `undefined${suffix}`', 'switch (t) { case "object": break; }']) {
		test(`比較以外の文字列: ${source}`, () => expect(() => parse(source)).not.toThrow());
	}
});

describe('strict mode の早期エラー', () => {
	const rejected: [string, string][] = [
		['delete x', 'STRICT_DELETE_IDENTIFIER'],
		['delete ((x))', 'STRICT_DELETE_IDENTIFIER'],
		['function f(x = 1) { "use strict"; }', 'STRICT_NON_SIMPLE_PARAMETERS'],
		['function f({ x }) { "use strict"; }', 'STRICT_NON_SIMPLE_PARAMETERS'],
		['function f([x]) { "use strict"; }', 'STRICT_NON_SIMPLE_PARAMETERS'],
		['function f(...x) { "use strict"; }', 'STRICT_NON_SIMPLE_PARAMETERS'],
		['(x = 1) => { "custom"; "use strict"; }', 'STRICT_NON_SIMPLE_PARAMETERS'],
		['async (...x) => { "use strict"; }', 'STRICT_NON_SIMPLE_PARAMETERS'],
	];
	for (const name of ['eval', 'arguments']) {
		const code = name === 'eval' ? 'EVAL' : 'ARGUMENTS';
		for (const source of [
			`let ${name};`, `const ${name} = 1;`, `let [${name}] = xs;`, `let {x: ${name}} = obj;`, `let {${name}} = obj;`,
			`const [...${name}] = xs;`, `const {...${name}} = obj;`, `function ${name}() {}`, `function f() { function ${name}() {} }`,
			`function f(${name}) {}`, `(${name}) => 1`, `(${name} = 1) => 1`, `({x: ${name}}) => 1`, `(...${name}) => 1`,
			`try {} catch (${name}) {}`, `try {} catch ({x: ${name}}) {}`, `for (let ${name} of []) {}`, `for (let ${name} = 0; false;) {}`,
		]) rejected.push([source, code]);
	}
	for (const [source, code] of rejected) {
		test(source, () => {
			const reference = spawnSync(nodeExecutable, ['--input-type=module', '--check'], { input: source, encoding: 'utf8', timeout: 5000 });
			expect(reference.error).toBeUndefined();
			expect(reference.status).toBe(1);
			expect(reference.stderr).toContain('SyntaxError');
			expect(() => parse(source)).toThrow(expect.objectContaining({ code }));
		});
	}
	for (const source of [
		'delete obj.x', 'delete obj["x"]', 'delete obj?.x',
		'function f(x) { "use strict"; }', 'x => { "use strict"; }',
		'function f(x = 1) { ("use strict"); }', 'function f(x = 1) { ; "use strict"; }',
		'function f(x = 1) { "use\\x20strict"; }', 'function f(x = 1) { `use strict`; }',
		'function f(x = 1) { "custom"; ("use strict"); }',
		'const { eval: x, arguments: y } = obj;', 'const obj = {eval: 1, arguments: 2};',
	]) {
		test(`受理: ${source}`, () => {
			const reference = spawnSync(nodeExecutable, ['--input-type=module', '--check'], { input: source, encoding: 'utf8', timeout: 5000 });
			expect(reference.error).toBeUndefined();
			expect(reference.status, reference.stderr).toBe(0);
			expect(() => parse(source)).not.toThrow();
		});
	}
});
