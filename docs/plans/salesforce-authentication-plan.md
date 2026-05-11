# Salesforce 認証共通プラン

Status: Proposed

## 位置づけ

この文書は、`agents-party` に Salesforce 認証を導入する前提を整理するための
実装前 plan である。

ここで定義するのは、主に次の判断軸である。

- どの OAuth フローを標準にするか
- Slack ユーザーと Salesforce ユーザーをどう対応づけるか
- token と接続状態をどこに保存するか
- Node HTTP server / Slack / repository / infrastructure の責務をどう分けるか

実装後の source of truth はコードとテストであり、
この文書は初期スコープと設計判断を固定するための proposal として扱う。

## 目的

Salesforce 連携で先に共通化したいのは、認証と接続状態の扱いである。

- Salesforce アカウント接続
- OAuth state / PKCE / callback の安全な取り扱い
- access token / refresh token の管理
- Slack user と Salesforce user の紐づけ
- 後続の Salesforce API 呼び出しで再利用できる接続境界

逆に、この文書では Salesforce object の取得・更新モデルまでは固定しない。

## 想定ユースケース

初期の認証共通層は、少なくとも次の用途で再利用できるようにする。

- Slack 上でユーザー自身の Salesforce 接続を作る
- agent が接続済みユーザーの権限で Salesforce API を呼ぶ
- 未接続時に安全に接続導線へ戻す
- 接続解除時に token を revoke する
- 将来の Salesforce read/write 機能で共通接続情報を再利用する

## 初期前提

- 現在のアプリは Node HTTP server を入口にし、Slack イベントを `/slack/events` で受けている
- 将来の OAuth callback も同じ Node HTTP server アプリに追加する
- Slack SDK 依存は `src/slack/` に閉じ込める
- Salesforce API 呼び出しは infrastructure 層に閉じ込める
- PostgreSQL は接続情報の保存先として継続利用する
- まだ Salesforce 連携は未実装であり、既存の互換制約はない

## 認証方式の結論

### 推奨方針

初期標準は **ユーザー単位の Authorization Code Flow + PKCE** とする。

理由:

- `agents-party` は Slack 上の個人操作から起動されるため、user-centric な認可と相性がよい
- 将来の Salesforce API 呼び出しを「誰の権限で実行するか」で追跡しやすい
- PKCE を使うことで認可コード横取りへの耐性を上げられる
- refresh token を使えば再接続を毎回要求せずに済む

### アプリ種別の方針

2026-03-22 時点の Salesforce Developer ドキュメントでは、
Spring '26 以降は新規 Connected App の作成が制限され、
**External Client App を推奨**している。

したがって、新規導入では External Client App を標準とし、
既存顧客がすでに Connected App を持っている場合だけ互換対象として扱う。

### なぜ Client Credentials を標準にしないか

Client Credentials Flow は server-to-server 連携には適しているが、
Slack 上の個人操作と Salesforce 側の実行主体がずれやすい。

初期段階では次の理由で標準にしない。

- 誰の権限でデータを読んだかが曖昧になりやすい
- 1 人の integration user に権限が集中しやすい
- Slack の user-centric UX と整合しにくい

ただし、後続でバッチ同期や org 共通処理が必要になれば
workspace 単位の Client Credentials を別 capability として追加できる余地は残す。

### 初期 scope 方針

初期候補 scope は次の最小集合とする。

- `api`
- `refresh_token`
- `id`

補足:

- `refresh_token` は offline access を前提に接続を維持するために必要
- `id` は identity URL から org / user 情報を取得するために使う
- `full` は避ける。Salesforce の scope 定義では `full` は refresh token を返さない

## 接続モデル

Salesforce 認証は、workspace 設定と user 接続を分けて扱う。

### `SalesforceWorkspaceAuthConfig`

workspace 単位で共有する OAuth 設定。

