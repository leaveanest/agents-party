# ワーク管理エージェント設計書

## 目的

`agents-party` 上で、Slack から自然言語で work を登録、更新、確認できる agent を定義する。
ユーザー向けの会話では `task` という言葉を使ってよいが、内部ドメインは `work item` を中心に設計する。

理由:

- `task` という語だけでは、未整理の仕事、引き継ぎ途中の仕事、確認待ちの仕事を同じ粒度で扱いにくい
- Slack 上では、会話から生まれた仕事をその場で残し、あとで再浮上させることが重要になる
- 仕事そのものと、人がそれをどう気にしているかを分けて設計した方が壊れにくい

## この設計の立場

この設計では、work 管理の中核を `task` ではなく次の 5 つに分ける。

- `WorkItem`: 何を扱うか
- `ParticipantRelation`: 誰がどう関与するか
- `WorkEvent`: 何が起きたか
- `AttentionIndex`: 誰が今気にすべきかを引ける read model
- `VisibilityPolicy`: 誰に見えるか

ここで重要なのは、**attention は work item そのものではなく、人と work item の関係の性質**だという点である。

- `due_at` は item の属性
- `next_attention_at` は relation の属性
- `needs_attention_now` は保存値ではなく導出値だが、一覧検索のために per-user attention index にも反映する

## Slack で扱う価値

この agent は、専用の task 管理ツールより高機能であることではなく、
**Slack を見ているその場で仕事を残し、会話文脈ごと再浮上できること**に価値を置く。

価値の中心:

- メッセージやスレッドを見た瞬間に、その場で item 化できる
- item から元の会話文脈へ戻れる
- 個人の follow-up と共有 task を同じ会話面で扱える
- 状態だけでなく attention に基づいて「今気にすべきもの」を見られる
- 共有範囲、責任、確認タイミングを混ぜずに扱える

## 想定する利用文脈

対象は、Slack を日常の連絡窓口として使い、その会話から生まれる仕事を整理したい個人と小規模チームである。
特定の職種や業界は前提にしない。

想定する使い方:

- DM やスレッドで受けた頼まれごとを、そのまま自分の work item として残す
- 会議後の宿題や確認事項を shared task として残す
- 誰が主担当か、誰が見守るか、いつ再確認するかを分けて扱う
- 「この件どうなったっけ」を Slack 上で思い出す
- 返答待ちや handoff 後の仕事を attention ベースで再浮上させる

主対象にしないもの:

- 組織全体の公式台帳や案件管理の置き換え
- 多段の承認経路や厳密な権限管理
- 工数管理、負荷平準化、ガントチャート
- 外部 SaaS との同期前提の運用

## 主要ユースケース

### 1. 会話からの即時 capture

DM、スレッド、会議メモを見ている最中に、
「これ後でやる」「返事が来たら対応する」「忘れたくない」をすぐ item 化する。

期待する体験:

- 文脈を説明し直さずに登録できる
- title が雑でもよい
- source context が自動で残る

### 2. 個人の follow-up 管理

自分用に残した item を見返し、
未整理、着手可能、確認待ちを切り分ける。

期待する体験:

- `今は未整理のものだけ見たい`
- `自分が今気にすべきものを短く見たい`
- `締切ではなく確認タイミングで再浮上させたい`

### 3. 共有 task の起票と担当更新

channel で出た宿題や依頼を shared task として残し、
主担当、協力者、見守る人を分けて扱う。

期待する体験:

- `この件を task にして`
- `主担当は A さん`
- `私は見るだけでいい`
- `この channel の open task を見たい`

### 4. 待ちと handoff の管理

blocked 状態の item や、担当変更した item を、
状態と attention を混ぜずに扱う。

期待する体験:

- `返事待ちのものだけ見たい`
- `Aさんに引き継いだので自分は強く追わない`
- `金曜にもう一度確認したい`

### 5. 元の会話へ戻る

Slack で item を持つ意味は、item 単体の情報だけでなく、
その item が生まれた会話へ戻れることにある。

