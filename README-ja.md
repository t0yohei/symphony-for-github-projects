# GitHub Projects 向け Symphony

このリポジトリは [Symphony](https://github.com/openai/symphony) の TypeScript 実装を、
**GitHub Projects** を課題管理システムとして利用できるようにしたものです。
仕様は [Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md) をベースに、GitHub Projects 向けに調整されています。

Symphony は、プロジェクト作業を「独立した自律実行」単位に分解して実行する仕組みで、
チームはコーディングエージェントの作業監視ではなく進行管理に集中できます。
上流実装は Linear をトラッカーとして使用しており、このプロジェクトでは同じアーキテクチャを GitHub Projects へ適用しています。

> **ステータス:** Engineering preview。信頼できる環境での評価用途。

---

## Symphony for GitHub Projects の実行

### 方式 1: 自分で構築する

好きなコーディングエージェントに、次の実装を依頼できます。

> Implement Symphony for GitHub Projects according to the following spec:
> https://github.com/t0yohei/symphony-for-github-projects/blob/main/SPEC.md

### 方式 2: このリポジトリの実装を試す

このリポジトリを参照実装としてチェックアウトし、次を実行します。

```bash
git clone https://github.com/t0yohei/symphony-for-github-projects.git
cd symphony-for-github-projects
npm install
npm run build
npm start
```

セットアップの補助をエージェントに依頼することもできます。

> Set up Symphony for GitHub Projects for my repository based on
> https://github.com/t0yohei/symphony-for-github-projects/blob/main/SPEC.md

`.github/workflows/ci.yml` に含まれる GitHub Actions を、初期チェック用のベースラインとして使えます。

---

## 仕組み

```text
GitHub Projects（課題管理）
    ↓  ポーリング（設定可能な間隔）
Symphony Orchestrator
    ↓  issue ごと workspace 分離
    ↓  コーディングエージェント起動（Codex app-server）
Coding Agent
    ↓  変更を実装し PR を作成
GitHub Projects の状態更新
```

1. **Poll**: `Todo`, `In Progress` などのアクティブ状態を持つアイテムを定期取得
2. **Isolate**: 各作業アイテムごとに専用ワークスペースを生成（hooks で初期化）
3. **Dispatch**: レンダリング済みプロンプトで `codex app-server`（または同等のコマンド）を起動
4. **Multi-turn**: `max_turns` まで複数ターンで実装を継続
5. **Reconcile**: 定期的にトラッカー状態を再確認し、完了/失敗時にワークスペースを終了・クリーンアップ

---

## 前提条件

- **Node.js** 20 以上
- 対象リポジトリと Project ボードにアクセスできる **GitHub トークン**
- `codex app-server` が実行可能な Codex CLI（または同等コマンド）
- ステータス列を持つ GitHub Project（classic / ProjectV2 のいずれか）

---

## はじめ方

### 1. クローンしてインストール

```bash
git clone https://github.com/t0yohei/symphony-for-github-projects.git
cd symphony-for-github-projects
npm install
```

### 2. 環境変数を設定

このリポジトリの [SPEC](./SPEC.md) では、実行時の設定値は `.env` ではなく
環境変数で解決されます。起動前にシェルで設定してください。

```bash
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
```

`WORKFLOW.md` の front matter は `$VAR_NAME` 形式（例: `tokenEnv: GITHUB_TOKEN`）で参照します。
設定リゾルバは起動時に `process.env` から値を読み込みます。

### 3. WORKFLOW.md を作成

例として `examples/WORKFLOW.md` をコピーして、実プロジェクトに合わせて編集します。

```bash
cp examples/WORKFLOW.md ./WORKFLOW.md
```

最小構成の例:

```yaml
---
tracker:
  kind: github_projects

runtime:
  poll_interval_ms: 30000
  max_concurrency: 2

workspace:
  root: ~/symphony-workspaces

hooks:
  timeout_ms: 120000
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
    npm install

agent:
  command: codex app-server
  max_turns: 20

extensions:
  github_projects:
    owner: your-org
    project_number: 1
    token_env: GITHUB_TOKEN
---

You are working on GitHub Project item {{ issue.identifier }}.

Title: {{ issue.title }}
Description: {{ issue.description }}

Follow repository coding standards. Write tests for new functionality.
Create a pull request when the implementation is complete.
```

YAML の Front Matter が実行設定を定義し、Markdown 本文が各作業項目に渡されるプロンプトテンプレートになります。
Liquid 記法で以下の変数を使えます。

### 4. ビルドして起動

```bash
npm run build
npm start
# または
node dist/cli.js
```

## WORKFLOW.md の役割

`WORKFLOW.md` はオーケストレータの「単一情報源（single source of truth）」です。
リポジトリと一緒にバージョン管理し、変更履歴で実行ルールを追えるようにしてください。

主要キー:

- `tracker.kind`: `github_projects`
- `runtime.poll_interval_ms`, `runtime.max_concurrency`
- `runtime.retry.{continuation_delay_ms,failure_base_delay_ms,failure_multiplier,failure_max_delay_ms}`
- `workspace.root`
- `agent.command`, `agent.args`, `agent.max_turns`
- `agent.timeouts.{turn_timeout_ms,read_timeout_ms,stall_timeout_ms,hooks_timeout_ms}`
- `hooks.{after_create,before_run,after_run,before_remove,timeout_ms}`

GitHub Projects 拡張: 

- `extensions.github_projects.owner`
- `extensions.github_projects.project_number`
- `extensions.github_projects.token_env`
- `extensions.github_projects.type`
- `extensions.github_projects.active_states`（任意、既定値: `todo`, `in_progress`, `blocked`）
- `extensions.github_projects.terminal_states`（任意、既定値: `done`）
- `extensions.github_projects.status_options.in_progress`（任意、既定値: `In Progress`）
- `extensions.github_projects.status_options.done`（任意、既定値: `Done`）
- `extensions.github_projects.mark_done_on_completion`（任意、既定値: `false`）

`mark_done_on_completion: true` の場合、ワーカーが `completed` を返したら、対象アイテムを設定済み `done` の状態へ遷移させます。
`false` のままだと、既定では短い間隔の continuation 再試行へ入り、1ターン完了の単純構成ではループに見えることがあります。

古いキー（`polling.intervalMs` や `workspace.baseDir` など）との互換マッピングもあり、
設定の自動移行をサポートします。

### テンプレート変数

- `{{ issue.identifier }}`
- `{{ issue.title }}`
- `{{ issue.description }}`
- `{{ issue.state }}`
- `{{ issue.labels }}`
- `{{ attempt }}`（初回は `null`、リトライ時は整数）

不明な変数やフィルタは strict mode でエラーになります。

### ホットリロード

`WORKFLOW.md` の変更を監視し、再起動なしで再読込します。
不正な設定の場合は直近の有効設定を維持します。
