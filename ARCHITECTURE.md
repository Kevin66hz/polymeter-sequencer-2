# Architecture — Core / Apps 分離と Type2Plus

このドキュメントは Polymeter Sequencer のコードベースを、
**1 つの共通コア + 複数の UI アプリ（Type2 / Type2Plus）** に組み替えるための
方針と構造を定義する。実装の一次資料。

対象読者：この repo を触る人（将来の自分を含む）。

---

## 1. なぜ組み替えるのか

現状は `pages/index.vue`（926 行）に UI・状態・スケジューラ連結・MIDI mapping まで
集約されており、

- 別 UI（RING 特化のリッチ版など）を作るたびに 900 行を複製することになる
- コア（スケジューラ、pure 関数、プラグイン的な拡張）を再利用できない
- NOTE リピートのような**共通拡張**を複数 UI に均しく適用できない

これを、**1 コア + 複数 UI アプリ + 差し替え可能なプラグイン**に変える。

## 2. 製品ラインナップ

2 本を同一リポジトリ内で**共存**させる。片方が片方を置き換えるのではない。

| 製品 | 位置づけ | 内容 |
|---|---|---|
| **Type2**（無印） | lean / 軽量 / モバイル OK | いまの Type2 をそのまま維持。シンプル RING、GRID ビュー、基本機能 |
| **Type2Plus** | deluxe / デスクトップ推奨 | リッチ RING（静的 / 動的レイヤ分離、Canvas オーバーレイ可）、NOTE リピート等のプラグイン有効 |

両者は**同じ core / 同じ store / 同じスケジューラ**を共有する。差分は:

- `components/` の RING 実装
- 有効化するプラグインの集合
- `nuxt.config.ts` のタイトル・meta・デプロイ先

それ以外は共通。

### Plus の責務境界（重要）

**Plus は "グラフィック / ビジュアル表現のアップグレード" に責務を限定する。**
コア機能の分岐先ではない。「Plus にも入れないと無印に影響が出る」と感じた時点で、
それは Plus 側ではなく layers/core に入れるべき修正である。

Plus 側に**書いてよいもの**:

- RING / GRID の描画実装（SVG 多層化、Canvas オーバーレイ、パーティクル、残像、グロウ）
- 既存機能・既存プラグインの**ビジュアル表示**（NOTE リピートの連打可視化など）
- Plus 限定プラグインの登録セット（重い描画を伴う拡張の有効化など）
- ブランディング・テーマ差分

Plus 側に**書いてはいけないもの（＝ layers/core に入れるべき）**:

- MIDI I/O のロジック（mapping、clock sync、learn、transpose 等の挙動変更）
- スケジューラ本体（`createScheduler`）の修正
- 拍子計算・ブリッジ生成・Pending 適用などの pure 関数
- プラグイン API の契約（`SequencerPlugin` 型、スケジューラのフック仕様）
- ストア（`useSequencerStore`）の挙動・公開インターフェイス
- オーディオ / MIDI アダプタの interface 変更

**コアのバグ修正・機能追加は layers/core に直接コミット**し、両アプリがそれを
参照する形で一元化する。Plus 側のブランチでコア修正をするのは禁止（アーキテクチャ
違反）。

## 3. ディレクトリ構造

```
polymeter-sequencer-2/
├── layers/
│   └── core/                          ← Nuxt レイヤ。全アプリが extends する
│       ├── nuxt.config.ts
│       ├── core/                      (pure TS, Vue 非依存)
│       │   ├── pure/                  meter.ts, bridge.ts, pending.ts
│       │   ├── scheduler/             create-scheduler.ts
│       │   ├── adapters/              audio.ts, midi.ts (interface + default impl)
│       │   ├── plugins/               api.ts + builtins/ (note-repeat 等)
│       │   └── types/                 Track, Pending, NoteEvent, SequencerPlugin
│       ├── composables/
│       │   ├── useSequencerStore.ts   ← pages/index.vue から抽出した脳みそ
│       │   ├── useMidiSetup.ts        Web MIDI access / デバイス一覧
│       │   └── useMidiIn.ts           CC/Note mapping / clock sync / learn
│       └── components/                両アプリ共通プリミティブ
│           ├── MeterKnob.vue
│           └── StepCell.vue
├── apps/
│   ├── type2/                         ← 無印
│   │   ├── nuxt.config.ts             extends: ['../../layers/core']
│   │   ├── pages/index.vue            store を consume する薄いビュー
│   │   ├── components/
│   │   │   ├── CircularTrack.vue
│   │   │   ├── ConcentricView.vue     RING (SVG 1 層, lean)
│   │   │   └── StepSequencer.vue
│   │   ├── plugins/                   (Nuxt の plugins ディレクトリ)
│   │   │   └── sequencer.client.ts    プラグイン登録 = []（基本なし）
│   │   ├── tailwind.config.js
│   │   └── vercel.json
│   └── type2-plus/                    ← デラックス
│       ├── nuxt.config.ts             extends: ['../../layers/core']
│       ├── pages/index.vue
│       ├── components/
│       │   ├── CircularTrack.vue      (Plus 専用の装飾入り)
│       │   ├── RingsStatic.vue        RING 静的レイヤ (SVG)
│       │   ├── RingsOverlay.vue       RING 動的レイヤ (Canvas)
│       │   └── ConcentricViewPlus.vue
│       ├── plugins/
│       │   └── sequencer.client.ts    [noteRepeat, humanize, ...]
│       ├── tailwind.config.js
│       └── vercel.json
├── DESIGN.md                          スケジューラ等のロジック設計
├── ARCHITECTURE.md                    このファイル
└── README.md
```