- `team_id`
- `salesforce_org_id`
- `salesforce_org_name`
- `salesforce_my_domain_host`
- `oauth_client_id`
- `oauth_client_secret_encrypted`
- `app_type`
- `default_scopes`
- `redirect_uri`
- `status`
- `created_at`
- `updated_at`

補足:

- `oauth_client_secret_encrypted` は PKCE 前提でも optional で残しておく
- confidential flow に切り替える場合や既存 Connected App 互換で使う余地を持たせる
- `salesforce_my_domain_host` は token / revoke / authorize の基準 host とする

### `SalesforceConnection`

Slack user ごとの接続状態。

- `team_id`
- `slack_user_id`
- `salesforce_org_id`
- `salesforce_user_id`
- `salesforce_username`
- `salesforce_user_email`
- `salesforce_identity_url`
- `salesforce_instance_url`
- `granted_scopes`
- `connection_status`
- `access_token_encrypted`
- `refresh_token_encrypted`
- `token_expires_at`
- `last_refreshed_at`
- `last_refresh_error_at`
- `last_refresh_error_code`
- `last_successful_access_at`
- `created_at`
- `updated_at`

補足:

- `salesforce_org_id` と `salesforce_user_id` は identity URL か ID token 由来の stable identifier を使う
- access token は短命なので保存しない設計もありうるが、初期は encrypted 保存を許容する
- `token_expires_at` は advisory な値として扱う。Salesforce 側の session timeout により access token が失効しうるため、常に厳密とは限らない
- 長期的には refresh token 中心に寄せ、access token は必要時に更新してもよい
- `connection_status` は少なくとも `active` / `revoked` / `expired` / `error` を持つ

### `SalesforceOAuthState`

callback 検証用の短命 state。

- `state_id`
- `team_id`
- `slack_user_id`
- `workspace_auth_config_key`
- `pkce_code_verifier_encrypted`
- `redirect_after_connect`
- `expires_at`
- `created_at`

補足:

- TTL は短く保ち、使い捨てにする
- PostgreSQL 保存でもよいが、署名付き state に最小情報だけ載せる案も比較対象に残す
- 初期は実装単純性を優先して server-side 保存を推奨する

## 接続単位

接続を一意にする最小単位は次の組み合わせとする。

- `team_id`
- `slack_user_id`
- `salesforce_org_id`

意図:

- Slack workspace が異なれば接続状態を分離できる
- 同じ Slack user が複数 org を使う余地を残せる
- org 単位の切り替えや無効化に追従しやすい

将来「1 workspace = 1 Salesforce org」に固定したくなっても、
このキーなら上位互換で扱える。

## OAuth シーケンス方針

初期の HTTP 導線は次を想定する。

- `GET /oauth/salesforce/start`
- `GET /oauth/salesforce/callback`
- `POST /oauth/salesforce/disconnect`

想定シーケンス:

1. Slack App Home かメッセージ上の導線から接続開始 URL を開く
2. アプリは `state` と PKCE verifier を発行して保存する
3. Salesforce の authorize endpoint へ redirect する
4. callback で `state` と code を検証する
5. token endpoint で access token / refresh token を取得する
6. identity 情報を取得して `SalesforceConnection` を upsert する
7. 完了画面を返し、Slack 側には接続完了メッセージを出せるようにする

切断時は revoke endpoint を呼び、
成功・失敗に関わらずローカルの接続状態を `revoked` または `error` に更新する。

## トークンリフレッシュ方針

初期方針では、**常時バックグラウンド更新は行わず、必要時 refresh を標準**とする。

理由:

- Salesforce の access token 有効期間は Connected App や session policy に依存する
- access token の厳密な失効時刻を常に事前計算できる前提にしないほうが安全
- agent 実行時にだけ token を更新すれば、実装と運用を小さく保てる

### 基本戦略

- access token が使える間はそのまま再利用する
- `token_expires_at` が既知なら、期限の 5 分前から refresh 対象とする
- `token_expires_at` が不明なら、期限予測ではなく API 呼び出し時の認証失敗を契機に refresh する
- 1 回の outbound API 呼び出しにつき refresh 試行は最大 1 回にとどめる

