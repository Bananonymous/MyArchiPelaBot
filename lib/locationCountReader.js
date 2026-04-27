const { execFile } = require('child_process');
const path = require('path');

function readLocationCounts(archivePath) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '../scripts/get_location_counts.py');
    execFile('python3', [script, archivePath], (err, stdout, stderr) => {
      if (stderr?.trim()) console.warn(`[locationCounts] ${stderr.trim()}`);
      if (err) { console.warn(`[locationCounts] script error: ${err.message}`); return resolve({}); }
      if (!stdout?.trim()) return resolve({});
      try {
        const counts = JSON.parse(stdout.trim());
        if (Object.keys(counts).length > 0) console.log(`[locationCounts] Parsed: ${JSON.stringify(counts)}`);
        resolve(counts);
      } catch { resolve({}); }
    });
  });
}

module.exports = { readLocationCounts };
