// ── Utilities ──────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function stripAnsi(s) {
  return s.replace(/\[[0-9;]*m/g, '').replace(/§[0-9a-fklmnor]/gi, '');
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : type === 'warn' ? 'warn' : ''}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function logClass(line) {
  const l = line.toLowerCase();
  if (l.includes('warn')) return 'warn';
  if (l.includes('error') || l.includes('exception') || l.includes('fatal')) return 'error';
  if (l.includes('info') || l.includes('[server]')) return 'info';
  return '';
}

// ── API ────────────────────────────────────────────────────────────────────

async function api(method, url, body) {
  const opts = {
    method,
    headers: {},
  };
  if (body && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  servers: [],
  selected: null,   // server id
  tab: 'overview',
  filePath: '/',
  files: [],
  backups: [],
  logs: [],
  ws: null,
  refreshTimer: null,
};

// ── Server Actions ─────────────────────────────────────────────────────────

async function loadServers() {
  try {
    state.servers = await api('GET', '/api/servers');
    renderSidebar();
    if (state.selected) {
      const srv = state.servers.find(s => s.id === state.selected);
      if (srv) renderDetailHeader(srv);
    }
  } catch (e) {
    console.error('Failed to load servers', e);
  }
}

async function selectServer(id) {
  state.selected = id;
  state.tab = 'overview';
  state.filePath = '/';
  state.logs = [];
  disconnectLogs();
  renderSidebar();
  const srv = state.servers.find(s => s.id === id);
  if (srv) renderDetail(srv);
}

async function startServer(id) {
  const btn = document.querySelector(`[data-action="start"][data-id="${id}"]`);
  if (btn) btn.disabled = true;
  try {
    await api('POST', `/api/servers/${id}/start`);
    toast('Server starting…', 'success');
    await loadServers();
    if (state.selected === id && state.tab === 'console') connectLogs(id);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function stopServer(id) {
  try {
    await api('POST', `/api/servers/${id}/stop`);
    toast('Server stopped');
    disconnectLogs();
    await loadServers();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function restartServer(id) {
  try {
    await api('POST', `/api/servers/${id}/restart`);
    toast('Server restarting…');
    await loadServers();
  } catch (e) {
    toast(e.message, 'error');
  }
}

let pendingDeleteId = null;

function confirmDeleteServer(id) {
  const srv = state.servers.find(s => s.id === id);
  if (!srv) return;
  pendingDeleteId = id;
  document.getElementById('delete-server-name').textContent = srv.name;
  document.getElementById('delete-data-check').checked = false;
  document.getElementById('delete-overlay').classList.remove('hidden');
}

async function deleteServer(id) {
  const deleteData = document.getElementById('delete-data-check').checked;
  document.getElementById('delete-overlay').classList.add('hidden');
  try {
    await api('DELETE', `/api/servers/${id}?deleteData=${deleteData}`);
    toast('Server deleted');
    if (state.selected === id) {
      state.selected = null;
      disconnectLogs();
      document.getElementById('main').innerHTML = emptyStateHTML();
    }
    await loadServers();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function sendCommand() {
  const input = document.getElementById('cmd-input');
  const cmd = input?.value?.trim();
  if (!cmd || !state.selected) return;
  input.value = '';
  try {
    const { response } = await api('POST', `/api/servers/${state.selected}/command`, { command: cmd });
    appendLog(`> ${cmd}\n${response || '(no response)'}`);
  } catch (e) {
    appendLog(`> ${cmd}\n[Error: ${e.message}]`);
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────

function emptyStateHTML() {
  return `<div class="empty-state">
    <div class="empty-icon">🎮</div>
    <h2>No server selected</h2>
    <p>Select a server from the sidebar or create a new one to get started.</p>
    <button class="btn btn-primary" id="empty-new-btn">+ New Server</button>
  </div>`;
}

function statusBadge(srv) {
  const s = srv.status || 'stopped';
  const cls = s === 'running' ? 'badge-green' : s === 'starting' || s === 'restarting' ? 'badge-yellow' : 'badge-gray';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}

function dotClass(srv) {
  const s = srv.status || 'stopped';
  if (s === 'running') return 'running';
  if (s === 'starting' || s === 'restarting') return 'starting';
  return 'stopped';
}

function renderSidebar() {
  const list = document.getElementById('server-list');
  if (!state.servers.length) {
    list.innerHTML = '<div style="padding:12px 16px;color:var(--muted);font-size:13px;">No servers yet</div>';
    return;
  }
  list.innerHTML = state.servers.map(s => `
    <div class="server-item ${s.id === state.selected ? 'active' : ''}"
         data-action="select-server" data-id="${s.id}">
      <span class="status-dot ${dotClass(s)}"></span>
      <span class="server-name">${esc(s.name)}</span>
    </div>
  `).join('');
}

function renderDetail(srv) {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="server-detail">
      <div class="server-detail-header">
        <div class="server-detail-title">
          <h2>${esc(srv.name)}</h2>
          ${statusBadge(srv)}
        </div>
        <div class="server-controls">
          <button class="btn btn-primary" data-action="start" data-id="${srv.id}" ${srv.running ? 'disabled' : ''}>▶ Start</button>
          <button class="btn" data-action="stop" data-id="${srv.id}" ${!srv.running ? 'disabled' : ''}>■ Stop</button>
          <button class="btn" data-action="restart" data-id="${srv.id}" ${!srv.running ? 'disabled' : ''}>↺ Restart</button>
          <button class="btn btn-danger" data-action="delete" data-id="${srv.id}">🗑 Delete</button>
        </div>
        <div class="tabs">
          ${['overview','console','files','backups'].map(t => `
            <button class="tab-btn ${state.tab === t ? 'active' : ''}" data-action="tab" data-value="${t}">${t.charAt(0).toUpperCase()+t.slice(1)}</button>
          `).join('')}
        </div>
      </div>
      <div class="tab-content" id="tab-content"></div>
    </div>`;
  renderTab(srv);
}

function renderDetailHeader(srv) {
  const title = document.querySelector('.server-detail-title');
  if (!title) return;
  title.innerHTML = `<h2>${esc(srv.name)}</h2>${statusBadge(srv)}`;

  const controls = document.querySelector('.server-controls');
  if (controls) {
    controls.querySelector('[data-action="start"]').disabled = srv.running;
    controls.querySelector('[data-action="stop"]').disabled = !srv.running;
    controls.querySelector('[data-action="restart"]').disabled = !srv.running;
  }
}

function renderTab(srv) {
  const content = document.getElementById('tab-content');
  if (!content) return;
  switch (state.tab) {
    case 'overview': loadMcVersions().then(() => { content.innerHTML = renderOverview(srv); }); break;
    case 'console':  content.innerHTML = renderConsole(srv); connectLogs(srv.id); break;
    case 'files':    content.innerHTML = renderFilesShell(); loadFiles(srv.id, state.filePath); break;
    case 'backups':  content.innerHTML = renderBackupsShell(srv); loadBackups(srv.id); break;
  }
}

let MC_VERSIONS = [];

async function loadMcVersions() {
  if (MC_VERSIONS.length) return MC_VERSIONS;
  try {
    MC_VERSIONS = await api('GET', '/api/servers/mc-versions');
  } catch {
    MC_VERSIONS = ['1.21.4','1.21.3','1.21.1','1.20.4','1.20.1','1.19.4','1.18.2','1.17.1','1.16.5'];
  }
  return MC_VERSIONS;
}

function versionOptions(selected) {
  const versions = MC_VERSIONS.length ? MC_VERSIONS : ['1.21.4','1.21.3','1.21.1','1.20.4','1.20.1'];
  const isKnown = versions.includes(selected) || selected === 'LATEST';
  return `<option value="LATEST" ${selected === 'LATEST' ? 'selected' : ''}>Latest</option>`
    + versions.map(v => `<option value="${v}" ${selected === v ? 'selected' : ''}>${v}</option>`).join('')
    + `<option value="__custom__" ${!isKnown ? 'selected' : ''}>Custom…</option>`;
}

function renderVersionCard(srv) {
  if (srv.running) {
    return `<div class="info-card"><label>Version</label><span>${esc(srv.version)}</span></div>`;
  }
  const versions = MC_VERSIONS.length ? MC_VERSIONS : [];
  const isKnown = versions.includes(srv.version) || srv.version === 'LATEST';
  return `<div class="info-card">
    <label>Version</label>
    <div style="display:flex;gap:6px;align-items:center;margin-top:2px">
      <select id="version-edit-select" style="flex:1;padding:4px 6px;font-size:13px">
        ${versionOptions(srv.version)}
      </select>
      <button class="btn btn-sm btn-primary" data-action="save-version">Save</button>
    </div>
    <input type="text" id="version-edit-custom" placeholder="e.g. 1.21.2"
           value="${!isKnown ? esc(srv.version) : ''}"
           style="margin-top:6px;font-size:12px;${!isKnown ? '' : 'display:none'}">
  </div>`;
}

function renderOverview(srv) {
  return `
    <div class="section-title">Server Info</div>
    <div class="info-grid">
      <div class="info-card"><label>Type</label><span>${esc(srv.type)}</span></div>
      ${renderVersionCard(srv)}
      <div class="info-card"><label>Port</label><span>${esc(srv.port)}</span></div>
      <div class="info-card"><label>Memory</label><span>${esc(srv.memory)}</span></div>
      <div class="info-card"><label>Max Players</label><span>${esc(srv.maxPlayers)}</span></div>
      <div class="info-card"><label>Game Mode</label><span>${esc(srv.gamemode)}</span></div>
      <div class="info-card"><label>Difficulty</label><span>${esc(srv.difficulty)}</span></div>
      <div class="info-card"><label>MOTD</label><span style="font-size:12px">${esc(srv.motd)}</span></div>
    </div>
    <div class="section-title">Connection</div>
    <div class="info-grid">
      <div class="info-card"><label>Address</label><span>localhost:${esc(srv.port)}</span></div>
      <div class="info-card"><label>Created</label><span style="font-size:12px">${formatDate(srv.createdAt)}</span></div>
    </div>
    <div class="danger-zone">
      <div class="section-title">Danger Zone</div>
      <button class="btn btn-danger" data-action="delete" data-id="${srv.id}">🗑 Delete Server</button>
    </div>`;
}

function renderConsole(srv) {
  return `
    <div class="console-wrapper">
      <div class="console-status" id="console-status">
        <span class="spinner"></span> Connecting to log stream…
      </div>
      <div class="log-viewer" id="log-viewer">
        <div id="log-content"></div>
      </div>
      <div class="console-input-bar">
        <input type="text" id="cmd-input" placeholder="Enter server command (e.g. list, say Hello, give player diamond 1)">
        <button id="cmd-send">Send</button>
      </div>
    </div>`;
}

const QUICK_FOLDERS = [
  { path: '/',        label: '🏠 Root' },
  { path: '/mods',    label: '🧩 Mods' },
  { path: '/plugins', label: '🔌 Plugins' },
  { path: '/config',  label: '⚙️ Config' },
  { path: '/world',   label: '🌍 World' },
];

function renderFilesShell() {
  return `
    <div class="quick-folders" id="quick-folders">
      ${QUICK_FOLDERS.map(f => `
        <button class="quick-folder-btn ${state.filePath === f.path ? 'active' : ''}"
                data-action="nav-files" data-path="${esc(f.path)}">${esc(f.label)}</button>
      `).join('')}
    </div>
    <div class="files-toolbar">
      <div class="breadcrumb" id="breadcrumb">/ </div>
      <div class="file-actions">
        <label class="btn" for="file-upload-input">📤 Upload Files</label>
        <input type="file" id="file-upload-input" multiple style="display:none">
        <label class="btn btn-primary" for="world-upload-input" title="Upload a .zip or .tar.gz of your world folder">🌍 Import World</label>
        <input type="file" id="world-upload-input" accept=".zip,.tar.gz,.tgz" style="display:none">
      </div>
    </div>
    <div class="drop-zone" id="drop-zone">
      Drop files here to upload to <strong id="drop-zone-path">${esc(state.filePath)}</strong>
    </div>
    <div id="upload-progress" class="upload-progress hidden"></div>
    <div id="file-list-container"></div>`;
}

function renderBackupsShell(srv) {
  const scheduleOptions = [
    { value: '', label: 'No schedule' },
    { value: '0 */6 * * *', label: 'Every 6 hours' },
    { value: '0 0 * * *', label: 'Daily at midnight' },
    { value: '0 0 * * 0', label: 'Weekly on Sunday' },
    { value: '__custom__', label: 'Custom cron…' },
  ];
  return `
    <div class="backups-header">
      <div class="schedule-card">
        <h4>Backup Schedule</h4>
        <div class="schedule-row">
          <select id="schedule-select" style="flex:1">
            ${scheduleOptions.map(o => `<option value="${esc(o.value)}" ${srv.backupSchedule === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>
          <input type="text" id="schedule-custom" placeholder="cron expression"
                 value="${esc(srv.backupSchedule || '')}"
                 style="flex:1;${!srv.backupSchedule || scheduleOptions.some(o=>o.value===srv.backupSchedule) ? 'display:none' : ''}">
          <button class="btn btn-primary" data-action="save-schedule">Save</button>
        </div>
      </div>
      <button class="btn btn-primary" data-action="create-backup">+ Backup Now</button>
    </div>
    <div class="section-title">Backup History</div>
    <div id="backup-list" class="backup-list"><div class="empty-list">Loading…</div></div>`;
}

// ── File Explorer ──────────────────────────────────────────────────────────

async function loadFiles(serverId, filePath) {
  state.filePath = filePath;
  try {
    const { entries } = await api('GET', `/api/servers/${serverId}/files?path=${encodeURIComponent(filePath)}`);
    state.files = entries;
    renderFileList(serverId, filePath, entries);
    renderBreadcrumb(filePath);

    // Sync quick folder active state
    document.querySelectorAll('.quick-folder-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.path === filePath);
    });

    // Update drop zone label
    const dzPath = document.getElementById('drop-zone-path');
    if (dzPath) dzPath.textContent = filePath;
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderBreadcrumb(filePath) {
  const el = document.getElementById('breadcrumb');
  if (!el) return;
  const parts = filePath.split('/').filter(Boolean);
  let crumbs = `<span class="crumb-link" data-action="nav-files" data-path="/">🏠 /</span>`;
  let current = '';
  for (let i = 0; i < parts.length; i++) {
    current += '/' + parts[i];
    const path = current;
    if (i < parts.length - 1) {
      crumbs += `<span class="crumb-sep"> / </span><span class="crumb-link" data-action="nav-files" data-path="${esc(path)}">${esc(parts[i])}</span>`;
    } else {
      crumbs += `<span class="crumb-sep"> / </span><span class="crumb-current">${esc(parts[i])}</span>`;
    }
  }
  el.innerHTML = crumbs;
}

function renderFileList(serverId, filePath, entries) {
  const container = document.getElementById('file-list-container');
  if (!container) return;
  if (!entries.length) {
    container.innerHTML = '<div class="empty-list">This directory is empty</div>';
    return;
  }
  container.innerHTML = `
    <table class="file-table">
      <thead><tr>
        <th>Name</th><th>Size</th><th>Modified</th><th>Actions</th>
      </tr></thead>
      <tbody>
        ${entries.map(f => {
          const entryPath = (filePath === '/' ? '' : filePath) + '/' + f.name;
          return `<tr>
            <td>
              <div class="file-name">
                <span class="file-icon">${f.type === 'directory' ? '📁' : fileIcon(f.name)}</span>
                ${f.type === 'directory'
                  ? `<span class="dir-link" data-action="nav-files" data-path="${esc(entryPath)}">${esc(f.name)}</span>`
                  : `<span>${esc(f.name)}</span>`}
              </div>
            </td>
            <td class="file-size">${f.type === 'file' ? formatBytes(f.size) : '—'}</td>
            <td class="file-date">${formatDate(f.modifiedAt)}</td>
            <td>
              <div class="file-actions-cell">
                ${f.type === 'file'
                  ? `<a class="btn btn-sm" href="/api/servers/${serverId}/files/download?path=${encodeURIComponent(entryPath)}">↓</a>`
                  : ''}
                <button class="btn btn-sm btn-danger" data-action="del-file" data-path="${esc(entryPath)}">✕</button>
              </div>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = { jar: '☕', json: '{}', yml: '⚙', yaml: '⚙', properties: '⚙', log: '📋', txt: '📄', zip: '🗜', gz: '🗜' };
  return icons[ext] || '📄';
}

async function deleteFile(serverId, filePath) {
  if (!confirm(`Delete ${filePath}?`)) return;
  try {
    await api('DELETE', `/api/servers/${serverId}/files?path=${encodeURIComponent(filePath)}`);
    toast('Deleted');
    loadFiles(serverId, state.filePath);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function uploadFiles(serverId, filePath, files) {
  const progressEl = document.getElementById('upload-progress');
  const progressFill = progressEl?.querySelector('.progress-bar-fill');
  const progressText = progressEl?.querySelector('.progress-text');

  if (progressEl) {
    progressEl.classList.remove('hidden');
    progressEl.innerHTML = `
      <div class="progress-text">Uploading ${files.length} file(s)…</div>
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:0%"></div></div>`;
  }

  try {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/servers/${serverId}/files/upload?path=${encodeURIComponent(filePath)}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && progressEl) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressEl.querySelector('.progress-bar-fill').style.width = pct + '%';
          progressEl.querySelector('.progress-text').textContent = `Uploading… ${pct}%`;
        }
      };
      xhr.onload = () => (xhr.status < 400 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`)));
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(fd);
    });

    toast(`Uploaded ${files.length} file(s)`);
    loadFiles(serverId, filePath);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setTimeout(() => progressEl?.classList.add('hidden'), 1500);
  }
}

async function importWorld(serverId, file) {
  const progressEl = document.getElementById('upload-progress');
  if (progressEl) {
    progressEl.classList.remove('hidden');
    progressEl.innerHTML = `
      <div class="progress-text">Importing world… (this may take a moment)</div>
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:0%"></div></div>`;
  }
  try {
    const fd = new FormData();
    fd.append('world', file);
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/servers/${serverId}/files/upload-world`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && progressEl) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressEl.querySelector('.progress-bar-fill').style.width = pct + '%';
          progressEl.querySelector('.progress-text').textContent = `Uploading… ${pct}%`;
        }
      };
      xhr.onload = () => {
        if (xhr.status < 400) {
          progressEl && (progressEl.querySelector('.progress-text').textContent = 'Extracting…');
          resolve();
        } else {
          try { reject(new Error(JSON.parse(xhr.responseText).error)); } catch { reject(new Error('Upload failed')); }
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(fd);
    });
    toast('World imported successfully');
    loadFiles(serverId, '/');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setTimeout(() => progressEl?.classList.add('hidden'), 2000);
  }
}

// ── Backups ────────────────────────────────────────────────────────────────

async function loadBackups(serverId) {
  try {
    const backups = await api('GET', `/api/servers/${serverId}/backups`);
    state.backups = backups;
    renderBackupList(serverId, backups);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderBackupList(serverId, backups) {
  const el = document.getElementById('backup-list');
  if (!el) return;
  if (!backups.length) {
    el.innerHTML = '<div class="empty-list">No backups yet. Create one with the button above.</div>';
    return;
  }
  el.innerHTML = backups.map(b => `
    <div class="backup-item">
      <div class="backup-info">
        <span class="backup-name">${esc(b.filename)}</span>
        <span class="backup-meta">${formatBytes(b.size)} · ${formatDate(b.createdAt)}</span>
      </div>
      <div class="backup-actions">
        <a class="btn btn-sm" href="/api/servers/${serverId}/backups/download/${encodeURIComponent(b.filename)}">↓ Download</a>
        <button class="btn btn-sm btn-danger" data-action="del-backup" data-filename="${esc(b.filename)}">Delete</button>
      </div>
    </div>`).join('');
}

async function createBackup(serverId) {
  const btn = document.querySelector('[data-action="create-backup"]');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const result = await api('POST', `/api/servers/${serverId}/backups`);
    toast(`Backup created: ${formatBytes(result.size)}`);
    loadBackups(serverId);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '+ Backup Now'; }
  }
}

async function deleteBackup(serverId, filename) {
  if (!confirm(`Delete backup "${filename}"?`)) return;
  try {
    await api('DELETE', `/api/servers/${serverId}/backups/${encodeURIComponent(filename)}`);
    toast('Backup deleted');
    loadBackups(serverId);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function saveVersion(serverId) {
  const select = document.getElementById('version-edit-select');
  const custom = document.getElementById('version-edit-custom');
  let version = select.value === '__custom__' ? (custom.value.trim() || 'LATEST') : select.value;
  try {
    await api('PUT', `/api/servers/${serverId}`, { version });
    const srv = state.servers.find(s => s.id === serverId);
    if (srv) srv.version = version;
    toast(`Version set to ${version} — container will be recreated on next start`);
    // Re-render overview with updated version
    const content = document.getElementById('tab-content');
    if (content && state.tab === 'overview') content.innerHTML = renderOverview({ ...srv, version });
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function saveSchedule(serverId) {
  const select = document.getElementById('schedule-select');
  const custom = document.getElementById('schedule-custom');
  let schedule = select.value === '__custom__' ? custom.value.trim() : select.value;

  try {
    await api('PUT', `/api/servers/${serverId}/backups/schedule`, { schedule: schedule || null });
    toast(schedule ? `Backup schedule set: ${schedule}` : 'Backup schedule removed');
    // Persist schedule in local state
    const srv = state.servers.find(s => s.id === serverId);
    if (srv) srv.backupSchedule = schedule || null;
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Console / WebSocket ────────────────────────────────────────────────────

function connectLogs(serverId) {
  disconnectLogs();
  state.logs = [];

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/logs?serverId=${serverId}`);
  state.ws = ws;

  ws.onopen = () => {
    const statusEl = document.getElementById('console-status');
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--green)">● Connected</span>';
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'log') appendLog(msg.data);
    if (msg.type === 'end') {
      const statusEl = document.getElementById('console-status');
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--muted)">○ Log stream ended</span>';
    }
  };

  ws.onerror = () => {
    const statusEl = document.getElementById('console-status');
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--red)">● Connection error</span>';
  };

  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
  };
}

function disconnectLogs() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
}

function appendLog(raw) {
  const content = document.getElementById('log-content');
  if (!content) return;
  const viewer = document.getElementById('log-viewer');
  const atBottom = viewer && viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 60;

  const line = document.createElement('div');
  line.className = 'log-line ' + logClass(raw);
  line.textContent = stripAnsi(raw);
  content.appendChild(line);

  // Keep max 2000 lines
  while (content.children.length > 2000) content.removeChild(content.firstChild);

  if (atBottom && viewer) viewer.scrollTop = viewer.scrollHeight;
}

// ── Modals ─────────────────────────────────────────────────────────────────

async function showCreateModal() {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('create-form').reset();
  document.querySelector('[name="name"]').focus();

  const select = document.getElementById('version-select');
  if (select) {
    select.innerHTML = '<option value="LATEST">Loading…</option>';
    await loadMcVersions();
    select.innerHTML = versionOptions('LATEST');
  }
}

function hideCreateModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

async function submitCreateServer() {
  const form = document.getElementById('create-form');
  const data = Object.fromEntries(new FormData(form));
  if (!data.name.trim()) { toast('Server name is required', 'error'); return; }
  if (!data.eula) { toast('You must accept the Minecraft EULA to continue', 'warn'); return; }
  if (data.version === '__custom__') data.version = (data['version-custom'] || '').trim() || 'LATEST';

  const btn = document.getElementById('modal-submit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating…';

  try {
    const server = await api('POST', '/api/servers', {
      name: data.name.trim(),
      type: data.type,
      version: data.version || 'LATEST',
      memory: data.memory,
      gamemode: data.gamemode,
      difficulty: data.difficulty,
      maxPlayers: Number(data.maxPlayers) || 20,
      port: data.port ? Number(data.port) : undefined,
      motd: data.motd || data.name.trim(),
    });

    hideCreateModal();
    await loadServers();
    selectServer(server.id);
    toast(`Server "${server.name}" created on port ${server.port}`);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Server';
  }
}

// ── Event Delegation ───────────────────────────────────────────────────────

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id || state.selected;

  switch (action) {
    case 'select-server': await selectServer(el.dataset.id); break;
    case 'start':  await startServer(id); break;
    case 'stop':   await stopServer(id); break;
    case 'restart': await restartServer(id); break;
    case 'delete': confirmDeleteServer(id); break;
    case 'tab':
      state.tab = el.dataset.value;
      disconnectLogs();
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.value === state.tab));
      const srv = state.servers.find(s => s.id === state.selected);
      if (srv) renderTab(srv);
      break;
    case 'nav-files': loadFiles(state.selected, el.dataset.path); break;
    case 'del-file':  deleteFile(state.selected, el.dataset.path); break;
    case 'create-backup': createBackup(state.selected); break;
    case 'del-backup': deleteBackup(state.selected, el.dataset.filename); break;
    case 'save-schedule': saveSchedule(state.selected); break;
    case 'save-version': saveVersion(state.selected); break;
  }
});

// New server buttons
document.getElementById('new-server-btn').addEventListener('click', showCreateModal);
document.addEventListener('click', (e) => {
  if (e.target.id === 'empty-new-btn') showCreateModal();
});

// Modal controls
document.getElementById('modal-close').addEventListener('click', hideCreateModal);
document.getElementById('modal-cancel').addEventListener('click', hideCreateModal);
document.getElementById('modal-submit').addEventListener('click', submitCreateServer);
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideCreateModal();
});

document.getElementById('delete-cancel').addEventListener('click', () => {
  document.getElementById('delete-overlay').classList.add('hidden');
});
document.getElementById('delete-confirm').addEventListener('click', () => {
  if (pendingDeleteId) deleteServer(pendingDeleteId);
});

// Schedule select — show/hide custom input
document.addEventListener('change', (e) => {
  if (e.target.id === 'schedule-select') {
    const custom = document.getElementById('schedule-custom');
    if (custom) custom.style.display = e.target.value === '__custom__' ? '' : 'none';
  }
  if (e.target.id === 'version-select') {
    const custom = document.getElementById('version-custom');
    if (custom) custom.style.display = e.target.value === '__custom__' ? '' : 'none';
  }
  if (e.target.id === 'version-edit-select') {
    const custom = document.getElementById('version-edit-custom');
    if (custom) custom.style.display = e.target.value === '__custom__' ? '' : 'none';
  }
});

// Console send button & enter key
document.addEventListener('click', (e) => {
  if (e.target.id === 'cmd-send') sendCommand();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'cmd-input') sendCommand();
});

// File upload inputs
document.addEventListener('change', (e) => {
  if (e.target.id === 'file-upload-input' && e.target.files.length) {
    uploadFiles(state.selected, state.filePath, [...e.target.files]);
    e.target.value = '';
  }
  if (e.target.id === 'world-upload-input' && e.target.files[0]) {
    importWorld(state.selected, e.target.files[0]);
    e.target.value = '';
  }
});

// Drag-and-drop upload
document.addEventListener('dragover', (e) => {
  if (document.getElementById('drop-zone')) {
    e.preventDefault();
    document.getElementById('drop-zone')?.classList.add('drag-over');
  }
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || !document.getElementById('drop-zone')?.contains(e.relatedTarget)) {
    document.getElementById('drop-zone')?.classList.remove('drag-over');
  }
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.getElementById('drop-zone')?.classList.remove('drag-over');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length && state.selected && state.tab === 'files') {
    uploadFiles(state.selected, state.filePath, files);
  }
});

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  await loadServers();
  // Poll server statuses every 5 seconds
  state.refreshTimer = setInterval(loadServers, 5000);
}

init();
