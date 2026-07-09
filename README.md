# @syuilo/aiscript (Misskey fork)

[syuilo/aiscript](https://github.com/syuilo/aiscript) 1.2.1 をこのMisskeyフォークにベンダリングしたもの。Play / Widget / プラグインで使われるAiScript処理系(パーサ・インタプリタ・標準ライブラリ)本体で、独自の言語拡張(新構文・型システム・標準ライブラリ・パフォーマンス改善)を加えていくためのベースとして取り込んでいる。

upstreamとの追従・同期は行わない(このMisskeyフォーク自体がupstream Misskeyから完全に独立した独自路線であるのと同じ方針)。ライセンスはMITのまま、著作権表示は`LICENSE`に保持している。

`packages/frontend`からは`@syuilo/aiscript`という同名のworkspaceパッケージとして解決される(本物の同名npmパッケージをbunのworkspace解決で差し替える手法)。
