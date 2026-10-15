<div align="center">
  <a href="https://github.com/toneriko-dev"><img src=".github/assets/toneriko-icon.svg" width="72" height="72" alt="Toneriko"></a>

  <h1>Toneriko Script</h1>

  <p>Misskey (Toneriko) の Play・ウィジェット・プラグインで動くスクリプト言語</p>

  <p>
    <a href="https://github.com/toneriko-dev/toneriko-script/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/toneriko-dev/toneriko-script/test.yml?branch=main&style=flat-square&label=test" alt="test"></a>
    <a href="https://github.com/toneriko-dev/toneriko-script/tags"><img src="https://img.shields.io/github/v/tag/toneriko-dev/toneriko-script?style=flat-square&color=26739f&label=release" alt="release"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-434d54?style=flat-square" alt="MIT"></a>
  </p>

  <p>
    <a href="#名前の対応">名前の対応</a>
    ·
    <a href="#次の版">次の版</a>
    ·
    <a href="#コマンド">コマンド</a>
    ·
    <a href="#misskey-から使う">Misskey から使う</a>
  </p>

  <sub><a href="https://github.com/toneriko-dev">Toneriko</a> の部品</sub>
</div>

<br>

[AiScript](https://github.com/syuilo/aiscript) 1.2.1 から分かれた言語の処理系(パーサー、インタプリタ、標準ライブラリ)です。upstream には追従していません。分かれた時点の構文は AiScript 1.2.1 と同じなので、AiScript のスクリプトはそのまま動きます。

## 名前の対応

| AiScript | Toneriko Script |
| --- | --- |
| `@syuilo/aiscript` | `toneriko-script` |
| `AiScriptError` など | `TonerikoScriptError` など(`name` は `TonerikoScript`) |
| AiSON(`AiSON.parse`、`AiSON.stringify`) | TSON(`TSON.parse`、`TSON.stringify`) |
| `AISCRIPT_VERSION` | `TONERIKO_SCRIPT_VERSION` |
| `.is`、`.ais` | `.tks` |

## 次の版

Toneriko Script 2 を作っています。AiScript の構文をやめ、JavaScript の小さな部分集合と型注釈に作り直す版です。設計は [docs/design/toneriko-script-2.md](./docs/design/toneriko-script-2.md)、実装は [v2 ブランチ](https://github.com/toneriko-dev/toneriko-script/tree/v2) にあります。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `bun run build` / `watch` | ビルドする / 監視してビルドする |
| `bun run test` | テスト |
| `bun run typecheck` | 型検査 |
| `bun run repl` | 対話環境 |
| `bun run start` / `parse` | `main.tks` を実行する / 構文木を表示する |

## Misskey から使う

Misskey は release のタグを git の依存として読み込みます。

```json
"toneriko-script": "github:toneriko-dev/toneriko-script#v<版>"
```

ビルド済みのファイルはタグのコミットにだけ入っているので、install のときにビルドは走りません。npm には公開していません。

版を出すときは、`package.json` の `version` を上げて main に push し、release workflow を手動で実行します。テストとビルドが通ると、`v<版>` のタグが付きます。
