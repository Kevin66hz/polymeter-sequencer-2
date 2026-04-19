// Scheduler timer worker.
//
// This worker runs setInterval in a dedicated thread so the 25ms tick
// is not throttled by main-thread activity (Vue reactive updates, GC
// pauses, layout/paint). The tick() function itself still executes on
// the main thread (AudioContext is not accessible from workers), but
// the interval fires from here and postMessage delivers the prompt.
//
// Protocol (all messages are plain numbers):
//   main → worker:  25      start ticking every 25ms
//   main → worker:  0       stop ticking
//   worker → main:  0       tick pulse

let timerId: ReturnType<typeof setInterval> | null = null

self.onmessage = (e: MessageEvent<number>) => {
  const intervalMs = e.data
  if (timerId !== null) {
    clearInterval(timerId)
    timerId = null
  }
  if (intervalMs > 0) {
    timerId = setInterval(() => self.postMessage(0), intervalMs)
  }
}
