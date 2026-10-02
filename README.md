# @syuilo/aiscript

[syuilo/aiscript](https://github.com/syuilo/aiscript) 1.2.1 を、このリポジトリに取り込んだものです。Play、ウィジェット、プラグインで使う AiScript の処理系(パーサー、インタプリタ、標準ライブラリ)の本体で、独自の言語拡張(新しい構文、型システム、標準ライブラリ、性能の改善)を加えるときの出発点にしています。

upstream には追従せず、同期もしません。このリポジトリが Misskey の upstream から独立して開発されているのと同じ方針です。ライセンスは MIT のままで、著作権表示は [LICENSE](./LICENSE) に残してあります。

ワークスペースのパッケージとして、同じ名前の `@syuilo/aiscript` で解決されます。[packages/frontend](../frontend) は `workspace:*` でこれを参照するので、npm 上の同名のパッケージは使われません。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `bun run --filter @syuilo/aiscript build` | ビルドする |
| `bun run --filter @syuilo/aiscript watch` | 監視してビルドを繰り返す |
| `bun run --filter @syuilo/aiscript test` | テストを実行する |
| `bun run --filter @syuilo/aiscript typecheck` | 型検査を行う |
| `bun run --filter @syuilo/aiscript repl` | 対話環境を開く |
| `bun run --filter @syuilo/aiscript start` | カレントディレクトリの `main.ais` を実行する |
| `bun run --filter @syuilo/aiscript parse` | カレントディレクトリの `main.ais` を構文木に変換して表示する |
