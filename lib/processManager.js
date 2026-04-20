const { spawn } = require('child_process');
const portManager = require('./portManager');

// gameId (integer) -> { process, port }
const running = new Map();

module.exports = {
  start(gameId, archipelagoFile, port) {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        'ArchipelagoServer',
        [archipelagoFile, '--port', String(port), '--host', '0.0.0.0'],
        { stdio: ['ignore', 'pipe', 'pipe'], detached: false }
      );

      running.set(gameId, { process: proc, port });

      proc.stdout.on('data', (d) => console.log(`[game-${gameId}] ${d.toString().trim()}`));
      proc.stderr.on('data', (d) => console.error(`[game-${gameId}] ${d.toString().trim()}`));
      proc.on('error', (err) => {
        running.delete(gameId);
        portManager.release(port);
        reject(err);
      });
      proc.on('close', () => {
        running.delete(gameId);
        portManager.release(port);
      });

      // Give server time to bind the port before resolving
      setTimeout(() => resolve(proc.pid), 1500);
    });
  },

  stop(gameId) {
    const entry = running.get(gameId);
    if (!entry) return false;
    try { entry.process.kill('SIGTERM'); } catch (_) {}
    return true;
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
