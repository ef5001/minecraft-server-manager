const express = require('express');
const fs = require('fs');
const router = express.Router({ mergeParams: true });
const backup = require('../services/backupService');
const store = require('../services/serverStore');

// GET /api/servers/:id/backups
router.get('/', (req, res) => {
  try {
    res.json(backup.listBackups(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/servers/:id/backups
router.post('/', async (req, res) => {
  try {
    const server = store.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const result = await backup.createBackup(server.id, server.name);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/servers/:id/backups/schedule
router.get('/schedule', (req, res) => {
  const server = store.get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  res.json({ schedule: server.backupSchedule || null });
});

// PUT /api/servers/:id/backups/schedule
router.put('/schedule', (req, res) => {
  try {
    const server = store.get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const { schedule } = req.body;
    backup.scheduleBackup(server.id, server.name, schedule || null);
    store.save({ ...server, backupSchedule: schedule || null });

    res.json({ schedule: schedule || null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/servers/:id/backups/download/:filename
router.get('/download/:filename', (req, res) => {
  try {
    const filePath = backup.getBackupFilePath(req.params.id, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.download(filePath);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/servers/:id/backups/:filename
router.delete('/:filename', (req, res) => {
  try {
    backup.deleteBackup(req.params.id, req.params.filename);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
