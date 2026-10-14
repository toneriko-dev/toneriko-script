import fs from 'fs';
import { Parser } from 'toneriko-script';
import { inspect } from 'util';

const script = fs.readFileSync('./main.tks', 'utf8');
const ast = Parser.parse(script);
console.log(inspect(ast, { depth: 10 }));
