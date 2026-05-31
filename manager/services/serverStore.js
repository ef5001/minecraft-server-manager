const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'servers.json');

function readStore() {
  if (!fs.existsSync(STORE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

function getAll() {
  return Object.values(readStore());
}

function get(id) {
  return readStore()[id] || null;
}

function save(server) {
  const store = readStore();
  store[server.id] = server;
  writeStore(store);
  return server;
}

function remove(id) {
  const store = readStore();
  delete store[id];
  writeStore(store);
}

function getUsedPorts() {
  return getAll().flatMap(s => [s.port, s.rconPort].filter(Boolean));
}

module.exports = { getAll, get, save, remove, getUsedPorts };
