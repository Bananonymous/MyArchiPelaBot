const { dbQueryAll, dbExecute, dbQueryOne } = require('../database');
const config = require('../config.json');

const inUsePorts = new Set();

module.exports = {
  async init() {
    const rows = await dbQueryAll("SELECT port FROM games WHERE status = 'running' AND port IS NOT NULL");
    if (rows) rows.forEach((r) => inUsePorts.add(r.port));

    // Also account for any reserved ports (e.g. mid-start during a crash)
    const reserved = await dbQueryAll('SELECT port FROM port_reservations');
    if (reserved) reserved.forEach((r) => inUsePorts.add(r.port));
  },

  async allocateForGame(gameId) {
    const { min, max } = config.portRange;
    for (let port = min; port <= max; port++) {
      if (!inUsePorts.has(port)) {
        try {
          // DB-backed reservation makes this survive bot restarts and prevents duplicates.
          await dbExecute(
            'INSERT INTO port_reservations (port, gameId, reservedAt) VALUES (?,?,?)',
            [port, gameId, Math.floor(Date.now() / 1000)]
          );
          inUsePorts.add(port);
          return port;
        } catch (_) {
          // Port was reserved concurrently (or stale). Keep scanning.
        }
      }
    }
    return null;
  },

  async release(port) {
    inUsePorts.delete(port);
    try { await dbExecute('DELETE FROM port_reservations WHERE port = ?', [port]); } catch (_) {}
  },

  countAvailable() {
    const { min, max } = config.portRange;
    return (max - min + 1) - inUsePorts.size;
  },

  async releaseByGameId(gameId) {
    const row = await dbQueryOne('SELECT port FROM port_reservations WHERE gameId = ?', [gameId]);
    if (!row?.port) return false;
    await module.exports.release(row.port);
    return true;
  },
};