期待する体験:

- `この task はどの話から出たんだっけ`
- `最後にどこで話したか`
- 候補が複数ある時に文脈付きで選べる

## 中核概念

### Work Item

追跡対象となる仕事そのもの。
個人用の follow-up でも、shared task でもよい。
`task` は、work item が actionable な粒度に見えている時の呼び方と考える。

### Participant Relation

user と work item の関係。
責任と attention は item 本体ではなく relation に乗る。

relation が持つ主な意味:

- `role`: どう関与しているか。`primary_assignee` は 0 人または 1 人だけ
- `attention_profile`: 普段どのように注意に戻るか
- `next_attention_at`: 時刻で再浮上させたい時点
- `last_seen_event_id`: どこまでの change を見たか

### Work Event

意味のある変化。
単なる保存ログではなく、来歴と attention trigger の両方に使う。

### Attention Index

participant ごとに持つ denormalized read model。
`needs_attention` 系の一覧を PostgreSQL で効率よく読めるようにするために使う。

この index は source of truth ではなく、item / participant / event の変更と同じ transaction で更新する。
`context` visibility で見えるだけの non-participant には index 行を作らない。

### Visibility Policy

誰に見えるかを決める item-level の方針。
participant は常に可視対象に含める。

### Source Context / Home Context

- `source_context`: どこで生まれたか
- `home_context`: どこで主に扱うか

同じ context とは限らない。
`context` visibility の audience は `home_context` を基準にし、`home_context` が未設定の時だけ `source_context` を使う。
query と access check には、これを解決した cached field として `audience_channel_id` を使う。

## 概念上の要点

- `status` は item に 1 つだけ持つ
- participant ごとの状態は持たない
- 人ごとの差は relation 側の attention で表す
- `due_at` は item-level、`next_attention_at` は relation-level
- `created_by` は来歴であり、attention の強制対象ではない
- creator は作成時に follower として自動参加するが、後で外せる
- `primary_assignee` は 0 人または 1 人だけ持つ
- `primary_assignee_user_id` は work item の cached field としても保持し、list query で参照できるようにする
- `collaborator` と `follower` は 0 人以上を許容する
- `primary_assignee` は未設定のまま capture できる
- `primary_assignee` を外す時は relation を削除し、cached `primary_assignee_user_id` も null に戻す
- `primary_assignee + mute` は不自然なので許可しない
- `shared` は中核 enum ではなく、`visibility != private` の見え方として扱う
- item 間 relation の中核は `blocks` であり、親子を完了制御には使わない
- `context` visibility は `audience_channel_id` で評価し、これは `home_context` があればそれ、無ければ `source_context` から導く
- repository は Slack membership を直接見に行かず、caller が渡す `viewer_context_channel_ids` と `audience_channel_id` の一致で `context` visibility を判定する
- `AttentionIndex` は participant 専用の read model であり、`context` で見えるだけの channel member には fan-out しない
- `mute` と `muted_until` は directed event より下位で、`mention` や明示的な assign は mute を越えて surfaced してよい

## ドメイン仕様

### `WorkItemStatus`

- `captured`
- `planned`
- `in_progress`
- `blocked`
- `done`
- `canceled`
- `archived`

意味:

- `captured`: まだ整理しきっていない
- `planned`: 次のアクションとして成立している
- `in_progress`: 誰かが現在取り組んでいる
- `blocked`: item 自体が進めにくい
- `done`: 完了した
- `canceled`: 不要になった
- `archived`: 履歴として残す

`waiting` は status ではなく、attention に基づく view として扱う。

### `WorkItemPriority`

- `low`
- `medium`
- `high`
- `urgent`

### `VisibilityPolicyKind`

- `private`
- `context`
- `named`

意味:

- `private`: participant のみ見える
- `context`: `audience_channel_id` にいる人と participant が見える
- `named`: 指定メンバーと participant が見える

effective visibility は、常に `base audience ∪ participants` で決まる。
`base audience` の判定に使う `audience_channel_id` は cached field であり、`home_channel_id` があればそれ、無ければ `source_channel_id` を使う。

