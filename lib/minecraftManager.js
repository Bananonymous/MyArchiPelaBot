const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const config = require('../config.json');

// gameId -> child process
const running = new Map();

function findServerStartable(serverPath) {
  const files = fs.readdirSync(serverPath);
  // Modern Forge (1.19.4+) ships run.sh / run.bat instead of a standalone jar
  if (files.includes('run.sh')) return { type: 'sh', file: 'run.sh' };
  const jar = files.find((f) => /^forge-.*\.jar$/.test(f)) ?? files.find((f) => f === 'server.jar');
  if (jar) return { type: 'jar', file: jar };
  return null;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '0.0.0.0');
  });
}

// Minecraft only reads its port from server.properties (no CLI override), so a
// port conflict (e.g. another Minecraft server already bound to 25565 on this
// host) has to be resolved by rewriting that file before spawning.
async function ensureFreePort(serverPath) {
  const propsPath = path.join(serverPath, 'server.properties');
  let contents = '';
  try { contents = fs.readFileSync(propsPath, 'utf8'); } catch (_) {}

  const match = contents.match(/^server-port=(\d+)\s*$/m);
  let port = match ? parseInt(match[1], 10) : 25565;

  let attempts = 0;
  while (!(await isPortFree(port)) && attempts < 50) {
    port++;
    attempts++;
  }

  if (match && parseInt(match[1], 10) !== port) {
    contents = contents.replace(/^server-port=\d+\s*$/m, `server-port=${port}`);
    fs.writeFileSync(propsPath, contents);
  } else if (!match && contents) {
    fs.writeFileSync(propsPath, `${contents}\nserver-port=${port}\n`);
  }

  return port;
}

module.exports = {
  isMinecraftGame(players) {
    if (!Array.isArray(players) || players.length === 0) return false;
    const names = (config.minecraftGameNames ?? ['Minecraft', 'Minecraft Dig'])
      .map((n) => n.toLowerCase());
    return players.some((p) => p.game && names.includes(p.game.toLowerCase()));
  },

  async start(gameId, archivePath, apServerAddress) {
    const serverPath = config.minecraftServerPath;
    if (!serverPath) throw new Error('minecraftServerPath is not set in config.json');

    const conflicting = [...running.entries()].find(([id]) => id !== gameId);
    if (conflicting) {
      throw new Error(`Minecraft server is already running for game ${conflicting[0]}. Only one Minecraft instance is supported at a time.`);
    }

    // Apply the .apmc patch (sets up APData and syncs mod jar) before starting Forge
    if (archivePath) {
      await new Promise((resolve, reject) => {
        const script = path.join(__dirname, '../scripts/apply_minecraft_patch.py');
        const scriptArgs = [script, archivePath, serverPath];
        if (apServerAddress) scriptArgs.push(apServerAddress);
        execFile('python3', scriptArgs, (err, stdout, stderr) => {
          if (stderr) console.log(`[mc-${gameId}] ${stderr.trim()}`);
          if (stdout) console.log(`[mc-${gameId}] ${stdout.trim()}`);
          if (err) {
            console.error(`[mc-${gameId}] Patch setup failed (continuing anyway): ${err.message}`);
          }
          resolve(); // non-fatal — attempt Forge start regardless
        });
      });
    }

    const startable = findServerStartable(serverPath);
    if (!startable) throw new Error(`No Forge/server JAR or run.sh found in ${serverPath}`);

    // Minecraft always reads its port from server.properties regardless of
    // launch method — bump it off any port already bound on this host (e.g.
    // another Minecraft server already running) before spawning.
    const mcPort = await ensureFreePort(serverPath);

    const jvmArgs = (config.minecraftJvmArgs ?? '-Xmx2G -Xms1G').split(/\s+/).filter(Boolean);

    // run.sh already embeds the correct java/classpath; pass JVM args via env
    const [cmd, args] =
      startable.type === 'sh'
        ? ['bash', [startable.file, 'nogui']]
        : ['java', [...jvmArgs, '-jar', startable.file, 'nogui']];

    const env = { ...process.env };
    if (startable.type === 'sh') {
      // Prepend JVM args so run.sh picks them up via JAVA_TOOL_OPTIONS or similar
      env.JVM_ARGS = jvmArgs.join(' ');
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        cwd: serverPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        detached: true,  // own process group so we can kill the whole tree
      });

      running.set(gameId, { proc, port: mcPort });

      proc.stdout.on('data', (d) => console.log(`[mc-${gameId}] ${d.toString().trim()}`));
      proc.stderr.on('data', (d) => console.error(`[mc-${gameId}] ${d.toString().trim()}`));
      proc.on('error', (err) => { running.delete(gameId); reject(err); });
      proc.on('close', () => running.delete(gameId));

      // Give server a moment to start before resolving
      setTimeout(() => resolve({ pid: proc.pid, port: mcPort }), 2000);
    });
  },

  stop(gameId) {
    const entry = running.get(gameId);
    if (!entry) return false;
    try {
      // Kill the entire process group (bash run.sh + child Java) via negative PID
      process.kill(-entry.proc.pid, 'SIGTERM');
    } catch (_) {
      try { entry.proc.kill('SIGTERM'); } catch (__) {}
    }
    running.delete(gameId);
    return true;
  },

  isRunning(gameId) {
    const entry = running.get(gameId);
    return entry ? !entry.proc.killed && entry.proc.exitCode === null : false;
  },

  getPort(gameId) {
    return running.get(gameId)?.port ?? null;
  },
};