### refresh の発火条件

次のいずれかで refresh を試みる。

- 保存済み access token が存在しない
- `token_expires_at` があり、現在時刻が期限近傍に入っている
- Salesforce API 呼び出しで認証切れ相当のエラーを受けた

認証切れ相当の判定は、少なくとも次を対象にする。

- HTTP `401`
- Salesforce の `INVALID_SESSION_ID`
- token endpoint で access token 再取得が必要と判断できる認証エラー

### refresh 実行時の更新内容

refresh に成功したら、少なくとも次を同時に更新する。

- `access_token_encrypted`
- `last_refreshed_at`
- `token_expires_at`
- `salesforce_instance_url`
- `connection_status`

補足:

- `token_expires_at` は response に十分な情報がある場合だけ更新し、厳密に求められない場合は `null` のままでよい
- refresh response が新しい `refresh_token` を返した場合は、保存済み `refresh_token_encrypted` を原子的に置き換える
- `last_refresh_error_at` と `last_refresh_error_code` は成功時にクリアする

### refresh 失敗時の扱い

失敗時は error を一括りにせず、再試行可能かどうかで分ける。

- 一時的なネットワーク障害、`5xx`、timeout:
  `connection_status` は `active` のまま維持し、呼び出し元へ retriable error を返す
- `invalid_grant`、revoke 済み token、期限切れ refresh token:
  `connection_status` を `expired` へ更新し、ユーザーに再接続を要求する
- 復号失敗、設定不整合、想定外レスポンス:
  `connection_status` を `error` へ更新し、管理者確認が必要な障害として扱う

### 並行 refresh の制御

同じ接続に対する同時 refresh は抑止する。

- 同一 `team_id` / `slack_user_id` / `salesforce_org_id` の refresh は直列化する
- 実装時は PostgreSQL transaction または version field による楽観ロックを使う
- 先行 refresh が成功した場合、後続処理は新しい token を読み直して再利用する

### 非採用方針

初期段階では次は採用しない。

- 定期ジョブでの token warm-up
- API 呼び出しごとの無条件 refresh
- refresh の無限リトライ

## Slack UX 方針

初期 UX は App Home 中心にする。

- App Home に `Salesforce を接続` ボタンを置く
- 接続済みなら org 名、ユーザー名、最終接続時刻、scope を表示する
- 未接続ユーザーが Salesforce 機能を呼んだら、接続導線のみ返す
- 切断も App Home から行えるようにする

理由:

- OAuth はブラウザ遷移を伴うため、channel 内だけで完結させるより見通しがよい
- 将来 Google Calendar など他の外部接続も同じ UI パターンに寄せやすい

## Repository / Infrastructure 境界

責務分担は次の通り。

- repository: 接続情報と workspace 設定の保存・取得
- oauth client / gateway: authorize URL 生成、token exchange、identity 取得、revoke
- slack feature: 接続状態に応じた UI と導線
- agent: 接続済みかの判定と、必要に応じた gateway 呼び出し

モジュール配置案:

```text
src/
  repositories/
    salesforceConnectionRepository.ts
    salesforceWorkspaceAuthConfigRepository.ts
    salesforceOAuthStateRepository.ts
    salesforceGateway.ts
  infrastructure/
    postgres/
      salesforceConnectionRepository.ts
      salesforceWorkspaceAuthConfigRepository.ts
      salesforceOAuthStateRepository.ts
    salesforce/
      oauthClient.ts
      salesforceGateway.ts
  slack/
    events/
    features/
      salesforceConnection.ts
```

## 保存配置案

PostgreSQL 上の初期配置は次を基準にする。

```text
salesforce_auth_configs (team_id, salesforce_org_id)
salesforce_connections (team_id, slack_user_id, salesforce_org_id)
salesforce_oauth_states (state_id)
```

理由:

