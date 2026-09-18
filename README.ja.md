# @kubohiroya/capability-proxy

外部APIの資格情報をクライアントへ渡さず、名前付きCapabilityだけをlocalhostから提供するRelayです。Providerとして、Candy House SESAME Web APIと、OpenAI Realtime APIのエフェメラルクライアントシークレット発行を実装しています。

## セキュリティ境界

- サーバーは`127.0.0.1`だけでlistenします。
- 任意URL、任意HTTPヘッダー、任意のCandy House UUIDは受け付けません。
- Candy HouseのAPIキーとsecretはローカル設定ファイルだけに置きます。
- OpenAIのAPIキーは環境変数(推奨)または設定ファイルだけに置き、ブラウザへは短命のエフェメラルキー(`ek_...`)だけを返します。
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

`config.local.json`に使うProviderだけを設定します。`providers.candyhouse`と`providers.openai`はどちらも省略可能ですが、少なくとも一方が必要です。ファイルはGit管理対象外です。

### Candy House

デバイス別名、APIキー、UUID、secret keyを設定します。

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

### OpenAI Realtime

OpenAIのAPIキーは環境変数で渡すことを推奨します。

```sh
export OPENAI_API_KEY='sk-...'
```

```json
{
  "server": {
    "port": 8787,
    "allowedOrigins": ["null", "https://turbowarp.org"]
  },
  "providers": {
    "openai": {
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-realtime-2.1-mini",
      "allowedModels": ["gpt-realtime-2.1-mini", "gpt-realtime-2.1"],
      "allowedVoices": ["alloy", "marin", "cedar"],
      "clientSecretTtlSeconds": 60
    }
  }
}
```

| キー                     | 必須 | 既定値               | 説明                                                                              |
| ------------------------ | ---- | -------------------- | --------------------------------------------------------------------------------- |
| `apiKeyEnv`              | ※    | -                    | APIキーを保持する環境変数名。推奨。起動時に未設定または空ならエラーで終了します。 |
| `apiKey`                 | ※    | -                    | APIキーを直接記述。設定ファイルのmode `0600`が前提です。                          |
| `model`                  |      | `"gpt-realtime-2.1"` | 既定モデル。リクエストで`session.model`を省略したときに使います。                 |
| `allowedModels`          |      | `[model]`            | クライアントが`session.model`で選べるモデルの一覧。`model`を含む必要があります。  |
| `allowedVoices`          |      | 制限なし             | 指定した場合、リクエストの`voice`はこの一覧に含まれている必要があります。         |
| `clientSecretTtlSeconds` |      | `60`                 | エフェメラルキーの有効期間(秒)。10〜600の整数。                                   |

※ `apiKeyEnv`と`apiKey`はどちらか一方だけを指定します。両方または両方なしは起動エラーです。未知のキーも起動エラーになります。APIキーの値はログやエラーメッセージに出力しません。

