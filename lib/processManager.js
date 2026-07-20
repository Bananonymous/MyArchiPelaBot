const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const net = require('net');
const portManager = require('./portManager');
const ArchipelagoClient = require('./archipelagoClient');
const config = require('../config.json');
const { dbQueryOne, dbExecute } = require('../database');

// AP resolves {NUMBER}/{PLAYER} templates in a YAML `name:` field before assigning
// the real slot name, so the name we stored from the YAML can differ from what the
// server actually calls that slot (and from what item-send events report as
// senderName/receiverName). Once connected, AP's own player list is authoritative —
// rewrite games.players to match it (by slot order, which mirrors YAML doc order)
// so every later lookup by exact name (SQL, map keys) just works.
async function reconcilePlayerNames(gameId, client, knownPlayers) {
  try {
    const realSlots = client.players.filter((p) => p.slot > 0).sort((a, b) => a.slot - b.slot);
    if (realSlots.length !== knownPlayers.length) return;
    if (realSlots.every((p, i) => p.name === knownPlayers[i].name)) return;

    const game = await dbQueryOne('SELECT players FROM games WHERE id = ?', [gameId]);
    if (!game) return;
    let players;
    try { players = JSON.parse(game.players ?? '[]'); } catch { return; }
    if (players.length !== realSlots.length) return;

    let changed = false;
    const updated = players.map((p, i) => {
      if (p.name !== realSlots[i].name) { changed = true; return { ...p, name: realSlots[i].name }; }
      return p;
    });
    if (changed) {
      await dbExecute('UPDATE games SET players = ? WHERE id = ?', [JSON.stringify(updated), gameId]);
      console.log(`[game-${gameId}] Reconciled player names with AP-resolved slot names.`);
    }
  } catch (e) {
    console.warn(`[game-${gameId}] name reconcile failed: ${e.message}`);
  }
}

// gameId (integer) -> { process, port, client, stdout: EventEmitter }
const running = new Map();

function waitForPort(proc, port, timeoutMs = 20000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (proc.exitCode !== null) {
        reject(new Error(`Server process exited before binding port ${port}.`));
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for server to bind port ${port} (${timeoutMs}ms).`));
        return;
      }
      const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 800 });
      sock.on('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => {
        sock.destroy();
        setTimeout(tryOnce, 200);
      });
      sock.on('timeout', () => {
        sock.destroy();
        setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

module.exports = {
  start(gameId, archipelagoFile, port, knownPlayers = [], options = {}) {
    return new Promise((resolve, reject) => {
      const sslArgs = config.ssl?.cert && config.ssl?.key
        ? ['--cert', config.ssl.cert, '--cert_key', config.ssl.key]
        : [];
      const optionArgs = [
        '--release_mode',   options.release_mode   ?? 'goal',
        '--collect_mode',   options.collect_mode   ?? 'goal',
        '--remaining_mode', options.remaining_mode ?? 'goal',
        '--hint_cost',      String(options.hint_cost ?? 10),
      ];
      // Don't pass --savefile: AP MultiServer silently ignores it for loading
      // and autosaves to <multidata>.apsave next to the multidata anyway.
      // Setting --savefile to a non-existent path made AP load fresh state on
      // restart, then the autosaver overwrote the real .apsave with empty data.
      const proc = spawn(
        'ArchipelagoServer',
        [archipelagoFile, '--port', String(port), '--host', '0.0.0.0', ...sslArgs, ...optionArgs],
        { stdio: ['pipe', 'pipe', 'pipe'], detached: false, env: { ...process.env, PYTHONUNBUFFERED: '1' } }
      );

      const stdout = new EventEmitter();
      running.set(gameId, { process: proc, port, client: null, stdout });

      // Persist server logs to disk for debugging/auditing.
      let logOut = null;
      let logErr = null;
      try {
        const logsDir = path.join(config.dataPath ?? '.', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        logOut = fs.createWriteStream(path.join(logsDir, `ap-${gameId}-${stamp}.out.log`), { flags: 'a' });
        logErr = fs.createWriteStream(path.join(logsDir, `ap-${gameId}-${stamp}.err.log`), { flags: 'a' });
      } catch (e) {
        console.warn(`[game-${gameId}] Could not open log files: ${e.message}`);
      }

      proc.stdout.on('data', (d) => {
        const line = d.toString().trim();
        console.log(`[game-${gameId}] ${line}`);
        try { logOut?.write(d); } catch (_) {}
        stdout.emit('line', line);
      });
      proc.stderr.on('data', (d) => {
        console.error(`[game-${gameId}] ${d.toString().trim()}`);
        try { logErr?.write(d); } catch (_) {}
      });
      proc.on('error', (err) => {
        running.get(gameId)?.client?.close();
        running.delete(gameId);
        void portManager.release(port);
        try { logOut?.end(); logErr?.end(); } catch (_) {}
        reject(err);
      });
      proc.on('close', () => {
        running.get(gameId)?.client?.close();
        running.delete(gameId);
        void portManager.release(port);
        try { logOut?.end(); logErr?.end(); } catch (_) {}
      });

      // Wait until the server is actually listening, then attach the WS client.
      waitForPort(proc, port, 20000).then(() => {
        const entry = running.get(gameId);
        if (entry) {
          const client = new ArchipelagoClient(port, knownPlayers, { ssl: !!(config.ssl?.cert && config.ssl?.key) });
          entry.client = client;
          client.connect();
          client.on('error', (e) => console.warn(`[game-${gameId}] AP WS error: ${e.message}`));
          client.on('connected', () => { void reconcilePlayerNames(gameId, client, knownPlayers); });
        }
        resolve(proc.pid);
      }).catch((e) => {
        // Fail fast: clean up reservation and process.
        try { proc.kill('SIGTERM'); } catch (_) {}
        running.get(gameId)?.client?.close();
        running.delete(gameId);
        void portManager.release(port);
        try { logOut?.end(); logErr?.end(); } catch (_) {}
        reject(e);
      });
    });
  },

  stop(gameId) {
    const entry = running.get(gameId);
    if (!entry) return false;
    try { entry.client?.close(); } catch (_) {}
    try { entry.process.kill('SIGTERM'); } catch (_) {}
    return true;
  },

  sendCommand(gameId, text, timeoutMs = 2500) {
    const entry = running.get(gameId);
    if (!entry) return null;
    entry.process.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
    return new Promise((resolve) => {
      const lines = [];
      const handler = (line) => lines.push(line);
      entry.stdout.on('line', handler);
      setTimeout(() => {
        entry.stdout.off('line', handler);
        resolve(lines);
      }, timeoutMs);
    });
  },

  getClient(gameId) {
    return running.get(gameId)?.client ?? null;
  },

  isAlive(gameId) {
    const entry = running.get(gameId);
    if (!entry) return false;
    return !entry.process.killed && entry.process.exitCode === null;
  },

  getPort(gameId) {
    return running.get(gameId)?.port ?? null;
  },

  sendBatch(gameId, lines) {
    const entry = running.get(gameId);
    if (!entry) return false;
    for (const line of lines) {
      entry.process.stdin.write(line.endsWith('\n') ? line : `${line}\n`);
    }
    return true;
  },

  getAllRunning() {
    return new Map(running);
  },
};
