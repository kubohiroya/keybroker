# TurboWarp Plus Editor からの GitHub への公開

[English](./github-publication.md)

Cloudflare の BFF は、明示的に承認された公開ジョブを実行できます。対象は、通常の Git の書き込みセッションで確かめたリポジトリです。ジョブは、変わらない GitHub アカウント ID、リポジトリ ID、Editor のオリジンごとに記録（journal）します。ジョブを進められるのは、Editor の Git パッケージにある公開エンジンの、決まった GitHub の呼び出しだけです。Git Worker は、これまでどおり Git Smart HTTP と読み取り専用の PR の経路を提供します。

## 承認と実行

Editor は、10 分間有効な一回限りの承認 URL を求めます。最初のページには、一般的な GitHub のサインインの案内を表示します。GitHub App の認可を新たに行い、同じ数値のアカウントとリポジトリであることを確かめます。ブラウザーだけが持つ cookie で、コールバックを開始したブラウザーに結び付けます。そのあと BFF は、正確なリポジトリ、head と base のコミット、PR の文面、任意のスタックの親、issue の操作、マージの設定を表示します。別の **Approve** の操作で、記録したジョブを 8 時間認めます。中断や期限切れのあとは、同じジョブと変わらない意図（intent）について、Editor が新しい承認 URL を求められます。

ジョブはリモートの ref を確かめ、Editor が記録したコミットをジョブ専用のブランチに push するのを待ちます。GitHub API の各段階では、セッション、リポジトリ、承認された公開を確かめます。記録には、送る前に実行中の変更を書き込みます。応答が不確かだったときは、エンジンが GitHub で先の結果を確かめます。自動マージは、確かめた CI とレビューの条件がそろうのを待ちます。マージには GitHub の非同期マージ API を使い、期待する head の SHA を指定し、ブランチの保護を有効にしたまま行います。送る直前に、base と差分をもう一度確かめます。GitHub はバックグラウンドのマージに期待する base の SHA を指定する前提条件を持たないため、送ったあとの base の変更は GitHub のリポジトリのルールに従います。[GitHub の非同期マージ API](https://docs.github.com/ja/rest/pulls/pulls#merge-a-pull-request-asynchronously)

## 試験用の配備

keybroker の Worker（`src/cloudflare/worker.ts`）は、`GitHubPublication` を Editor の Git パッケージの `./pull-request-queue` と `./github-publication-host` の入口につなぎます。パッケージは、公開されている版に keybroker が固定します。`wrangler.toml.template` は、`GitHubPublication` を SQLite の Durable Object として登録し、`GIT_SESSIONS` と並べて `GIT_PUBLICATION_JOBS` に結び付けます。通常の Git の App のコールバックと `GIT_ALLOWED_ORIGINS` はそのまま残します。

PR の作成を有効にするには `GIT_PUBLICATION=pulls-read,pulls-write` を設定します。CI を条件にしたマージを許すには `checks-read,merge` を、issue の作成と close を許すには `issues-read,issues-write` を加えます。試験用のリポジトリで GitHub がネイティブの PR スタックに対応している場合は `stacks` も加えます。GitHub App のインストールには、Git の push とマージに **Contents: Write**、PR とスタックの作成に **Pull requests: Write**、CI に **Checks: Read** と **Commit statuses: Read**、issue の操作に応じて **Issues: Read** または **Issues: Write** が必要です。サインインした利用者にも、対応するリポジトリの権限が必要です。[GitHub App の権限](https://docs.github.com/ja/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)

確かめるときは、必須のチェックを設定した使い捨てのリポジトリを使います。試験用の作品を保存してコミットし、PR のダイアログを開きます。別の GitHub アカウントでは承認のプレビューを開けないことを確かめます。同じアカウントで戻り、表示されたリポジトリとコミットを確かめてから承認します。GitHub 上で、ジョブ専用のブランチと PR を確かめます。ジョブがチェックを待ち、マージを確かめてから、明示的に選んだ issue を close することを確認します。ネイティブのスタックでは、スタックの一番上にある開いた PR を選び、GitHub が子の関係を記録することを確かめます。公開の経路を無効にするには `GIT_PUBLICATION` を空にします。ジョブの記録は、突き合わせのために残します。

共有のエンジンを使って手元で試すときは、`TW_PUBLICATION_ENGINE_PREVIEW_DIST` にレビュー済みのパッケージのビルド済み `dist` を指定し、`vitest run tests/github/gitHubPublication.test.ts` を実行します。fixture が GitHub の応答を模擬します。
