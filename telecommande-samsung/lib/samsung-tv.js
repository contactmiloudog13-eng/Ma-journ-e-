'use strict';

// Client pour l'API réseau des TV Samsung Tizen (2016+).
// - Port 8001 : API HTTP (infos de la TV) et WebSocket non chiffré (anciens modèles)
// - Port 8002 : WebSocket chiffré avec jeton d'appairage (modèles 2018+)

const { EventEmitter } = require('node:events');
const dgram = require('node:dgram');
const WebSocket = require('ws');

// Nom affiché sur la TV dans la demande d'autorisation (ASCII pour éviter les soucis d'affichage).
const CLIENT_NAME = 'Ma telecommande';
const PAIRING_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10_000;

const base64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

function friendlyError(err) {
  const unreachable = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'];
  if (unreachable.includes(err.code) || /timed? ?out/i.test(err.message)) {
    return new Error('TV injoignable : est-elle allumée et connectée au même réseau ?');
  }
  return err;
}

async function fetchDeviceInfo(host, timeoutMs = 3000) {
  const res = await fetch(`http://${host}:8001/api/v2/`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Réponse inattendue de la TV (HTTP ${res.status})`);
  return res.json();
}

// Allume la TV en envoyant un « paquet magique » Wake-on-LAN.
// Nécessite l'option « Allumer avec le mobile » activée sur la TV.
async function wakeOnLan(mac, { address = '255.255.255.255', port = 9, repeat = 3 } = {}) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error('Adresse MAC invalide (format attendu : AA:BB:CC:DD:EE:FF)');

  const macBytes = Buffer.from(hex, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);

  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(() => {
        socket.setBroadcast(true);
        resolve();
      });
    });
    for (let i = 0; i < repeat; i++) {
      await new Promise((resolve, reject) => {
        socket.send(packet, port, address, (err) => (err ? reject(err) : resolve()));
      });
    }
  } finally {
    socket.close();
  }
}

class SamsungTV extends EventEmitter {
  constructor({ host, token = null, secure = true }) {
    super();
    this.host = host;
    this.token = token;
    this.secure = secure;
    this.ws = null;
    this.connecting = null;
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  connect({ timeoutMs = this.token ? COMMAND_TIMEOUT_MS : PAIRING_TIMEOUT_MS } = {}) {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const port = this.secure ? 8002 : 8001;
      const protocol = this.secure ? 'wss' : 'ws';
      let url = `${protocol}://${this.host}:${port}/api/v2/channels/samsung.remote.control?name=${base64(CLIENT_NAME)}`;
      if (this.token) url += `&token=${encodeURIComponent(this.token)}`;

      // La TV utilise un certificat auto-signé : on ne peut pas le vérifier.
      const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000 });
      let settled = false;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connecting = null;
        if (err) {
          ws.terminate();
          reject(err);
        } else {
          this.ws = ws;
          resolve();
        }
      };

      const timer = setTimeout(() => {
        finish(new Error('La TV n’a pas répondu à temps. Si une demande d’autorisation s’affiche, choisissez « Autoriser ».'));
      }, timeoutMs);

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        switch (msg.event) {
          case 'ms.channel.connect': {
            const token = msg.data && msg.data.token;
            if (token && String(token) !== this.token) {
              this.token = String(token);
              this.emit('token', this.token);
            }
            finish();
            break;
          }
          case 'ms.channel.unauthorized':
            finish(new Error('La TV a refusé l’accès. Autorisez « Ma telecommande » dans Paramètres › Général › Gestionnaire de périphériques externes.'));
            break;
          case 'ms.channel.timeOut':
            finish(new Error('La demande d’autorisation a expiré sur la TV. Réessayez.'));
            break;
          default:
            this.emit('message', msg);
        }
      });

      ws.on('error', (err) => finish(friendlyError(err)));
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        finish(new Error('La TV a fermé la connexion.'));
      });
    });

    return this.connecting;
  }

  async send(payload) {
    const data = JSON.stringify(payload);
    // Si la connexion est tombée (TV mise en veille puis rallumée…), on se reconnecte une fois.
    for (let attempt = 0; ; attempt++) {
      await this.connect();
      try {
        await new Promise((resolve, reject) => {
          if (!this.ws) return reject(new Error('Connexion perdue'));
          this.ws.send(data, (err) => (err ? reject(err) : resolve()));
        });
        return;
      } catch (err) {
        this.close();
        if (attempt >= 1) throw friendlyError(err);
      }
    }
  }

  // cmd : 'Click' (appui simple), 'Press' (maintenir) ou 'Release' (relâcher)
  sendKey(key, cmd = 'Click') {
    return this.send({
      method: 'ms.remote.control',
      params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
    });
  }

  // Fonctionne uniquement quand un champ de saisie est ouvert sur la TV.
  async sendText(text) {
    await this.send({
      method: 'ms.remote.control',
      params: { Cmd: base64(text), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' },
    });
    await this.send({ method: 'ms.remote.control', params: { TypeOfRemote: 'SendInputEnd' } });
  }

  async getApps(timeoutMs = 5000) {
    await this.connect();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('message', onMessage);
      };
      const onMessage = (msg) => {
        if (msg.event !== 'ed.installedApp.get') return;
        cleanup();
        const apps = (msg.data && msg.data.data) || [];
        resolve(apps.map((app) => ({ appId: String(app.appId), name: app.name, appType: app.app_type })));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('La TV n’a pas renvoyé la liste des applis.'));
      }, timeoutMs);

      this.on('message', onMessage);
      this.send({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } }).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  // appType renvoyé par la TV : 2 = DEEP_LINK, 4 = NATIVE_LAUNCH
  launchApp(appId, appType = 2) {
    return this.send({
      method: 'ms.channel.emit',
      params: {
        event: 'ed.apps.launch',
        to: 'host',
        data: { appId: String(appId), action_type: appType === 4 ? 'NATIVE_LAUNCH' : 'DEEP_LINK', metaTag: '' },
      },
    });
  }

  close() {
    if (this.ws) {
      this.ws.removeAllListeners('close');
      this.ws.terminate();
      this.ws = null;
    }
  }
}

module.exports = { SamsungTV, fetchDeviceInfo, wakeOnLan };
