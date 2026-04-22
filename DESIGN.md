# Polymeter Sequencer — Design Notes

Nuxt 3 + Tailwind v3 ポリメーター・ステップシーケンサー。8トラック、各トラックが独立した拍子で同時に走り、Web Audio 先読みスケジューラと Web MIDI で発音する。このドキュメントは実装の中心にある設計判断とロジックをまとめたもの。

## 1. 時間軸モデル

- 全体は **16分音符グリッド** に固定。BPM と分母 `d` からステップ長を決める：
  - `stepDur(bpm) = 60 / bpm / 4` （秒／16分音符）
  - `stepCount(n, d) = round(n * 16 / d)` （1ループあたりのステップ数）
- 拍子 `n/d` はトラックごとに独立。ポリメーターはここから自然に生まれる（トラックごとにループ長が違う）。
- `n = 0` は特殊値で **drop bar**（1小節まるごと無音）を意味する。トランジション・キューの中で「ブレーク予約」として使える。
- ユーザーが触れる分母は `{4, 8, 16}` に限定。ブリッジ生成器だけは `{4, 6, 8, 12, 16}` を使い、(n,d) を線形補間するときに滑らかな中間値を出す。

## 2. スケジューラ (`composables/useScheduler.ts`)

Web Audio 先読みループ（lookahead 100ms、tick 25ms）で先の時間にノートイベントを発行する。

重要な設計原則：**スケジューラは Vue のリアクティブ経路から完全に外す**。

- `bpmRaw` / `tracksRaw` / `pendingRaw` / `displayHeads` / `masterTargetRef` などは全て `{ current: T }` 形式のプレーンなオブジェクト。
- `applyFnRef` / `midiFireRef` / `audioEnabledRef` も同じ。レンダリング時に最新のクロージャで書き換える。
- これにより、Vue の depTrack がスケジューラのホットループに入り込まず、ジッタが出ない。

### 発音ロジック

各トラックは独立した `trackState[j]` を持つ：`step`（現在位置）、`nextTime`（次のノートの AudioContext 時刻）。
`nextTime <= ctx.currentTime + LOOKAHEAD` の間、`step` 位置のノートを発火し `step++` / `nextTime += stepDur`。

### Pending キュー

`pendingRaw.current[j]: Pending[]` はトラック `j` に予約された拍子変更の列。各 Pending は `{ timeSig: "n/d" }`。

**適用タイミング**：`step` が `trk.steps.length` に達した瞬間（＝ループ境界）に `applyPending(j)` を呼ぶ。ここで `steps` を差し替え、`step = 0` にリセット。これで拍子変更が常にループの頭で揃う。

### Master Target と R1 リセット

マスター拍子を変更すると `masterTargetRef.current = "n/d"` がセットされる。スケジューラはトラック0のループ境界で `checkMasterTarget()` を呼び、**全トラック** の Pending キューが空で、かつ全トラックの timeSig が target と一致する瞬間を検出する。

一致した瞬間：
1. 全トラックの `step = 0` に強制。
2. 全トラックの `nextTime` を次のダウンビートに揃える。
3. `setTimeout(onMasterReset, 0)` で UI 側に通知（MIDI パニック＋フラッシュ＋スナップショット再適用）。

これが convergence sync — ポリメーターの位相ズレを一度リセットしてクリーンな 1拍目から再出発させる仕組み。

## 3. Track モデル

```ts
interface Track {
  id: number
  name: string
  timeSig: string           // "n/d" — 現在鳴っている拍子
  mode: 'instant' | 'transition'
  color: string
  steps: boolean[]          // 現在の可視パターン（長さ = stepCount(n,d)）
  stepsSource: boolean[]    // 正準パターン（縮めた tail を失わないために保持）
  mute: boolean
  solo: boolean
  midiChannel: number
  midiNote: number
}
```

### `steps` vs `stepsSource`

拍子変更でステップ数が変わる時、ユーザーが打ち込んだ後ろのビートを失わないための二重化。

- `stepsSource` はユーザーの編集を反映する正準パターン。**縮めても切り落とさない**。
- `steps` は再生用。`stepsSource.slice(0, stepCount)` の可視版。
- セルをトグルすると `steps[i]` と `stepsSource[i]` の **両方** が更新される。