**依存方向（厳守）**: `apps/* → layers/core`。逆は禁止。core は下流アプリを知らない。

## 4. 共通 vs 差分の分水嶺

**layers/core に置くもの（両アプリ共通）**

- すべての pure 関数: `stepCount` / `stepDur` / `autoPreset` / `deriveStepsFromSource` /
  `applyPending` / `bridgeMeter` / `generateBridge`
- 型: `Track` / `Pending` / `NoteEvent` / `SequencerPlugin` / 他
- `createScheduler`（look-ahead ループ本体）
- オーディオ / MIDI アダプタのインターフェイス + デフォルト実装
- `useSequencerStore`（Vue ref を束ねた reactive 脳みそ）
- `useMidi` / `useMidiIn`
- `MeterKnob` / `StepCell` のようなプリミティブ

**各 app が持つもの**

- RING / GRID の実装コンポーネント（`ConcentricView` vs `ConcentricViewPlus` 等）
- `pages/index.vue`（ただし薄い）
- 有効化するプラグインの配列
- ブランディング・meta・Tailwind テーマ差分

## 5. プラグイン戦略（NOTE リピート等）

### 5.1 設計要点

スケジューラを **"step → NoteEvent パイプライン"** に改修し、拡張は
`transform(events, ctx) → events` の pure 関数として挿す。

```ts
// layers/core/core/types/index.ts
export type NoteEvent = {
  trackId: number
  timeSec: number
  channel: number
  note: number
  velocity: number
  gateMs: number
  tag?: string
}

export interface SequencerPlugin {
  id: string
  version: string
  transform?: (events: NoteEvent[], ctx: PluginContext) => NoteEvent[]
  defaultTrackExtras?: () => Record<string, unknown>
  ui?: { detailPanel?: string }   // variants 側で component を登録
}
```

スケジューラ改修点（`create-scheduler.ts` 内 `sched()`）:

```ts
// before
if (ok) {
  if (audioEnabledRef.current && ctx) triggerSound(ctx, id)
  midiFireRef.current?.(id)
}

// after
if (ok) {
  let events: NoteEvent[] = [/* base event from track settings */]
  for (const p of plugins) if (p.transform) events = p.transform(events, pluginCtx)
  for (const ev of events) outAdapter.schedule(ev)
}
```

**制約**: `transform` は pure & synchronous。ホットループで呼ばれるため副作用厳禁。

### 5.2 プラグインの ON/OFF

アプリごとに `plugins/sequencer.client.ts` で登録:

```ts
// apps/type2-plus/plugins/sequencer.client.ts
import { noteRepeat, humanize } from '#core/plugins/builtins'
export default defineNuxtPlugin(() => {
  registerSequencerPlugins([noteRepeat, humanize])
})

// apps/type2/plugins/sequencer.client.ts
export default defineNuxtPlugin(() => {
  registerSequencerPlugins([])   // lean: 拡張なし
})
```

### 5.3 将来入れうる拡張（同じ器で書ける）

- `note-repeat` — 1 step を N 連打に分割（count, subdiv）
- `ratchet` — `note-repeat` の count=2..4 亜種
- `probability` — 各 step に発火確率
- `humanize` — `timeSec` に ±ms ジッタ
- `swing` — 偶奇 step の `timeSec` をずらす
- `flam` — 1 発を 2 発に割って velocity 差
- `chord` — `note` を和音に展開

## 6. Vercel 配備

GitHub repo は 1 つのまま、Vercel project を 2 つ作る。

