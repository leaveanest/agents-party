# ワーク管理エージェント Google Calendar 連携プラン

Status: Proposed

## 位置づけ

この文書は、[../agents/task-management.md](../agents/task-management.md) の中核設計を前提に、
Google Calendar 連携だけを切り出して定義する個別プランである。

この文書は実装前の plan であり、実装後の挙動の source of truth ではない。
実装後はコードとテストを正とし、この文書には work 管理向けの前提と論点を残す。
ここで出す tool、repository、document 形状の具体案は、未実装段階で実装をぶらさないための proposal である。

Google Calendar 連携の共通プランは、[google-calendar-integration-plan.md](google-calendar-integration-plan.md) を先に参照する。
この文書は、その共通プランを work 管理に落とし込む時の個別プランとして読む。

ここで扱うのは、Slack 上の work item と Google Calendar 上の予定をどう接続するかであり、
`WorkEvent` の意味そのものを変えるものではない。

## 分離原則

この設計でいう `WorkEvent` は、work item に起きた意味のある変化であり、
Google Calendar の event そのものではない。
したがって、カレンダー予定は `WorkEvent` に埋め込まず、**外部予定への参照**として別に持つ。

初期スコープでは Google Calendar だけを対応対象にする。
ただし、work 管理の中核モデルを Google API の都合で汚さないため、
内部では「Google Calendar の予定」ではなく「外部カレンダー予定への link」として扱う。

## 追加する概念

### `CalendarEventLink`

`WorkItem` と外部カレンダー予定をつなぐ link。
1 つの会議から複数の work item が生まれうるため、link は item に対して 0 個以上を許容する。
一方で、初期 UI や tool では 1 件だけ張る運用から始めてもよい。

役割:

- 元になった会議や予定へ戻れるようにする
- `due_at` や `next_attention_at` を決める手掛かりを持つ
- 予定変更や中止を、work item 自体の意味変化とは分けて扱う

### `CalendarProviderKind`

- `google_calendar`

## `WorkItemCalendarLinkDocument`

- `link_id`
- `work_item_id`
- `provider_kind`
- `external_calendar_id`
- `external_event_id`
- `event_title_snapshot`
- `starts_at`
- `ends_at`
- `is_all_day`
- `response_status`
- `sync_status`
- `last_synced_at`
- `created_at`
- `updated_at`

補足:

- `external_calendar_id` と `external_event_id` が Google Calendar 上の識別子
- `event_title_snapshot` / `starts_at` / `ends_at` は query や表示用の cache であり、Google 側の source of truth を mirror する
- `sync_status` は少なくとも `active` / `canceled` / `not_found` を持てればよい
- Google Calendar の予定が消えても、work item 自体は自動削除しない
- 同じ Google Calendar event に複数の work item が link してよい

## 既存概念との関係

- `WorkEvent` は semantic event のまま保つ
- Google Calendar event の差分を、そのまま `WorkEvent` にしない
- カレンダー同期の結果、work item にとって意味がある変化だけを semantic event に変換する

例:

- 予定を紐づけた -> `calendar_event_linked`
- 予定との紐づけを外した -> `calendar_event_unlinked`
- 会議時刻が変わり、item 側の確認時刻も更新した -> `calendar_event_rescheduled`
- 予定が中止された -> `calendar_event_canceled`

逆に、Google から取得した軽微な差分や再同期そのものは `WorkEvent` にしない。

## `due_at` / `next_attention_at` との関係

- `due_at` は引き続き work item の締切
- `next_attention_at` は引き続き participant relation ごとの再確認時刻
- Google Calendar の `starts_at` / `ends_at` は、そのまま `due_at` や `next_attention_at` と同一視しない

既定方針:

- カレンダー予定を link しても、`due_at` は自動では上書きしない
- カレンダー予定を link しても、`next_attention_at` は自動では上書きしない
- agent は予定時刻を手掛かりとして提案してよいが、反映は明示操作で行う

これにより、
「会議は火曜 15:00 だが、宿題の締切は水曜」
「会議の 30 分前に自分だけ再確認したい」
を自然に表現できる。

## PostgreSQL 配置追加案

```text
work_item_calendar_links (team_id, work_item_id, link_id)
```

この row は外部予定との link と local cache を持つ。
`WorkItemDocument` に Google Calendar 固有フィールドを増やしすぎずに済む。

## Repository / Gateway の責務

repository は Google API を直接叩かず、calendar gateway を介して同期済みデータを受け取る。

責務分担:

- repository: link の保存、semantic event 生成、transaction 管理
- Google Calendar gateway: Google API 呼び出し、event 取得、ID 解決
- agent/tool: どの予定を link するか、予定時刻を `due_at` や `next_attention_at` に反映するかの判断

追加候補 interface:

- `GoogleCalendarGateway.get_event(calendar_id: str, event_id: str) -> GoogleCalendarEvent`
- `GoogleCalendarGateway.find_events(...) -> list[GoogleCalendarEvent]`
- `WorkItemRepository.link_calendar_event(...) -> WorkItemAggregate`
- `WorkItemRepository.unlink_calendar_event(...) -> WorkItemAggregate`

## Tool 追加案

### `link_google_calendar_event`

入力:

- `work_item_id`
- `google_calendar_id`
- `google_event_id`
- `apply_start_to_due_at`
- `apply_start_to_next_attention_at_for_me`

補足:

- `apply_start_to_due_at` は false を既定にする
- `apply_start_to_next_attention_at_for_me` も false を既定にする
- 時刻反映と link 作成と event append は、1 回の mutation でまとめる

### `unlink_google_calendar_event`

入力:

- `work_item_id`
- `link_id`

## 振る舞いルール追加

- Google Calendar event は `WorkEvent` と混同しない
- Google Calendar の変更だけで `status` を自動変更しない
- 予定の削除や中止で work item を自動削除しない
- sync に失敗しても link は即削除せず、`sync_status` で表す
- 表示は local cache を優先し、毎回 Google API を叩いて一覧を作らない

## モジュール追加案

```text
src/
  agents/
    skills/
      workManagerTools.ts
  repositories/
    workItemRepository.ts
    googleCalendarGateway.ts
  infrastructure/
    postgres/
      workItemRepository.ts
    google_calendar/
      googleCalendarGateway.ts
```
