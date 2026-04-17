# IBK — Polymeter Sequencer

Nuxt 3 + Tailwind CSS v3 製の **16 トラック・ポリメトリック・ステップシーケンサー**。
各トラックが独立した拍子（4/4, 7/8, 9/8, 11/8, 13/8 …）を持ち、ループ末尾で拍子変更を
反映するポリメーター構造。音声は Web Audio API の look-ahead スケジューラ
（lookahead 100ms / tick 25ms）でサンプル精度で再生し、Web MIDI 経由で
外部機器へも同時にノートを送出する。

共通コアの上に **複数の UI バリアント** を同居させる apps-split 構造:

- **Type2**（無印） … シンプル RING + GRID。軽量、モバイル OK。
- **Type2Plus**（予定） … RING をリッチ化した拡張版。デスクトップ推奨、NOTE リピート
  等のプラグインを有効化。グラフィック／ビジュアル表現のアップグレードに特化し、
  コア機能は Type2 と完全共有。

設計の全体像は `ARCHITECTURE.md`、スケジューラの内部設計は `DESIGN.md` を参照。

## セットアップ

開発は各アプリのディレクトリで行う:

```bash
cd apps/type2
npm install
npm run dev       # http://localhost:3000
```

ビルドとローカルプレビュー:

```bash
npm run build
npm run preview
```

## Vercel デプロイ

GitHub リポジトリは 1 つのまま、Vercel project を app ごとに作る。

| Vercel Project | Root Directory | 想定 URL |
|---|---|---|
| `polymeter-sequencer-2` | `apps/type2` | `polymeter-sequencer-2.vercel.app` |
| `polymeter-sequencer-2-plus` | `apps/type2-plus`（後続） | `polymeter-sequencer-2-plus.vercel.app` |

Framework は自動検出（Nuxt）。`apps/<name>/vercel.json` を各アプリに配置済み。

## 構成

```
polymeter-sequencer-2/
├── layers/
│   └── core/                    ← 全アプリ共通レイヤ（Nuxt Layer）
│       ├── core/                   pure TS: meter / bridge / pending / scheduler / adapters / plugins / types
│       ├── composables/            useSequencerStore / useMidi / useMidiIn
│       └── components/             MeterKnob / StepCell（共通プリミティブ）
├── apps/
│   └── type2/                   ← 無印 Type2
│       ├── nuxt.config.ts          extends: ['../../layers/core']
│       ├── pages/index.vue         薄いビュー (store を consume)
│       ├── components/             CircularTrack / ConcentricView / StepSequencer
│       ├── assets/css/main.css
│       ├── public/ibk.svg          左上ブランドマーク
│       ├── tailwind.config.js
│       ├── package.json
│       └── vercel.json
├── ARCHITECTURE.md              ← apps-split 設計
├── DESIGN.md                    ← スケジューラ / ポリメーターのロジック設計
└── README.md
```

## 実装上の重要ルール

スケジューラはオーディオスレッド寄りのループなので、**Vue のリアクティブ状態を
直接触らない** ことで安定性を担保している。

- `bpmRaw` / `tracksRaw` / `pendingRaw` / `displayHeads` / `masterTargetRef` は
  すべて `{ current: T }` 形式のプレーンオブジェクトで参照。
- `applyFnRef` / `midiFireRef` / `audioEnabledRef` も同じパターン。レンダーごとに
  最新クロージャを `.current` に差し替える。
- これにより Vue の `depTrack` がスケジューラのホットループに入らず、ジッタが出ない。
- 反映が必要な UI 更新は `setTimeout(fn, 0)` でマイクロタスクの外へ出す。

詳しくは `DESIGN.md` 参照。

## 機能

### トラック

- **16 トラック**（KICK / SNARE / HAT / CLAP / BASS / LEAD / PAD / PERC + K2〜PC2）
- トラックごとの拍子：分子 `N = 0..16`、分母 `D ∈ {4, 8, 16}`
  - `N = 0` は **drop bar**（1小節まるごと無音）として扱える
- 各ステップは 16分音符グリッドにスナップ（`stepCount = round(N * 16 / D)`）
- Mute / Solo / Clear
- トラックごとの MIDI 出力：CH（1–16）、Note No（0–127）、Velocity（1–127）、Gate（10–500ms）

### ビュー

- **GRID**：8×2 のセル配置。各セルは円形の `CircularTrack` を中心に、ツマミ・M/S/✕ を配す
  - 円をクリックするとそのトラックがアクティブ化（スケール拡大 + ⚙ ボタンが円内に表示）
  - 円の外をクリックでアクティブ解除
  - ⚙ を押すと画面下端に **スライドパネル**（詳細設定）が開く
  - スライド表示中に他のトラックの円をクリックすると、そのトラックへ切り替わる
  - スライドは ✕ または円の外クリックで閉じる
- **RING**：全トラックを同心円状に重ねた俯瞰ビュー（右サイドパネルで詳細編集）

### 再生と遷移

- **INSTANT モード**：拍子を変えたら次のループ境界で即座に切替
- **TRANSITION モード**：`generateBridge` が中間メーターを 1〜2 小節挟み、滑らかに補間
- トラック単位でも、マスターでもそれぞれ INST / TRANS を選べる
- MASTER の APPLY は TRANSITION 時だけ有効（ツマミは stage のみ）
- **convergence sync (R1)**：全トラックがマスター target に揃った瞬間、全トラックの
  `step = 0` に強制、MIDI パニック、フラッシュ、スナップショット再適用

### パターンスナップショット

- `SNAP SHOT` ボタンで現在の全ステップ・拍子を保存
- `↩ INST` / `↩ TRANS` で呼び戻し。TRANS 側は拍子の違うトラックをブリッジで戻す

### 再生制御

- BPM 40–240（上段の `BPM ▾` からオーバーレイスライダー）
- PLAY / STOP
- **ALL MUTE**（`⊘ ALL M`）：全トラックの mute を一括 on/off
- **AUDIO ON/OFF**：Web Audio 内蔵音源の有音／無音切替（MIDI OUT は常時送信）
  - AUDIO OFF のときトラック名の代わりに `ch:note`（例 `1:60`）を表示

### MIDI

- **MIDI OUT**：ブラウザが接続しているデバイスから選択（Web MIDI API 対応ブラウザ限定）
- **MIDI IN**：
  - **Clock Sync**：`INT`（内部）／`SYNC`（外部クロック 0xF8, 24 PPQN）
  - **Mapping**：CC / Note を内部コントロール（BPM、Master N/D、MASTER APPLY、PLAY/STOP 等）へ
    自由に割り当て。`MAPPING` をオンにすると各コントロールに learn 用オーバーレイが載る
  - **Learn**：オーバーレイをクリック→待機状態→次に受信した CC/Note を記録
  - **SAVE / LOAD**：マッピングを JSON でエクスポート／インポート

## 既知の制約

- MIDI は Web MIDI API 対応ブラウザのみ（Chromium 系で動作確認）
- `AudioContext` は最初のユーザージェスチャ後に作成・再開される
- `N = 16, D = 4` だとステップ数が 64 になる。16列折り返しが前提の内部計算を行うので
  RING ビューではセルが小さくなる（`minmax(0, 1fr)` で収まる）
- Master reset は「全トラック target 一致」が同時成立した瞬間にだけ発火する。
  TRANSITION 中に個別トラックの拍子を手動で変えると convergence が遅延する場合がある

---

<!-- I -->
<!-- B -->
<!-- K -->

*Inspiration By Kensei — [DJ KENSEI](https://www.djkensei.com/)*
*Im Bin Kevin — Bin Ke Vin*
