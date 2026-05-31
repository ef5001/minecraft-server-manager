const cron = require('node-cron');
const tar = require('tar');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';

const scheduledJobs = new Map();

function serverDataDir(serverId) {
  return path.join(DATA_DIR, serverId);
}

function serverBackupDir(serverId) {
  return path.join(BACKUP_DIR, serverId);
}

async function createBackup(serverId, serverName) {
  const backupDir = serverBackupDir(serverId);
  fs.mkdirSync(backupDir, { recursive: true });

  const dataDir = serverDataDir(serverId);
  if (!fs.existsSync(dataDir)) throw new Error('Server data directory not found');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${serverName.replace(/[^a-z0-9]/gi, '_')}-${timestamp}.tar.gz`;
  const outputPath = path.join(backupDir, filename);

  await tar.create({ gzip: true, file: outputPath, cwd: dataDir }, ['.']);

  const { size } = fs.statSync(outputPath);
  return { filename, size, path: outputPath };
}

function listBackups(serverId) {
  const backupDir = serverBackupDir(serverId);
  if (!fs.existsSync(backupDir)) return [];

  return fs.readdirSync(backupDir)
    .filter(f => f.endsWith('.tar.gz'))
    .map(filename => {
      const stat = fs.statSync(path.join(backupDir, filename));
      return { filename, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function deleteBackup(serverId, filename) {
  // Prevent path traversal
  if (filename.includes('/') || filename.includes('..')) throw new Error('Invalid filename');
  const filePath = path.join(serverBackupDir(serverId), filename);
  if (!fs.existsSync(filePath)) throw new Error('Backup not found');
  fs.unlinkSync(filePath);
}

function getBackupFilePath(serverId, filename) {
  if (filename.includes('/') || filename.includes('..')) throw new Error('Invalid filename');
  return path.join(serverBackupDir(serverId), filename);
}

function scheduleBackup(serverId, serverName, cronExpr) {
  if (scheduledJobs.has(serverId)) {
    scheduledJobs.get(serverId).stop();
    scheduledJobs.delete(serverId);
  }

  if (!cronExpr) return;
  if (!cron.validate(cronExpr)) throw new Error('Invalid cron expression');

  const task = cron.schedule(cronExpr, () => {
    console.log(`Running scheduled backup for ${serverName} (${serverId})`);
    createBackup(serverId, serverName).catch(console.error);
  });

  scheduledJobs.set(serverId, task);
}

function cancelSchedule(serverId) {
  if (scheduledJobs.has(serverId)) {
    scheduledJobs.get(serverId).stop();
    scheduledJobs.delete(serverId);
  }
}

module.exports = {
  createBackup,
  listBackups,
  deleteBackup,
  getBackupFilePath,
  scheduleBackup,
  cancelSchedule,
};
