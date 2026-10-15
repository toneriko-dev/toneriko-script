# Toneriko Script 2 の設計案

Toneriko Script を作り直す案です。構文を JavaScript(と型注釈)の小さな部分集合にし、他の言語で書きやすいとされる機能を標準ライブラリで足し、型注釈と実行時の検査で安全性を持たせます。言語も道具も軽く保ちます。AiScript の構文との互換は持ちません。パーサー・インタプリタ・標準ライブラリは `src/v2/` に実装しています。型注釈の検査と Misskey の関数は今後の段階で扱います。

文中の「今」は 1.3.0 の振る舞いで、例は 1.3.0 で実行して確かめています。

## なぜ JavaScript の部分集合か

- **書く人の多くが JavaScript を知っている:** 本家の issue、記事、公開スクリプトで確かめられた書き手は、JavaScript の経験者と言語の開発に関わる人でした。プログラミング未経験だと自分で書いている体験談は見つかっていません。
- **知っていることがそのまま使える:** Python 経験者に R を教えた研究では、両者の対応を説明すると成績が上がりました。一方で、同じ形に違う意味がある所では、知っている意味で誤って読みました(Shrestha ら 2018)。形も意味も JavaScript と同じにすれば、この誤りが起きません。
- **困っていた点が消える:** 本家に寄せられた不満のうち、次のものは JavaScript の書き方にすると無くなります。
  - 空白と改行の規則(6 人)
  - 文字列の扱い(6 人)
  - `Core:` と `.` のどちらに関数があるか(4 人)
  - `for` の範囲(4 人)
  - オブジェクトの書き方(4 人)

本物の JavaScript を WebAssembly の箱(QuickJS など)で動かす案は採りません。次の 3 つが理由です。

- **`await` を書かせることになる:** MakeCode は、初めて書く人に `await` を求めないために、待つ処理を普通の呼び出しに見せています。今の Toneriko Script も同じで、この良さを残します。
- **作り直しが要る:** 実行時間の上限(5 秒)とホストへの譲り方を、作り直すことになります。
- **大きさが増える:** バンドルが数百 KB 増えます。

TypeScript の検査器をブラウザで動かす案も採りません。TypeScript 6.0.3 の `typescript.js` は圧縮前で 8.8 MB あり、型の書き方も多く、言語と道具が重くなるためです。

## 方針

1. **JavaScript として書いたコードは、JavaScript と同じ結果になるか、エラーになる。** 違う結果を黙って返すのは、下の「意図した違い」に書いた所だけです。
2. **軽く保つ。** 構文も標準ライブラリも、小さなスクリプトで使うものに絞ります。入れるか迷ったものは入れず、使えないと分かるエラーを出します。
3. **書きやすさは関数とメソッドで足す。** 他の言語から借りる機能は標準ライブラリに入れ、独自の構文は足しません。
4. **安全性は、少ない種類の型注釈と実行時の検査で持つ。**
5. **使えない書き方には、使える書き方を案内する。** JavaScript の機能のうち入れないものと、AiScript の書き方には、エラーで代わりを示します。

## 書き方の例

Misskey の Play の雛形(ローカルタイムライン)です。今は 43 行あります。

```ts
function fetchTimeline() {
	Ui.render([Ui.text({ text: "読み込み中..." })])

	const notes = Mk.api("notes/local-timeline", {})
	const els = notes.map(note => Ui.container({
		bgColor: "#444",
		fgColor: "#fff",
		padding: 10,
		rounded: true,
		children: [
			Ui.mfm({ text: note.user.name ?? note.user.username, bold: true }),
			Ui.mfm({ text: note.text ?? "(リノートもしくはメディア・投票のみのノート)" }),
		],
	}))

	Ui.render([
		Ui.text({ text: "ローカル タイムライン" }),
		Ui.button({ text: "更新", onClick: () => fetchTimeline() }),
		Ui.container({ children: els }),
	])
}

fetchTimeline()
```

`Mk.api` はサーバーの応答を待ちますが、`await` は要りません。

## 構文

### 使えるもの

