# ADR 0001: Cloudflare ホストと GitHub provider を keybroker に加える

- **状態:** Proposed
- **日付:** 2026-11-18

## 背景

資格情報をクライアントに渡さず、決められた操作だけを中継する仕組み（credential broker）が、現在二か所にあります。

|                        | keybroker（旧 capability-proxy）                  | hierarchidb の BFF と Git Worker                                  |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| 動く場所               | 利用者のマシン（`127.0.0.1`、Node）               | Cloudflare Workers と Durable Object                              |
| 守る資格情報           | 運用者の OpenAI API キー、Sesame の鍵             | 利用者ごとの GitHub のアクセストークンとリフレッシュトークン      |
| クライアントの認証     | ワンタイムコードによるペアリング                  | GitHub App の Web フロー（PKCE）でのログイン                      |
| クライアントに渡すもの | リレー用トークン、OpenAI の一時キー               | 5分で切れるプロキシ用の Bearer                                    |
| 中継の形               | JSON の要求と応答（`CapabilityProvider.execute`） | Git Smart HTTP のバイナリの中継と、決まった GitHub API の呼び出し |
| 主な利用者             | turbowarp-openai-realtime-api、turbowarp-sesame   | TurboWarp Plus Editor のブラウザー版                              |

hierarchidb の Git の部分は、hierarchidb 本体の機能とは関係がありません。TurboWarp Plus Editor のために、hierarchidb の BFF と CORS プロキシへ同居させたものです（hierarchidb #1754、#1755、#1757、#1761）。一方で、hierarchidb 自身、turbowarp-openai-realtime-api、turbowarp-sesame も、同じ型の中継をクラウドで必要とする見込みがあります。

二つを別々に保守すると、オリジンの検査、短期トークンの発行、任意の URL を中継しないための制限を二重に持つことになります。そこで、Git の部分を hierarchidb から keybroker に移し、keybroker を「動く場所（ホスト）」と「つなぐサービス（provider）」の組み合わせとして組み立て直します。

### 移す対象

hierarchidb の main（5d8bcd811）と、未マージの hierarchidb #1760 にある次のものです。

