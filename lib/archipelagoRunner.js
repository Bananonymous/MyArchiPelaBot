const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    // Without this, Python fully buffers stdout when it's not a TTY (i.e. always,
    // since this is piped) — progress/errors only show up in `docker logs` once
    // the buffer flushes or the process exits, making a slow run look identical
    // to a hung one.
    const env = { ...process.env, PYTHONUNBUFFERED: '1' };
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        // Log full output to container logs, show only the last 1200 chars in Discord
        console.error(`[archipelagoRunner] ${cmd} failed (exit ${code}):\n${stderr}`);
        const tail = stderr.length > 1200 ? '…' + stderr.slice(-1200) : stderr;
        reject(new Error(`${cmd} exited ${code}\n${tail}`));
      }
    });
  });
}

module.exports = {
  async generate(yamlPaths, outputDir) {
    const playerDir = path.join(outputDir, 'players');
    fs.mkdirSync(playerDir, { recursive: true });

    for (const p of yamlPaths) {
      fs.copyFileSync(p, path.join(playerDir, path.basename(p)));
    }

    // apworlds are synced to /opt/archipelago/worlds/ by entrypoint.sh
    await run('ArchipelagoGenerate', [
      '--player_files_path', playerDir,
      '--outputpath', outputDir,
    ]);

    // Modern Archipelago outputs .zip; older versions used .archipelago
    const file = fs.readdirSync(outputDir)
      .find((f) => f.endsWith('.zip') || f.endsWith('.archipelago'));
    if (!file) throw new Error('ArchipelagoGenerate produced no output file (.zip or .archipelago)');
    return path.join(outputDir, file);
  },

  async generateTemplate(gameName, outputDir, username) {
    const helper = path.join(__dirname, '..', 'scripts', 'generate_template.py');
    const args = [helper, gameName, outputDir];
    if (username) args.push(username);
    await run('python3', args);
    const file = fs.readdirSync(outputDir).find((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    if (!file) throw new Error(`No template generated for: ${gameName}`);
    return path.join(outputDir, file);
  },

  async listGames() {
    const helper = path.join(__dirname, '..', 'scripts', 'list_games.py');
    const { stdout } = await run('python3', [helper]);
    return stdout.trim().split('\n').filter(Boolean);
  },
};
