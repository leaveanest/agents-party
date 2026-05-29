# OSA-69 / Claude Design プロンプト

OSS プロジェクト「agents-party」の GitHub Pages 紹介サイトを Slack ネイティブ感のデザインへ
刷新するための **Claude Design 用プロンプト**。以下の「---」で囲んだ本文を Claude Design に
そのまま貼り付けて使う。

---

OSS プロジェクト「agents-party」の GitHub Pages 紹介サイトを刷新する、静的サイトの
デザインと HTML / CSS を生成してください。現状は light-green テーマ(アクセント `#126b54`)
ですが、これを置き換え、**Slack ネイティブ感**のあるデザインへ刷新します。

完成物は **React 等のフレームワークを使わない素の HTML + CSS のみ**の静的サイトです。
ビルドは Vite 前提、GitHub Pages で配信され、base path は `/agents-party/`、公開 URL は
`https://leaveanest.github.io/agents-party/` です。日本語をデフォルト、英語版も用意する
**二言語サイト**として、同じデザインシステムで統一してください。URL 構成は
`/agents-party/` が日本語、`/agents-party/en/` が英語です。

## プロダクト概要

agents-party は、Slack 上で AI エージェントを自然に呼び出し、会話・要約・検索・翻訳・
ファイル理解・マルチモーダル処理・Canvas 出力などを業務導線の中で扱うための pre-1.0 の
OSS 基盤です。商用アプリ「Party on Slack」そのものではなく、その設計思想を継承した
オープンソースプロジェクトです。

## トップで伝えたい思想

- AI を別アプリとして使わせず、普段使う Slack の会話空間に自然に参加させる
- 個人と AI の閉じた利用ではなく、「仲間・AI・自分」の三者協働を支える
- AI は自動意思決定者ではなく、業務と創造ワークを支援する協働パートナー
- OpenAI 固定ではなく、Anthropic / Google など複数 LLM プロバイダーを選べる(multi-provider routing)
- ワークスペース側の API キー管理を前提にし、利用量とコストを運用者が制御できる
- セキュリティとデータ処理を前面に出し、「何を保存しないか」と「設定上保存するもの」を曖昧にしない

## ターゲット読者

- Slack を業務基盤として使う開発者・運用者・情シス・プロダクトチーム
- Slack Bot / AI エージェント / LLM ルーティング基盤に関心のある OSS 利用者
- Party on Slack の思想に共感し、自社ワークスペースで制御可能な AI 協働基盤を検討する人

## 維持する情報構造とページ一覧

既存のページ構成・情報は維持し、見た目だけを刷新します。

- `site/index.html`: 日本語トップ
- `site/en/index.html`: 英語トップ
- `site/pages/quick-start.html`: 日本語 Quick Start
- `site/en/pages/quick-start.html`: 英語 Quick Start
- 共通 CSS: `site/assets/styles.css`
- デモ画像: `site/assets/agents-party-thread-demo.png`(縦長のスレッド画面。実寸未確定なのでレスポンシブに破綻しない配置にする)

### トップページで維持する内容

- ナビ: ブランド「AP / Agents party」、Quick Start、GitHub、English 切替
- Hero:
  - eyebrow: `Slack-native agent routing OSS`
  - h1: `Slackの会話に、AIエージェントが自然に参加する。`
  - lead 文
  - CTA: `始める`、`GitHubを見る`
  - 技術チップ: `Slack Bolt`、`Multi-provider LLM routing`、`PostgreSQL`、`Terraform`
  - 右側に Slack 風スレッドのデモ画面画像
- 「設計思想」セクション(3 つ): 仲間・AI・自分で進める / モデルを固定しない / 運用者が制御できる
- pre-1.0 OSS であることの notice
- フッター: MIT、README、Data、Security、English リンク

### Quick Start ページで維持する内容

Docker Compose 起動手順 / 必要なもの 3 カード / 番号付きステップ群 / コードブロック / PR 前検証コマンド。

## 目指すビジュアル

Slack の UI を連想させつつ、Slack の公式ロゴや商標そのものを流用・模倣しすぎない
「Slack-native inspired」なデザインにしてください。

### 配色案(現状の緑テーマを置き換える)

- Primary aubergine: `#4A154B`
- Deep purple: `#611F69`
- Accent blue: `#36C5F0`
- Accent green: `#2EB67D`
- Accent yellow: `#ECB22E`
- Accent red/pink: `#E01E5A`
- Text primary: `#1D1C1D`
- Text muted: `#5E5A62`
- Background: `#F8F5F8`
- Surface: `#FFFFFF`
- Border: `#E7DDE8`
- Code background: `#17131A`

### タイポグラフィ

- 日本語と英語が読みやすい system font stack を基本にする
- Hero は力強く、本文はドキュメントとして読みやすく、コードブロックは等幅フォント
- 過度な巨大文字やマーケティング LP 風の装飾に寄せすぎず、OSS プロジェクトとして信頼できる密度にする

### コンポーネント・モチーフ