| 分類 | 書き方 |
|---|---|
| 宣言 | `const`、`let`(ブロック単位、宣言より前で使うとエラー) |
| 関数 | `function` 宣言(先に呼べる)、アロー関数、既定値、残り引数 `...xs`、分割代入 |
| 制御 | `if`/`else`、`for (;;)`、`for … of`、`while`、`do … while`、`break`/`continue` とラベル、`switch`、`try`/`catch`/`finally`、`throw`、`return` |
| 演算子 | `+ - * / % **`、`=== !== < <= > >=`、`&& \|\| ??`、`!`、`?.`、`? :`、`typeof`、`in`、`delete`、`= += -= *= /= %= **= ??=`、文としての `++`/`--` |
| リテラル | 数(`1_000`、`0x`、指数)、文字列(JavaScript のエスケープ)、テンプレート `` `${x}` ``、配列、オブジェクト(省略形 `{ x }`、計算するキー `[k]: v`、スプレッド) |
| 型注釈 | 変数、引数、戻り値に書ける。型は下の「型注釈」の節の 6 種類だけ |
| `new` | `new Error(message)` だけ |
| コメント | `//`、`/* */` |
| プラグインの情報 | `export const meta = { name: "…", version: "…" }`(値はリテラルだけ) |

`async` と `await` は書いても構文エラーにせず、無いのと同じに扱います。JavaScript から貼ったコードがそのまま動くようにするためです。

### 使えないもの

使うと構文エラーになり、代わりを案内します。

| 書き方 | 入れない理由 | 案内 |
|---|---|---|
| `class`、`this`、`new`(`Error` 以外) | 小さなスクリプトでは使われず、`this` の束縛の規則が複雑 | オブジェクトと関数で書く |
| `Map`、`Set`、`Date` のオブジェクト | 軽く保つため | オブジェクト、`arr.unique()`、`Date.now()` と `Date.format` |
| `var` | 関数単位の範囲と巻き上げで読み違える | `let`、`const` |
| `==`、`!=`(`null` との比較以外) | 型を変換して比べる | `===`、`!==`。`x == null` は使える(`undefined` が無いので `=== null` と同じ) |
| 式の中の代入(`if (x = 1)`、`a = b = 1`) | 比較と取り違える | 代入は文で書く |
| カンマ演算子 | 読み違いが多い(Torres ら 2023 で正答 28/70 → 65/70) | 文に分ける |
| 式の中の `++`(`a[i++]`) | 前置と後置で値が変わる | `i += 1` を別の文に |
| ビット演算 `& \| ^ ~ << >> >>>` | 小さなスクリプトでほぼ使わない。AiScript の `^`(累乗)と取り違える | 累乗は `**`。乱数は `Math.seededRandom` |
| `for … in` | キーの順の規則が複雑 | `for (const k of Object.keys(o))` |
| 正規表現 | 利用者の入力しだいで処理が終わらなくなる | `includes`、`split`、`replaceAll` など |
| `eval`、`Function`、`with`、ジェネレーター、`Symbol`、`BigInt`、getter と setter、`arguments`、`debugger`、`import` | 小さなスクリプトに要らない | |
| `Promise`、`.then()` | 待つ処理は自動で待つ | 並行に動かすなら `arr.mapConcurrent` |
| `undefined` | 値が無いことは `null` だけで表す | `null` |
| 型の書き方のうち 6 種類以外(`type`、`interface`、`enum`、型引数 `<T>`、`as`、`!`、`Record` など) | 軽く保つため。`as` と `!` は検査をすり抜ける | 6 種類で書くか、型注釈を省く |

### 改行とセミコロン

セミコロンは省けます。JavaScript の自動セミコロン挿入で、思わぬ読み方になる所はエラーにします。