### `ParticipantRole`

- `primary_assignee`
- `collaborator`
- `follower`

意味:

- `primary_assignee`: その item を代表して持つ人
- `collaborator`: 一緒に進める人
- `follower`: 見守る人、状況を追う人

### `AttentionProfile`

- `focus`
- `track`
- `mute`

意味:

- `focus`: 普段から attention 集合に入る。directed event 以外でも再浮上しやすい
- `track`: change や時刻で再浮上する
- `mute`: 原則自動再浮上しない。directed event だけが再浮上条件になる

既定値:

- `primary_assignee -> focus`
- `collaborator -> track`
- `follower -> track`

override は許すが、`primary_assignee + mute` は不可とする。
`muted_until` は一時的な抑制であり、`attention_profile = mute` よりも弱い。どちらも `track` と `next_attention_at` を抑制するが、`mention` や明示 assign のような directed event は優先して surfaced してよい。`attention_profile = focus` は、mute が無い限り原則 surfaced する。

### `WorkItemDocument`

- `work_item_id`
- `team_id`
- `title`
- `description`
- `status`
- `priority`
- `due_at`
- `visibility_kind`
- `named_visibility_user_ids`
- `primary_assignee_user_id`
- `source_channel_id`
- `source_thread_ts`
- `source_message_ts`
- `home_channel_id`
- `audience_channel_id`
- `tags`
- `blocked_by_work_item_ids`
- `project_ref`
- `created_by_user_id`
- `created_at`
- `updated_at`
- `completed_at`

補足:

- `created_by_user_id` は provenance であり、現在の責任や attention を表さない
- `project_ref` は grouping 用の接続点であり、依存関係とは別
- `blocked_by_work_item_ids` は進行上の依存だけを表す
- `primary_assignee_user_id` は optional で、未設定のまま capture できる
- `primary_assignee_user_id` は relation の `primary_assignee` を mirror する cached field である
- `audience_channel_id` は `context` visibility の base audience を表す cached field であり、`home_channel_id` があればそれ、無ければ `source_channel_id` を入れる
- `visibility_kind != context` の時、`audience_channel_id` は null を許容する
- `audience_channel_id` は `visibility_kind` / `home_channel_id` / `source_channel_id` から決まる derived cached field であり、mutation 時に毎回再計算する

### `ParticipantRelationDocument`

- `work_item_id`
- `user_id`
- `role`
- `attention_profile`
- `next_attention_at`
- `muted_until`
- `last_seen_event_id`
- `joined_at`
- `updated_at`

補足:

- relation は現在の関与だけを表す
- 関与の変遷は `WorkEventDocument` に残す
- `next_attention_at` は optional
- `attention_profile = track` でも `next_attention_at` を併用してよい
- `mute` / `muted_until` / `next_attention_at` の優先順位は、`directed event` > `muted_until` / `mute` suppress > `next_attention_at` > `track` relevant event とする

### `WorkItemAttentionIndexDocument`

- `team_id`
- `user_id`
- `work_item_id`
- `status`
- `visibility_kind`
- `audience_channel_id`
- `home_channel_id`
- `primary_assignee_user_id`
- `attention_profile`
- `next_attention_at`
- `needs_attention_now`
- `attention_reason`
- `last_seen_event_id`
- `updated_at`

補足:

- participant ごとに 1 行持つ read model とする
- `needs_attention_now` は derived だが、`needs_attention` 系一覧を queryable にするために保持する
- `list_work_items(view = needs_attention)` はこの index を起点に work item を hydrate する
- `needs_attention_now` の更新は item / participant / event の変更と同じ transaction で行う
- `context` で見えるだけの non-participant channel member には index 行を作らない
- `audience_channel_id` は channel 単位の絞り込みに使う cached field である

### `WorkEventDocument`

- `event_id`
- `work_item_id`
- `type`
- `actor_user_id`
- `affected_user_ids`
- `payload`
- `occurred_at`

