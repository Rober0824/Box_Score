// Service worker de Box Score: solo se encarga de mostrar notificaciones push.
self.addEventListener('install', function(event){
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function(event){
  var data = {};
  try{
    data = event.data ? event.data.json() : {};
  }catch(e){
    data = { title: 'Box Score', body: event.data ? event.data.text() : '' };
  }
  var title = data.title || 'Box Score';
  var options = {
    body: data.body || '',
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    data: { url: data.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList){
      for(var i=0; i<clientList.length; i++){
        var client = clientList[i];
        if('focus' in client){
          try{ client.navigate(url); }catch(e){}
          return client.focus();
        }
      }
      if(self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