| Project | Root Directory | 想定 URL |
|---|---|---|
| `polymeter-sequencer-2` | `apps/type2` | `polymeter-sequencer-2.vercel.app` |
| `polymeter-sequencer-2-plus` | `apps/type2-plus` | `polymeter-sequencer-2-plus.vercel.app` |

各 `vercel.json` は該当 app のルートに置く。ルートの `vercel.json` は削除する。

## 7. 命名・エイリアス規則

import 解決の混乱を防ぐため、以下を厳守する。

- `~` / `@` は**アプリ側のルート**を指す（Nuxt デフォルトどおり）
- **layer 内の core/ を参照する時は `#core/*`** を使う（layer 内と apps 内の両方で同じ書き方）
- layer 内から layer 内の composables / components を参照する時も `#core/*` 経由で安定させる

```ts
// layers/core/nuxt.config.ts
import { fileURLToPath } from 'node:url'
export default defineNuxtConfig({
  alias: {
    '#core': fileURLToPath(new URL('./core', import.meta.url)),
  },
})
```

## 8. Tailwind 設定

共通テーマを layer 側で preset として持ち、各アプリで拡張する。

```js
// layers/core/tailwind.preset.js
module.exports = { /* 共通 theme / colors */ }
```

```js
// apps/type2/tailwind.config.js
module.exports = {
  presets: [require('../../layers/core/tailwind.preset.js')],
  content: [
    './pages/**/*.vue',
    './components/**/*.vue',
    // layer の Vue/TS も content に入れないと Tailwind が class を purge してしまう
    '../../layers/core/components/**/*.vue',
    '../../layers/core/composables/**/*.ts',
  ],
}
```

## 9. 移行手順（Phase 分け）

**Phase 0 — ベースライン確定**（Task #2）

浮いている未コミット変更を `wip: pre-restructure` として commit、
`feat/apps-split` ブランチを切る。

**Phase 1 — layers/core 骨組み作成**（Task #3）

`layers/core/` に pure 関数 / createScheduler / useMidi / useMidiIn /
MeterKnob / StepCell を**コピー**。この時点で既存アプリは何も変わらない。
alias `#core` と `nuxt.config.ts` をセットアップ。

**Phase 2 — useSequencerStore 抽出**（Task #4）

`pages/index.vue` 926 行のうち、UI 描画以外
（state / commitMaster / handleMasterReset / snapshot / scheduler 連結 / MIDI apply）
を `layers/core/composables/useSequencerStore.ts` に移す。`pages/index.vue` は
`const s = useSequencerStore()` から state/method を受け取るだけの
**読むだけビュー**にする。**Phase 中で最重要。この 1 回で UI バリアント作成コストがほぼ 0 になる**。

**Phase 3 — apps/type2 への引っ越し**（Task #5）

`pages/` `components/` `app.vue` `nuxt.config.ts` `tailwind.config.js` `vercel.json`
を `apps/type2/` に移動。`nuxt.config.ts` に `extends: ['../../layers/core']` を追加。
import path / Tailwind content の調整。**機能は完全に同等のまま**。

**Phase 4 — apps/type2-plus を複製**（Task #6）

`apps/type2` を `apps/type2-plus` として複製。title / meta を差別化。
Vercel の新 project を作成（Root: `apps/type2-plus`）。

**Phase 5 — Plus 側 RING リッチ化**（別タスク群、後続）

- 段 1: `ConcentricView` を `RingsStatic` + `RingsOverlay` に分解し、
  playhead と step dot の Vue リアクティブ結合を切る
- 段 2: ジオメトリを `Map<string, {x:number[], y:number[]}>` でキャッシュ
- 段 3: 動的レイヤを Canvas に逃がして波紋・パーティクル・残像を入れる

**Phase 6 — プラグイン基盤**（後続）

`sched()` を NoteEvent パイプライン化し、`SequencerPlugin` 契約を実装。
`noteRepeat` を最初のプラグインとして `apps/type2-plus` で有効化。

## 10. main ↔ feat/apps-split の同期ルール

`feat/apps-split` ブランチが走っている間も、**main ではコア機能の修正・
アップデートが継続する**前提の運用ルール。Plus はグラフィック拡張専用なので、
コア修正は main → branch に流す一方通行。

### 基本フロー

```bash
# feat/apps-split 側で main を取り込む（基本）
git switch feat/apps-split
git merge main
```

- 普段は `git merge main` で取り込む（cherry-pick や rebase は特殊ケース限定）
- 取り込みは**早め・小さく**。週次〜毎日ぐらいで main を merge して衝突を溜めない
- コア機能のバグ修正・アップデートは **main で行う** → merge で branch へ流す

### Phase 1〜2 期間中の重複ファイル同期

