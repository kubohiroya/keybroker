# TurboWarp Plus Editor の Git プロキシ

[English](./git-smart-http.md)

この契約は任意のもので、[TurboWarp Plus Editor #315](https://github.com/kubohiroya/turbowarp-plus-editor/issues/315) の方式 B を実装します。GitHub App の Web 認可、BFF が持つ Durable Object、経路を固定した Git 中継を使います。どちらも keybroker の Cloudflare Worker（`src/cloudflare/worker.ts`）で動きます。ここでいう「BFF」と「Git Worker」の意味は、[目次](./README.ja.md) を見てください。

アカウント単位の初回作成には、別の [リポジトリ作成の契約](./github-repository-creation.ja.md) を使います。

## ログインとセッション

1. Editor は、BFF の `/v1/git-auth/start` に JSON `{remote, write, review?}` を POST します。`review` は任意の真偽値で、プルリクエストのレビューを送信する権限（許可）を求めます。`write`（push）とは別のもので、省略すると false です。真偽値でない値は `400 BAD_REQUEST` を返します。BFF は、認可 URL と、中身の見えないログインチケットを返します。Editor はチケットをメモリーに持ち、認可 URL を開きます。
2. GitHub が `/v1/git-auth/callback` を呼びます。BFF は、PKCE を使ってコードを交換する前に、OAuth の state を不可分に消費します。選ばれたリポジトリ ID と、求められた権限を検証します。コールバックは、簡単な確認画面を返します。
3. Editor は、ログインチケットを Bearer にして、BFF の `GET /v1/git-auth/session` をポーリングします。ログインが完了していなければ 202 を返します。完了していれば、Cloudflare の接続、アカウント、プロキシの Bearer、Unix ミリ秒の有効期限を返します。チケットはオリジンに結び付いており、ログインが期限切れになるまで、更新した 5 分間有効のプロキシの Bearer を取得できます。ログインは最長 8 時間です。
4. ログインチケットを付けた `DELETE /v1/git-auth/session` は、サーバー側の記録を取り消します。処理中の呼び出しは、認可が完了する前に記録を確かめ直します。

初回の公開では、開始の本文に `repositoryId`（正の安全な整数）を加えることがあります。コールバックは、[GitHub のトークン交換](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) でその ID を求め、セッションを与える前に、リポジトリの照会が返した ID と照合します。セッションの応答は、この任意の流れに限って、検証した ID を返します。Git の認可は、発見のリダイレクトも含めて、すべてのリクエストでその ID を再び確かめます。

GitHub のアクセストークンと更新用のトークン、現在のプロキシの秘密は、BFF の Durable Object の中で AES-GCM で暗号化します。BFF はトークンの更新を直列に行います。Git Worker は、Durable Object のバインディングを通して認可にアクセスします。公開している BFF のエンドポイントは、表示用の情報とプロキシのセッションを返し、上流の認証情報は Worker の境界の中に留めます。

### アカウントの本人照合

新しいログインではGitHubの `GET /user` が返す正の数値IDを必須とし、プロキシセッションの `account.id` に返します。ログイン名は表示用です。トークン更新時もIDを再照合し、同じIDの名前変更を許可します。IDが変わった場合は、既存セッションを失効させ、別人としての送信へ切り替えません。公開操作の認可でも名前の一致だけで本人を判断しません。

変更前のサーバー記録にはIDがない場合があります。ペアプログラミングのクライアントはその接続を送信に使わず、対応版での再認証を案内します。保存済みの参加者との対応付けはクライアントで本人が明示確認し、ログイン名だけから移行しません。

## プロキシ

Git 専用の経路は、`GET /v1/git/<owner>/<repo>.git/info/refs?service=git-upload-pack|git-receive-pack` と `POST /v1/git/<owner>/<repo>.git/git-upload-pack|git-receive-pack` です。プロキシは、自分の配備の正確な HTTPS オリジン、リクエストのオリジン、Bearer、リポジトリ ID、操作を検証します。許可する呼び出し元のオリジンは明示します。Desktop を有効にするには、両方のオリジンの一覧に `tw-editor://.` を加えます。許可された OPTIONS は、求められたメソッドと許可したヘッダーを付けて 204 を返します。認証済みの Git の応答とエラーは、許可した正確なオリジンを含み、`no-store` を付けます。

プロキシは、GitHub の HTTP Basic 認可ヘッダーを新しく作り、Smart HTTP のバイナリーストリームをそのまま保ち、宣言された POST の長さを 32 MiB の上限と照合します。発見のリダイレクトは、同じ GitHub リポジトリ ID とサービスへの 1 回だけを検証して認め、RPC のリダイレクトは拒否します。エラーの本文は `{code, requestId}` です。

`git-receive-pack` の POST には、`Git-Push-Id` に小文字の UUID v4 が必ず要ります。その事前確認（preflight）は、このヘッダーを許可します。BFF は、セッション、リポジトリ、書き込みの権限（許可）を検証した後、Git Worker が POST を送る前に、その ID を不可分に予約します。予約済みの ID には `409 PUSH_DUPLICATE` を返します。予約は、リクエストの失敗、Worker の再起動、Bearer の更新の後も残り、ログインと一緒に期限切れになります。1 つのログインで受け付ける異なる ID は 256 個までで、上限に達すると `429 RATE_LIMITED` を返します。Git Worker は、BFF による予約の確認を必ず求めます。両方の Worker を配備し、この契約を実装したクライアントで push を有効にしてください。[Editor の契約](https://github.com/kubohiroya/turbowarp-plus-editor/issues/316)

<a id="github-api-routes"></a>

## GitHub API の経路

この節は、[TurboWarp Plus Editor #444](https://github.com/kubohiroya/turbowarp-plus-editor/issues/444)（[hierarchidb #1757](https://github.com/kubohiroya/hierarchidb/issues/1757)）の段階 A を実装します。Git Worker は、決まった一連のプルリクエストとレビューの呼び出しを、`/v1/github/<owner>/<repo>/` の下で GitHub に中継します。プルリクエストの中身は Git Smart HTTP で扱います。これらの経路は、任意の URL も、クライアントの GraphQL ドキュメントも転送しません。変更ファイルの一覧、ファイルの中身や比較、行コメント、単独の REST コメント、プルリクエストの作成・マージ・クローズは中継しません。

| 経路                                | 上流                                                                                            | クエリーまたは操作                                                                                                                                       | 権限（許可） | `GIT_GITHUB_API` |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------- |
| `GET /pulls`                        | `GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=20&page=<page>` | `page` は 1–50、1 回まで                                                                                                                                 | read         | `pulls-read`     |
| `GET /pulls/<n>`                    | `GET /repos/{owner}/{repo}/pulls/{n}`（`application/vnd.github.text+json`）                     | なし                                                                                                                                                     | read         | `pulls-read`     |
| `GET /pulls/<n>/publication-status` | 公開状態を調べる決まったクエリーで `POST https://api.github.com/graphql`                        | なし                                                                                                                                                     | read         | `checks-read`    |
| `POST /graphql/<operation>`         | 決まったドキュメントで `POST https://api.github.com/graphql`                                    | `pullRequestReviewContext`（read）、`addPullRequestReview`、`addPullRequestReviewThread`、`submitPullRequestReview`、`deletePullRequestReview`（review） | 操作ごと     | `review-threads` |
| `GET /pulls/<n>/reviews`            | `GET /repos/{owner}/{repo}/pulls/{n}/reviews?per_page=30&page=<page>`                           | `page` は 1–10、1 回まで                                                                                                                                 | read         | `reviews-body`   |
| `POST /pulls/<n>/reviews`           | `POST /repos/{owner}/{repo}/pulls/{n}/reviews`                                                  | なし                                                                                                                                                     | review       | `reviews-body`   |

`<owner>` と `<repo>` は、Git の経路と同じ規則に従いますが、`.git` の接尾辞は付けません。`<n>` は 1–2,147,483,647 で、先頭に 0 を付けません。これ以外のメソッド、パス、クエリー、繰り返したクエリー、ページ、操作は、セッションにも GitHub にも問い合わせる前に `400 BAD_REQUEST` を返します。`GIT_GITHUB_API` にない経路のグループは `404 GITHUB_API_UNAVAILABLE` を返します。この変数に未知の値や重複した値があると、すべての経路が `500 GITHUB_API_MISCONFIGURED` で失敗します。`reviews-body` の経路は、`review-threads` がオフのときに、レビューの本文だけを送る代わりの手段です。

### 検証の順番

1. オリジン: Git の経路と同じく、`GIT_ALLOWED_ORIGINS` との完全一致（`null`、`*`、オリジンなしは拒否）と、Worker 自身の `GIT_PROXY_ORIGIN`。この段階より後のエラーは、許可したオリジンと `Cache-Control: no-store` を付けます。
2. `GIT_GITHUB_API` と経路のグループ。
3. パス、メソッド、クエリー。事前確認（preflight）は、必ずその経路のメソッドを求めなければなりません。GET で許可するのは `authorization` だけで、POST は `authorization, content-type, review-submit-id` を許可します。それ以外のヘッダーを求めると `403 FORBIDDEN` を返します。
4. Bearer（Git の経路と同じく `<state>.<secret>`）: `401 SESSION_REQUIRED`。
5. リクエストの形。GET は本文も `Review-Submit-Id` も持ちません。POST には、`Content-Type: application/json`、256 KiB 以下（`413 PAYLOAD_TOO_LARGE`）の `Content-Length`（`411 LENGTH_REQUIRED`）、JSON オブジェクトの本文、下の変数が必ず要ります。`Review-Submit-Id`（小文字の UUID v4）は、`POST /pulls/<n>/reviews` と 4 つのミューテーションでは必須、`pullRequestReviewContext` では任意で、それ以外では拒否します。
6. `GitSession` の `/authorize` に `operation`（`read` または `review`）を付けて確かめるセッション: オリジン、有効期限、取り消し、リポジトリ名。`review` には、ログインの `review` の権限（許可）が必ず要ります（`403 FORBIDDEN`）。
7. リポジトリ ID: すべてのリクエストで、`GET /repos/{owner}/{repo}` が、セッションのリポジトリ ID と `permissions.pull` を必ず返さなければなりません（読み取りでもレビューでも同じで、push は要りません）。照会がレート制限にかかると `retryAfter` を付けて `429 RATE_LIMITED` を返します。それ以外の失敗は `403 FORBIDDEN` を返します（トークンが拒否されたときは `401 REAUTH_REQUIRED`）。
8. 予約（`POST /pulls/<n>/reviews` と GraphQL の各段階）、その後に上流へのリクエストを 1 回だけ送ります。

上流へのリクエストは、照会で得た正規のオーナー名とリポジトリ名で、`https://api.github.com` にだけ送ります。そのヘッダーは、`Authorization: Bearer <user access token>`、決まった `Accept`（単一のプルリクエストでは `application/vnd.github.text+json`、それ以外は `application/vnd.github+json`）、REST に限り `X-GitHub-Api-Version: 2022-11-28`、`User-Agent`、POST では `Content-Type: application/json` です。クライアントの Bearer、Cookie、`Origin`、`Referer` は転送しません。リダイレクトはたどりません（`409 REDIRECT_REJECTED`）。上流のタイムアウトは 30 秒です（`504 UPSTREAM_TIMEOUT`）。

### 変数

GraphQL の本文は、変数だけの JSON オブジェクトです。それ以外のキーや、型の違う値は `400 BAD_REQUEST` を返します。クライアントは、GraphQL ドキュメントもノード ID も決して送りません。

| 操作                         | 変数                                     | 規則                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pullRequestReviewContext`   | `number`                                 |                                                                                                                                                                                            |
| `addPullRequestReview`       | `number`、`commitOid`                    | `commitOid` は小文字の 16 進数 40 桁                                                                                                                                                       |
| `addPullRequestReviewThread` | `number`、`threadIndex`、`path`、`body`  | `threadIndex` は 0–49。`path` は相対パスで、UTF-8 で 1,024 バイト以下、最後の要素がちょうど `project.source.json`、空・`.`・`..` の要素、`\`、制御文字を含まない。`body` は 1–65,536 文字  |
| `submitPullRequestReview`    | `number`、`threadCount`、`event`、`body` | `threadCount` は 0–50。`event` は `COMMENT`、`APPROVE`、`REQUEST_CHANGES` のいずれか。`body` は 65,536 文字以下で、`REQUEST_CHANGES` のときと、スレッドのない `COMMENT` のときは空にしない |
| `deletePullRequestReview`    | `number`                                 |                                                                                                                                                                                            |

`POST /pulls/<n>/reviews` が受け付けるのは、`commit_id`（小文字の 16 進数 40 桁、必須）、`event`（`COMMENT`、`APPROVE`、`REQUEST_CHANGES` のいずれか、必須）、`body`（`APPROVE` 以外では必須で空にしない、65,536 文字以下）だけです。`comments` と空の `event` は拒否します。

Worker は、5 つのレビューのドキュメントと、公開状態を調べるクエリーを `src/providers/github/githubReviewDocuments.ts` に持ちます。スレッドのミューテーションは、ドキュメントに `subjectType: FILE` を書き込みます。Worker は、`owner` と `name`（正規の名前、`followRenames: false`）、`pullRequestId`、`reviewId` を埋めます。

### プルリクエストの公開状態

状態の経路は、`read` の権限（許可）を持つ、リポジトリに結び付いた通常の Git セッションを使います。Worker は、GraphQL のリポジトリ ID をセッションの権限（許可）と、プルリクエスト番号をパスと、ロールアップのコミット OID を現在の head の SHA と照合します。リポジトリが一致しなければ `403 FORBIDDEN`、プルリクエストかロールアップの SHA が一致しなければ `502 UPSTREAM_FAILURE` で拒否します。セッションの照会と GraphQL のクエリーは、GitHub のリポジトリのデータを読みます。

応答には次のものが入ります。

| フィールド                      | 値                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositoryId`、`number`        | 検証した GitHub のリポジトリ ID とプルリクエスト番号                                                                                                                |
| `state`、`mergedAt`、`draft`    | `OPEN`、`CLOSED`、`MERGED` のいずれか。マージの時刻または `null`。ドラフトかどうか                                                                                  |
| `head`                          | `{ ref, sha, repositoryId }`。head のリポジトリを特定できないときは `repositoryId: null`                                                                            |
| `base`                          | 検証したリポジトリの中の `{ ref, sha }`                                                                                                                             |
| `checks`                        | `{ state, totalCount }`。state は `SUCCESS`、`FAILURE`、`PENDING`、`ERROR`、`EXPECTED` のいずれかで、見えるロールアップのチェックの項目（context）がなければ `null` |
| `reviewDecision`                | `APPROVED`、`CHANGES_REQUESTED`、`REVIEW_REQUIRED`、`null` のいずれか                                                                                               |
| `mergeStateStatus`、`mergeable` | GitHub の [詳しいマージ状態とマージできるかどうか](https://docs.github.com/en/graphql/reference/pulls#mergestatestatus)                                             |

キューは、返された head のリポジトリ、ref、SHA を、承認済みの公開ジョブと必ず照合し、base を意図した対象と必ず照合しなければなりません。[チェックのロールアップ](https://docs.github.com/en/graphql/reference/commits#statuscheckrollup) が成功なら、その head にある見えるチェックの状態を示します。件数が 0 なら、CI の裏付けにはなりません。ブランチのルール、必須のレビュー、テストマージやマージキューのチェック、マージの権限は、GitHub がマージの時点で評価します。

実際に読み取りを確かめるには、Git Worker で `checks-read` を有効にし、使い捨てのテスト用リポジトリに GitHub App のインストールを承認し、そのリポジトリで利用者の通常の Git セッションを認可します。Git の読み取りには `Contents: Read` を、PR の状態と 2 種類のチェックには `Pull requests: Read`、`Checks: Read`、`Commit statuses: Read` を与えます。既存の書き込みの権限（許可）があれば、対応する読み取りの権限としても足ります。リポジトリのオーナーに、CI のワークフローか外部のチェックを持つ PR を用意してもらい、更新した head を push する前と後に、この経路をポーリングします。返された SHA と状態を GitHub と比べます。別のリポジトリ、許可していないオリジン、期限切れのセッションは、必ず拒否されなければなりません。`checks-read` を外すと、この経路だけを無効にできます。

### 今後の公開の書き込みに向けた承認

今後の BFF の公開エンドポイントは、BFF が出す確認画面から始めることになります。その画面には、正確なリポジトリ、ブランチとコミット ID、PR のタイトルと本文、Issue の操作、マージの方法、認可した手順を表示します。Worker は、利用者がその下見を確認した後でだけ、認証済みのアカウント、リポジトリ ID、許可した Editor のオリジン、ジョブ ID に結び付いた短期間の承認を発行します。ジョブは、承認した手順を永続ストレージに予約し、タイムアウトの後は検証した結果を回復するべきです。承認とミューテーションの処理には、状態の経路や通常の Git セッションとは別の権限が必ず要ります。

サーバーは、プルリクエストを読み直し、現在の head と base を承認したジョブと比べ、GitHub のマージのリクエストに期待する head の SHA を渡すべきです。対象か head が変わったら、承認をやり直す必要があります。積み重ねたプルリクエストでは、承認は、前のプルリクエストと意図した base を必ず特定しなければなりません。Issue を閉じるには、承認された Issue の操作と、検証したマージが必要です。GitHub App のインストールには、作成のために `Pull requests: Write`、push と [マージ](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request) のために `Contents: Write`、Issue を作成するときや明示的に閉じるときに `Issues: Write` が必要になります。それぞれの権限をインストールに設定し、リポジトリのルールの下で、利用者が承認した操作を実行できることを確かめてください。

### ノード ID

プロキシは、クライアントからノード ID を決して受け取らず、決して返しません。`addPullRequestReview` の前に、Worker は検証したリポジトリで `pullRequestReviewContext` を送り、`repository.databaseId` がセッションのリポジトリ ID と等しいときに限って `pullRequest.id` を使います。レビュー ID は、`addPullRequestReview` の応答からだけ得ます。その応答の `pullRequest.id`、`state: PENDING`、コミットが一致した後で使います。`GitSession` は、両方を送信の記録に保存し、同じ送信 ID、セッション、プルリクエストの後の段階で、`/authorize` の権限（許可）に入れて Worker に渡します。

### Review-Submit-Id と段階

1 つの `Review-Submit-Id` は、1 回のレビューの送信を表します。`GitSession` は 2 つのキーを持ちます。どちらもログインと一緒に期限切れになり、取り消しと期限切れのときに削除され、Worker の再起動と Bearer の更新の後も残ります。

- `review-ids`: `POST /pulls/<n>/reviews` の ID。`push-ids` と同じトランザクションの形で予約します。予約済みの ID は `409 REVIEW_DUPLICATE` を返します。
- `review-submits`: GraphQL の送信 ID → `{repositoryId, number, commitOid, pullRequestNodeId, reviewNodeId, threads, state, since, attempt}`。

2 つのキーが持つ項目は、終わったものも含めて合わせて 256 個までです。それを超えると、`/authorize` は `retryAfter` を付けずに `429 RATE_LIMITED` を返します。待っても空きは増えないからです。ID は 2 つのキーを通して一意です。

`/authorize` は、Worker が GitHub に問い合わせる前に、段階を記録と照合し、処理中の状態を 1 つのトランザクションで書き込みます。Worker は、上流の結果（`ok`、`failed`、`unknown`、`gone`、確認では `pending`、`submitted`、`closed`）を、記録の `attempt` のノンスを付けて、内部の `/review-result` 経路に報告します。`GitSession` は、そのノンスが現在のものである間だけ、報告を反映します。

| 段階                                   | 受け付ける条件                                                                                                   | 重複（`409 REVIEW_DUPLICATE`）                                               | 結果                                                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addPullRequestReview`                 | ID が新しく、そのプルリクエストについてセッションに終わっていない記録がない（あれば `409 REVIEW_STEP_CONFLICT`） | その ID を持つ既存の記録すべて                                               | `starting` → `pending`（スレッド 0 件）、`closed`、または `start-unknown`                                                                                                                                               |
| `addPullRequestReviewThread`           | `pending` で、`threadIndex` が受け付けたスレッドの数と等しい                                                     | `threadIndex` がその数より小さい、または処理中か最後に失敗したスレッドの番号 | `threading` → `pending`（+1）、`broken`、またはレビューがなくなっていれば `closed`                                                                                                                                      |
| `submitPullRequestReview`              | `pending` で、`threadCount` が受け付けたスレッドの数と等しい                                                     | `submitting`、`submit-unknown`、`submitted`                                  | `submitting` → `submitted`、`pending`（送っていない）、`submit-unknown`、またはなくなっていれば `closed`                                                                                                                |
| `deletePullRequestReview`              | `pending` または `broken`                                                                                        | `deleting`、`closed`                                                         | `deleting` → `closed`、または前の状態に戻る                                                                                                                                                                             |
| ID を付けた `pullRequestReviewContext` | 同じプルリクエストの任意の記録                                                                                   | —                                                                            | `start-unknown` → 記録したコミットにある閲覧者の保留中のレビューが本文もコメントも空なら `pending`、そうでなければ `closed`。`submit-unknown` → 記録したレビューを見つけて、`submitted`、`pending`、`closed` のいずれか |

これ以外の段階の順番、違うリポジトリやプルリクエスト番号、記録がないときは `409 REVIEW_STEP_CONFLICT` を返します。60 秒より古い処理中の状態は、不明として読みます（`starting` → `start-unknown`、`threading` → `broken`、`submitting` → `submit-unknown`、`deleting` → その前の状態）。そのため、段階の途中で止まった Worker が送信を妨げることはありません。`addPullRequestReview` の前に、閲覧者の保留中のレビューがあれば、ミューテーションを送らずに `409 PENDING_REVIEW_EXISTS` を返し、記録を閉じます。ミューテーションの後に結果の報告そのものが失敗したときは、クライアントは `502 UPSTREAM_FAILURE` を受け取り、`pullRequestReviewContext` で解決します。

### 応答

成功は `200` の JSON で、次のフィールドだけを含みます。上流のヘッダーは捨て、応答は `no-store` です。上流の本文が上限を超えたとき、JSON でないとき、ほかの形のときは `502 UPSTREAM_FAILURE` を返します。

| 経路                         | 上流の上限 | フィールド                                                                                                                                                                                                                                  |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /pulls`                 | 1 MiB      | `number, title, state, draft, merged_at, updated_at, user.login, head{sha, ref}, base{sha, ref}` の配列                                                                                                                                     |
| `GET /pulls/<n>`             | 1 MiB      | `number, title, state, draft, merged_at, user.login, body`（GitHub が送ったとき）、`body_text, changed_files, head{sha, ref, repo.full_name}, base{sha, ref, repo.full_name}`                                                               |
| `GET /pulls/<n>/reviews`     | 4 MiB      | `id, user.login, commit_id, state, submitted_at, body` の配列                                                                                                                                                                               |
| `POST /pulls/<n>/reviews`    | 1 MiB      | `id, state, commit_id, submitted_at, html_url`                                                                                                                                                                                              |
| `pullRequestReviewContext`   | 256 KiB    | `headRefOid`、`viewer`、`pendingReview`（`null` または `{ours, commitOid, createdAt}`）、`reviews`（直近 30 件のうち閲覧者のレビュー、新しい順、`{state, commitOid, submittedAt, ours}`）、ID を付けたときは `submit`（`{state, threads}`） |
| `addPullRequestReview`       | 64 KiB     | `{state: "PENDING", commitOid}`                                                                                                                                                                                                             |
| `addPullRequestReviewThread` | 64 KiB     | `{threads}`                                                                                                                                                                                                                                 |
| `submitPullRequestReview`    | 64 KiB     | `{state, commitOid, submittedAt, url}`                                                                                                                                                                                                      |
| `deletePullRequestReview`    | 64 KiB     | `{deleted: true}`                                                                                                                                                                                                                           |

`ours` は、リクエストの `Review-Submit-Id` で記録したレビューについて true です。`user`、`head.repo`、コミットが null のときは `null` を返します。

### エラーとレート制限

エラーの本文は `{code, requestId}` です。GitHub のレート制限のときは、これに `retryAfter`（0 以上の整数の秒数）を加えます。その値は `retry-after`、なければ `x-ratelimit-reset` から現在時刻を引いた値、それもなければ 60 です。GitHub のエラーメッセージは、返しもせず、ログにも残しません。

| 上流                                                                                                                                                                                                 | クライアント                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST の `429`、または `x-ratelimit-remaining: 0` か `retry-after` を伴う `403`                                                                                                                       | `429 RATE_LIMITED`                                                                                                                                                                                                               |
| REST の `401`/`403`                                                                                                                                                                                  | `403 FORBIDDEN`                                                                                                                                                                                                                  |
| REST の `404`                                                                                                                                                                                        | プルリクエストの経路では `404 PULL_REQUEST_NOT_FOUND`、一覧では `403 FORBIDDEN`                                                                                                                                                  |
| レビューの POST での REST の `422`                                                                                                                                                                   | `422 REVIEW_REJECTED`                                                                                                                                                                                                            |
| `errors[].type` が `RATE_LIMITED` の GraphQL `200`、またはエラーがある（かデータがない）うえに `x-ratelimit-remaining: 0` の GraphQL `200`。GraphQL の `429`、またはレート制限のヘッダーを伴う `403` | `429 RATE_LIMITED`（送っていない）                                                                                                                                                                                               |
| GraphQL の `401`/`403`、または `errors[].type` が `FORBIDDEN`                                                                                                                                        | `403 FORBIDDEN`（送っていない）                                                                                                                                                                                                  |
| GraphQL の `NOT_FOUND`                                                                                                                                                                               | 確認の段階（`pullRequestReviewContext`）と `addPullRequestReview`: 検証したリポジトリの中なら `404 PULL_REQUEST_NOT_FOUND`、それ以外は `403 FORBIDDEN`。スレッドと送信: `409 REVIEW_STEP_CONFLICT`（記録は閉じ済み）。削除: 成功 |
| `data: null` とほかのエラーを伴う GraphQL `200`                                                                                                                                                      | スレッドでは `422 REVIEW_THREAD_REJECTED`、それ以外は `422 REVIEW_REJECTED`（送っていない）                                                                                                                                      |
| エラーを伴う GraphQL の `data`、形の合わないもの、`502`、接続の切断                                                                                                                                  | `502 UPSTREAM_FAILURE`（結果は不明）                                                                                                                                                                                             |
| `504` または 30 秒のタイムアウト                                                                                                                                                                     | `504 UPSTREAM_TIMEOUT`（結果は不明）                                                                                                                                                                                             |
| その他の状態コード                                                                                                                                                                                   | `502 UPSTREAM_FAILURE`（送っていない）                                                                                                                                                                                           |

正しい形で成功した GraphQL の `200` は、`x-ratelimit-remaining` が `0` でも成功です。そのリクエストが最後の 1 ポイントを使ったからです。これらの経路は何もログに残しません。リクエストの本文、`path`、`Authorization`、上流の本文、ノード ID のどれも残しません。

<a id="enable-and-roll-back"></a>

## 有効にする手順と切り戻し

keybroker は、ログインと Git の中継を、1 つの Cloudflare Worker `src/cloudflare/worker.ts` として配備します。この Worker は、これらの文書にある決まった経路だけを扱い、それ以外のパスにはすべて `404 NOT_FOUND` を返します。`wrangler.toml.template` を `wrangler.toml` にコピーし、プレースホルダーを置き換え、シークレットを設定して、`pnpm deploy:cloudflare` を実行します。設定の写しは配備ごとに 1 つ持ち、それぞれに専用の GitHub App とシークレットを用意します。

`GIT_ALLOWED_ORIGINS` と、Worker 自身の正確な HTTPS の `GIT_PROXY_ORIGIN` を設定します。Editor は、そのオリジンを `TW_PLUS_GIT_BFF_ORIGIN` と `TW_PLUS_GIT_PROXY_ORIGIN` の両方に指定してビルドします。`GIT_GITHUB_CLIENT_ID`、`GIT_GITHUB_CLIENT_SECRET`、`/v1/git-auth/callback` で終わる `GIT_GITHUB_REDIRECT_URI`、`GIT_SESSION_KEY` を設定します。`GIT_SESSION_KEY` はシークレットにし、32 バイトの乱数を 16 進数 64 桁で表した値にします。テンプレートは、`GitSession` を SQLite を使う Durable Object として登録し、同じ Worker の中で `GIT_SESSIONS` としてバインドします。バインディングや設定がないときは、これらの経路は安全側に倒れて失敗します（fail closed）。

`GIT_GITHUB_CLIENT_ID` と `GIT_GITHUB_CLIENT_SECRET` を与える GitHub App の作り方は、[github-app-setup.ja.md](./github-app-setup.ja.md) で説明しています。

GitHub API の経路を有効にするには、`GIT_GITHUB_API` を設定します。例: `pulls-read,review-threads,reviews-body`。GitHub App には、リポジトリの権限 Pull requests: Read and write も必要で、それぞれのインストールで承認されている必要があります。`review` は既存の `GitSession` の保存記録に加わる新しいフィールドで、`review-ids` と `review-submits` は新しいキーです。そのため、Durable Object のマイグレーションは要りません。

切り戻すには、Git の経路のバインディングを外し、影響を受けるセッションの記録を取り消します。リポジトリ作成と公開の経路は、それぞれ自分の設定を保ちます。`GIT_GITHUB_API` から `review-threads` を外すと GraphQL の経路だけが止まり、`reviews-body` が残っていれば、クライアントはレビュー本文の経路に切り替えます。変数そのものを外すと、GitHub API の経路はすべて止まります。Git の経路、ログイン、セッションの記録には影響しません。`review-ids` と `review-submits` は、ログインと一緒に期限切れになります。切り戻しの間に GitHub に残った保留中のレビューは、書いた本人にしか見えず、本人がプルリクエストのページで破棄できます。