- **前の文の続きと読まれる行:** 文の後の行が `(`、`[`、`` ` ``、`+`、`-`、`/` で始まり、JavaScript なら前の行の続きと読まれる所は、エラーにします。1 行にまとめるか、前の行の終わりに `;` を書くよう案内します。
- **`return` の後の改行:** `return` の直後で改行すると、JavaScript は値を返さないので、エラーにします。
- **研究の裏付け:** 自動セミコロン挿入の思わぬ読み方を避けたコードでは、出力を予測できた人が 32/70 から 68/70 に増えました(Torres ら 2023)。

## 意図した違い

JavaScript として書いたコードが、違う結果になる所と、構文の受理に上限がある所は次の 7 つです。

| 違い | JavaScript | Toneriko Script | 理由 |
|---|---|---|---|
| 待つ処理 | `Mk.api()` や `async` 関数は Promise を返し、`await` が要る | 最後まで待って値を返す。`async` 関数の呼び出しも Promise を返さない | 初めて書く人に `await` を求めない |
| 文字列の単位 | UTF-16 の単位で数える(`"👍🏽".length` は 4) | 見た目の 1 文字(書記素)で数える(1) | 絵文字の多いノートを扱うので、見た目の文字数が要る |
| 値が無いこと | `undefined` と `null`。既定値は `undefined` のときに使う | `null` だけ。無いプロパティ、省いた引数、値を返さない関数は `null`。引数と分割代入の既定値は、値が無いときと `null` のときに使う | 2 つを使い分ける場面が小さなスクリプトに無い |
| 配列の範囲外 | `arr[10]` は `undefined` | エラー。`arr.at(10)` は `null` | 添字の誤りに気付けるようにする |
| 実行の上限 | 無い | 5 秒待たずに動き続けるか、決めた回数を超えるとエラー | 無限ループで画面を止めない |
| オブジェクトの原型 | `{}` にも `toString` などがある | 無い。書いたキーだけがある。スクリプトのエラーも原型を持たず、`name` と `message` の既定値だけを返す。`e.toString`・`e.constructor` は `null`。ホスト由来も含め、エラーの `stack` とエンジンの位置のキー（`fileName`・`lineNumber`・`columnNumber`・`sourceURL`・`line`・`column`・`originalLine`・`originalColumn`）は `null` | 利用者の文字列をキーにする辞書として使うため |
| 構文の入れ子 | エンジンのスタックの上限まで読む | 括弧、配列、オブジェクト、関数、ブロック、分割代入のパターンなどは 256 段まで。左結合の演算やメンバーの連鎖は数えない。単項演算と右結合の演算は、括弧をまたぐ構文木の各経路で合わせて 1,024 段まで。演算子の優先順位を混ぜても 256 段の入れ子を読める | ブラウザのスタックを溢れさせないため |

文字列の単位の違いは、次の操作に関わります: `length`、`s[i]`、`at`、`slice`、`substring`、`indexOf`、`split("")`、`for … of`、`padStart` と `padEnd` の長さ。

次の 3 つは、JavaScript と同じ結果を黙って返すと誤りに気付けないので、エラーにします。

- **数を含む配列の `sort()`:** 比べる関数を省くと、JavaScript は文字列として並べます(`[10, 9, 1].sort()` は `[1, 10, 9]`)。比べる関数を渡すか `sortBy` を使うよう案内します。文字列だけの配列は、JavaScript と同じく省けます。
- **文字列と配列・オブジェクト・`null` の `+`:** JavaScript では `"a" + null` が `"anull"`、`"a" + {}` が `"a[object Object]"` になります。文字列と数・真偽値の `+` は、JavaScript と同じくつなぎます。
- **暗黙の型変換:** `"5" * 2` や `1 + null` はエラーです(JavaScript は 10 と 1)。

テンプレートの `${}` も、文字列を `+` でつなぐときと同じ規則です。文字列・数・真偽値をつなぎ、`null`・配列・オブジェクト・関数はエラーにします。エラーでは `JSON.stringify(x)` か `x ?? ""` を使うよう案内します。

## ホストから渡す値

守る相手はスクリプトです。スクリプトから作れる値を使って、ホストの内部情報（`stack`、エンジンの位置情報、原型の getter）に届かないことを保証します。

ホストが渡す値は、JSON で表せる値、クラスのインスタンス、この realm の `Error` と `DOMException`、`Promise` を前提にします。別 realm の値、`Proxy`、原型を付け替えた値、エラーを偽装した値は、ホストの責任で渡さないようにします。

前提の外の値では、見えないはずのキーが見えたり、エラーになったりすることがあります。

## 型注釈

### 書ける型

| 型 | 例 |
|---|---|
| 基本 | `number`、`string`、`boolean`、`null`、`any` |
| 配列 | `number[]`、`(string \| null)[]` |
| オブジェクト | `{ id: string, count: number }` |
| 関数 | `Function`(関数であることだけ) |
| 合併 | `string \| null` |
| 戻り値なし | `void` |

```ts
function greet(name: string, times: number = 1): string {
	return `Hello, ${name}!`.repeat(times)
}
let picked: string | null = null
```

型注釈はどれも省けます。どれも TypeScript と同じ書き方なので、TypeScript を知っている人は覚え直さずに済みます。

### 調べること

- **実行時:**
  - 調べる場所: 型注釈の付いた変数の初期値と代入、引数(既定値を入れた後)、戻り値
  - 調べる深さ: 配列とオブジェクトは直下の要素まで。全部の段を調べると、大きな配列を代入するたびに中身をすべてたどるため
  - 例: `x は number と書かれていますが、string の値 "text" が入りました (3 行目)`
- **実行前:**
  - 型の違うリテラルを入れたとき(`let x: number = "text"`)
  - `const` への再代入
  - 宣言されていない変数(似た名前を「もしかして」で出す)
  - 標準の関数とホストの関数に渡す引数の数
  - 中身のある `case` が `break` や `return` なしに次の `case` へ進むとき(警告)

実行前の検査は、型の推論はしません。変数をたどって型を決めると、検査器が TypeScript と同じくらい大きくなるためです。`null` かもしれない値への誤った操作は、実行時に `null` のプロパティを読もうとした所でエラーになり、`?.` と `??` を案内します。

## 標準ライブラリ

関数の名前、所属、引数の名前と型、戻り値の型、日本語と英語の 1 行説明、実装は `src/v2/stdlib/` の単一定義に置きます。実行表と一覧 JSON は同じ定義から作り、一覧は `toneriko-script/v2/stdlib/catalog.json` で公開します。型は「型注釈」の 6 種類を使い、省略可能・可変長は別の項目で表します。引数の実行時検査は標準関数の責任とし、型注釈の検査とは分けます。

標準関数は評価フレームを使い、利用者の関数呼び出しと実行予算・中止状態・書記素キャッシュを共有します。反復処理の途中でチェックポイントを通し、ホストへの譲りと実行上限の確認を行います。

標準関数から呼ぶ短い関数は、引数の準備を含めて最大 32 ステップの同期評価に収まる場合、評価フレームを作らずに実行します。ステップ数・エラー位置・呼び出し深さは通常の呼び出しと同じです。引数の環境は呼び出しごとに作り、閉包や引数への代入を共有しません。中断する処理や長い本体は評価フレームで順に待ちます。

### JavaScript の標準から入れるもの

JavaScript と同じ名前、同じ引数、同じ結果にします(文字列は書記素の単位)。

| 分類 | 入れるもの |
|---|---|
| 値 | `Math`(全部)、`JSON.parse`/`stringify`、`Number()`、`String()`、`parseInt`、`parseFloat`、`Number.isInteger`、`Array.isArray`、`Array.from`、`Object.keys`/`values`/`entries`/`fromEntries`/`groupBy`、`structuredClone`、`encodeURIComponent`、`decodeURIComponent` |
| 配列 | `length`、`push pop shift unshift slice splice concat join indexOf includes find findIndex filter map flatMap flat reduce some every forEach sort reverse toSorted toReversed at fill entries` |
| 文字列 | `length`、`slice substring at indexOf includes startsWith endsWith padStart padEnd trim toUpperCase toLowerCase split replace replaceAll repeat` |
| 数 | `toFixed`、`toString(radix)` |
| 時間 | `Date.now()`、`setTimeout`、`setInterval`、`clearTimeout`、`clearInterval` |
| 出力 | `console.log`(今の `<:` と `print`) |
| エラー | `new Error(message)`、`error.message` |

`replace` は JavaScript と同じく最初の 1 つだけを置き換えます。今の `replace` は全部を置き換えるので、`replaceAll` を使うよう書き換えが要ります。`str.to_num()` の誤り(`"3.14"` を 3 にする)は、`Number()` と `parseFloat` を JavaScript と同じにすることで無くなります。

### 他の言語の書きやすさから足すもの

利用者が自作していた補助関数(公開されている Play とプラグイン、14 アカウント 33 本)と、本家の要望を根拠にしています。JavaScript に無い名前なので、JavaScript として書いたコードとはぶつかりません。

| 足すもの | 元にした言語 | 自作していた人/本 |
|---|---|---|
| `Date.format(t, "YYYY-MM-DD HH:mm", offset?)`、`Date.parts(t, offset?)`(年月日・時分秒・曜日) | Python `strftime` | 4/4 |
| `arr.shuffle(rng?)`、`arr.sample(rng?)`、`arr.sampleBy(weight, rng?)` | Python `random`、Ruby `sample` | 3/5、重みは 2/2 |
| `arr.sortBy(key)` | Python `sorted(key=)`、Kotlin `sortedBy` | 2/3 |
| `arr.unique()`、`arr.uniqueBy(key)` | Kotlin `distinct`、lodash `uniq` | 2/3 |
| `arr.sum()`、`arr.minBy(key)`、`arr.maxBy(key)` | Python `sum`、Kotlin `minBy` | 2/2、1/1 |
| `arr.countBy(key)` | Kotlin `eachCount`、lodash | 1/2 |
| `arr.mapConcurrent(f, limit?)` | | (並行の節) |
| `deepEqual(a, b)` | Node `isDeepStrictEqual` | 2/2 |
| `range(start, end, step?)`(終わりを含まない) | Python `range` | (今の `Core:range`) |
| `sleep(ms)` | Python `time.sleep`、Kotlin `delay` | (今の `Core:sleep`) |
| `Math.randomInt(min, max)`、`Math.seededRandom(seed)` | Python `randint`、`Random(seed)` | (今の `Math:rnd`、`Math:gen_rng`) |
| `Math.clamp(x, min, max)` | Kotlin `coerceIn` | (比較のみ) |
| `str.dedent()` | Python `textwrap.dedent` | (本家 #637) |

- `key` は値を返す関数です。値は数か文字列です。配列を返すと、前の要素から順に比べます(`u => [u.age, u.name]`)。
- `rng` は `Math.seededRandom(seed)` が返す関数です。同じ種なら同じ結果になります(日替わりのおみくじなど)。
- `sortBy` と `shuffle` は、`sort` と同じく元の配列を並べ替えます。
- グループ分けは JavaScript の `Object.groupBy` を、深いコピーは `structuredClone` を使います。

### 乱数と数値関数

`Math` の公開名は Node 24.19.0 の一覧で固定し、`f16round` と 8 個の定数も含めます。ホストに追加された名前は自動で公開しません。数のメソッドは `toFixed` と `toString(radix)` です。URI の変換失敗は `URIError`、数値の範囲外は `RangeError` とし、診断コードと日英の説明を付けます。

`Math.seededRandom(seed)` は xoshiro128** を使い、版や実行環境が変わっても同じ種の列を変えません。種は有限の数か文字列です。数は型 byte 0 と little-endian binary64、文字列は型 byte 1 と little-endian UTF-16 コード単位です。文字列は正規化せず、数の -0 も区別します。

初期状態の 4 ワードは、番号 byte 0〜3 をそれぞれ種の byte 列の先頭に付け、FNV-1a（初期値 0x811c9dc5、素数 0x01000193、32 bit 桁あふれ）で作ります。全ワードが 0 の場合は先頭を 1 にします。xoshiro128** の rotate は出力側 7、状態側 11、shift は 9、出力乗数は 5 と 9 です。乱数一つは連続した出力 a,b から `((a >>> 5) * 2^26 + (b >>> 6)) / 2^53` として作り、範囲は [0,1) です。9 種の先頭 32 個と 4096 個の列の SHA-256 をテストで固定します。

`Math.randomInt(min,max)` は両端を含む安全整数を返し、逆順や安全に扱えない幅はエラーです。`Math.clamp(x,min,max)` は範囲に収め、逆順はエラーです。明示的な Number/String の変換は基本値を受け、配列・オブジェクト・関数はエラーにします。

### 文字列の操作

`substring` は書記素単位で、負数を 0 に丸め、start と end が逆なら入れ替えます。検索・接頭辞・接尾辞・区切り文字・置換は書記素の途中では一致させません。位置を取る引数と置換関数へ渡す位置も書記素数です。空の検索文字列は各書記素の境界に一致します。`replace` は最初の一件、`replaceAll` は全件を置き換え、JavaScript の置換記号を扱います。

書記素の準備は実行内のキャッシュを共有し、CRLF のない ASCII は直接添字を使います。検索は KMP で入力と検索文字列の長さに対して線形に処理し、処理の途中で評価器へ制御を返します。連結境界によって書記素が結合した場合は、padding の指定長と結果の書記素数が異なることがあります。単一の巨大書記素の Intl.Segmenter 内部は中断できません。

`dedent` は空白だけの行を共通字下げの計算から除き、残る行の共通の行頭空白・タブ列を取り除きます。タブを空白へ展開しません。

### 配列と反復子

配列のメソッドは JavaScript の引数・戻り値・元配列の変更を基準にします。コールバックは値・添字・元配列を受け、順に完了を待ちます。`this` は使えないため、非 null の `thisArg` はエラーです。関数が配列を変更する場合の長さの取り方も各 JavaScript メソッドに合わせ、穴を作る結果はエラーです。

`Array.from` は配列、書記素単位の文字列、`{ length: n }` と添字のプロパティを持つ配列状のオブジェクトを受けます。第 2 引数の関数には値と添字を渡して順に待ちます。存在しない要素は null になります。

`entries()` は配列の現在の長さを参照する内部反復子を返します。`next()` の結果は原型なしの `{ value, done }`、value は `[添字, 要素]` です。完了後の value は null です。`for…of`、スプレッド、`Array.from` でも使えます。Symbol と利用者が作るジェネレーターは公開しません。

### 並べ替えと配列の補助関数

`sort` と `sortBy` は安定なマージソートで元の配列を変更して返します。`toSorted` は新しい配列を返します。比較関数の呼び出しは順に待ち、比較結果の NaN は同値として扱います。比較関数を省いた場合は文字列だけを許し、UTF-16 の辞書順で比べます。文字列以外を含む場合は比較関数か sortBy を案内するエラーです。コピーと書き戻し、長い共通接頭辞の比較にも処理を譲る地点を設けます。

`sortBy` は元の添字順にキーを一度ずつ取得します。キーは数・文字列・それらの配列で、配列は辞書式に比較します。同じ位置で型が混在する場合と NaN はエラーです。`uniqueBy`、`minBy`、`maxBy` も同じキーの規則です。

`unique` は SameValueZero（NaN は同値、±0 は同値、オブジェクトは参照の同一性）で最初の要素を残す新配列を返します。`sum` は数を左から加算し、空配列は 0 です。`minBy` と `maxBy` は同値なら最初の要素を返し、空配列は null です。`countBy` は数か文字列のキーを文字列化して原型なしの辞書に集計します。配列キーは辞書のキーへ無損失に変換できないのでエラーです。

`shuffle` は Fisher–Yates で元の配列を並べ替えます。`sample` と `sampleBy` は要素を一つ返し、空配列は null です。sampleBy は重みを順に一度ずつ取り、有限の非負数を受けます。非空配列で全重みが 0 ならエラーです。rng の出力は有限の [0,1) に限ります。

### JSON と辞書、複製

標準関数が作る辞書は原型を持ちません。`__proto__` はどの深さでも禁止し、JSON.parse、Object.fromEntries、Object.groupBy、structuredClone でも診断コードと日英の説明を付けて拒否します。入力を黙って削除・変更しません。JSON.stringify でそのキーを除いて作り直すか、送信元へキーの変更を依頼するよう案内します。

JSON.parse は reviver を子から順に呼びます。基本値には原文の source を第 3 引数で渡します。null を返した場合は JSON の null とし、削除指示にはしません。JSON.stringify は replacer・space・toJSON を扱い、関数は辞書のプロパティなら省略、配列内なら null、最上位なら null を返します。循環は TypeError です。利用者の関数は逐次呼び、元のキー順や数の表現は JavaScript に合わせます。

structuredClone は共有参照と循環を保存し、関数は DataCloneError です。未対応の型と transfer 指定はエラーです。deepEqual は基本値を Object.is 相当で比べ、配列の順序・辞書の own key と内容を比較します。循環を扱い、関数は参照の同一性で比べます。

Error の生成も標準関数の単一定義に含めます。new Error だけが new で呼べ、既存の例外値の原型・非公開プロパティの規則を守ります。

### 時刻とホストとの接続

Date.format と Date.parts の時刻は Unix epoch からのミリ秒、offset は UTC より東を正とする分です。省略時はホストの dateOffsetMinutes、それも無ければその時刻 t の実行環境の `-new Date(t).getTimezoneOffset()` を使います。明示した offset は固定の時差です。Date.parts は原型なしの year/month/day/hour/minute/second/millisecond/weekday を返します。月は 1〜12、曜日は日曜 0〜土曜 6 です。

Date.format の記号は YYYY/MM/DD/HH/mm/ss/SSS/d/ddd/dddd/Z/ZZ です。ddd/dddd は固定英語曜日、Z/ZZ は +09:00/+0900 の形、[文字列] はリテラルです。未知の英字記号と閉じていないリテラル、無効な時刻は RangeError です。

console.log は値を文字列化せず、可変長引数を readonly Value[] としてホストの onConsoleLog へ一度渡します。オブジェクトは参照を渡し、スナップショットにはしません。未指定ならホストの console.log に渡します。

setTimeout/setInterval は本体の exec() が解決した後も動きます。数値 ID で管理し、両方の clear 関数で解除できます。interval は前回の関数が待機中でも次を開始できます。コールバックごとに新しいステップ予算を使い、その中で呼ぶ配列メソッドは同じ予算を共有します。連続稼働時間はインタプリタ全体で共有します。未捕捉例外は onUnhandledError、未指定ならホストの console.error に通知します。実行上限超過と abort() はタイマーをすべて解除し、実行中と待機中のスクリプトを停止します。ホスト側の外部処理を取り消す場合は AbortSignal に従う必要があります。

sleep は有限の非負ミリ秒を待ちます。range は start/end/step に安全整数を受け、step の省略値は 1、0 はエラー、終端は含みません。方向が合わなければ空配列です。

mapConcurrent の既定 limit は 4 で、正の安全整数を受けます。開始順と結果の順序は添字順です。最初の失敗を観測すると新規の開始を止め、開始済みの処理を待って最初のエラーを返します。開始済みの副作用は取り消しません。全ワーカーが親の実行予算を共有します。

### 関数を呼ぶ順

配列のメソッドは、すべて関数を 1 つずつ順に呼びます。今は `map`、`flat_map`、`sort` だけが並行に呼ぶので、関数の中で待つと終わる順が入れ替わります(`[1, 2, 3]` の `map` で `[2, 3, 1]`)。並行に呼びたいときは `arr.mapConcurrent(f, limit?)` を使います。`limit` は同時に動かす数の上限で、`Mk.api` をまとめて呼ぶときに、同時に送る数を抑えられます。

順に呼ぶことで、利用者の関数を呼ぶ巨大な `map` や `sort` の中でも、ホストに処理を譲れるようになります。今は並行に呼んだ関数の処理が続くので、譲ってもブラウザが空きません(100 万件の `sort` で約 3 秒止まる)。

### 関数の一覧

toneriko-script は、標準の関数とメソッドの一覧(名前、引数、戻り値の型、1 行の説明)を JSON で書き出します。Misskey も、渡す関数の一覧を同じ形で持ちます。エディタは、この一覧で補完と引数の説明を出します。型の推論はしないので、`.` の後には、名前空間(`Mk.`、`Math.` など)ならその関数を、それ以外なら配列と文字列のメソッドを、打った文字で絞って出します。

## Misskey が渡す関数

`:` の名前空間を、オブジェクトのプロパティに置き換えます。

| 今 | 2 |
|---|---|
| `Mk:api`、`Mk:dialog`、`Mk:confirm`、`Mk:toast`、`Mk:save`、`Mk:load`、`Mk:remove`、`Mk:url`、`Mk:nyaize` | `Mk.api` など(同じ名前) |
| `USER_ID`、`USER_NAME`、`USER_USERNAME` | `Mk.me.id`、`Mk.me.name`、`Mk.me.username` |
| `SERVER_URL`、`LOCALE`、`CUSTOM_EMOJIS` | `Mk.server.url`、`Mk.locale`、`Mk.customEmojis` |
| `Ui:render`、`Ui:get`、`Ui:root` | `Ui.render`、`Ui.get`、`Ui.root` |
| `Ui:C:button` などの部品 | `Ui.button` など(`C` を省く) |
| `THIS_ID`、`THIS_URL`(Play) | `Play.id`、`Play.url` |
| `Plugin:register:note_action` など | `Plugin.registerNoteAction` など |
| `Plugin:config` | `Plugin.config` |
| `### { name: … }`(プラグインの情報) | `export const meta = { name: … }` |

