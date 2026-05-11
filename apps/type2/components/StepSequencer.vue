<template>
  <!--
    StepSequencer — 汎用ステップバー表示
    再利用可能: 詳細パネル / RING VIEW 右パネル などに埋め込む

    Props:
      track      — Track オブジェクト（steps, color, mute, stepNotes を使用）
      head       — 現在の再生位置 (-1 = 停止中)
      cellH      — セルの高さ px (デフォルト 56)
      maxCellW   — セル最大幅 px (デフォルト 36)
      editMode   — true なら toggle ではなく select を emit (per-step note editor 用)
      selectedIdx— editMode 時にハイライトする選択セル
    Emits:
      toggle(stepIndex) — セルクリック (通常時)
      select(stepIndex) — セルクリック (editMode 時)

    Per-step override indicator:
      `track.stepNotes[si]` が null でない場合、右上に小さな dot を描画。
      これでユーザーは「どのステップに override が付いているか」を一目で把握できる。
      stepNotes 自体が undefined のトラック（feature 未使用）は dot が一切出ない。
  -->
  <div
    class="step-sequencer flex gap-[2px] w-full overflow-hidden"
    :style="{ height: `${cellH}px` }"
  >
    <div
      v-for="(active, si) in track.steps"
      :key="si"
      class="step-cell rounded-[2px] cursor-pointer flex-1 relative overflow-hidden"
      :style="{
        maxWidth: `${maxCellW}px`,
        background: stepBg(active, si),
        boxShadow: selectedIdx === si
          ? `0 0 0 2px ${track.color}`
          : head === si ? `0 0 0 1.5px ${track.color}88` : 'none',
        opacity: track.mute ? 0.3 : 1,
        transition: 'background 0.06s',
      }"
      @click="onClick(si)"
    >
      <!-- ヒットフラッシュ -->
      <div
        v-if="head === si && active"
        class="absolute inset-0 rounded-[2px] pointer-events-none"
        :style="{ background: track.color, opacity: 0.35 }"
      />
      <!-- Per-step override インジケーター (右上の小ドット) -->
      <div
        v-if="hasOverride(si)"
        class="absolute top-[2px] right-[2px] pointer-events-none rounded-full"
        style="width: 4px; height: 4px;"
        :style="{ background: '#ffcc55', boxShadow: '0 0 3px #ffcc5599' }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Track } from '~/composables/useScheduler'

const props = withDefaults(defineProps<{
  track: Track
  head: number
  cellH?: number
  maxCellW?: number
  editMode?: boolean
  selectedIdx?: number | null
}>(), {
  cellH: 56,
  maxCellW: 36,
  editMode: false,
  selectedIdx: null,
})

const emit = defineEmits<{
  toggle: [stepIndex: number]
  select: [stepIndex: number]
}>()

function onClick(si: number) {
  if (props.editMode) emit('select', si)
  else emit('toggle', si)
}

function hasOverride(si: number): boolean {
  // `stepNotes` may be undefined (common case — feature unused).
  // Optional-chain keeps this branchless and cheap per cell.
  return !!props.track.stepNotes?.[si]
}

function stepBg(active: boolean, si: number) {
  if (active) {
    // アクティブ: 再生中なら明るく
    return props.head === si
      ? props.track.color
      : props.track.color + 'bb'
  }
  // 非アクティブ
  return props.head === si ? '#2c2c2c' : '#181818'
}
</script>

<style scoped>
.step-cell {
  min-width: 6px;
}
</style>
