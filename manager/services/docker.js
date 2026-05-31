const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const MC_NETWORK = process.env.MC_NETWORK || 'mc-manager-net';
const HOST_DATA_DIR = (process.env.HOST_DATA_DIR || path.join(process.cwd(), '../data')).replace(/\\/g, '/');
const DATA_DIR = process.env.DATA_DIR || '/data';
const MC_IMAGE = 'itzg/minecraft-server';

async function ensureNetwork() {
  const networks = await docker.listNetworks({ filters: { name: [MC_NETWORK] } });
  if (!networks.find(n => n.Name === MC_NETWORK)) {
    await docker.createNetwork({ Name: MC_NETWORK, Driver: 'bridge' });
  }
}

async function ensureImage() {
  try {
    await docker.getImage(MC_IMAGE).inspect();
  } catch {
    await new Promise((resolve, reject) => {
      docker.pull(MC_IMAGE, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
      });
    });
  }
}

async function createContainer(server) {
  await ensureNetwork();
  await ensureImage();

  // Create data dir from inside the manager container so Docker can bind it
  const containerDataPath = path.join(DATA_DIR, server.id);
  fs.mkdirSync(containerDataPath, { recursive: true });

  const hostDataPath = `${HOST_DATA_DIR}/${server.id}`;

  const env = [
    'EULA=TRUE',
    `TYPE=${server.type || 'PAPER'}`,
    `VERSION=${server.version || 'LATEST'}`,
    `MEMORY=${server.memory || '2G'}`,
    `MOTD=${server.motd || 'A Minecraft Server'}`,
    `MAX_PLAYERS=${server.maxPlayers || 20}`,
    `DIFFICULTY=${server.difficulty || 'normal'}`,
    `MODE=${server.gamemode || 'survival'}`,
    'ENABLE_RCON=true',
    `RCON_PASSWORD=${server.rconPassword}`,
    'RCON_PORT=25575',
    `SERVER_PORT=${server.port}`,
  ];

  const container = await docker.createContainer({
    Image: MC_IMAGE,
    name: `mc-${server.id}`,
    Env: env,
    ExposedPorts: {
      [`${server.port}/tcp`]: {},
      [`${server.port}/udp`]: {},
    },
    HostConfig: {
      PortBindings: {
        [`${server.port}/tcp`]: [{ HostPort: String(server.port) }],
        [`${server.port}/udp`]: [{ HostPort: String(server.port) }],
      },
      Binds: [`${hostDataPath}:/data`],
      RestartPolicy: { Name: 'unless-stopped' },
    },
    NetworkingConfig: {
      EndpointsConfig: { [MC_NETWORK]: {} },
    },
  });

  return container.id;
}

async function startContainer(containerId) {
  await docker.getContainer(containerId).start();
}

async function stopContainer(containerId) {
  await docker.getContainer(containerId).stop({ t: 30 });
}

async function restartContainer(containerId) {
  await docker.getContainer(containerId).restart({ t: 30 });
}

async function removeContainer(containerId) {
  try {
    const container = docker.getContainer(containerId);
    try { await container.stop({ t: 10 }); } catch {}
    await container.remove({ force: true });
  } catch (e) {
    if (!e.message?.includes('No such container')) throw e;
  }
}

async function getContainerInfo(containerId) {
  try {
    const info = await docker.getContainer(containerId).inspect();
    return {
      status: info.State.Status,
      running: info.State.Running,
      startedAt: info.State.StartedAt,
    };
  } catch {
    return { status: 'removed', running: false };
  }
}

async function streamLogs(containerId, onData, onEnd) {
  const container = docker.getContainer(containerId);
  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: 200,
  });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on('data', (d) => onData(d.toString()));
  stderr.on('data', (d) => onData(d.toString()));
  container.modem.demuxStream(stream, stdout, stderr);
  stream.on('end', () => { stdout.end(); stderr.end(); onEnd(); });

  return stream;
}

module.exports = {
  createContainer,
  startContainer,
  stopContainer,
  restartContainer,
  removeContainer,
  getContainerInfo,
  streamLogs,
};