主な event type:

- `work_item_created`
- `status_changed`
- `primary_assignee_changed`
- `collaborator_added`
- `collaborator_removed`
- `follower_added`
- `follower_removed`
- `due_at_changed`
- `blocked`
- `unblocked`
- `attention_scheduled`
- `mentioned`
- `completed`
- `reopened`

event は semantic であることを重視し、単なる保存差分は event にしない。
status 変更は 1 回の transition につき 1 つの event type だけを持つ。意味が明確な時は `completed` / `reopened` / `blocked` / `unblocked` を使い、一般形が必要な時だけ `status_changed` を使う。`status_changed` と semantic event を同じ transition で重ねて出さない。

## 導出概念

### `needs_attention_now`

source of truth としては保存しない。
viewer ごとに relation と event から導く。

成立条件の例:

- `attention_profile = focus`
- または `next_attention_at <= now`
- または `attention_profile = track` で unseen の relevant event がある
- ただし `muted_until` が未来、または `attention_profile = mute` の時はこれらを抑制する
- ただし `mention`、明示 assign、primary assignee への変更のような directed event は最優先で surfaced してよい

### `shared task`

中核概念ではない。
会話上は、`visibility_kind != private` の item を shared task と呼んでよい。

### `today`

status ではない。
`due_at` と `needs_attention_now` から作る派生 view とする。

## クエリモデル

### `WorkItemQuery`

- `team_id`
- `viewer_user_id`
- `viewer_channel_id`
- `viewer_context_channel_ids`
- `view`
- `status_in`
- `visibility_kind`
- `primary_assignee_user_id`
- `participant_user_id`
- `audience_channel_id`
- `text_query`
- `due_before`
- `needs_attention_only`
- `include_completed`
- `limit`

主な view:

- `inbox`
- `my_tasks`
- `needs_attention`
- `channel_open`
- `done_recently`

補足:

- `needs_attention_only = true` の時は per-user attention index を起点にする
- `primary_assignee_user_id` は item doc の cached field を使って絞り込める
- `participant_user_id` は participant relation か attention index を使って絞り込む
- `viewer_channel_id` は現在の surface 上の channel を表す補助情報であり、access control そのものには使わない
- `channel_open` は item doc の `audience_channel_id` を使って絞り込む
- `viewer_context_channel_ids` は caller が解決した「この request で viewer が所属済みとして扱える channel 集合」であり、repository はこれを使って `context` visibility を判定する

## Repository 仕様

### 集約

repository は item 単体ではなく、必要に応じて aggregate を返す。

source of truth は `WorkItemDocument`、`ParticipantRelationDocument`、`WorkEventDocument` の 3 種である。
`WorkItemAttentionIndexDocument` は denormalized read model として、同じ transaction で更新する。

### `WorkItemAggregate`

- `item: WorkItemDocument`
- `participants: list[ParticipantRelationDocument]`
- `recent_events: list[WorkEventDocument]`
- `viewer_relation: ParticipantRelationDocument | None`

### 抽象 interface

`src/agents_party/repositories/` には `WorkItemRepository` を置く。

- `create_work_item(item: WorkItemDocument, participants: list[ParticipantRelationDocument], initial_events: list[WorkEventDocument]) -> WorkItemAggregate`
- `get_work_item(work_item_id: str, team_id: str, viewer_user_id: str, viewer_context_channel_ids: list[str]) -> WorkItemAggregate | None`
- `list_work_items(query: WorkItemQuery) -> list[WorkItemAggregate]`
- `mutate_work_item(work_item_id: str, team_id: str, mutation: WorkItemMutation, actor_user_id: str) -> WorkItemAggregate`

補足:

- `create_work_item` と `mutate_work_item` は item / participant / event / attention index を 1 回の transaction で更新する
- `get_work_item` と `mutate_work_item` は workspace scope を明示的に受け取る
- repository は Slack API を直接呼ばず、`viewer_context_channel_ids` と `audience_channel_id` の一致で `context` visibility を判定する
- App Home や cross-channel surface では、caller 側が membership snapshot か同等の resolver で `viewer_context_channel_ids` を埋める