| hierarchidb のファイル                                                           | 役割                                                                                           |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/backend/bff/src/GitSession.ts`                                         | Durable Object。ログインの状態、トークンの暗号化と保管、更新の直列化、push ID とレビューの予約 |
| `packages/backend/bff/src/handleGitAuth.ts`                                      | `/v1/git-auth/start`・`callback`・`session`                                                    |
| `packages/backend/cors-proxy/src/gitWorker.ts`                                   | Git Worker の入口                                                                              |
| `packages/backend/cors-proxy/src/handleGitProxy.ts`                              | `/v1/git/<owner>/<repo>.git/...`（Git Smart HTTP）                                             |
| `packages/backend/cors-proxy/src/handleGitHubApi.ts`、`githubReviewDocuments.ts` | `/v1/github/<owner>/<repo>/...`（PR とレビュー）                                               |
| #1760 の `GitRepositoryCreation.ts`、`GitHubPublication.ts` ほか                 | リポジトリの作成と公開                                                                         |
| `packages/backend/bff/docs/git-smart-http.md`、`github-app-setup*.md`            | 通信の契約と、GitHub App の作り方                                                              |

hierarchidb 本体のログイン（Google・Microsoft・GitHub OAuth App と KV）と、汎用の `?url=` プロキシは移しません。

## 決定

### 1. 一つのパッケージに、ホストごとの入口を設ける

`@kubohiroya/keybroker` を一つのパッケージのまま保ち、入口を分けます。

| 入口                                            | 内容                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| `@kubohiroya/keybroker`                         | core（provider の型、registry、エラー、ポリシー） |
| `@kubohiroya/keybroker/node` と CLI `keybroker` | 今の localhost のリレー                           |
| `@kubohiroya/keybroker/cloudflare`              | Worker の `fetch` と Durable Object のクラス      |

core と provider は、Web 標準の API（Web Crypto、`fetch`、`Request`／`Response`）だけを使います。現在 `node:crypto` を使っているのは `src/core/pairing.ts` だけなので、Web Crypto に置き換えます。HTTP の組み立てに使っている Hono は、Workers でもそのまま動きます。

npm の名前を `@kubohiroya/capability-proxy` から `@kubohiroya/keybroker` に改める作業も、ここに含めます（GitHub のリポジトリ名は改名済み、npm には未公開）。

### 2. capability に「呼び出し」と「中継」の二種類を設ける

今の `CapabilityProvider.execute` は、JSON を受けて JSON を返す「呼び出し」です。Git Smart HTTP は、バイナリのストリームをそのまま流す必要があるので、これに収まりません。そこで provider が、もう一種類の「中継」を持てるようにします。

```ts
interface CapabilityProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<string>;
  execute?(request: CapabilityRequest): Promise<unknown>;
  relay?(request: RelayRequest): Promise<Response>;
}
```

中継でも、上流の URL は provider が決めた形だけを組み立てます。クライアントから任意の URL を受け取らないという不変条件は、両方に共通です。

### 3. 「誰が使ってよいか」と「資格情報の保管」を、ホストから差し替えられるようにする

| 部品                                           | node ホスト                  | cloudflare ホスト                                    |
| ---------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| 利用者の確かめ方（principal source）           | ペアリング（今のまま）       | GitHub App の Web フロー（PKCE）によるログイン       |
| 利用者ごとの資格情報の保管（credential store） | なし（運用者の資格情報だけ） | Durable Object。AES-GCM で暗号化し、更新を直列化する |
| 運用者の資格情報                               | 環境変数と設定ファイル       | Workers の secret                                    |

GitHub は「利用者本人の資格情報」を預かる provider です。OpenAI と Sesame は「運用者の資格情報」を使わせる provider です。core はこの違いを、principal source と credential store の組み合わせとして扱います。

### 4. Cloudflare ホストは、既定で一つの Worker にまとめる

hierarchidb では、BFF と Git Worker を別の Worker にし、Git Worker から BFF の Durable Object を参照していました。keybroker には汎用プロキシが同居しないので、既定では一つの Worker にまとめ、Durable Object も同じ Worker に置きます。他の Worker の Durable Object を参照する設定がなくなり、配備が一回で済みます。

Editor のビルド設定 `TW_PLUS_GIT_BFF_ORIGIN` と `TW_PLUS_GIT_PROXY_ORIGIN` は、どちらも同じ keybroker のオリジンを指します。

### 5. GitHub provider は、今の通信の契約をそのまま引き継ぐ

経路（`/v1/git-auth/*`、`/v1/git/*`、`/v1/github/*`）、要求と応答の形、エラーのコード、Bearer の形式と期限を変えません。TurboWarp Plus Editor の `turbowarp-plus-editor-auth` と `turbowarp-plus-editor-git` は、接続先のオリジンを替えるだけで使えます。テストも hierarchidb から移し、同じ振る舞いを確かめます。

### 6. 一つの配備は、一人の運用者のもの

マルチテナント（一つの配備で複数の運用者の GitHub App を扱う形）は対象にしません。運用者ごとに、自分の Cloudflare アカウントへ配備します。学校や機関が自分で持てるよう、配備の手順と設定の雛形を用意します。

### 7. クラウドで有効にする provider は、運用者が明示的に選ぶ

cloudflare ホストで最初に有効にするのは、GitHub provider だけです。OpenAI と Sesame を cloudflare ホストで使えるのは、必要になってから、次を用意したあとにします。

- **OpenAI：** 運用者の API キーを複数の利用者が使うので、利用者の識別と、一人あたりの使用量・費用の上限が要る。
- **Sesame：** インターネットから解錠を要求できる場所に置くことになるので、遠隔の操作は既定で無効にし、施錠だけ・確認つきなどの制限を先に設計する。

### 8. ライセンスは MPL-2.0 にそろえる

移すコードは hierarchidb（MIT）にありますが、作者は同じです。keybroker の MPL-2.0 で公開し直します。

## 移行の手順

1. hierarchidb #1760 を先にマージする。動いている途中のものを移さないため。
2. keybroker：npm の名前を改め、core を Web 標準の API に寄せ、provider に「中継」を加える。node ホストの振る舞いは変えない。
3. keybroker：cloudflare ホストと GitHub provider を、hierarchidb の main から移す。テストも移す。
4. dev に配備する。dev 用の GitHub App（GitHub App を作るアカウント）と、Cloudflare（Worker を配備するアカウント）が要る。秘密の値は運用者が自分で入れる。
5. TurboWarp Plus Editor を keybroker の dev のオリジンでビルドし、実 GitHub の private リポジトリで fetch・pull・push を確かめる（TurboWarp Plus Editor #316）。
6. hierarchidb から Git の部分と文書を外し、keybroker を指すようにする。
7. TurboWarp Plus Editor の文書のリンク（`docs/features/git/` の GitHub App 設定と API 設定）を keybroker に替える。

## 未決事項

- cloudflare ホストを、ログイン（client secret を持つ）と中継（大量の通信を流す）の二つの Worker に分けられる設定も残すか。
- TurboWarp Plus Desktop のメインプロセスにある localhost の Git プロキシを、keybroker の node ホストと GitHub provider（デバイスフロー）に寄せるか。
- 英語版の ADR を用意する時期。

## 関連

- [TurboWarp Plus Editor #315](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315)、[#316](https://github.com/kubohiroya/turbowarp-plus-editor/issues/316)
- [hierarchidb #1760](https://github.com/kubohiroya/hierarchidb/pull/1760)、[#1761](https://github.com/kubohiroya/hierarchidb/pull/1761)
- turbowarp-sesame の ADR 0001（capability-proxy を keybroker へ改名する決定）