サーバーへの要求が失敗したとき、今の `Mk:api` はエラーの値を返します。2 では例外を投げ、`try`/`catch` で受けます。

## AiScript の書き方への案内

AiScript の書き方で書いたときは、構文エラーで 2 の書き方を案内します。

| AiScript | 案内 |
|---|---|
| 1 行目の `/// @ 1.x.x` | AiScript の構文のスクリプトです。Toneriko Script 2 では動かないので、書き直しが要ります |
| `<: x` | `console.log(x)` |
| `@f(x) { … }`、`@(x) { … }` | `function f(x) { … }`、`(x) => { … }` |
| `Core:sleep(1)`、`Mk:api(…)` | `sleep(1)`、`Mk.api(…)` |
| `each let x, arr` | `for (const x of arr)` |
| `for let i, 10` | `for (let i = 0; i < 10; i++)` |
| `eval { … }` | 関数にまとめる |
| `match x { case … }` | `switch` |
| `if a b else c`(式として) | `a ? b : c` |
| `x ^ 2` | `x ** 2` |

AiScript の `let` は再代入できない変数なので、そのまま動きます(2 では `const` にあたる書き方ですが、`let` でも誤りにはなりません)。

## 実装

- **パーサー:** 部分集合を読むパーサーを自前で書きます。既存のパーサー(acorn など)を使わないのは、使えない書き方を見分けて案内を出す必要があり、エラーの文を自分で決めたいためです。
- **パーサーの差分テスト:** 受け付けたプログラムは、TypeScript のパーサー(`ts.createSourceFile`)でも同じ構文木になることを確かめます。プログラムは fast-check で作ったものと、集めたスクリプトを使います。TypeScript はテストでだけ使い、配る成果物には入れません。
- **実行の差分テスト:** 「意図した違い」に当たらないプログラム(ASCII の文字列だけ、待つ処理なし)は、Node で実行した結果と同じになることを確かめます。方針 1 を、テストで守るためです。
- **インタプリタ:** 今のインタプリタの仕組み(ノードごとに待てる評価、時間で譲る、5 秒の上限)を引き継ぎ、新しい構文木に合わせて書き直します。