### `WorkItemPatch`

- `title`
- `description`
- `status`
- `priority`
- `due_at`
- `visibility_kind`
- `named_visibility_user_ids`
- `home_channel_id`
- `tags`
- `project_ref`
- `clear_fields`

更新セマンティクス:

- patch に含めないフィールドは変更しない
- 値を持つフィールドはその値で上書きする
- nullable なフィールドを消したい場合は `clear_fields` にフィールド名を入れる
- `visibility_kind`、`home_channel_id`、`clear_fields` のいずれかが `audience_channel_id` の導出条件を変える時は、`mutate_work_item` が item 側の `audience_channel_id` を再計算する

### `WorkItemMutation`

- `item_patch`
- `primary_assignee_user_id`
- `clear_primary_assignee`
- `collaborator_user_ids_to_add`
- `collaborator_user_ids_to_remove`
- `follower_user_ids_to_add`
- `follower_user_ids_to_remove`
- `events`

補足:

- `primary_assignee_user_id` は optional で、未指定なら現在値を維持する
- `clear_primary_assignee` が true の時は primary assignee を外す
- `mutate_work_item` は item / participant / event / attention index を 1 つの transaction で更新する
- `WorkItemMutation` で primary assignee を変える時は `WorkItemDocument.primary_assignee_user_id` も同時に更新する
- `mutate_work_item` は `item_patch` 適用後の `visibility_kind` / `home_channel_id` / `source_channel_id` から `WorkItemDocument.audience_channel_id` を毎回再計算する
- `audience_channel_id` が変わった場合は、影響を受ける `WorkItemAttentionIndexDocument` を同じ transaction で再書き込みし、不要になった行は削除または `audience_channel_id = null` に更新する
- `events` は mutation の結果として同時に書き込む semantic event である

### PostgreSQL 配置

source of truth と read model は relational table として分けて持つ。

```text
work_items
work_item_participants
work_item_events
work_item_attention_index
```

この形を採る理由:

- item、participant、event を明確に分けられる
- channel 横断検索がしやすい
- DM 起点の item と shared task を同じ枠組みで扱える
- event を attention trigger と provenance の両方に使える
- attention index を participant 向けの queryable read model として持てる
- `channel_open` は item doc の `audience_channel_id` で引き、attention index に channel member 全員分の fan-out を要求しない

## Agent 契約

### `deps_type`

`WorkManagerDeps` を定義する。

- `request_context: WorkManagerRequestContext`
- `work_item_repository: WorkItemRepository`
- `now: Callable[[], datetime]`
- `default_timezone: str`
- `max_list_size: int = 20`

`WorkManagerRequestContext`:

- `team_id`
- `user_id`
- `channel_id`
- `viewer_context_channel_ids`
- `thread_ts`
- `message_ts`

この context は Slack ハンドラが作り、agent と tool はこれを source of truth として使う。
`channel_id` は現在の surface 上の channel を表す。
通常の channel / thread request では `viewer_context_channel_ids = [channel_id]` としてよい。App Home など current channel が無い surface では、Slack 側の membership snapshot などから解決した channel 群を入れる。

### `output_type`

`WorkManagerResult` を定義する。

- `action`
- `message`
- `work_items`
- `needs_confirmation`
- `follow_up_question`

`action` の候補:

- `created`
- `listed`
- `updated`
- `completed`
- `clarification_needed`
- `no_op`

## Tool 仕様

tool は意図ごとに分ける。
tenant scope と現在の Slack 文脈は `request_context` から取り、tool 入力で `team_id` は受け取らない。

### `capture_work_item`

入力:

- `title`
- `description`
- `visibility_kind`
- `named_visibility_user_ids`
- `primary_assignee_user_id`
- `collaborator_user_ids`
- `follower_user_ids`
- `due_at`
- `next_attention_at_for_me`
- `priority`
- `tags`
- `home_channel_id`

補足:

