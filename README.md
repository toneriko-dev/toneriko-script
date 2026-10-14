# Toneriko Script

Misskey (Toneriko) の Play、ウィジェット、プラグインで使うスクリプト言語の処理系(パーサー、インタプリタ、標準ライブラリ)です。[AiScript](https://github.com/syuilo/aiscript) 1.2.1 から分かれた言語で、独自の言語拡張(新しい構文、型システム、標準ライブラリ、性能の改善)を加えるときの出発点にしています。

upstream には追従せず、同期もしません。このフォークを使う Misskey (Toneriko) が、Misskey の upstream から独立して開発されているのと同じ方針です。ライセンスは MIT のままで、著作権表示は [LICENSE](./LICENSE) に残してあります。

パッケージ名は `toneriko-script` で、upstream の `@syuilo/aiscript` とは別のパッケージです。分かれた時点の構文は AiScript 1.2.1 と同じなので、AiScript のスクリプトはそのまま動きます。名前は次のように変えています。

| AiScript | Toneriko Script |
| --- | --- |
| 言語名 | Toneriko Script |
| `AiScriptError` などのエラーの class | `TonerikoScriptError` など。エラーの `name` は `TonerikoScript` |
| データ記法の AiSON (`AiSON.parse`、`AiSON.stringify`) | TSON (`TSON.parse`、`TSON.stringify`) |
| `AISCRIPT_VERSION` | `TONERIKO_SCRIPT_VERSION` |
| ファイルの拡張子 `.is`、`.ais` | `.tks` |

## コマンド

| コマンド | 内容 |
| --- | --- |
| `bun run build` | ビルドする |
| `bun run watch` | 監視してビルドを繰り返す |
| `bun run test` | テストを実行する |
| `bun run typecheck` | 型検査を行う |
| `bun run repl` | 対話環境を開く |
| `bun run start` | カレントディレクトリの `main.tks` を実行する |
| `bun run parse` | カレントディレクトリの `main.tks` を構文木に変換して表示する |

## Misskey から使う

[Misskey (Toneriko)](https://github.com/haru0416-dev/misskey) は、このリポジトリのタグを git の依存として `"toneriko-script": "github:toneriko-dev/toneriko-script#v<版>"` の形で参照します。main には `built/` を置かず、タグのコミットにだけビルド済みの `built/` が入ります。依存として入れるときにビルドが走らないので、利用側に esbuild や TypeScript は要りません。npm には公開していません。

タグは GitHub Actions の release workflow で作ります。`package.json` の `version` を上げて main に push してから、workflow を手動で実行します。workflow はテストとビルドを通したあと、`built/` を足したコミットに `v<版>` のタグを付けて push します。同じ版のタグがあれば止まります。
