// The phone app's service worker. It does one job: show Greg's reminders as
// notifications when they arrive, even with the app closed and the phone
// locked. The message comes encrypted from Greg's PC through the phone's push
// service (lib/webpush.js); the browser has already decrypted it by the time
// it gets here.
//
// Deliberately caches nothing. Greg is only useful when the PC can be reached,
// and a stale copy of this page would only make "the PC is off" harder to see.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(message.title || "Greg", {
      body: message.body || "",
      // One notification per reminder: a repeat of the same one replaces it.
      tag: message.tag || undefined,
      icon: "icon-192.png",
      badge: "icon-192.png",
      requireInteraction: true,
    })
  );
});

// Tapping it opens the app, or brings it forward if it is already open.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const app = open.find((client) => new URL(client.url).pathname.startsWith("/phone/"));
      if (app) return app.focus();
      return self.clients.openWindow("/phone/");
    })()
  );
});
