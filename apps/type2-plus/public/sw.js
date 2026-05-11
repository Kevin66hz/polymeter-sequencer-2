// Self-unregistering Service Worker.
//
// Type2Plus は PWA / Service Worker を使わない構成だが、過去に登録された
// SW がブラウザに残っていると、開くたびに `/sw.js` を更新チェックしに来て
// Vue Router が「No match found for /sw.js」を警告する。
//
// この空 SW は、インストール直後に自分自身を unregister し、開いている
// クライアントを reload して綺麗な状態に戻す役割だけを持つ。
// 充分な期間（数週間〜）が経って警告が出なくなったら、このファイル自体を
// 削除して構わない。

self.addEventListener('install', () => {
  // 既存の旧SWに譲らず即座に置き換わる
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        // キャッシュも掃除しておく（旧SWが残していた可能性に備えて）
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      } catch {
        // ignore
      }

      // 自分自身を登録解除
      try {
        await self.registration.unregister()
      } catch {
        // ignore
      }

      // 開いているタブを reload して、SWなしの状態に戻す
      try {
        const clients = await self.clients.matchAll({ type: 'window' })
        for (const client of clients) {
          client.navigate(client.url)
        }
      } catch {
        // ignore
      }
    })()
  )
})