`allowedModels`は空でない配列で、各要素は`^[A-Za-z0-9._:-]{1,128}$`に一致し重複不可です。`model`が一覧に含まれていない場合は起動エラーです。省略時は`[model]`となり、クライアントは既定モデルしか使えません。どのモデルを許可するかで運用者が費用を制御できます。`gpt-realtime-2.1-mini`は`gpt-realtime-2.1`より安価なため、上の例ではminiを既定にし、通常版は明示的に要求された場合だけ使えるようにしています。

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
POST /v1/openai/realtime/client-secrets
```

コマンド本文には任意で`{"history":"TurboWarp"}`を指定できます。コマンドAPIを使うには、設定で`commandsEnabled`を明示的に`true`へ変更してRelayを再起動します。

エラーはすべて`{"error":{"code":"...","message":"..."}}`形式です。

### OpenAI Realtime クライアントシークレット

`POST /v1/openai/realtime/client-secrets`は、ペアリング済みクライアント(Capability `openai.realtime.client_secret`)に対して、OpenAI Realtime APIのエフェメラルクライアントシークレットを発行します。`Authorization: Bearer <token>`が必要です。このルートだけ本文上限は65536バイトです(他のルートは4096バイト)。

リクエスト本文(すべて任意。未知のキーは400 `invalid_input`):

```json
{
  "session": {
    "model": "gpt-realtime-2.1",
    "instructions": "16384文字以下",
    "voice": "marin",
    "outputModalities": ["audio"],
    "tools": [
      {
        "type": "function",
        "name": "move_sprite",
        "description": "1024文字以下",
        "parameters": { "type": "object", "properties": {} }
      }
    ]
  }
}
```

- `model`: `allowedModels`に含まれるモデル名。省略時は設定の`model`を使います。一覧にない場合は400 `invalid_input`(メッセージは`session.model is not allowed by the relay configuration.`で、許可一覧は返しません。`allowedVoices`と同じ扱いです)。
- `voice`: `^[a-z0-9_-]{1,32}$`。`allowedVoices`設定時はその一覧に含まれること。
- `outputModalities`: `["audio"]`または`["text"]`のみ。
- `tools`: 最大32件。`type`は`"function"`、`name`は`^[A-Za-z0-9_-]{1,64}$`で一意、`description`と`parameters`は任意。`parameters`は`type: "object"`を持つJSONオブジェクト。toolsを1件以上指定した場合だけ`tool_choice: "auto"`を付けて送信します。
- TTLは設定値で固定され、クライアントからは指定できません。

成功時(200、`Cache-Control: no-store`):

```json
{
  "data": {
    "value": "ek_...",
    "expiresAt": 1756310470000,
    "model": "gpt-realtime-2.1"
  }
}
```

`data.model`は実際に発行に使ったモデルです。`expiresAt`はUnixエポックのミリ秒です。ブラウザはこの`value`を使ってOpenAI Realtime APIへ直接接続します。

| ステータス | `code`               | 条件                                                                        |
| ---------- | -------------------- | --------------------------------------------------------------------------- |
| 400        | `invalid_json`       | 本文がJSONでない                                                            |
| 400        | `invalid_input`      | 本文の検証に失敗                                                            |
| 401        | `missing_token`      | Bearer tokenがない                                                          |
| 401        | `invalid_token`      | tokenが無効または期限切れ                                                   |
| 403        | `capability_denied`  | tokenにCapabilityがない                                                     |
| 403        | `origin_denied`      | Originが`allowedOrigins`にない                                              |
| 403        | `invalid_host`       | Hostヘッダーが不正                                                          |
| 404        | `provider_not_found` | `providers.openai`が設定されていない                                        |
| 413        | `request_too_large`  | 本文が65536バイトを超える                                                   |
| 502        | `upstream_error`     | OpenAIが2xx以外を返した、応答が不正、ネットワークエラー、タイムアウト(10秒) |

`upstream_error`のメッセージは汎用文言だけで、OpenAIの応答本文やAPIキーは返しません。

### OpenAI利用時のセキュリティ上の注意

- 長期APIキーはRelayプロセス内に留まり、ブラウザへは送られません。ブラウザが受け取るのは`clientSecretTtlSeconds`で期限の切れるエフェメラルキーだけです。TTLは用途に必要な最短に保ってください。
- エフェメラルキーは有効期間中、そのまま課金を伴うRealtimeセッションを開始できます。ログやプロジェクトファイルへ保存しないでください。
- TurboWarp拡張から呼び出す場合、`server.allowedOrigins`に拡張の実行Origin(サンドボックス拡張は`"null"`、非サンドボックスは`"https://turbowarp.org"`など)を含めてください。
- Origin検証とHost検証(DNS rebinding対策)はこのルートにも適用されます。CORSは認可ではなく、Bearer tokenが認可境界です。

## 検証

```sh
pnpm check
```

## ロールバック

Relayプロセスを停止すれば、すべてのローカルセッションが直ちに失効します。TurboWarp-SesameはDirect modeへ戻せます。設定ファイルと資格情報は自動削除しません。発行済みのOpenAIエフェメラルキーは、Relay停止後も`expiresAt`まで有効です。

## ライセンスと由来

MPL-2.0。Candy HouseクライアントとAES-CMACの初期実装は、同じ著作者による`@kubohiroya/turbowarp-sesame`のMPL-2.0実装を基に分離しています。
