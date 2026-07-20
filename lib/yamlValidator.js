const yaml = require('js-yaml');
const fs = require('fs');

function validateOne(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object') {
    return { errors: ['File is not a valid YAML object'], game: null, player: null };
  }
  if (!parsed.name) errors.push('Missing required field: `name`');
  if (!parsed.game) errors.push('Missing required field: `game`');
  return { errors, game: parsed.game ?? null, player: parsed.name ?? null };
}

module.exports = {
  validateFile(filePath) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return { valid: false, errors: [`Cannot read file: ${e.message}`], players: [] };
    }

    // A YAML file may contain multiple documents separated by ---
    let docs;
    try {
      docs = yaml.loadAll(raw).filter(Boolean);
    } catch (e) {
      return { valid: false, errors: [`YAML parse error: ${e.message}`], players: [] };
    }

    if (docs.length === 0) {
      return { valid: false, errors: ['File is empty'], players: [] };
    }

    const allErrors = [];
    const players = [];
    for (const doc of docs) {
      const { errors, game, player } = validateOne(doc);
      allErrors.push(...errors);
      if (player) players.push({ name: player, game });
    }

    return { valid: allErrors.length === 0, errors: allErrors, players };
  },
};
