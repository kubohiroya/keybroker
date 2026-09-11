# @kubohiroya/capability-proxy

外部APIの資格情報をクライアントへ渡さず、名前付きCapabilityだけをlocalhostから提供するRelayです。最初のProviderとしてCandy House SESAME Web APIを実装しています。

## セキュリティ境界

- サーバーは`127.0.0.1`だけでlistenします。
- 任意URL、任意HTTPヘッダー、任意のCandy House UUIDは受け付けません。
- Candy HouseのAPIキーとsecretはローカル設定ファイルだけに置きます。
- 設定ファイルはPOSIX環境でmode `0600`を必須とします。
- 起動時の8桁コードを一度だけセッショントークンに交換します。
- セッショントークンはハッシュ化してメモリだけに保持し、Relay再起動時に失効します。
- `lock`、`unlock`、`toggle`は既定で無効です。
- CORSはアクセス許可ではありません。実際の認可境界はBearer tokenです。

localhost上のサービスも、悪意あるWebページ、DNS rebinding、総当たりを考慮する必要があります。本実装はHost検証、Origin制限、ペアリング試行回数制限を行います。

## 必要環境

- Node.js 22.12以降
- pnpm 11

## セットアップ

```sh
pnpm install
cp config.example.json config.local.json
chmod 600 config.local.json
```

`config.local.json`にデバイス別名、APIキー、UUID、secret keyを設定します。ファイルはGit管理対象外です。

```json
{
  "server": {
    "port": 8787,
    "commandsEnabled": false,
    "allowedOrigins": ["null", "https://turbowarp.org"]
  },
  "providers": {
    "candyhouse": {
      "devices": {
        "front-door": {
          "apiKey": "...",
          "uuid": "...",
          "secretKey": "..."
        }
      }
    }
  }
}
```

## 起動とペアリング

```sh
pnpm dev -- --config config.local.json
```

標準出力へ表示された8桁のコードを、5分以内に一度だけ交換します。

```sh
curl -X POST http://127.0.0.1:8787/v1/pair \
  -H 'Content-Type: application/json' \
  -d '{"code":"12345678"}'
```

返された`token`はTurboWarp拡張のメモリに保持し、各Capability APIへ`Authorization: Bearer <token>`として送ります。

## API

```text
GET  /health
POST /v1/pair
GET  /v1/candyhouse/devices/:alias/status
GET  /v1/candyhouse/devices/:alias/history?page=1&length=20
POST /v1/candyhouse/devices/:alias/commands/lock
POST /v1/candyhouse/devices/:alias/commands/unlock
POST /v1/candyhouse/devices/:alias/commands/toggle
```

コマンド本文には任意で`{"history":"TurboWarp"}`を指定できます。コマンドAPIを使うには、設定で`commandsEnabled`を明示的に`true`へ変更してRelayを再起動します。

## 検証

```sh
pnpm check
```

## ロールバック

Relayプロセスを停止すれば、すべてのローカルセッションが直ちに失効します。TurboWarp-SesameはDirect modeへ戻せます。設定ファイルと資格情報は自動削除しません。

## ライセンスと由来

MPL-2.0。Candy HouseクライアントとAES-CMACの初期実装は、同じ著作者による`@kubohiroya/turbowarp-sesame`のMPL-2.0実装を基に分離しています。
