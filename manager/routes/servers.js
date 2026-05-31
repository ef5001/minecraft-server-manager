const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Rcon } = require('rcon-client');
const router = express.Router();
const docker = require('../services/docker');
const store = require('../services/serverStore');
const backup = require('../services/backupService');

// GET /api/servers/mc-versions — fetches release versions from Mojang, cached for 1 hour
let versionCache = null;
let versionCacheTime = 0;

router.get('/mc-versions', async (req, res) => {
  try {
    if (!versionCache || Date.now() - versionCacheTime > 3600000) {
      const resp = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
      const data = await resp.json();
      versionCache = data.versions.filter(v => v.type === 'release').map(v => v.id);
      versionCacheTime = Date.now();
    }
    res.json(versionCache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function pickPort(preferred, used) {
  let port = preferred || 25565;
  while (used.includes(port)) port++;
  return port;
}

// GET /api/servers
router.get('/', async (req, res) => {
  try {
    const servers = store.getAll();
    const enriched = await Promise.all(
      servers.map(async (s) => {
        if (s.containerId) {
          const info = await docker.getContainerInfo(s.containerId);
          return { ...s, status: info.status, running: info.running };
        }
        return { ...s, status: 'stopped', running: false };
      })
    );
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/servers
router.post('/', async (req, res) => {
  try {
    const { name, type, version, memory, port, motd, maxPlayers, difficulty, gamemode } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const usedPorts = store.getUsedPorts();
    const gamePort = pickPort(port ? Number(port) : 25565, usedPorts);
    const rconPort = gamePort; // RCON is internal-only via container name

    const server = {
      id: uuidv4(),
      name,
      type: type || 'PAPER',
      version: version || 'LATEST',
      memory: memory || '2G',
      port: gamePort,
      rconPort,
      motd: motd || `${name}`,
      maxPlayers: maxPlayers || 20,
      difficulty: difficulty || 'normal',
      gamemode: gamemode || 'survival',
      rconPassword: uuidv4().replace(/-/g, '').slice(0, 16),
      containerId: null,
      backupSchedule: null,
      createdAt: new Date().toISOString(),
    };

    store.save(server);
    res.status(201).json(server);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/servers/:id
router.get('/:id', async (req, res) => {
  const server = store.get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  let status = 'stopped', running = false;
  if (server.containerId) {
    const info = await docker.getContainerInfo(server.containerId);
    status = info.status;
    running = info.running;
  }
  res.json({ ...server, status, running });
});

// PUT /api/servers/:id
router.put('/:id', async (req, res) => {
  const server = store.get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const allowed = ['name', 'motd', 'maxPlayers', 'difficulty', 'gamemode', 'memory', 'version', 'type'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // If version or type changed, remove the existing container so it gets
  // recreated with the new env vars on next start. World data is untouched.
  const containerRelevantChanged = ['version', 'type', 'memory'].some(
    k => updates[k] !== undefined && updates[k] !== server[k]
  );
  if (containerRelevantChanged && server.containerId) {
    try {
      await docker.removeContainer(server.containerId);
    } catch {}
    updates.containerId = null;
  }

  res.json(store.save({ ...server, ...updates }));
});

// DELETE /api/servers/:id
router.delete('/:id', async (req, res) => {
  try {
    const server = store.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    if (server.containerId) {
      await docker.removeContainer(server.containerId);
    }

    backup.cancelSchedule(server.id);
    store.remove(server.id);

    if (req.query.deleteData === 'true') {
      const dataDir = path.join(process.env.DATA_DIR || '/data', server.id);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/servers/:id/start
router.post('/:id/start', async (req, res) => {
  try {
    let server = store.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    if (!server.containerId) {
      const containerId = await docker.createContainer(server);
      server = store.save({ ...server, containerId });
    }

    await docker.startContainer(server.containerId);
    res.json({ success: true, containerId: server.containerId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/servers/:id/stop
router.post('/:id/stop', async (req, res) => {
  try {
    const server = store.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (!server.containerId) return res.status(400).json({ error: 'Server has no container' });

    await docker.stopContainer(server.containerId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/servers/:id/restart
router.post('/:id/restart', async (req, res) => {
  try {
    const server = store.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (!server.containerId) return res.status(400).json({ error: 'Server has no container' });

    await docker.restartContainer(server.containerId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/servers/:id/command  (RCON)
router.post('/:id/command', async (req, res) => {
  try {
    const server = store.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'Command required' });

    const rcon = new Rcon({
      host: `mc-${server.id}`,
      port: 25575,
      password: server.rconPassword,
    });

    await rcon.connect();
    const response = await rcon.send(command);
    await rcon.end();

    res.json({ response });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
