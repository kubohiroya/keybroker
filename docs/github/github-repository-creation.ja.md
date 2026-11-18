# TurboWarp Plus Editor のための GitHub リポジトリの作成

[English](./github-repository-creation.md)

この任意の BFF のフローは、[TurboWarp Plus Editor #525](https://github.com/kubohiroya/turbowarp-plus-editor/issues/525) の、個人アカウントにリポジトリを作る経路を実装します。通常の [Git プロキシ](./git-smart-http.ja.md) は、これまでどおりリポジトリに限った別のセッションを使います。

## 認可

すべての経路は BFF の HTTPS のオリジンで動きます。呼び出し元のオリジンは `GIT_ALLOWED_ORIGINS` に設定します。呼び出し元は、ログインのチケットと作成用の Bearer をメモリにだけ持ちます。

| 経路                                                        | 要求                                                                                         | 結果                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /v1/github-create/start`                              | 空の JSON オブジェクト                                                                       | OAuth の認可 URL と、オリジンに結び付いた `login.<state>.<secret>` のチケット      |
| `GET /v1/github-create/callback`                            | GitHub の code と state                                                                      | state を使い切り、PKCE で code を交換したあとの、プレーンテキストの結果            |
| `GET /v1/github-create/session`                             | Bearer としてのログインのチケット                                                            | 待機中は `202`、そのあと `{scope, connection, account, bearer, expiresAt}`         |
| `DELETE /v1/github-create/session`                          | Bearer としてのログインのチケット                                                            | セッションを取り消したあと `204`                                                   |
| `GET /v1/github-create/owners`                              | 作成用の Bearer                                                                              | 認証された個人の所有者と、許される公開範囲の選択肢                                 |
| `POST /v1/github-create/repos`                              | 作成用の Bearer と `{operationId, owner, name, description, visibility, seedDigest, topics}` | 確かめたリポジトリ ID、所有者、名前、公開範囲、HTTPS の Git リモートとともに `201` |
| `PUT /v1/github-create/repos/<id>/topics`                   | 作成用の Bearer と `{operationId}`                                                           | 記録した topics をその確かめたリポジトリに適用したら `204`                         |
| `GET /v1/github-create/operations/<operationId>`            | 作成用の Bearer                                                                              | 記録した状態と、確かめた受領記録（receipt）または突き合わせのために示す候補        |
| `POST /v1/github-create/operations/<operationId>/reconcile` | 作成用の Bearer と、明示的に確認した `{repositoryId}`                                        | 候補をもう一度確かめたあと、確かめた受領記録とともに `201`                         |

作成の権限は、`scope: "repository-creation"`、`connection: {mode: "cloudflare", proxyOrigin: <BFF のオリジン>}`、`create.<state>.<secret>` の形の Bearer を使います。有効なのは最長 15 分で、期限が切れたら認可し直す必要があります。上流の利用者のアクセストークンは、期限切れか取り消しまで、ログインの Durable Object の中で暗号化したままです。作成用の資格情報は、この API だけが受け付けます。作成に成功すると、Editor は受領記録の HTTPS のリモートと `repositoryId` を通常の Git の認証の開始の経路に渡し、書き込みの権限を求めます。最初のコミットを push する前に、得られたセッションの ID を確かめます。

最初の所有者の一覧には、サインインした個人アカウントが入ります。組織でのリポジトリの作成には、別のポリシーと、メンバーかどうかを確かめる仕組みが必要です。所有者の選択肢は、この機能に設定した範囲を反映します。GitHub は、操作ごとに App と利用者の権限を確かめます。

## 作成の受領記録と再試行

Durable Object は、GitHub を呼ぶ前に、正規化した意図（intent）を、変わらない GitHub アカウント ID と操作 ID ごとに記録します。変わらない意図を再送すると、保存した受領記録か失敗を返します。応答が失われた場合、元の要求は成功しているかもしれません。その操作は不明のまま残り、再送しても新たな作成の要求は送りません。所有者、名前、公開範囲が同じで、ブランチもタグもない最近作られたリポジトリは、突き合わせの候補として示せます。Editor は、突き合わせを求める前に、候補の ID について明示的な確認を得なければなりません。BFF は、受領記録を記録する前にもう一度確かめます。topics には、同じ記録の項目にある確認済みの値を使います。topics を変更する前には、毎回 ID と公開範囲を確かめます。

上流の API の経路は、GitHub の `/user`、`/user/repos`、`/repos/<owner>/<name>` と、その topics、branches、tags の経路に固定しています。リダイレクトは拒否し、エラーは中身を伏せて返します。BFF は、GitHub のアクセストークンも上流の応答の本文も返しません。

## 設定

`GitRepositoryCreation` を SQLite の Durable Object として登録し、BFF で `GIT_REPOSITORY_CREATION` に結び付けます。`GIT_CREATE_CLIENT_ID`、`GIT_CREATE_CLIENT_SECRET`、`GIT_CREATE_REDIRECT_URI`（正確に `https://<bff>/v1/github-create/callback`）、`GIT_CREATE_SESSION_KEY`（32 バイトの乱数を 16 進 64 桁で）を設定します。コールバックを GitHub App に加えます。これらを設定しないと、作成の経路は使えません。

個人のリポジトリを作るために、GitHub App にリポジトリの権限 **Repository creation: Write** を与えます。topics の別の操作には、**Administration: Write** の承認が必要です。通常の Git プロキシで最初の push を行うには、その App のインストールと利用者に、作ったリポジトリでの **Contents: Write** が必要です。[リポジトリの作成](https://docs.github.com/ja/rest/repos/repos#create-a-repository-for-the-authenticated-user) · [topics のエンドポイント](https://docs.github.com/ja/rest/repos/repos#replace-all-repository-topics)

実際に確かめるときは、試験環境に keybroker を配備し、二つの App と Editor のオリジンを設定します。使い捨ての GitHub アカウントかリポジトリ名と、内容をアップロードしてよい作品を使います。Editor から作成用の App にサインインし、個人の所有者とリポジトリの公開範囲を確かめてから、リポジトリを作ります。GitHub で、数値の ID、公開範囲、説明、topics を確かめます。通常の Git の App のインストールで選んだリポジトリだけを許している場合は、通常の Git の App にサインインする前に、新しいリポジトリをそのインストールに加えます。最初の push のあと、既定のブランチ、変換した作品のファイル、README、ライセンスを確かめます。同じ操作を元の入力のまま再送すると、既存の受領記録が返らなければなりません。

切り戻すには、作成の binding かその設定を外します。あとで再び有効にしたときに以前の試みを突き合わせられるよう、記録は消さずに残します。
