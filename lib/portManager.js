const { dbQueryAll } = require('../database');
const config = require('../config.json');

const inUsePorts = new Set();

module.exports = {
  async init() {
    const rows = await dbQueryAll("SELECT port FROM games WHERE status = 'running' AND port IS NOT NULL");
    if (rows) rows.forEach((r) => inUsePorts.add(r.port));
  },

  allocate() {
    const { min, max } = config.portRange;
    for (let port = min; port <= max; port++) {
      if (!inUsePorts.has(port)) {
        inUsePorts.add(port);
        return port;
      }
    }
    return null;
  },

  release(port) {
    inUsePorts.delete(port);
  },

  countAvailable() {
    const { min, max } = config.portRange;
    return (max - min + 1) - inUsePorts.size;
  },
};
