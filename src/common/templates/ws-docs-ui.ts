import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

export function registerWsDocsUi(app: NestFastifyApplication): void {
  const fastify: FastifyInstance = app.getHttpAdapter().getInstance();

  fastify.addHook('onSend', async (
    request: FastifyRequest,
    reply: FastifyReply,
    payload: any,
  ) => {
    const url = request.url || '';
    if (url.startsWith('/ws-docs/ui')) {
      try {
        reply.removeHeader('content-security-policy');
        reply.removeHeader('x-frame-options');
      } catch {
        /* noop */
      }
    }

    // Inject a header button into AsyncAPI docs page at /ws-docs
    if (
      (url === '/ws-docs' || url.startsWith('/ws-docs?')) &&
      typeof payload === 'string' &&
      payload.includes('</body>')
    ) {
      try {
        const injection = `\n<style>
  .ws-docs-launch { position: fixed; top: 14px; right: 14px; z-index: 9999; }
  .ws-docs-launch a { text-decoration: none; padding: 8px 12px; border-radius: 8px; border: 1px solid #213051; background: #121b38; color: #e6e8f0; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
  .ws-docs-launch a:hover { background: #203464; }
</style>
<div class="ws-docs-launch"><a href="/ws-docs/ui" title="Open Socket Tester">Open Tester</a></div>`;
        const updated = payload.replace('</body>', `${injection}\n</body>`);
        return updated;
      } catch {
        // fall through with original payload
      }
    }
    return payload;
  });

  fastify.get('/ws-docs/ui', async (req: FastifyRequest, res: FastifyReply) => {
    const xfProto = req.headers['x-forwarded-proto'] as string | undefined;
    const proto =
      xfProto?.split(',')[0]?.trim() || (req.protocol as string) || 'http';
    const host =
      (req.headers['x-forwarded-host'] as string | undefined) ||
      req.headers.host ||
      'localhost:9000';
    const origin = `${proto}://${host}`;
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WebSocket Tester • Socket.IO</title>
    <style>
      html,body{height:100%}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0b1020;color:#e6e8f0}
      .container{max-width:1100px;margin:0 auto;padding:24px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
      .card{background:#121b38;border:1px solid #213051;border-radius:12px;padding:16px}
      input,select,textarea,button{width:100%;padding:10px;border-radius:8px;border:1px solid #213051;background:#0f1630;color:#e6e8f0}
      textarea{min-height:140px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace}
      label{display:block;margin:8px 0 6px 4px;font-size:12px;opacity:.9}
      .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .btn{cursor:pointer;border:1px solid #38507f;background:#1a2a52}
      .btn:hover{background:#203464}
      .log{height:320px;overflow:auto;background:#0a1126;border-radius:8px;border:1px solid #213051;padding:10px;white-space:pre-wrap}
      .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#22365e;margin-right:6px;font-size:12px}
    </style>
    <script src="https://cdn.socket.io/4.8.1/socket.io.min.js" integrity="sha384-7gP+u8nOe+QyX1yJvZ7fQ4Zf0I3r1U7sM1pEydjYtY8n8VxXqZx7GQZi7E9O2YqI" crossorigin="anonymous"></script>
  </head>
  <body>
    <div class="container">
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        <a href="/ws-docs" style="text-decoration:none;padding:8px 12px;border-radius:8px;border:1px solid #213051;background:#121b38;color:#e6e8f0">Back to Docs</a>
      </div>
      <h2>WebSocket Tester <span class="pill">Socket.IO</span></h2>
      <div class="grid">
        <div class="card">
          <label>Server URL</label>
          <input id="url" value="${origin}" />
          <div class="row">
            <div>
              <label>Namespace</label>
              <input id="ns" value="/ws" />
            </div>
            <div>
              <label>Auth (JSON)</label>
              <input id="auth" placeholder='{"token":"..."}' />
            </div>
          </div>
          <div class="row" style="margin-top:10px">
            <button id="connect" class="btn">Connect</button>
            <button id="disconnect" class="btn">Disconnect</button>
          </div>
          <hr style="border-color:#213051;margin:16px 0" />
          <label>Event</label>
          <div class="row">
            <select id="eventSelect"></select>
            <input id="event" placeholder="custom:event" />
          </div>
          <label style="margin-top:10px">Payload (JSON)</label>
          <textarea id="payload" placeholder='{"hello":"world"}'></textarea>
          <div class="row" style="margin-top:10px">
            <button id="emit" class="btn">Emit</button>
            <button id="subscribe" class="btn">Subscribe</button>
          </div>
        </div>
        <div class="card">
          <label>Log</label>
          <div id="log" class="log"></div>
        </div>
      </div>
    </div>
    <script>
      const log = (msg, data) => {
        const el = document.getElementById('log');
        const time = new Date().toISOString().replace('T',' ').replace('Z','');
        el.textContent += '[' + time + '] ' + msg + (data!==undefined? ' ' + JSON.stringify(data, null, 2): '') + '\n';
        el.scrollTop = el.scrollHeight;
      };

      // Try to load AsyncAPI JSON to prefill channels
      async function loadChannels() {
        const select = document.getElementById('eventSelect');
        select.innerHTML = '';
        const candidates = ['/ws-docs-json','/ws-docs/json','/ws-docs?format=json'];
        for (const path of candidates) {
          try {
            const res = await fetch(path);
            if (!res.ok) continue;
            const doc = await res.json();
            const channels = (doc.channels and Object.keys(doc.channels)) || [];
            const defaults = ['connection','ping','session.join','session.joined'];
            const items = Array.from(new Set([...defaults, ...channels]));
            for (const ch of items) {
              const opt = document.createElement('option');
              opt.value = ch; opt.textContent = ch; select.appendChild(opt);
            }
            return;
          } catch {}
        }
        // Fallback
        for (const ch of ['connection','ping']) {
          const opt = document.createElement('option');
          opt.value = ch; opt.textContent = ch; select.appendChild(opt);
        }
      }

      let socket = null;

      document.getElementById('connect').onclick = () => {
        const urlEl = document.getElementById('url');
        let base = urlEl.value;
        if (typeof base === 'string' and base.endsWith('/')) base = base.slice(0, -1);
        const ns = document.getElementById('ns').value || '/ws';
        let auth = {};
        try { auth = JSON.parse(document.getElementById('auth').value || '{}'); } catch {}
        if (socket and socket.connected) socket.disconnect();
        socket = io(base + ns, { transports: ['websocket','polling'], auth });
        socket.on('connect', () => log('connected', { id: socket.id }));
        socket.on('disconnect', (reason) => log('disconnected', { reason }));
        socket.onAny((event, ...args) => log('event: ' + event, args.length === 1 ? args[0] : args));
      };

      document.getElementById('disconnect').onclick = () => {
        if (socket) socket.disconnect();
      };

      document.getElementById('emit').onclick = () => {
        if (!socket || !socket.connected) return log('not connected');
        const evSel = document.getElementById('eventSelect').value;
        const ev = document.getElementById('event').value || evSel || 'ping';
        let data = undefined;
        const raw = document.getElementById('payload').value.trim();
        if (raw) { try { data = JSON.parse(raw); } catch { return log('invalid JSON payload'); } }
        if (data === undefined) socket.emit(ev);
        else socket.emit(ev, data);
        log('emit: ' + ev, data);
      };

      document.getElementById('subscribe').onclick = () => {
        if (!socket) return log('not connected');
        const evSel = document.getElementById('eventSelect').value;
        const ev = document.getElementById('event').value || evSel || 'ping';
        socket.on(ev, (payload) => log('on ' + ev, payload));
        log('subscribed: ' + ev);
      };

      loadChannels();
    </script>
  </body>
  </html>`;

    res.type('text/html; charset=utf-8').send(html);
    return;
  });
}
