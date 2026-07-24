self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(clients.claim()));
self.addEventListener("fetch", event => {
	const url = new URL(event.request.url);
	if(event.request.method == 'POST' && url.pathname == '/share') {
		event.respondWith(async event => {
			const clients = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
			if(clients.length) {
				const client = clients[0];
				await client.focus();
				return Response.redirect(client.url, 303);
			}
			return Response.redirect('/', 303);
		});
	}
});
self.addEventListener('fetch', event => event.respondWith(fetch(event.request)));
self.addEventListener('push', event => {
	const { title, body } = event.data.json();
	event.waitUntil(self.registration.showNotification(title, { body }));
});
