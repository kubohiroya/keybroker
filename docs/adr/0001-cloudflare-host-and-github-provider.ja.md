# ADR 0001: Cloudflare ホストと、GitHub・ide-gsm の provider を keybroker に加える

- **状態:** Accepted
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

さらに ide-gsm も、自分の GraphQL API を認証済みの利用者に開放するために、keybroker を使います。ide-gsm はこれまでの provider と違い、他社のサービスではなく運用者自身が動かす API です。今の ide-gsm には次の仕組みがあります（ide-gsm の `api-idegsm`、`api-github`、`api-idegsm/docs/HIERARCHIDB_INTEGRATION_SPEC_ja.md` による）。

- GraphQL の HTTP と、subscription 用の WebSocket を提供する。
- 認証は、ide-gsm が信頼する鍵で署名された JWT（`upn` の claim）で行う。
- 認可は、利用者ごとのワークスペースを境界にして ide-gsm 自身が行う。
- `api-github` が GitHub OAuth を自前で行い、利用者の GitHub トークンをメモリ上に持つ。
- ブラウザーは、外から供給される Bearer で呼び出す。CORS は許可するオリジンを完全一致で決める。

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

### 2. capability に「呼び出し」「中継」「発行」の三種類を設ける

| 種類                  | 内容                                                               | 使う provider                                         |
| --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| 呼び出し（`execute`） | JSON を受けて JSON を返す                                          | Sesame の状態・履歴・操作                             |
| 中継（`relay`）       | 決まった上流へ、ストリームのまま流す。WebSocket の upgrade も扱う  | GitHub（Git Smart HTTP）、ide-gsm（中継を選んだ場合） |
| 発行（`mint`）        | 上流で使える短期の資格情報を発行し、クライアントは上流に直接つなぐ | OpenAI Realtime の一時キー、ide-gsm の短期 JWT        |

今の `CapabilityProvider.execute` は「呼び出し」だけです。Git Smart HTTP はバイナリのストリームを流し、ide-gsm の subscription は WebSocket を使うので、これに収まりません。OpenAI の一時キーは今は `execute` の結果として返していますが、性質は「発行」です。

```ts
interface CapabilityProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<string>;
  execute?(request: CapabilityRequest): Promise<unknown>;
  relay?(request: RelayRequest): Promise<Response>;
  mint?(request: CapabilityRequest): Promise<MintedCredential>;
}

interface MintedCredential {
  value: string;
  expiresAt: number;
}
```

どの種類でも、上流の URL は provider が決めた形だけを組み立てます。クライアントから任意の URL を受け取らないという不変条件は共通です。「発行」では、資格情報が短期であること、権限が必要最小限であることを provider が保証します。

### 3. 「誰が使ってよいか」と「資格情報の保管」を、ホストから差し替えられるようにする

| 部品                                           | node ホスト                  | cloudflare ホスト                                    |
| ---------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| 利用者の確かめ方（principal source）           | ペアリング（今のまま）       | GitHub App の Web フロー（PKCE）によるログイン       |
| 利用者ごとの資格情報の保管（credential store） | なし（運用者の資格情報だけ） | Durable Object。AES-GCM で暗号化し、更新を直列化する |
| 運用者の資格情報                               | 環境変数と設定ファイル       | Workers の secret                                    |

GitHub は「利用者本人の資格情報」を預かる provider です。OpenAI と Sesame は「運用者の資格情報」を使わせる provider です。ide-gsm は、keybroker が運用者の署名鍵で利用者ごとの資格情報をその場で作る provider です。core はこの違いを、principal source と credential store の組み合わせとして扱います。

cloudflare ホストで GitHub のログインを使うとき、GitHub provider はリポジトリの権限を持つ GitHub App のトークンを預かります。ide-gsm provider はそのログインを「誰か」を確かめるためだけに使い、GitHub のトークンは使いません。

### 4. Cloudflare ホストは、既定で一つの Worker にまとめる

hierarchidb では、BFF と Git Worker を別の Worker にし、Git Worker から BFF の Durable Object を参照していました。keybroker には汎用プロキシが同居しないので、既定では一つの Worker にまとめ、Durable Object も同じ Worker に置きます。他の Worker の Durable Object を参照する設定がなくなり、配備が一回で済みます。

Editor のビルド設定 `TW_PLUS_GIT_BFF_ORIGIN` と `TW_PLUS_GIT_PROXY_ORIGIN` は、どちらも同じ keybroker のオリジンを指します。

### 5. GitHub provider は、今の通信の契約をそのまま引き継ぐ

経路（`/v1/git-auth/*`、`/v1/git/*`、`/v1/github/*`）、要求と応答の形、エラーのコード、Bearer の形式と期限を変えません。TurboWarp Plus Editor の `turbowarp-plus-editor-auth` と `turbowarp-plus-editor-git` は、接続先のオリジンを替えるだけで使えます。テストも hierarchidb から移し、同じ振る舞いを確かめます。

### 6. ide-gsm provider は、短期の JWT の発行を既定にする

