# Google Calendar 連携共通プラン

Status: Proposed

## 位置づけ

この文書は、`agents-party` 内の複数 agent から再利用できる
Google Calendar 連携の共通プランを定義する。

この文書は実装前の plan であり、実装後の挙動の source of truth ではない。
実装後はコードとテストを正とし、この文書には判断軸とスコープを残す。
ここで出す interface、schema、storage の具体案は、未実装段階で実装方針を固定するための proposal である。

個別 agent ごとの要件やドメインモデルは、この文書の上に積む。
たとえば work 管理での使い方は
[work-management-google-calendar-plan.md](work-management-google-calendar-plan.md) のような個別プランで扱う。

## 目的

Google Calendar 連携で共通化したいのは次の責務である。

- Google アカウント接続
- OAuth token 管理
- Google Calendar API へのアクセス境界
- event / calendar の共通取得モデル
- セキュリティ方針

逆に、Google Calendar の予定を各 agent がどう解釈するかは、
この文書では固定しない。

## 想定ユースケース

この共通連携は、少なくとも次の用途に使い回せるようにする。

- 自分の直近予定を読む
- 特定 event を取得する
- 予定 URL や event ID から予定を参照する
- 予定を agent 固有の domain object に紐づける
- 会議準備、会議後フォロー、日次確認などの agent で使う

## 初期前提

- 対応プロバイダは Google Calendar のみ
- 最初は read-only 中心で始める
- 双方向同期や常時同期は前提にしない
- Google SDK / API は infrastructure 層に閉じ込める
- 各 agent の中核 domain model は Google Calendar に直接依存させない

## 分離原則

Google Calendar event は外部予定であり、
各 agent が持つ domain event や domain object とは別物として扱う。

つまり:

- Google Calendar event は source data
- agent 側の object は product の管理対象
- 両者は必要に応じて参照または link でつなぐ

この分離を守る理由は次の通り。

- 1 つの予定から複数の domain object が生まれうる
- 1 つの domain object が複数予定に関係しうる
- 予定が消えても domain object は残ることがある
- agent ごとに event の意味づけが違う

## 認証モデル

### 推奨方針

基本方針は **個人ごとの OAuth** とする。

理由:

- 多くの agent は個人の primary calendar を読みたくなる
- 個人予定は本人同意ベースが最も自然
- Slack user-centric な体験と相性がよい
- 小さく始めやすい

したがって、個人の予定を扱うなら
OAuth 接続は原則としてユーザー単位になる。

### 代替案

将来的には次もありうる。

- 共有カレンダー連携
- 管理者許可ベースの組織連携

ただし、これは初期共通設計の中心には置かない。
まずは個人 OAuth を成立させ、その上で必要な共通カレンダーだけを追加する。

## 接続単位

接続の基本単位は次の組み合わせにする。

- `team_id`
- `slack_user_id`
- `google_account_subject`

意図:

- Slack workspace ごとに接続状態を分けられる
- 同じ人が複数 workspace で同じ app を使っても扱える
- Google 側の stable subject でアカウントを識別できる

## 共通データモデル

### `GoogleCalendarConnection`

- `team_id`
- `slack_user_id`
- `google_account_subject`
- `google_account_email`
- `granted_scopes`
- `connection_status`
- `access_token`
- `refresh_token`
- `token_expires_at`
- `last_refreshed_at`
- `last_refresh_error_at`
- `last_refresh_error_code`
- `created_at`
- `updated_at`
- `last_successful_access_at`

補足:

- token は平文保存しない
- 少なくとも `refresh_token` は暗号化保存を前提にする
- `token_expires_at` は Google token endpoint の `expires_in` をもとに計算する advisory な値とする
- `connection_status` は `active` / `revoked` / `expired` / `error` を持てればよい

### `GoogleCalendarEventRef`

agent 固有モデルに埋め込んだり、link document に持たせたりするための共通参照。

- `calendar_id`
- `event_id`
- `html_link`
- `summary_snapshot`
- `starts_at`
- `ends_at`
- `is_all_day`
- `status`
- `organizer_email`
- `updated_at`

補足:

- これは Google 側の source of truth を mirror する軽量 snapshot である
- 参加者一覧など大きい情報は、共通モデルの必須項目にしない
- 詳細データが必要な agent は追加取得する

## 共通 Gateway

Google API を直接呼ぶのは gateway の実装だけにする。
agent や repository は SDK に触らない。

最小 interface 候補:

- `get_connection(team_id: str, slack_user_id: str) -> GoogleCalendarConnection | None`
- `list_calendars(connection: GoogleCalendarConnection) -> list[GoogleCalendarCalendar]`
- `get_event(connection: GoogleCalendarConnection, calendar_id: str, event_id: str) -> GoogleCalendarEvent`
- `search_events(connection: GoogleCalendarConnection, query: GoogleCalendarEventQuery) -> list[GoogleCalendarEvent]`
- `list_upcoming_events(connection: GoogleCalendarConnection, limit: int) -> list[GoogleCalendarEvent]`

write 系は初期共通 interface に含めない。
必要性が確定した段階で追加する。

## Repository / Infrastructure 境界

責務分担:

- repository: 接続状態の保存、取得
- gateway: Google OAuth / Calendar API 呼び出し
- agent: どの予定をどう解釈するかの判断

モジュール配置案:

```text
src/
  repositories/
    googleCalendarConnectionRepository.ts
    googleCalendarGateway.ts
  infrastructure/
    postgres/
      googleCalendarConnectionRepository.ts
    google_calendar/
      googleCalendarGateway.ts
```

