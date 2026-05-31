const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const store = require('./services/serverStore');
const docker = require('./services/docker');
const backup = require('./services/backupService');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/servers', require('./routes/servers'));
app.use('/api/servers/:id/files', require('./routes/files'));
app.use('/api/servers/:id/backups', require('./routes/backups'));

// WebSocket log streaming — upgrade on /ws/logs?serverId=...
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws/logs') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const serverId = url.searchParams.get('serverId');

  if (!serverId) { ws.close(1008, 'Missing serverId'); return; }

  const srv = store.get(serverId);
  if (!srv?.containerId) { ws.close(1000, 'Server has no container'); return; }

  let logStream;
  try {
    logStream = await docker.streamLogs(
      srv.containerId,
      (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'log', data }));
        }
      },
      () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'end' }));
        }
      }
    );
  } catch (e) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
    ws.close();
    return;
  }

  ws.on('close', () => {
    try { logStream?.destroy(); } catch {}
  });
});

// Restore backup schedules from persisted state on startup
function restoreSchedules() {
  for (const srv of store.getAll()) {
    if (srv.backupSchedule) {
      try {
        backup.scheduleBackup(srv.id, srv.name, srv.backupSchedule);
        console.log(`Restored backup schedule for "${srv.name}"`);
      } catch (e) {
        console.error(`Failed to restore schedule for "${srv.name}": ${e.message}`);
      }
    }
  }
}

const PORT = process.env.MANAGER_PORT || 3000;
server.listen(PORT, () => {
  console.log(`MC Manager running on http://localhost:${PORT}`);
  restoreSchedules();
});