- workspace 境界が明確
- Slack user lookup が単純
- org 切り替えや複数 org 対応を追加しやすい

## Node HTTP server 追加ポイント

既存アプリは `/healthz` と `/slack/events` を持つだけなので、
OAuth 用のルート追加は比較的素直に行える。

初期案:

- `create_app()` 内で Salesforce OAuth 用 router を登録する
- Slack Bolt gateway とは分離し、HTTP callback は Node HTTP server の素の handler で受ける
- callback では Slack SDK に依存しない

この分離により、OAuth callback の検証と Slack UI 更新を別責務にできる。

## 設定値の計画

将来追加する設定値の候補:

- `SALESFORCE_REDIRECT_BASE_URL`
- `SALESFORCE_STATE_SIGNING_SECRET`
- `SALESFORCE_TOKEN_ENCRYPTION_KEY`

補足:

- `client_id` と `client_secret` は workspace ごとに変わりうるため、環境変数ではなく PostgreSQL 管理を基本にする
- ただし、単一 org 固定の社内利用で始めるなら env-only 運用でもよい
- 初期 plan では multi-workspace / multi-org へ拡張できる設計を優先する

## セキュリティ方針

- token は平文保存しない
- 少なくとも refresh token は暗号化保存を前提にする
- OAuth state は短命・使い捨てにする
- PKCE verifier は callback 完了後ただちに破棄する
- revoke 可能な token は切断時に積極的に revoke する
- agent は未接続状態でも壊れず、接続要求を返すだけにする
- `full` scope は使わず、最小権限から始める
- org 固有の My Domain host を優先し、endpoint host を固定しすぎない

## 非目標

この共通 plan では次を最初から目指さない。

- Salesforce object モデルの共通抽象化
- Account / Opportunity / Case など個別 object の domain 設計
- 双方向同期
- 組織全体のバックグラウンド同期
- Client Credentials Flow の同時実装

## open questions

実装前に決めるべき残件は次の通り。

- 1 workspace に複数 Salesforce org を許可するか
- workspace 管理者だけが `SalesforceWorkspaceAuthConfig` を更新できるようにするか
- token 暗号化を GCP KMS で行うか、アプリ鍵で行うか
- callback 完了後に Slack 側へどこまで明示的な通知を返すか
- Salesforce 接続済みユーザーの権限不足を UX 上どう表現するか

## 判断の結論

今の段階では、Salesforce 連携は
「複数 agent から使える共通認証 capability」として先に plan を持つのがよい。

初期結論は次の通り。

- 新規標準は External Client App
- 認証方式はユーザー単位の Authorization Code Flow + PKCE
- Slack App Home を接続導線の中心にする
- 接続情報は workspace 設定と user 接続に分けて保存する
- OAuth / token / revoke は infrastructure に閉じ込める

## 参考

- [Connected Apps](https://developer.salesforce.com/docs/platform/mobile-sdk/guide/connected-apps.html)
- [Create an External Client App](https://developer.salesforce.com/docs/platform/mobile-sdk/guide/eca-create.html)
- [OAuth 2.0 Web Server Flow](https://developer.salesforce.com/docs/platform/mobile-sdk/guide/oauth-web-server-flow.html)
- [Scope Parameter Values](https://developer.salesforce.com/docs/atlas.en-us.mobile_sdk.meta/mobile_sdk/oauth_scope_parameter_values.htm)
- [Using Identity URLs](https://developer.salesforce.com/docs/atlas.en-us.mobile_sdk.meta/mobile_sdk/oauth_using_identity_urls.htm)
- [Revoking OAuth Tokens](https://developer.salesforce.com/docs/atlas.en-us.mobile_sdk.meta/mobile_sdk/oauth_revoking_tokens.htm)
- [Salesforce Developers Blog: 外部アプリから Salesforce API にアクセスする方法](https://developer.salesforce.com/jpblogs/2026/02/jp-access-the-salesforce-api-from-externalclientapp)
