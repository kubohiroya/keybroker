# TurboWarp Plus Editor の Git 経路で使う GitHub App

[English](./github-app-setup.md)

[git-smart-http.md](./git-smart-http.ja.md) の Git 経路は、GitHub App を通して GitHub に接続します。この文書では、誰がその App を作るのかと、配備を運用する人が App を作って設定する手順を説明します。

## 誰が App を作るか

Cloudflare の配備（BFF と Git Worker）を運用する人が、配備ごとに App を 1 つ作ります。Editor を使う人は App を作りません。運用する人の App を自分のリポジトリにインストールし、接続するときに認可します。

| 立場                                                          | App を作るか                  | すること                                                                     |
| ------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| BFF と Git Worker を運用する人                                | 作る（配備ごとに 1 つ）       | 下の手順で App を作り、Client ID とクライアントシークレットを BFF に設定する |
| TurboWarp Plus Desktop を配布する人                           | 作る（上と同じ App でもよい） | Device Flow を有効にした App の Client ID を Desktop に渡す                  |
| 公開版の Editor や配布された Desktop を使う人                 | 作らない                      | App を自分のリポジトリにインストールし、接続するときに認可する               |
| 自分で接続先を立てる人、Client ID を含まない Desktop を使う人 | 作る                          | 運用する人と同じ手順で作る                                                   |

GitHub App のユーザーアクセストークンで操作できるのは、次の 3 つがすべて重なる範囲だけです。App に与えた権限、App をインストールしたリポジトリ、認可した本人がそのリポジトリに持っている権限です。そのため、App を 1 つ共有しても、使う人どうしで相手のリポジトリを操作できるようにはなりません。 [GitHub App のユーザーアクセストークン](https://docs.github.com/ja/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)

## App を作る

GitHub の **Settings → Developer settings → GitHub Apps → New GitHub App** で作ります。組織で運用する場合は、組織の **Settings → Developer settings → GitHub Apps** で作ります。 [GitHub App の登録](https://docs.github.com/ja/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)

### 基本の設定

| 項目                                                   | 値                                                                                | 理由                                                                                                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App name                                        | 例: `<App の名前> (dev)`                                                          | 認可とインストールの画面に出る。環境ごとに App を分けると見分けやすい                                                                              |
| Homepage URL                                           | Editor の公開先。例: `https://kubohiroya.github.io/turbowarp-plus-editor/`        | 認可の画面に出る                                                                                                                                   |
| Callback URL                                           | BFF の `/v1/git-auth/callback`。例: `https://<BFF のホスト>/v1/git-auth/callback` | ログインの後に GitHub が戻る先。BFF の `GIT_GITHUB_REDIRECT_URI` と完全に一致させる。環境ごとに足す                                                |
| Expire user authorization tokens                       | **オン**                                                                          | BFF と Desktop は、期限付きのアクセストークンと更新用のトークン（refresh token）を前提にしている。オフだと更新用のトークンが返らず、接続に失敗する |
| Request user authorization (OAuth) during installation | オフ                                                                              | 認可は接続するときに行う                                                                                                                           |
| Enable Device Flow                                     | Desktop で使うなら **オン**                                                       | Desktop は device flow でログインする                                                                                                              |
| Webhook → Active                                       | **オフ**                                                                          | Webhook は使わない                                                                                                                                 |

### リポジトリの権限（Repository permissions）

| 権限          | 値             | 使う機能                                               |
| ------------- | -------------- | ------------------------------------------------------ |
| Contents      | Read and write | fetch と pull（read）、push（write）                   |
| Pull requests | Read and write | PR の一覧・題名・本文（read）、レビューの送信（write） |
| Metadata      | Read-only      | 自動で付く。リポジトリ ID の照合に使う                 |

ほかの権限は付けません。アカウントと組織の権限（Account permissions、Organization permissions）も付けません。レビューの機能を使わないなら、Pull requests は付けなくてかまいません。その場合は PR の経路だけが GitHub に断られ、Git の経路はそのまま使えます。

あとから足した権限は、インストールした各アカウントが承認するまで、そのインストールには反映されません。 [GitHub App の登録の変更](https://docs.github.com/ja/apps/maintaining-github-apps/modifying-a-github-app-registration)

### インストールできる先

使う人が自分のアカウントにインストールするなら、**Where can this GitHub App be installed?** で **Any account** を選びます。運用する人自身の個人や組織のリポジトリだけで使うなら、**Only on this account** で足ります。

### 控えておく値

- **Client ID**（`Iv23…` の形）: 公開してよい値です。BFF の `GIT_GITHUB_CLIENT_ID` に設定し、Desktop にも渡します。
- **クライアントシークレット**: **Generate a new client secret** で作ります。使うのは BFF だけで、GitHub が表示するのは作ったときの 1 回だけです。リポジトリ、チャット、ログに書かないでください。
- **Private key**: 使いません。この経路はインストールのトークンを使わないためです。作らないでください。

### keybroker に設定する

keybroker の Worker（例: `keybroker-dev`）に、変数 `GIT_GITHUB_CLIENT_ID`（Client ID）、`GIT_GITHUB_REDIRECT_URI`（Callback URL と同じ値）、`GIT_ALLOWED_ORIGINS`、`GIT_PROXY_ORIGIN` を設定します。秘密の値は、運用する人が自分のターミナルで入れます。

```bash
npx wrangler secret put GIT_GITHUB_CLIENT_SECRET --name keybroker-dev
```

```bash
openssl rand -hex 32 | npx wrangler secret put GIT_SESSION_KEY --name keybroker-dev
```

Git Worker の変数（`GIT_ALLOWED_ORIGINS`、`GIT_PROXY_ORIGIN`、`GIT_GITHUB_API`）の設定と配備の順番は、[git-smart-http.md](./git-smart-http.ja.md#enable-and-roll-back) に従います。

## うまくいかないとき

| 症状                                               | 原因                                                                         | 直し方                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 認可の直後に接続が失敗する                         | Expire user authorization tokens がオフで、更新用のトークンが返らない        | オンにする                                                     |
| GitHub の画面に `redirect_uri` のエラーが出る      | Callback URL と `GIT_GITHUB_REDIRECT_URI` が一致していない                   | 両方を同じ値にする                                             |
| リポジトリが見つからない、またはアクセスを断られる | そのリポジトリに App がインストールされていない                              | App をインストールし、そのリポジトリを選ぶ                     |
| PR は読めるのに、レビューを送れない                | Pull requests が Read-only、またはインストール先で権限の追加を承認していない | Pull requests を Read and write にし、インストール先で承認する |
| Desktop でログインが始まらない                     | Device Flow がオフ、または Desktop に Client ID が渡っていない               | Device Flow をオンにし、Desktop に Client ID を渡す            |
