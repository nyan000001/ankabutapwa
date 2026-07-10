self.addEventListener('push', async (event) => {
	if(!event.data) return;
	const payload = event.data.json();
	self.registration.showNotification(payload.title, { body:payload.body });
});