## 保存配置案

接続情報の PostgreSQL 配置は、まず次を基準にする。

```text
google_calendar_connections (team_id, slack_user_id)
```

理由:

- workspace 境界が明確
- user 単位 OAuth と自然に対応する
- 各 agent から共通 lookup しやすい

event の snapshot や link document は、
この共通配置には含めず、各 agent 側の設計で決める。

## OAuth UX 方針

最初の接続 UX は App Home 中心にする。

- `Google Calendar を接続` ボタンを置く
- 接続済みなら接続先アカウントと状態を表示する
- 未接続ユーザーが calendar 機能を呼んだら接続導線を返す
- 切断も App Home からできるようにする

channel 上の操作だけで完結させようとすると認証フローが見えづらいので、
最初は App Home ベースが安全である。

## スコープ方針

初期 scope は read-only を基本にする。

推奨:

- calendar 読み取り
- event 読み取り

後回し:

- event 作成
- event 更新
- event 削除

理由:

- write は誤更新の責任が重い
- 要求 scope が強くなりやすい
- 初期の価値は read だけでも十分出せる

## トークンリフレッシュ方針

Google Calendar 連携でも、**常時バックグラウンド更新は行わず、必要時 refresh を標準**とする。

理由:

- Google の access token は通常短命で、`expires_in` から有効期限を見積もれる
- 一方で refresh token 自体はユーザー操作やポリシー変更で失効しうる
- 初期段階では agent 実行時にだけ refresh すれば十分で、運用負荷も小さい

### refresh token 取得条件

Google OAuth では、refresh token を安定して扱うために認可リクエスト側の条件を明記しておく。

- `access_type=offline` を付ける
- `include_granted_scopes=true` を基本にする
- 初回接続または refresh token 再発行が必要な再接続では `prompt=consent` を使う

補足:

- Google は refresh token を毎回返すとは限らない
- 既存接続がある状態の再認可では、新しい refresh token が返らないことがある
- refresh token が返らなかった場合は、既存の保存済み refresh token を保持する

### 基本戦略

- `token_expires_at` が既知なら、期限の 5 分前から refresh 対象とする
- `token_expires_at` が不明なら、API 呼び出し時の認証失敗を契機に refresh する
- 1 回の outbound API 呼び出しにつき refresh 試行は最大 1 回にとどめる
- Google client library が自動 refresh できる場合でも、接続状態の更新責務は gateway 側で明示的に持つ

### refresh の発火条件

次のいずれかで refresh を試みる。

- 保存済み access token が存在しない
- `token_expires_at` があり、現在時刻が期限近傍に入っている
- Google Calendar API 呼び出しで認証切れ相当のエラーを受けた

認証切れ相当の判定は、少なくとも次を対象にする。

- HTTP `401`
- OAuth token error の `invalid_token`
- access token 失効とみなせる認証エラー

### refresh 実行時の更新内容

refresh に成功したら、少なくとも次を同時に更新する。

- `access_token`
- `token_expires_at`
- `last_refreshed_at`
- `connection_status`

補足:

- refresh response が新しい `refresh_token` を返した場合だけ保存済み `refresh_token` を更新する
- refresh response に `refresh_token` が含まれない場合は、既存の `refresh_token` を維持する
- `last_refresh_error_at` と `last_refresh_error_code` は成功時にクリアする

### refresh 失敗時の扱い

失敗時は、再試行可能かどうかで分けて扱う。

- 一時的なネットワーク障害、`5xx`、timeout:
  `connection_status` は `active` のまま維持し、呼び出し元へ retriable error を返す
- `invalid_grant`、ユーザーによる同意取り消し、失効済み refresh token:
  `connection_status` を `expired` へ更新し、ユーザーに再接続を要求する
- 復号失敗、設定不整合、想定外レスポンス:
  `connection_status` を `error` へ更新し、管理者確認が必要な障害として扱う

### Google 固有の注意点

- Google Cloud の OAuth consent screen が `Testing` 状態で、基本 profile 系以外の scope を使う場合、refresh token が 7 日で失効しうる
- したがって本番運用前に consent screen の公開状態を確認する
- Google Calendar read-only 連携でも、失効時は静かに壊さず再接続導線へ戻す

### 非採用方針

初期段階では次は採用しない。

- 定期ジョブでの token warm-up
- API 呼び出しごとの無条件 refresh
- refresh の無限リトライ

## セキュリティ方針

- 最小権限で始める
- token revoke / expiry を前提にする
- 接続状態と取得 scope をユーザーに見せる
- 接続エラーは `connection_status` に反映する
- agent が未接続状態でも壊れない UX を用意する

## 非目標

この共通設計では次を最初から目指さない。

- Google Calendar 全体の完全同期
- バックグラウンド常時同期
- すべての agent で同じ event cache を共有すること
- Google Calendar を product の source of truth にすること

## 個別 agent で決めること

この共通設計の上で、各 agent は次を個別に決める。

- Google Calendar event をどの domain object に紐づけるか
- event 時刻を agent 側の期限や reminder にどう反映するか
- event 更新を domain event に変換するか
- event snapshot をどこまで保存するか

## 判断の結論

今の段階では、Google Calendar 連携は
「複数 agent から使える共通 capability」として plan を持っておくのがよい。

初期方針は次の通り。

- provider は Google Calendar のみ
- 認証は個人ごとの OAuth を基本にする
- 共通層は read-only 中心で始める
- Google API は infrastructure に閉じ込める
- 各 agent の domain とは link / ref で接続する
