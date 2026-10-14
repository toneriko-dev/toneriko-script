import { TokenKind } from '../token.js';
import { TonerikoScriptSyntaxError } from '../../error.js';
import { parseExpr } from './expressions.js';
import type * as Ast from '../../node.js';
import type { ITokenStream } from '../streams/token-stream.js';

export function parseTsonTopLevel(s: ITokenStream): Ast.Node {
	let node: Ast.Node | null = null;

	while (s.is(TokenKind.NewLine)) {
		s.next();
	}

	while (!s.is(TokenKind.EOF)) {
		if (node == null) {
			node = parseExpr(s, true);
		} else {
			throw new TonerikoScriptSyntaxError('TSON only supports one top-level expression.', s.getPos());
		}
		
		switch (s.getTokenKind()) {
			case TokenKind.NewLine:
			case TokenKind.SemiColon: {
				while (s.is(TokenKind.NewLine) || s.is(TokenKind.SemiColon)) {
					s.next();
				}
				break;
			}
			case TokenKind.EOF: {
				break;
			}
			default: {
				throw new TonerikoScriptSyntaxError('Multiple statements cannot be placed on a single line.', s.getPos());
			}
		}
	}

	if (node == null) {
		throw new TonerikoScriptSyntaxError('TSON requires at least one top-level expression.', s.getPos());
	}

	return node;
}