- `source_thread_ts` と `source_message_ts` は request context から取る
- creator は follower として自動参加させる
- `primary_assignee_user_id` は optional で、未指定のまま capture できる
- `primary_assignee_user_id` を指定しなかった場合は、capture 後も未設定のままとする
- `home_channel_id` が無い時は source context を audience として扱う

### `list_work_items`

入力:

- `view`
- `status`
- `visibility_kind`
- `participant_user_id`
- `audience_channel_id`
- `text_query`
- `due_before`
- `needs_attention_only`
- `include_completed`
- `limit`

### `update_work_item_status`

入力:

- `work_item_id`
- `status`

補足:

- `work_item_id` だけではなく `team_id` を必ず伴う
- state change と participant change と event append は、`mutate_work_item` の 1 回でまとめて起こす

### `update_work_item_fields`

入力:

- `work_item_id`
- `title`
- `description`
- `due_at`
- `priority`
- `visibility_kind`
- `named_visibility_user_ids`
- `tags`
- `home_channel_id`
- `clear_fields`

### `update_participants`

入力:

- `work_item_id`
- `primary_assignee_user_id`
- `clear_primary_assignee`
- `collaborator_user_ids_to_add`
- `collaborator_user_ids_to_remove`
- `follower_user_ids_to_add`
- `follower_user_ids_to_remove`

補足:

- `primary_assignee_user_id` は optional で、未指定なら現在値を維持する
- `clear_primary_assignee` が true の時は primary assignee を外す

### `set_my_attention`

入力:

- `work_item_id`
- `attention_profile`
- `next_attention_at`
- `muted_until`

補足:

- `muted_until` が未来なら `track` / `next_attention_at` は抑制する
- `mention` や明示 assign のような directed event は mute を越えて surfaced してよい
- `attention_profile = mute` の時も directed event のみは surfaced してよい
- `attention_profile = focus` は、mute が無い限り原則 surfaced する

### `complete_work_item`

入力:

- `work_item_id`

### `find_work_item_candidates`

入力:

- `text_query`
- `participant_user_id`
- `status`
- `audience_channel_id`
- `limit`

## 振る舞いルール

- ユーザー依頼に直接関係しない更新は行わない
- 曖昧な item 指定では確定更新しない
- `visibility_kind` が曖昧な時は確認する
- `primary_assignee` が未設定の時は、無理に埋めずにそのまま進めてよい
- `due_at` と `next_attention_at` を混同しない
- item の state change と participant の attention change を混同しない
- semantic な change に対してのみ event を生成する
- state change、participant change、event append、attention index 更新は必ず同じ transaction で行う
- assign、mention、participant 追加のような directed event は強く扱う
- 一覧応答は長くしすぎない
- item が見つからない場合は確認可能な候補を返す

## Slack 返答方針

- 返答は短くする
- 何が変わったかを先に書く
- 必要なら source context か home context を添える
- shared task の担当変更や完了は、担当情報を明示する
- 候補が複数ある場合は確認質問を返す

返答例:

- 「`見積書の送付確認` を登録しました。起点はこのスレッドで、次の確認は金曜です」
- 「`4月イベントの案内文作成` を shared task として登録しました。主担当は `<@U123>`、場所は `<#C123>` です」
- 「候補が2件あります。`#sales` のお客様フォローと `#ops` の備品発注、どちらを完了にしますか」

## モジュール配置

agent 関連コードは repo の現行規約に合わせて配置する。

```text
src/agents_party/
  agents/
    definitions/
      work_manager.py
    skills/
      work_manager_tools.py
  domain/
    work_management.py
  repositories/
    work_item_repository.py
  infrastructure/postgres/
    work_item_repository.py
  slack/
    features/work_management.py
```

`src/agents_party/agents/skills/` は Python の tool / support code を置く場所であり、
repo root の `skills/` は catalog に登録された built-in agent skill を置く場所である。
この設計書で挙げる候補は、現時点で built-in skill として追加済みであることを意味しない。

## Google Calendar 連携の境界