## 進める順番

1. **パーサーと構文の検査:** 使える書き方と使えない書き方、案内のエラー、改行の規則、型注釈。TypeScript のパーサーとの差分テスト
2. **インタプリタ:** JavaScript と同じ意味(真偽の判定、`===`、`+`、オブジェクトのキーの順、クロージャ、巻き上げ、宣言前の使用、例外、`switch`、ラベル)と意図した違い。Node との差分テスト
3. **標準ライブラリ:** JavaScript から入れるものと足すもの、関数の一覧の JSON
4. **型注釈と実行前の検査**
5. **Misskey:** 渡す関数の改名と一覧、Play の雛形とテストの書き直し、エディタの補完、AiScript の構文のエラー表示
6. **リリース:** toneriko-script 2.0.0 を出し、Misskey の依存を上げる

## 決めていないこと

- **実行の上限の回数:** 今のプラグインの上限は 10 万ステップです。新しい構文木ではノードの数え方が変わるので、測ってから決めます。
- **`Map` と `Set`:** 軽く保つために入れていません。任意の値をキーにしたい要望(本家 #225)はあるので、使われ方を見て決めます。

## 根拠にした調べもの

- 本家 AiScript の issue と PR(1,000 件)、Misskey の issue(196 件)、Zenn・Qiita・note・個人ブログでの利用者の声
- 公開されている Play とプラグインのソース(GitHub の 35 リポジトリ、Qiita の関数集)と、本家の issue 363 件と PR 320 件の採否
- 構文の使いやすさの研究(Stefik & Siebert 2013、Altadmri & Brown 2015、Shrestha ら 2018、Torres ら 2023、Santos & Becker 2024 など)と、組み込み言語の評判(Luau、GDScript、Lua、Apps Script、MakeCode など)
- 汎用の言語の設計資料(PEP、Swift Evolution、Rust の RFC、TC39 の提案)と開発者調査(Stack Overflow 2025、State of JS 2024、Go の開発者調査)

人数は、集めた資料の中で同じ点に触れた別々の人の数で、利用者全体での割合ではありません。
