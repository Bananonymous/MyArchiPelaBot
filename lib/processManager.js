const { spawn } = require('child_process');
const portManager = require('./portManager');
const ArchipelagoClient = require('./archipelagoClient');
const config = require('../config.json');

// gameId (integer) -> { process, port, client }
const running = new Map();

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
      const proc = spawn(
        'ArchipelagoServer',
        [archipelagoFile, '--port', String(port), '--host', '0.0.0.0', ...sslArgs, ...optionArgs],
        { stdio: ['ignore', 'pipe', 'pipe'], detached: false }
      );

      running.set(gameId, { process: proc, port, client: null });

      proc.stdout.on('data', (d) => console.log(`[game-${gameId}] ${d.toString().trim()}`));
      proc.stderr.on('data', (d) => console.error(`[game-${gameId}] ${d.toString().trim()}`));
      proc.on('error', (err) => {
        running.get(gameId)?.client?.close();
        running.delete(gameId);
        portManager.release(port);
        reject(err);
      });
      proc.on('close', () => {
        running.get(gameId)?.client?.close();
        running.delete(gameId);
        portManager.release(port);
      });

      // Give server time to bind the port before resolving and starting WS client
      setTimeout(() => {
        const entry = running.get(gameId);
        if (entry) {
          const client = new ArchipelagoClient(port, knownPlayers, { ssl: !!(config.ssl?.cert && config.ssl?.key) });
          entry.client = client;
          client.connect();
          client.on('error', (e) => console.warn(`[game-${gameId}] AP WS error: ${e.message}`));
        }
        resolve(proc.pid);
      }, 1500);
    });
  },

  stop(gameId) {
    const entry = running.get(gameId);
    if (!entry) return false;
    try { entry.client?.close(); } catch (_) {}
    try { entry.process.kill('SIGTERM'); } catch (_) {}
    return true;
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

  getAllRunning() {
    return new Map(running);
  },
};