Google Calendar 連携の active proposal は、task 管理の中核設計から切り出して
共通プランの [`../plans/google-calendar-integration-plan.md`](../plans/google-calendar-integration-plan.md) と
work 管理向けプランの [`../plans/work-management-google-calendar-plan.md`](../plans/work-management-google-calendar-plan.md) に置く。

この設計書には、長く残したい境界だけを残す。

- Google Calendar event は `WorkEvent` ではなく、外部予定への参照として扱う
- `due_at` と `next_attention_at` は Google Calendar の時刻と自動同一視しない
- work 管理の中核モデルは Google API に直接依存しない
- 実装後の挙動はコードとテストを正とする
- 実装後に長く残すべき判断が出たら、ADR かこの設計書へ昇格する

## Skill への切り分け

この設計のうち、**language-heavy で再利用したい判断** は agent 内部の prompt section や private support layer に切り出しやすい。
一方で、**整合性・可視性・永続化を壊すと困るルール** は agent / domain / repository に残す。

現行 repo の built-in skill は user-facing な業務ワークフロー単位で catalog 管理されている。
そのため、ここで挙げる候補は repo-wide built-in skill の即時追加案ではなく、まずは work manager agent 専用の内部レイヤとして扱うのが自然である。

### agent 内部に切り出しやすいもの

#### `work-item-capture`

雑な会話やメモから、work item 候補を整える prompt section / support layer。

- title の圧縮
- description の要約
- `primary_assignee` / `collaborator` / `follower` の候補抽出
- `due_at` と `next_attention_at_for_me` の手掛かり抽出
- 曖昧さが残る点の列挙

#### `work-item-clarifier`

登録や更新の前に、確認質問を 1 つだけ返す prompt section / support layer。

- どの曖昧さが blocking かを選ぶ
- `visibility_kind`、担当、期限、対象 item のどれを先に確認すべきか決める
- 質問を短く返す

#### `attention-review-builder`

一覧結果を Slack 向けに短く整形する prompt section / support layer。

- `needs_attention`
- `today`
- `waiting`
- `done_recently`

を、そのまま読める短い返答にまとめる。

これらは work manager agent の内部手順としては有用だが、
現行 catalog の built-in skill と同じ粒度で公開する前に、
user-facing な業務ワークフローとして独立価値があるかを別途検証した方がよい。

### agent / domain / repository に残すもの

- `WorkItem` / `ParticipantRelation` / `WorkEvent` / `WorkItemAttentionIndexDocument` のモデル定義
- `primary_assignee_user_id` と `audience_channel_id` の cached field 同期
- `visibility_kind` と `audience_channel_id` の導出
- `viewer_context_channel_ids` を使った `context` visibility 判定
- `mutate_work_item` の transaction 境界
- semantic event の生成規則
- PostgreSQL の配置と query モデル

### 判断基準

- skill は「どう読むか」「どう聞くか」「どう短く返すか」を担当する
- agent は「どの tool を呼ぶか」「どの mutation を行うか」を担当する
- domain / repository は「何が正しい状態か」を担当する
- policy を提案するのは skill でよいが、policy を enforce するのは skill に置かない

したがって、この task-management 設計全体を 1 つの skill にするのではなく、
**capture / clarification / review formatting のような再利用可能な思考手順を、まずは agent 内部の prompt section / support layer として切り出す** のが自然である。
repo root の `skills/` に追加するのは、それが work manager 専用の内部部品ではなく、
他の agent からも user-facing に呼ばれる built-in workflow として成立する場合に限る。

## 結論

この agent では、ユーザー体験としては `task` を扱っていても、設計上の中心は `WorkItem` である。
仕事そのもの、誰がどう関わるか、何が起きたか、誰に見えるかを分けることで、
Slack 上の個人 follow-up と shared task を同じ枠組みで扱える。

特に重要なのは、**attention を item 本体ではなく participant relation に置くこと**である。
これにより、締切、確認タイミング、共有範囲、責任、来歴を混ぜずに扱える。
