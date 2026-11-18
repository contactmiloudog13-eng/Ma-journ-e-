'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SamsungTV, fetchDeviceInfo, wakeOnLan } = require('./lib/samsung-tv');
const { discover } = require('./lib/discovery');

const PORT = Number(process.env.PORT) || 3000;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Proposées quand la TV ne renvoie pas la liste de ses applis (fréquent sur les modèles récents).
const DEFAULT_APPS = [
  { appId: '3201907018807', name: 'Netflix', appType: 2 },
  { appId: '111299001912', name: 'YouTube', appType: 2 },
  { appId: '3201910019365', name: 'Prime Video', appType: 2 },
  { appId: '3201901017640', name: 'Disney+', appType: 2 },
  { appId: '3201807016597', name: 'Apple TV', appType: 2 },
  { appId: '3201606009684', name: 'Spotify', appType: 2 },
];

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

// ---------- Configuration ----------

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

let config = loadConfig();

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let tv = null;

function getTV() {
  if (!config.host) throw httpError(400, 'Aucune TV configurée : ouvrez les réglages.');
  if (!tv) {
    tv = new SamsungTV({ host: config.host, token: config.token || null, secure: config.secure !== false });
    tv.on('token', (token) => {
      config.token = token;
      saveConfig();
    });
  }
  return tv;
}

function resetTV() {
  if (tv) tv.close();
  tv = null;
}

// ---------- Utilitaires HTTP ----------

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000) {
        reject(httpError(413, 'Requête trop volumineuse'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(httpError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

const HOST_PATTERN = /^[a-zA-Z0-9.-]{1,253}$/;
const KEY_PATTERN = /^KEY_[A-Z0-9_]{1,40}$/;
const KEY_COMMANDS = ['Click', 'Press', 'Release'];

async function readPowerState() {
  try {
    const info = await fetchDeviceInfo(config.host, 1500);
    const state = info.device && info.device.PowerState;
    return state ? String(state).toLowerCase() : 'on';
  } catch {
    return 'off';
  }
}

// ---------- Routes de l'API ----------

const routes = {
  'GET /api/status': async () => {
    if (!config.host) return { configured: false };
    return {
      configured: true,
      host: config.host,
      name: config.name || 'TV Samsung',
      model: config.model || '',
      mac: config.mac || '',
      paired: Boolean(config.token) || config.secure === false,
      connected: Boolean(tv && tv.connected),
      power: await readPowerState(),
    };
  },

  'GET /api/discover': async () => ({ tvs: await discover() }),

  'POST /api/config': async (body) => {
    const host = String(body.host || '').trim();
    if (!HOST_PATTERN.test(host)) throw httpError(400, 'Adresse IP invalide');
    const mac = String(body.mac || '').trim();

    const next = { ...config, host };
    if (host !== config.host) {
      delete next.token;
      delete next.name;
      delete next.model;
      delete next.mac;
    }

    let reachable = true;
    try {
      const info = await fetchDeviceInfo(host);
      const device = info.device || {};
      next.name = device.name || info.name || next.name;
      next.model = device.modelName || next.model;
      next.mac = device.wifiMac || next.mac;
      // Les modèles sans jeton (2016-2017) utilisent le WebSocket non chiffré du port 8001.
      next.secure = device.TokenAuthSupport !== 'false';
    } catch {
      reachable = false;
    }
    if (mac) next.mac = mac;

    config = next;
    saveConfig();
    resetTV();
    return { ok: true, reachable, name: config.name, model: config.model, mac: config.mac || '' };
  },

  'POST /api/pair': async () => {
    resetTV();
    await getTV().connect({ timeoutMs: 30_000 });
    return { ok: true, paired: true };
  },

  'POST /api/key': async (body) => {
    const key = String(body.key || '');
    const cmd = body.cmd ? String(body.cmd) : 'Click';
    if (!KEY_PATTERN.test(key)) throw httpError(400, 'Touche inconnue');
    if (!KEY_COMMANDS.includes(cmd)) throw httpError(400, 'Commande inconnue');
    await getTV().sendKey(key, cmd);
    return { ok: true };
  },

  'POST /api/power': async () => {
    if (!config.host) throw httpError(400, 'Aucune TV configurée : ouvrez les réglages.');
    const power = await readPowerState();
    if (power === 'on') {
      await getTV().sendKey('KEY_POWER');
      return { ok: true, action: 'off' };
    }
    if (!config.mac) throw httpError(400, 'Adresse MAC inconnue : renseignez-la dans les réglages pour allumer la TV.');
    resetTV();
    await wakeOnLan(config.mac);
    return { ok: true, action: 'on' };
  },

  'POST /api/text': async (body) => {
    const text = String(body.text || '');
    if (!text) throw httpError(400, 'Texte vide');
    if (text.length > 500) throw httpError(400, 'Texte trop long');
    await getTV().sendText(text);
    return { ok: true };
  },

  'GET /api/apps': async () => {
    try {
      const apps = await getTV().getApps();
      if (apps.length) {
        apps.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
        return { source: 'tv', apps };
      }
    } catch (err) {
      if (err.status) throw err;
    }
    return { source: 'default', apps: DEFAULT_APPS };
  },

  'POST /api/app': async (body) => {
    const appId = String(body.appId || '');
    if (!/^[\w.]{1,64}$/.test(appId)) throw httpError(400, 'Appli inconnue');
    await getTV().launchApp(appId, Number(body.appType) || 2);
    return { ok: true };
  },
};

// ---------- Serveur ----------

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname.startsWith('/api/')) {
    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) return sendJSON(res, 404, { error: 'Route inconnue' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      sendJSON(res, 200, await handler(body));
    } catch (err) {
      const status = err.status || 502;
      if (status >= 500) console.error(`[${req.method} ${pathname}]`, err.message);
      sendJSON(res, status, { error: err.message });
    }
    return;
  }

  const file = STATIC_FILES[pathname];
  if (req.method !== 'GET' || !file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Page introuvable');
  }
  fs.readFile(path.join(PUBLIC_DIR, file[0]), (err, data) => {
    if (err) {
      res.writeHead(500);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

function lanAddresses() {
  const list = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const addr of addresses || []) {
      if (addr.family === 'IPv4' && !addr.internal) list.push(addr.address);
    }
  }
  return list;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n📺  Télécommande Samsung prête !\n');
  console.log(`   Sur ce PC        : http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`   Sur le téléphone : http://${ip}:${PORT}`);
  console.log('\n   (le téléphone doit être sur le même Wi-Fi que ce PC et la TV)');
  console.log('   Ctrl+C pour arrêter.\n');
});