- Slack のスレッド UI、メッセージ UI、返信数、メンション、絵文字リアクション、チャンネル名、
  Canvas 風カードを連想させる要素を取り入れる
- Hero 右側は `agents-party-thread-demo.png` を主役にし、Slack 風の会話空間に AI が自然に
  参加している印象を作る
- 設計思想カードは白カード一辺倒にせず、Slack 風のメッセージ / スレッド / Canvas ノート風の
  リズムを持たせる
- CTA は明確にし、タップ領域は 44px 以上
- Quick Start は実務者が迷わず読めるドキュメント UI(コードブロック・ステップ・注意書き・必要条件を整理)

## 技術制約

- 素の HTML + CSS のみ。React / Vue / Svelte 等のフレームワークは使わない
- JavaScript は原則不要。必要でも最小限にし、HTML / CSS で成立する設計を優先する
- GitHub Pages 配信前提。base path `/agents-party/` でリンクとアセット参照が壊れないようにする
- 日本語版と英語版を同じデザインシステムで統一する
- アクセシビリティを守る: 十分なコントラスト比 / `prefers-reduced-motion` 対応 /
  適切な `aria-label` / 44px 以上のタップ領域 / キーボードフォーカスが見える
- 軽量・高速: 画像を主役にしつつ過度な装飾を避ける / アニメーションは控えめ / CSS は保守しやすく

## モバイル対応 / レスポンシブ

スマートフォンでの閲覧を前提に、**モバイルファースト**で設計してください。

- スマートフォン幅(360〜430px)で完全に成立し、**横スクロールやレイアウト崩れを発生させない**
- 主要ブレークポイントの目安: モバイル(〜640px)/ タブレット(641〜1024px)/ デスクトップ(1025px〜)
- Hero はモバイルで縦積み(テキスト → デモ画像)にし、h1 は `clamp()` で自動縮小する
- ナビゲーションはモバイルで折り返すか、ハンバーガー等のコンパクトな導線にする
  (開閉が必要なら最小限の JS は可)。日本語 / English 切替はモバイルでも明確に押せる位置に置く
- カード・ステップ・グリッドはモバイルで 1 カラムに落とす
- Slack 風スレッドのデモ画像 `agents-party-thread-demo.png` は縦長。モバイルでは幅 100% で
  アスペクト比を保ち、はみ出さない・歪まないようにする
- コードブロックは横スクロール可能にし、画面外で文字が切れて読めなくならないようにする
- すべてのタップ領域(リンク・ボタン・チップ・言語切替)は 44px 以上を確保する
- 左右に十分な余白(最低 16px 程度)を取り、ノッチ / セーフエリアでも内容が隠れないようにする
- 縦向き・横向き(landscape)のどちらでも破綻しないことを確認する

## 受け入れ条件

- 現状の緑テーマが Slack aubergine / purple 中心のテーマに置き換わっている
- トップページを見て「AI を別アプリではなく Slack の会話空間に自然に参加させる」思想が伝わる
- 「仲間・AI・自分」の三者協働がビジュアルとして伝わる
- multi-provider routing、運用者による API キー・コスト制御、セキュリティ / データ処理への配慮が
  情報として埋もれない
- 日本語版と英語版の情報構造が対応している
- Quick Start が OSS 利用者向けに読みやすく、実行手順が追いやすい
- スマートフォン幅(360〜430px)で横スクロールやレイアウト崩れがなく、すべての情報・CTA に到達できる
- HTML / CSS としてそのまま実装に移せる粒度で出力されている

## 注意点

- Slack らしさは必要だが、Slack の公式ロゴや商標そのものを流用・模倣しすぎない
- セキュリティ説明では「保存しないもの」と「設定上保存するもの」を曖昧にしない。
  ただし実際の実装仕様と矛盾しそうな断定は避ける
- agents-party は pre-1.0 OSS であり、商用 Party on Slack そのものではない点を明確にする

## 出力してほしい成果物

以下を、ファイル単位で貼り替えやすいコードブロックに分けて出力してください。

1. `site/index.html`(日本語トップ)
2. `site/en/index.html`(英語トップ)
3. `site/pages/quick-start.html`(日本語 Quick Start)
4. `site/en/pages/quick-start.html`(英語 Quick Start)
5. `site/assets/styles.css`(共通 CSS)

HTML は完全な文書構造を持たせ、CSS は共通デザイントークン・レイアウト・コンポーネント・
レスポンシブ・アクセシビリティ対応を含めてください。

---

## 使い方メモ

- 上記「---」内の本文を Claude Design に貼り付けてデザイン / コードを生成する。
- 生成された HTML / CSS は `site/` 配下の対応ファイルへ反映する(base path `/agents-party/` の
  リンク・アセット参照が壊れていないか確認する)。
- 反映後の検証: `vp run site:build` でビルド確認、必要ならローカルで日本語 / 英語両方を目視確認。
- 既存 runtime のビルド / テスト / 型チェックには影響しない範囲(`site/` 配下のみ)で完結させる。
