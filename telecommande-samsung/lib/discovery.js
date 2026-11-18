'use strict';

// Recherche des TV Samsung sur le réseau local :
// 1. SSDP (multicast UPnP), rapide quand le routeur le laisse passer ;
// 2. sinon, balayage des adresses du sous-réseau sur le port 8001.

const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');
const { fetchDeviceInfo } = require('./samsung-tv');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:samsung.com:device:RemoteControlReceiver:1',
  'urn:dial-multiscreen-org:service:dial:1',
  'upnp:rootdevice',
];

function ssdpSearch(timeoutMs) {
  return new Promise((resolve) => {
    const found = new Set();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
        // déjà fermé
      }
      resolve([...found]);
    };

    socket.on('message', (_msg, rinfo) => found.add(rinfo.address));
    socket.on('error', finish);
    socket.bind(() => {
      for (const st of SEARCH_TARGETS) {
        const message = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`
        );
        socket.send(message, SSDP_PORT, SSDP_ADDRESS, () => {});
      }
    });
    setTimeout(finish, timeoutMs);
  });
}

function isPortOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Adresses x.y.z.1 à x.y.z.254 de chaque réseau local IPv4 (hors adresse du PC).
function localSubnetHosts() {
  const hosts = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const addr of addresses || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const prefix = addr.address.split('.').slice(0, 3).join('.');
      for (let i = 1; i < 255; i++) {
        const host = `${prefix}.${i}`;
        if (host !== addr.address) hosts.add(host);
      }
    }
  }
  return [...hosts];
}

async function subnetScan() {
  const hosts = localSubnetHosts();
  const open = [];
  const BATCH = 128;
  for (let i = 0; i < hosts.length; i += BATCH) {
    const batch = hosts.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((h) => isPortOpen(h, 8001, 600)));
    batch.forEach((h, idx) => results[idx] && open.push(h));
  }
  return open;
}

async function identify(hosts) {
  const results = await Promise.allSettled(hosts.map((host) => fetchDeviceInfo(host, 1500)));
  const tvs = [];
  results.forEach((result, idx) => {
    if (result.status !== 'fulfilled') return;
    const info = result.value || {};
    const device = info.device || {};
    const type = device.type || info.type || '';
    if (!/samsung/i.test(type)) return;
    tvs.push({
      host: hosts[idx],
      name: device.name || info.name || 'TV Samsung',
      model: device.modelName || '',
      mac: device.wifiMac || '',
    });
  });
  return tvs;
}

async function discover({ timeoutMs = 3000 } = {}) {
  let tvs = await identify(await ssdpSearch(timeoutMs));
  if (tvs.length === 0) tvs = await identify(await subnetScan());
  return tvs;
}

module.exports = { discover };
