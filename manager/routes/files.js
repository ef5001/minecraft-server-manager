const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const tar = require('tar');
const extractZip = require('extract-zip');
const router = express.Router({ mergeParams: true });

const DATA_DIR = process.env.DATA_DIR || '/data';
const TMP_DIR = '/tmp/mc-uploads';

function serverDataDir(serverId) {
  return path.join(DATA_DIR, serverId);
}

function safePath(serverId, rel) {
  const base = serverDataDir(serverId);
  const resolved = path.resolve(base, rel || '');
  if (!resolved.startsWith(base)) throw new Error('Path traversal not allowed');
  return resolved;
}

// GET /api/servers/:id/files?path=
router.get('/', (req, res) => {
  try {
    const dir = safePath(req.params.id, req.query.path || '/');

    if (!fs.existsSync(dir)) {
      return res.json({ entries: [], path: req.query.path || '/' });
    }

    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

    const entries = fs.readdirSync(dir).map(name => {
      const s = fs.statSync(path.join(dir, name));
      return {
        name,
        type: s.isDirectory() ? 'directory' : 'file',
        size: s.size,
        modifiedAt: s.mtime.toISOString(),
      };
    }).sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ entries, path: req.query.path || '/' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/servers/:id/files/download?path=
router.get('/download', (req, res) => {
  try {
    const filePath = safePath(req.params.id, req.query.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.download(filePath);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/servers/:id/files/upload?path=  (regular files)
const fileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const dir = safePath(req.params.id, req.query.path || '/');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (e) {
        cb(e);
      }
    },
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
});

router.post('/upload', fileUpload.array('files'), (req, res) => {
  const uploaded = (req.files || []).map(f => ({ name: f.originalname, size: f.size }));
  res.json({ uploaded });
});

// POST /api/servers/:id/files/upload-world  (zip / tar.gz — extracted to data root)
const worldUpload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 },
});

router.post('/upload-world', worldUpload.single('world'), async (req, res) => {
  const tmpFile = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const destDir = serverDataDir(req.params.id);
    fs.mkdirSync(destDir, { recursive: true });

    const name = req.file.originalname.toLowerCase();

    if (name.endsWith('.zip')) {
      await extractZip(tmpFile, {
        dir: destDir,
        onEntry: (entry) => {
          // Guard against path traversal inside zip
          const resolved = path.resolve(destDir, entry.fileName);
          if (!resolved.startsWith(destDir)) throw new Error('Unsafe zip entry');
        },
      });
    } else if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) {
      await tar.extract({
        file: tmpFile,
        cwd: destDir,
        strip: 0,
        filter: (p) => {
          const resolved = path.resolve(destDir, p);
          return resolved.startsWith(destDir);
        },
      });
    } else {
      return res.status(400).json({ error: 'File must be .zip or .tar.gz' });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (tmpFile) fs.rmSync(tmpFile, { force: true });
  }
});

// DELETE /api/servers/:id/files?path=
router.delete('/', (req, res) => {
  try {
    const target = safePath(req.params.id, req.query.path);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/servers/:id/files/mkdir?path=
router.post('/mkdir', (req, res) => {
  try {
    const dir = safePath(req.params.id, req.query.path);
    fs.mkdirSync(dir, { recursive: true });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
