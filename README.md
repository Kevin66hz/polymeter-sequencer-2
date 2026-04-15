# polymeter-sequencer

Nuxt 3 + Tailwind CSS v3 製の 8 トラック・ポリメトリック・ステップシーケンサー。
各トラックが独立した拍子（4/4, 7/8, 9/8 …）を持ち、ループ末尾で拍子変更を
反映する。音声は Web Audio API の look-ahead スケジューラ（lookahead 100ms /
tick 25ms）でサンプル精度で再生。

## セットアップ

```bash
npm install
npm run dev       # http://localhost:3000
```

ビルドとローカルプレビュー:

```bash
npm run build
npm run preview
```

## Vercel デプロイ

1. リポジトリを用意する
   ```bash
   git init && git add . && git commit -m "init"
   git remote add origin <your-repo-url>
   git push -u origin main
   ```
2. [vercel.com](https://vercel.com) で **New Project** → 上記リポジトリを Import。
3. Framework は自動検出（Nuxt）。`vercel.json` も同梱済みなので追加設定不要。
4. Deploy。以後のブランチは自動でプレビュー環境が作られる。

## 構成

```
polymeter-sequencer/
├── pages/index.vue          ← UI とステート（Vue 3 Composition API）
├── composables/
│   ├── useScheduler.ts      ← look-ahead スケジューラ + サウンドエンジン
│   └── useMidi.ts           ← Web MIDI（後日実装のスタブ）
├── assets/css/main.css      ← Tailwind entry
├── nuxt.config.ts
├── tailwind.config.js
├── vercel.json
└── README.md
```

## 実装上の重要ルール

スケジューラはオーディオスレッド寄りのループなので、**Vue のリアクティブ状態を
直接触らない** ことで安定性を担保している。具体的には:

- `tick()` / `sched()` 内部では reactive な `ref` を書き換えない。
- 反映が必要な場合は `setTimeout(fn, 0)` でマイクロタスクの外へ追い出す。
- `applyFnRef.current` パターン — レンダーごとに最新のセッターを `ref` に代入し、
  スケジューラは常に `applyFnRef.current` を参照することで再購読なしに最新値を
  使う。これを壊すとループ末尾での拍子切替時にクラッシュする。

## 機能

- 8 トラック（KICK / SNARE / HAT / CLAP / BASS / LEAD / PAD / PERC）
- グローバル BPM（40–240）と ALL 拍子プルダウン
- トラックごとの拍子（4/4 / 3/4 / 5/4 / 7/8 / 9/8 / 11/8 / 13/8）と
  サブディビジョン（♪ = 8分基準 / ♬ = 16分基準）
- 再生中の拍子変更は pending 扱い（オレンジ表示）で、ループ末尾で反映
- 16 列 CSS グリッド、ステップ数が 16 を超えたら自然に折り返し
- Mute / Solo / Clear
- Web MIDI は `composables/useMidi.ts` のスタブに分離、実装は追って
