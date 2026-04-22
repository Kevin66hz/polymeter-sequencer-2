# IBK — Polymeter Sequencer

Nuxt 3 + Tailwind CSS v3 製の **16 トラック・ポリメトリック・ステップシーケンサー**。
各トラックが独立した拍子（4/4, 7/8, 9/8, 11/8, 13/8 …）を持ち、ループ末尾で拍子変更を
反映するポリメーター構造。音声は Web Audio API の look-ahead スケジューラ
（lookahead 100ms / tick 25ms）でサンプル精度で再生し、Web MIDI 経由で
外部機器へも同時にノートを送出する。

共通コアの上に **複数の UI バリアント** を同居させる apps-split 構造:

- **Type2**（無印） … シンプル RING + GRID。軽量、モバイル OK。
- **Type2Plus** … RING をリッチ化した拡張版。デスクトップ推奨。
  GRID / RING（静的 SVG + Canvas 動的レイヤ）に加えて **STAR**（Three.js
  入れ子球体）と **SOLAR**（トラックごとの楕円軌道）の 3D ビューを搭載。
  グラフィック／ビジュアル表現のアップグレードに特化し、コア機能は Type2
  と完全共有。

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
│       ├── composables/            useSequencerStore / useMidi / useMidiIn / useNoteRepeat / usePatternPresets
│       ├── components/             MeterKnob / StepCell / PresetMenu / PatternPicker
│       └── public/patterns/        kit & line プリセット（index.json + kits/*.json + lines/*.json）
├── apps/
│   ├── type2/                   ← 無印 Type2
│   │   ├── nuxt.config.ts          extends: ['../../layers/core']
│   │   ├── pages/index.vue         薄いビュー (store を consume)
│   │   ├── components/             CircularTrack / ConcentricView / StepSequencer
│   │   └── ...
│   └── type2-plus/              ← デラックス版（3D ビュー搭載）
│       ├── components/             CircularTrack / ConcentricView / ConcentricViewPlus /
│       │                           RingsStatic / RingsOverlay / ConcentricView3D / SolarView /
│       │                           StepSequencer + rings-geom.ts
│       └── ...
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
- **STAR**（Plus のみ）：Three.js による入れ子球体ビュー。各トラックが球殻で、
  ON ステップは経度方向の大円線（meridian）として描画される。現ステップの経線が
  毎フレーム最大輝度にブーストされ、次の経線へとスポットライトのように移動する。
- **SOLAR**（Plus のみ）：トラックごとの「1 星系」楕円軌道ビュー。拍子が straight
  （4/4）なら円、奇数拍子（7/8 / 5/4 / 13/16 等）なら比例した離心率の楕円に。
  軌道の大きさは active beat 数の逆数でスケール（`orbitR = a / K`）し、
  K=1 なら太陽を囲む大きな軌道、K=4 ならトリガ側に小さくまとまる。

3D ビューはすべて `<ClientOnly>` 配下でマウント。Three.js の import は `onMounted`
内で動的に呼ばれ、RAF ループは Vue リアクティブを一切触らず `displayHeads` /
`tracksRaw` の raw ミラーだけを読む（スケジューラと同じ hot-loop 分離規則）。

### 再生と遷移

- **INSTANT モード**：拍子を変えたら次のループ境界で即座に切替
- **TRANSITION モード**：`generateBridge` が中間メーターを 1〜2 小節挟み、滑らかに補間
- トラック単位でも、マスターでもそれぞれ INST / TRANS を選べる
- MASTER の APPLY は TRANSITION 時だけ有効（ツマミは stage のみ）
- **調整中オーバーレイ**：マスター遷移が進行中（`masterTarget` が立っている間＝ブリッジ小節）は
  画面中央に大きく「調整中」と表示し、トップバーのボーダーもオレンジに点灯。
  ブリッジ中のリズムは意図的に予測不能で「面白さの核心」なので、
  通常の再生状態と視覚的にはっきり区別できるよう常時表示される。
- **convergence sync (R1)**：全トラックがマスター target に揃った瞬間、全トラックの
  `step = 0` に強制、MIDI パニック、フラッシュ、スナップショット再適用

### パターンスナップショット

- `SNAP SHOT` ボタンで現在の全ステップ・拍子を保存
- `↩ INST` / `↩ TRANS` で呼び戻し。TRANS 側は拍子の違うトラックをブリッジで戻す

### パターンプリセットライブラリ（KIT / LINE）

`layers/core/public/patterns/` 配下にバンドルされた JSON プリセット集。5 ジャンル
（Hip-Hop / House·Techno / Rock·Funk·Jazz / Latin·Afro·World / Electro）× 複数
タイトルを収録し、**kit**（16 トラック丸ごと）と **line**（1 トラック分のスコア）の
2 レイヤで適用できる。

- **KIT PRESET ▾**（トップバー）：ジャンル → キット名で選択。STAGE されて、
  共通 `APPLY` ボタンで確定。TRANSITION モード時はブリッジ小節を挟んで切り替わる。
- **KIT SAVE / LOAD**：現在の 16 トラック状態を JSON として保存／復元。SAVE は
  スケジューラを止めないノンブロッキング popover（`window.prompt()` は look-ahead を
  停滞させるので使わない）。LOAD は STAGE のみ行い、APPLY で確定。
- **LINE ▾**（各トラック行のトラック名横の `▾` ボタン）：そのトラックのロール
  （KICK / SNARE / HAT / CLAP / BASS …）にマッチしたラインだけを提示し、単独で差し替え。
- **APPLY ボタンの優先順位**：`masterTarget` 進行中 > staged kit > 通常 master N/D。

### 統合 APPLY

マスター拍子遷移とキット適用で同じ `APPLY` ボタンを共有する。`masterTarget` が
飛んでいる間はロック（`⟳`）、staged kit がある時は `⏎ APPLY`（INSTANT）または
`∿ APPLY`（TRANSITION）表示、どちらも無ければ通常の master コミットとして機能する。

### 再生制御

- BPM 40–240（上段の `BPM ▾` からオーバーレイスライダー）
- PLAY / STOP（アイコン化。Space キーでトグル）
- **REC**（`●`）：MIDI IN + PLAY 中、マッピング未登録かつトラックの
  `(midiChannel, midiNote)` と一致する note-on が来た step に **toggle-record**
  を書き込む。同じ step に 2 回叩くと消せる（セルフ修正 overdub）。
  REC が ON になると、各トラックの下に **手動 REC パッド（● ボタン）** と
  **パターン・シフトボタン（`<` / `>`）** が現れる。REC パッドは現プレイヘッド
  位置に step を toggle-record、シフトボタンは押しっぱなしでパターンを
  右／左に回転（REC 中のみ有効。MIDI CC からも `trackN_shift` として
  バインド可能で、ノブを回すとスクラブ感覚で回せる）。
- **REP**（`⟳` + `1/N`）：DJ-style ビートリピート。ON の間、トリガ位置が
  `round(16/rate)` ステップ窓を内側でループし、実プレイヘッドは黙って進行し続ける。
  OFF にするとトリガが実プレイヘッドに即スナップ。スケジューラ内（`create-scheduler.ts`）
  で trigger step と real step を分離実装しており、マスター遷移や Pending キューは
  real step に紐付くので REP 中でもメーター変更は止まらない。レート: 1/2 → 1/4 → 1/8 → 1/16。
- **ALL MUTE**（`⊘ ALL M`）：全トラックの mute を一括 on/off（**solo-aware**：
  solo が立っているトラックには触れない）
- **AUDIO ON/OFF**（`♪` / `✕`）：Web Audio 内蔵音源の有音／無音切替
  （MIDI OUT は常時送信）。AUDIO OFF のときトラック名の代わりに `ch:note`（例 `1:60`）を表示

### MIDI

- **MIDI OUT**：ブラウザが接続しているデバイスから選択（Web MIDI API 対応ブラウザ限定）。
  デバイス名は長い場合は先頭 12 文字 + `…` に切り詰めて表示し、フル文字列は `title` 属性で参照可能。
- **MIDI IN**：
  - **Clock Sync**：`INT`（内部）／`SYNC`（外部クロック 0xF8, 24 PPQN）。
    BPM 表示は SYNC 時に緑で強調され、外部クロックに従っていることが視認できる。
  - **Mapping**：CC / Note を内部コントロール（BPM、Master N/D、MASTER APPLY、PLAY/STOP 等）へ
    自由に割り当て。`MAP` ボタンをオンにすると各コントロールに learn 用オーバーレイが載り、
    バインディング数バッジも表示される。
  - **Learn**：オーバーレイをクリック→待機状態→次に受信した CC/Note を記録
  - **Note handler precedence**：learn → mapped control → `onNoteIn`。 learn や mapping に
    消費されなかった note-on だけが REC パイプに届くので、transport にバインドしたパッドが
    誤ってステップを書き込むことはない。`onNoteOff` もシンメトリーに提供。
  - **MIDI SAVE / LOAD（v2）**：マッピング + `syncMode` **に加えて、各トラックの MIDI OUT
    設定**（channel / note / velocity / gate）も同一 JSON に同梱してエクスポート／
    インポート。旧形式（mappings + syncMode のみ）とも互換。ステップや拍子は
    KIT SAVE/LOAD 側が扱う。

## 既知の制約

- MIDI は Web MIDI API 対応ブラウザのみ（Chromium 系で動作確認）
- `AudioContext` は最初のユーザージェスチャ後に作成・再開される
- `N = 16, D = 4` だとステップ数が 64 になる。16列折り返しが前提の内部計算を行うので
  RING ビューではセルが小さくなる（`minmax(0, 1fr)` で収まる）
- Master reset は「全トラック target 一致」が同時成立した瞬間にだけ発火する。
  TRANSITION 中に個別トラックの拍子を手動で変えると convergence が遅延する場合がある

## ベータリリースノート

このリリースで整えたポイント（Type2／無印）:

- **調整中オーバーレイ**：マスター遷移のブリッジ小節中、画面中央に大きく
  「調整中」と表示されるようになった。ブリッジ中のリズム不安定さは
  ユニーク機能（詳細は `DESIGN.md`）で、状態遷移を誤解しないためのもの。
- **トップバー整形**：MASTER N/D ノブを少し小さくし（54→48）、`APPLY` ボタンの
  横幅と padding を詰めて 1 行に収まるように。staged kit 名のサブラベルは
  同じ行にあるキットメニュー表示で十分なので `APPLY` 内からは外した
  （フル名は `title` tooltip で参照可能）。
- **REC 行の整列**：REC / MAP 有効時、`M` / `S` / `✕` / `<` / `>` / `●` の
  各ボタンが高さ `17px`・`leading-none` で揃い、行の折返しやステップセルの
  微ズレが起きないように統一した。
- **既知バグ修正**：外部 MIDI クロック時の BPM 表示が稀に停止する件、
  および起動直後にデプロイ済み MIDI プリセットが適用されない競合を解消。

---

<!-- I -->
<!-- B -->
<!-- K -->

*Inspiration By Kensei — [DJ KENSEI](https://www.djkensei.com/)*
*Im Bin Kevin — Bin Ke Vin*
