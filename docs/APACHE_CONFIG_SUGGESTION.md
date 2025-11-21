# Apache Configuration for Socket.IO with WebSocket Support

The `ConnectFailed: Error: Server responded with a non-101 status: 404 Not Found` error happens when the WebSocket upgrade request fails or the client falls back to polling and gets rejected by the server.

I have updated `src/app/socket/redis-io.adapter.ts` to allow both `polling` and `websocket` transports. This should fix the immediate connection error.

## Improved Apache Configuration

For best performance and reliability, ensure your Apache configuration properly handles WebSocket upgrades.

### Recommended VirtualHost Configuration

```apache
<VirtualHost *:443>
    ServerName jio20session.codeholic.in

    # SSL Configuration
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/jio20session.codeholic.in/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/jio20session.codeholic.in/privkey.pem
    Include /etc/letsencrypt/options-ssl-apache.conf

    ProxyPreserveHost On
    ProxyRequests Off
    RequestHeader set X-Forwarded-Proto "https"
    ProxyTimeout 3600

    # WebSocket Support (Requires mod_rewrite and mod_proxy_wstunnel)
    RewriteEngine On
    # Check for WebSocket upgrade header
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*)           ws://127.0.0.1:9000/$1 [P,L]

    # Socket.IO path handling
    ProxyPass        /socket.io/ http://127.0.0.1:9000/socket.io/ retry=0 timeout=3600
    ProxyPassReverse /socket.io/ http://127.0.0.1:9000/socket.io/

    # All other traffic → Fastify app
    ProxyPass        / http://127.0.0.1:9000/
    ProxyPassReverse / http://127.0.0.1:9000/

    <IfModule mod_headers.c>
        Header always set X-Content-Type-Options "nosniff"
        Header always set X-Frame-Options "SAMEORIGIN"
        Header always set X-XSS-Protection "1; mode=block"
        Header always set Referrer-Policy "no-referrer"
    </IfModule>

    ErrorLog ${APACHE_LOG_DIR}/jio20session_error.log
    CustomLog ${APACHE_LOG_DIR}/jio20session_access.log combined
</VirtualHost>
```

### Steps to Apply

1.  Enable required modules:
    ```bash
    sudo a2enmod rewrite proxy proxy_http proxy_wstunnel headers
    ```
2.  Update your site config file (e.g., `/etc/apache2/sites-available/your-site.conf`).
3.  Restart Apache:
    ```bash
    sudo systemctl restart apache2
    ```

## Client-Side Connection

Ensure your client connects to the correct namespace:

```javascript
// The server listens on path /socket.io/ (default)
// But handles the namespace /ws/v1/session/
const socket = io('https://jio20session.codeholic.in/ws/v1/session/', {
  transports: ['websocket', 'polling'], // Recommended: try websocket, fallback to polling
});
```
