<template>
  <!--
    StepSequencer — 汎用ステップバー表示
    再利用可能: 詳細パネル / RING VIEW 右パネル などに埋め込む

    Props:
      track   — Track オブジェクト（steps, color, mute を使用）
      head    — 現在の再生位置 (-1 = 停止中)
      cellH   — セルの高さ px (デフォルト 56)
      maxCellW — セル最大幅 px (デフォルト 36)
    Emits:
      toggle(stepIndex) — セルクリック
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
        boxShadow: head === si ? `0 0 0 1.5px ${track.color}88` : 'none',
        opacity: track.mute ? 0.3 : 1,
        transition: 'background 0.06s',
      }"
      @click="$emit('toggle', si)"
    >
      <!-- ヒットフラッシュ -->
      <div
        v-if="head === si && active"
        class="absolute inset-0 rounded-[2px] pointer-events-none"
        :style="{ background: track.color, opacity: 0.35 }"
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
}>(), {
  cellH: 56,
  maxCellW: 36,
})

defineEmits<{
  toggle: [stepIndex: number]
}>()

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
