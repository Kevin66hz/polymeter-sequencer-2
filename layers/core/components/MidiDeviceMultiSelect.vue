<script setup lang="ts">
// Compact multi-select for MIDI devices (used for both IN and OUT lists).
//
// UI layout: a small trigger button showing the selected count
// (e.g. "2 Devices") that opens a checkbox list of every available device.
// Replaces the earlier select+chips form — checkboxes make the current
// selection state visible at a glance and scale better when the user wants
// to toggle several at once.
//
// For MIDI IN we also want to designate one of the selected inputs as the
// clock source (since mixing 0xF8 pulses from two masters would corrupt the
// BPM estimate). When `clockSource` is non-undefined each row gets a small
// `◷` button; clicking it promotes that device to clock source.
//
// Props are intentionally dumb: the parent owns selection + clock-source
// state. This component just emits intents.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

interface Device {
  id: string
  name: string
}

const props = withDefaults(defineProps<{
  label: string
  devices: readonly Device[]
  selectedIds: readonly string[]
  // Pass a string (or null for "none") to enable the clock-source picker
  // (MIDI IN side). Leave undefined to hide the marker (MIDI OUT side).
  clockSource?: string | null
  // Optional predicate for "this device has a bundled template
  // (mapping preset) that will auto-apply on connect". When it
  // returns true the row renders a small ○ before the name so the
  // user can tell a device comes pre-mapped without opening a
  // separate menu. Leave undefined to hide the indicator entirely
  // (e.g. the MIDI OUT list, which doesn't load mappings).
  hasPreset?: (deviceName: string) => boolean
  disabled?: boolean
  supportedLabel?: string
  truncate?: number
}>(), {
  clockSource: undefined,
  hasPreset: undefined,
  disabled: false,
  supportedLabel: 'unsupported',
  truncate: 18,
})

const emit = defineEmits<{
  (e: 'toggle', id: string): void
  (e: 'setClockSource', id: string | null): void
  // Fires when the user clicks the ○ template indicator. Parent is
  // expected to force-apply the bundled template for this device (the
  // auto-apply watcher is best-effort and can miss when the device was
  // already present before the store mounted).
  (e: 'applyPreset', id: string, name: string): void
}>()

const trunc = (name: string) => {
  if (!name) return ''
  return name.length > props.truncate ? name.slice(0, props.truncate - 1) + '…' : name
}

const selectedSet = computed(() => new Set(props.selectedIds))
const isSelected = (id: string) => selectedSet.value.has(id)

// Count for the trigger button. English pluralization is fine here —
// the surrounding UI is already mostly English technical jargon.
const countLabel = computed(() => {
  const n = props.selectedIds.length
  return n === 1 ? '1 Device' : `${n} Devices`
})

const showClockPicker = computed(() => props.clockSource !== undefined)

// Popover open/close. Click-outside + Escape close it, mirroring the
// other popovers in this app (KitSave / PresetMenu etc).
const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

const onDocClick = (e: MouseEvent) => {
  if (!open.value) return
  const root = rootEl.value
  if (!root) return
  if (!root.contains(e.target as Node)) open.value = false
}
const onDocKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') open.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onDocKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onDocKey)
})
</script>

<template>
  <div ref="rootEl" class="relative flex items-center gap-1.5">
    <span class="text-[10px] text-[#444]">{{ label }}</span>

    <!-- Unsupported state: render a short hint and nothing else. -->
    <span v-if="disabled" class="text-[10px] text-[#555]">{{ supportedLabel }}</span>

    <template v-else>
      <!-- Trigger button — shows the current count; click to open the
           checkbox list. -->
      <button
        class="text-[10px] px-2 py-[2px] border rounded-sm tabular-nums inline-flex items-center gap-1"
        :class="selectedIds.length > 0
          ? 'bg-[#1a1a1a] text-[#ccc] border-[#333]'
          : 'bg-transparent text-[#666] border-[#2a2a2a] hover:text-[#aaa]'"
        :title="devices.length === 0 ? 'No MIDI devices detected' : `${selectedIds.length} selected / ${devices.length} available`"
        :disabled="devices.length === 0 && selectedIds.length === 0"
        @click="open = !open">
        <span>{{ devices.length === 0 && selectedIds.length === 0 ? '— no device —' : countLabel }}</span>
        <span class="text-[8px] text-[#555]">{{ open ? '▴' : '▾' }}</span>
      </button>

      <!-- Popover list. Absolute-positioned beneath the trigger so it
           doesn't push the toolbar around. Width adapts to longest name
           via min/max-w. -->
      <div v-if="open"
        class="absolute top-full left-0 mt-1 z-50 bg-[#0f0f0f] border border-[#2a2a2a] rounded-sm shadow-lg min-w-[200px] max-w-[360px] max-h-[280px] overflow-y-auto">
        <!-- Empty state (device list empty). -->
        <div v-if="devices.length === 0"
          class="text-[10px] text-[#555] px-2 py-1.5">
          — no device —
        </div>

        <!-- Device rows with checkboxes. -->
        <label v-for="d in devices" :key="d.id"
          class="flex items-center gap-2 px-2 py-1 text-[10px] cursor-pointer hover:bg-[#1a1a1a] select-none"
          :class="isSelected(d.id) ? 'text-[#ddd]' : 'text-[#888]'"
          :title="d.name">
          <!-- Native checkbox. Styled to be subtle on the dark theme. -->
          <input type="checkbox"
            class="accent-[#88aaee] cursor-pointer"
            :checked="isSelected(d.id)"
            @change="emit('toggle', d.id)" />

          <!-- Template indicator. ○ marks a device that has a bundled
               mapping template — handy for users who reconnect their
               default controller and want to see "oh right, that one's
               pre-mapped" at a glance. Shown only when `hasPreset` is
               wired up by the parent. Now also clickable: presses emit
               `applyPreset` so the parent can force-apply the template
               when auto-apply didn't fire (race on cold-boot, reset,
               etc.). Stop propagation so clicking ○ doesn't toggle the
               row's checkbox. -->
          <button v-if="hasPreset && hasPreset(d.name)"
            class="text-[10px] leading-none text-[#9acb9a] hover:text-[#c0f0c0] px-[2px] rounded-sm"
            title="Bundled template available — click to apply now"
            @click.stop.prevent="emit('applyPreset', d.id, d.name)">○</button>

          <span class="flex-1 truncate">{{ trunc(d.name) }}</span>

          <!-- Clock-source marker (IN side only). Shown on every row, but
               only lit on the active one. Disabled on unselected devices
               since the clock source has to be a selected device. -->
          <button v-if="showClockPicker"
            class="text-[10px] leading-none px-1 rounded-sm"
            :class="clockSource === d.id
              ? 'text-[#9acb9a] bg-[#1a2a1a] border border-[#3a6a3a]'
              : (isSelected(d.id)
                ? 'text-[#666] hover:text-[#9acb9a] border border-transparent'
                : 'text-[#333] border border-transparent cursor-not-allowed')"
            :title="!isSelected(d.id)
              ? 'Select this device first to use it as clock source'
              : (clockSource === d.id
                ? 'Clock source (active)'
                : 'Click to use as clock source')"
            :disabled="!isSelected(d.id)"
            @click.stop.prevent="isSelected(d.id) && emit('setClockSource', d.id)">
            ◷
          </button>
        </label>
      </div>
    </template>
  </div>
</template>