### `deriveStepsFromSource(source, newLen, n, d)`

拍子変更時にこの関数で新しい `steps` を決める：

1. **`n === 0`**: サイレント・バー。`source` は触らず、全 false を返す（drop の後に元拍子へ戻すとグルーヴが復活する）。
2. **縮小（`newLen <= source.length`）**: `source.slice(0, newLen)`。`source` は不変なので、後で広げた時に tail が蘇る。
3. **拡大（`newLen > source.length`）**: 密度適応。
   - `tooShort = source.length < beat`（beat = `round(16/d)`）
   - `tooDense = density ≥ 0.5`
   - いずれか true → **ビート骨格で埋める**（`i % beat === 0`）。連打を防ぐ。
   - それ以外 → **タイリング**（`source[i % source.length]`）。元のグルーヴを反復。
   - 拡大結果は `stepsSource` に昇格（これが次の縮小基準になる）。

## 4. Per-track モード

- **Instant**: ツマミで拍子を変えた瞬間にキューに追加。次のループ境界で切り替わる。
- **Transition**: ブリッジ小節（(n,d) を現在→目標に線形補間したメーター）を 1 or 2 小節挟んで切り替わる。

`generateBridge(fromSig, toSig, bars)` が `bridgeMeter()` を使い中間メーターを計算。出力 Pending を Pending キューに順次積む。

## 5. Master 制御 (`pages/index.vue`)

### INSTANT vs TRANSITION

- **INSTANT**: MASTER のツマミを回した瞬間 `onMasterKnobChange` が `commitMaster()` を呼ぶ。ツマミ＝即時反映。
- **TRANSITION**: ツマミは値を stage するだけ。`APPLY →` ボタンを押して初めて `commitMaster()` が走る。ツマミを掃くだけでは誤発火しない。

### `commitMaster` の流れ

1. `masterStepsSnapshot = tracks.map(t => [...t.stepsSource])` を取る（**リセット後に使う** 正準パターンのスナップショット）。
2. 各トラックの Pending キューを組み立てる：
   - transition mode → `generateBridge` + target Pending
   - instant mode → target Pending のみ
3. `masterTargetRef.current = "n/d"` を立てる（UI は "CONVERGING →" 表示、R1 待ち）。

### `handleMasterReset` （R1 が発火した時）

`masterStepsSnapshot` を元に **`autoPreset` ではなく** `deriveStepsFromSource(snapshot[j], newLen, n, d)` を各トラックに適用する。これでユーザーの groove は保たれ、拍子だけが新しい `n/d` に再適合する。

さらに MIDI All Notes Off（パニック）＋ 画面フラッシュ 1フレームで「reset が起きた」ことを体感的に示す。

### 調整中オーバーレイ

`masterTarget` が立っている間（= ブリッジ小節が走っている間）は、画面中央に
「調整中 / ADJUSTING — BRIDGE BARS — TARGET n/d」のオーバーレイが出る。
`pointer-events-none` で操作は遮らず、`position: fixed` + `z-[50]` で全ビューに
オーバーレイ（GRID / RING どちらでも）。トップバーの下ボーダーも
`masterTarget` 有無で `#1a1a1a → #ff660044` に切り替わり、どの画面からでも
ブリッジ中だと視認できる。ブリッジ中のリズムは意図的に不安定で「面白さの核心」
なので、通常再生と混同されないことが重要。

## 6. MeterKnob (`components/MeterKnob.vue`)

回転ツマミ。離散値配列 `options` から1つ選ぶ。

**重要**：内部 state `localIdx` を持ち、ドラッグ中の視覚変化を即反映する。コミット（= `emit('update:modelValue')` と `emit('change')`）は pointerup / wheel settle / key release のみ。親は `@change` だけ受けても良い（`v-model` 必須ではない）。

- ドラッグ中は `props.modelValue` の watch を無視（ユーザーのジェスチャと戦わないため）。
- ドラッグしていない時だけ、親から `modelValue` が変わった場合に `localIdx` を再同期。

相互作用：
- 垂直ドラッグ: 上 = 増加、8px/step。
- マウスホイール: 上 = 増加、180ms 静止で settle → commit。
- キーボード: ArrowUp/Right / Down/Left（即 commit）。

## 7. UI レイアウト

