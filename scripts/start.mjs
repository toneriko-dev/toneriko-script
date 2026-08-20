import fs from 'fs';
import * as readline from 'readline';
import chalk from 'chalk';
import { Parser, Interpreter, errors, utils } from '@syuilo/aiscript';
const { AiScriptError } = errors;
const { valToString } = utils;

const i = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

const interpreter = new Interpreter({}, {
	in(q) {
		return new Promise(ok => {
			i.question(q + ': ', ok);
		});
	},
	out(value) {
		console.log(chalk.magenta(valToString(value, true)));
	},
	err(e) {
		console.log(chalk.red(`${e}`));
	},
	log(type, params) {
	}
});

const script = fs.readFileSync('./main.ais', 'utf8');
try {
	const ast = Parser.parse(script);
	await interpreter.exec(ast);
} catch (e) {
	if (e instanceof AiScriptError) {
		console.log(chalk.red(`${e}`));
	} else {
		throw e
	}
}
i.close();