利用者が keybroker にログインすると、keybroker は ide-gsm が信頼する鍵で、数分で切れる JWT を発行します。ブラウザーはその JWT で ide-gsm に直接つなぎます。ide-gsm 側の変更は、keybroker を JWT の発行元（issuer）として登録し、その公開鍵を信頼することだけです。シミュレーションの重い通信と WebSocket が Cloudflare を通りません。

ide-gsm をブラウザーから直接届く場所に置けない場合は、keybroker が GraphQL の HTTP と WebSocket を「中継」する形も選べます。その場合、ブラウザーは5分で切れるプロキシ用の Bearer だけを持ちます。

どちらの形でも、次を守ります。

- **誰に開放するか：** 運用者が許可した GitHub アカウントまたは組織だけに発行する。
- **利用者の対応づけ：** GitHub アカウントを、ide-gsm の `upn` とワークスペースに対応づける。対応表は運用者が持つ。
- **権限の上限：** ide-gsm の `worker` と `admin` の役割は、ブラウザーの利用者に発行しない。
- **GraphQL の制限：** ide-gsm は利用者ごとに自分で認可するので、クエリの中身は ide-gsm に任せる。必要なら操作名による許可リストを provider の設定で持てるようにする（ide-gsm は操作名の重複をテストで禁じている）。
- **対象外：** MCP（`/mcp/sse`）の接続は認証の流れが別なので、この provider では扱わない。

### 7. 一つの配備は、一人の運用者のもの

マルチテナント（一つの配備で複数の運用者の GitHub App を扱う形）は対象にしません。運用者ごとに、自分の Cloudflare アカウントへ配備します。学校や機関が自分で持てるよう、配備の手順と設定の雛形を用意します。

### 8. クラウドで有効にする provider は、運用者が明示的に選ぶ

cloudflare ホストで最初に有効にするのは、GitHub provider です。ide-gsm provider は、利用者の対応表と許可するアカウントを運用者が用意したら有効にできます。上流が運用者自身の API で、認可も ide-gsm が行うためです。OpenAI と Sesame を cloudflare ホストで使えるのは、必要になってから、次を用意したあとにします。

- **OpenAI：** 運用者の API キーを複数の利用者が使うので、利用者の識別と、一人あたりの使用量・費用の上限が要る。
- **Sesame：** インターネットから解錠を要求できる場所に置くことになるので、遠隔の操作は既定で無効にし、施錠だけ・確認つきなどの制限を先に設計する。

### 9. ライセンスは MPL-2.0 にそろえる

移すコードは hierarchidb（MIT）にありますが、作者は同じです。keybroker の MPL-2.0 で公開し直します。

## 移行の手順

1. hierarchidb #1760 を先にマージする。動いている途中のものを移さないため。
2. keybroker：npm の名前を改め、core を Web 標準の API に寄せ、provider に「中継」と「発行」を加える。node ホストの振る舞いは変えない。
3. keybroker：cloudflare ホストと GitHub provider を、hierarchidb の main から移す。テストも移す。
4. dev に配備する。dev 用の GitHub App（GitHub App を作るアカウント）と、Cloudflare（Worker を配備するアカウント）が要る。秘密の値は運用者が自分で入れる。
5. TurboWarp Plus Editor を keybroker の dev のオリジンでビルドし、実 GitHub の private リポジトリで fetch・pull・push を確かめる（TurboWarp Plus Editor #316）。
6. hierarchidb から Git の部分と文書を外し、keybroker を指すようにする。
7. TurboWarp Plus Editor の文書のリンク（`docs/features/git/` の GitHub App 設定と API 設定）を keybroker に替える。
8. keybroker：ide-gsm provider（短期の JWT の発行）を加える。ide-gsm に keybroker を JWT の発行元として登録し、hierarchidb の「Bearer を供給する仕組み」から keybroker を使う。

## 未決事項

- cloudflare ホストを、ログイン（client secret を持つ）と中継（大量の通信を流す）の二つの Worker に分けられる設定も残すか。
- TurboWarp Plus Desktop のメインプロセスにある localhost の Git プロキシを、keybroker の node ホストと GitHub provider（デバイスフロー）に寄せるか。
- ide-gsm を Cloudflare から届く場所に置く方法（Cloudflare Tunnel など）と、JWT の発行と中継のどちらを使うか。
- ide-gsm の `api-github` が自前で行っている GitHub OAuth と GitHub API の中継を、keybroker の GitHub provider に寄せるか。
- 英語版の ADR を用意する時期。

## 関連

- [TurboWarp Plus Editor #315](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315)、[#316](https://github.com/kubohiroya/turbowarp-plus-editor/issues/316)
- [hierarchidb #1760](https://github.com/kubohiroya/hierarchidb/pull/1760)、[#1761](https://github.com/kubohiroya/hierarchidb/pull/1761)
- turbowarp-sesame の ADR 0001（capability-proxy を keybroker へ改名する決定）
- ide-gsm の `api-idegsm/docs/HIERARCHIDB_INTEGRATION_SPEC_ja.md`（hierarchidb から ide-gsm への接続の契約）
