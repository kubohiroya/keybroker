# Cloudflare 上の GitHub provider

[English](./README.md)

この文書群は、keybroker が TurboWarp Plus Editor のために Cloudflare で提供する GitHub の経路を説明します。[ADR 0001](../adr/0001-cloudflare-host-and-github-provider.ja.md) の 3 段階目として、hierarchidb（49feb0e34 の `packages/backend/bff/docs/`）からここへ移しました。

hierarchidb では、これらの経路を二つの Worker で動かしていました。ログイン、作成、公開の経路を受け持つ BFF と、Git Smart HTTP と GitHub API を中継する Git Worker です。keybroker は、すべての Durable Object を同じスクリプトに置いた一つの Worker（`src/cloudflare/worker.ts`）で動かします。この文書群で「BFF」はその Worker のログイン側を、「Git Worker」はその中継側を指します。

| 文書                                                                   | 内容                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [git-smart-http.ja.md](./git-smart-http.ja.md)                         | ログイン、セッション、Git Smart HTTP の中継、GitHub API の経路、有効化と切り戻し |
| [github-app-setup.ja.md](./github-app-setup.ja.md)                     | GitHub App の作成と設定                                                          |
| [github-repository-creation.ja.md](./github-repository-creation.ja.md) | サインインしたアカウントへのリポジトリの作成                                     |
| [github-publication.ja.md](./github-publication.ja.md)                 | 承認された公開ジョブ（PR、CI を条件にしたマージ、issue）                         |

通信の契約（経路、要求と応答の形、エラーのコード、Bearer の形式と期限）は hierarchidb から変えていません。Editor は、ビルド時の接続先のオリジンを替えるだけで使えます。
