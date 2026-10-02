# docs

言語仕様や標準ライブラリなど、AiScript を使う人向けの文書は、専用のサイトに移しました。

- [移行先のサイト](https://aiscript-dev.github.io/ja/)
- [移行先のリポジトリ](https://github.com/aiscript-dev/aiscript-dev.github.io)
- [移行の経緯(upstream の issue)](https://github.com/aiscript-dev/aiscript/issues/804)

このディレクトリに残しているのは、処理系を開発する人向けの文書です。

- [parser/overview.md](parser/overview.md): パーサーの全体像
- [parser/scanner.md](parser/scanner.md): Scanner の設計。現在のトークンと先読みしたトークンの扱い
- [parser/token-streams.md](parser/token-streams.md): トークンを読み取る共通のインターフェース `ITokenStream` と、その実装