- ルート: `h-screen flex flex-col overflow-hidden`（ページ全体がビューポート高にフィット）。
- ヘッダー行: POLYMETER トランスポートと MASTER 設定を同一行に統合。MASTER が左側（各トラックの LEFT コントロール列と視覚軸を揃える）、PLAY/BPM/AUDIO/MIDI は `ml-auto` で右側に押し出す。
- トラック群コンテナ: `flex-1 flex flex-col gap-1.5 min-h-0`。8 行が `flex-1` で均等分割。
- 各トラック行: 左に固定幅コントロール（ツマミ・モード・M/S/✕・CH/N）、右に `flex-1` のステップグリッド。
- ステップグリッド:
  - `gridTemplateColumns: repeat(16, minmax(0, 1fr))`（幅いっぱい、横長の長方形セル）。
  - `gridAutoRows: minmax(0, 1fr)` + `maxHeight = ceil(len/16) × ROW_MAX(=22)px`。
  - 通常（1行）は 22px で固定、周囲余白を `items-center` で活用。ステップが折り返して複数行になる場合は `maxHeight` と トラック高の小さい方に収まるよう 1fr が均等割りで縮む。

## 8. 定数・チューニング

| 定数 | 値 | 場所 |
|------|----|------|
| `LOOKAHEAD` | 100ms | `useScheduler.ts` |
| `TICK` | 25ms | `useScheduler.ts` |
| `DRAG_PX` | 8 | `MeterKnob.vue` |
| Wheel settle | 180ms | `MeterKnob.vue` |
| `NUM_OPTS` | 0..16 | `pages/index.vue` |
| `DEN_OPTS` | `[4, 8, 16]` | `pages/index.vue` |
| Bridge denominators | `{4, 6, 8, 12, 16}` | `useScheduler.ts` |
| `ROW_MAX` | 22px | `pages/index.vue` |
| Density threshold | 0.5 | `useScheduler.ts` (`deriveStepsFromSource`) |

## 9. MIDI IN — Transpose / Sync / Mapping

外部 MIDI キーボード・コントローラからの入力。3つの機能を持つ：

### Transpose（移調）
グローバルな **semitone オフセット**。ベースノート C4 (= MIDI note 60) を基準に、そこからの差分を保持する。全トラックの MIDI note output に加算される。
- MIDI ノートを受信 → note - 60 = offset に設定。
- 例：D4 (62) を弾く → offset = +2 (全ノートが2半音高くなる)。
- Mapping に登録されていないノートは自動的に transpose を設定する。

### MIDI Clock Sync（テンポ同期）
外部 MIDI クロック（0xF8、24 PPQN）に従う。SYNC モード有効時：
- 受信した clock pulse を数え、`6 pulses = 1 sixteenth-note` で計算。
- BPM を clock interval から推定し `bpmRaw` を更新。
- 0xFA (Start) / 0xFC (Stop) で再生制御可（将来実装）。

### Mapping（CC / Note → Control）
外部コントローラのボタン / つまみを任意の内部コントロール（BPM、Master N/D、各トラック設定など）に割り当てる。

**Learn mode**: SAVE CFG / LOAD CFG 横の「LEARN」ボタンを押す → "waiting for MIDI..." → CC/note を受信すると自動記録。

**保存形式**:
```json
{
  "mappings": [
    { "controlId": "tempo", "type": "cc", "channel": 1, "number": 7 },
    { "controlId": "masterN", "type": "note", "channel": 1, "number": 60 }
  ],
  "transpose": 0,
  "syncMode": "internal"
}
```

**Persistent**: ダウンロード / ロード機能で JSON ファイルとして保存・復元可能。

## 10. 既知の制約

- MIDI OUT は Web MIDI API 対応ブラウザ限定（Chromium 系）。
- AudioContext はユーザー・ジェスチャ後にのみ作成・再開される。
- `n = 16, d = 4` の場合ステップ数は 64 に達し、16列グリッドだと 4 行折り返す。画面が低い場合はセルが小さくなる（それでも `minmax(0, 1fr)` で収まる）。
- Master reset は「全トラック target 一致」が同時発生した瞬間にしか撃たないので、transition 中に個別トラックの拍子を手動で変えると convergence が遅延 or 永久待機になる可能性がある。