Phase 1 で以下のファイルは **layer 側にコピー**されて 2 箇所に並存している。
main 側の修正は merge で自動的にオリジナル側のみ更新され、**layer 側には
伝播しない**ので手動同期が必要:

| オリジナル（main の修正が届く） | レイヤコピー（手で同期） |
|---|---|
| `composables/useMidi.ts` | `layers/core/composables/useMidi.ts` |
| `composables/useMidiIn.ts` | `layers/core/composables/useMidiIn.ts` |
| `components/MeterKnob.vue` | `layers/core/components/MeterKnob.vue` |
| `components/StepCell.vue` | `layers/core/components/StepCell.vue` |

同期手順:

```bash
git merge main
# 例：main 側で composables/useMidi.ts に修正が入っていた場合
cp composables/useMidi.ts layers/core/composables/useMidi.ts
git add layers/core/composables/useMidi.ts
git commit -m "sync: propagate main's useMidi fix into layers/core"
```

### useScheduler.ts の特殊扱い

`composables/useScheduler.ts`（オリジナル）の内容は、layer 側では
`layers/core/core/pure/*.ts` と `layers/core/core/scheduler/create-scheduler.ts`
および `layers/core/core/adapters/audio.ts` に**関数単位で分解コピー**
されている。機械 `cp` で同期できないので以下の対応:

| main 側の修正箇所 | layer 側の反映先 |
|---|---|
| `stepCount` / `stepDur` / `autoPreset` / `resizeSteps` / `deriveStepsFromSource` | `layers/core/core/pure/meter.ts` |
| `applyPending` | `layers/core/core/pure/pending.ts` |
| `bridgeMeter` / `generateBridge` | `layers/core/core/pure/bridge.ts` |
| `createScheduler`・`tick`・`sched` 系 | `layers/core/core/scheduler/create-scheduler.ts` |
| `triggerSound` | `layers/core/core/adapters/audio.ts` |
| 型（`Track` / `Pending` / `SchedulerDeps`） | `layers/core/core/types/index.ts` |

### Phase 3 以降

`apps/type2/` への移動が完了すると、オリジナル側（`composables/*`・
`components/*`）は削除される。この時点以降:

- main と branch の構造が大きく乖離するため、以降の main 修正は
  **cherry-pick + layer 側へ当て直し**が基本になる
- できればここに至る前に `feat/apps-split` を main に merge してしまう
  （Phase 3 は機械的な移動作業なので、長引かせる意味が薄い）
- どうしても branch が長生きする場合は、先に apps-split を main に merge して
  「新レイアウト = main」にしてから、Plus の RING 改修を別ブランチに切り直す

### 運用上の原則

1. **Plus 側でコア修正を書かない**。Plus は描画・アニメーション・ビジュアル拡張専用
2. **コア修正は layers/core に**。両アプリから共有されるべきものはレイヤにコミット
3. **main → branch の merge は頻繁に**、溜めない
4. **layer 側同期を忘れない**。Phase 1〜2 中は特にチェックリスト化する価値あり

> アーキテクチャ違反のサイン：`apps/type2-plus/components/` 下にスケジューラ
> ロジックが入っている、`apps/type2-plus/composables/` に MIDI mapping の
> 挙動変更が入っている、など。こういう修正を見つけたら layers/core に
> リファクタし直す。

## 11. 落とし穴チェックリスト

- [ ] `~` alias が layer 側と apps 側で別物になる → `#core` で統一する
- [ ] Tailwind の `content` に layer 側のパスを入れ忘れると class が purge される
- [ ] `.nuxt/` が apps ごとに生成されるので `.gitignore` は `**/.nuxt` で除外
- [ ] layer 側は `node_modules` を持たない（apps 側だけ）
- [ ] `vercel.json` はルートから削除し、各 apps に置く
- [ ] Web MIDI / AudioContext は依然 client-only（SSR 禁）、`.client.ts` で登録

## 12. やらない判断（スコープ固定）

- **pnpm / npm workspaces 化**: Nuxt Layers だけで成立する間はやらない。必要になる時
  （core を npm publish したい、他フレームワークで使いたい、プラグインを別リポ化したい）が来たら再検討
- **core を他フレームワーク対応にする**: core は TypeScript pure なので理論上どこでも動くが、
  当面は Vue/Nuxt 前提で書く
- **プラグインの動的ロード**（`import()` at runtime）: 静的登録で十分
- **SSR でスケジューラを走らせる**: `AudioContext` がユーザー gesture 必須なので client-only

## 13. 参照

- `DESIGN.md` — スケジューラ、pure 関数、Pending キュー、Master convergence の設計
- `README.md` — セットアップ、UI 概要、ユーザー向け機能
