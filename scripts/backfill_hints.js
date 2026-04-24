const WebSocket = require('ws');
const { dbInit, dbQueryOne, dbExecute } = require('./database');

(async () => {
  await dbInit();
  const game = await dbQueryOne('SELECT * FROM games WHERE id = 35');
  if (!game) { console.error('Game 35 not found'); process.exit(1); }

  let dbPlayers; try { dbPlayers = JSON.parse(game.players || '[]'); } catch { dbPlayers = []; }
  const slotCandidates = [
    { name: 'Archipelago', game: '' },
    ...dbPlayers.map(p => ({ name: p.name, game: p.game || '' })),
  ];
  let slotIndex = 0;

  const ws = new WebSocket('ws://127.0.0.1:' + game.port, { rejectUnauthorized: false });
  const itemMap = new Map(), locMap = new Map();
  let apPlayers = [];

  ws.on('message', async (data) => {
    for (const p of JSON.parse(data.toString())) {
      if (p.cmd === 'RoomInfo') {
        const slot = slotCandidates[slotIndex] || slotCandidates[0];
        ws.send(JSON.stringify([{
          cmd: 'Connect', game: slot.game, name: slot.name, uuid: 'backfill',
          version: { major: 0, minor: 6, build: 0, class: 'Version' },
          items_handling: 0, tags: ['TextOnly'], password: '',
        }]));

      } else if (p.cmd === 'ConnectionRefused') {
        slotIndex++;
        if (slotIndex >= slotCandidates.length) {
          console.error('All slots refused:', JSON.stringify(p.errors));
          ws.close(); process.exit(1);
        }
        console.log('Slot refused, trying: ' + slotCandidates[slotIndex].name);
        ws.send(JSON.stringify([{
          cmd: 'Connect', game: slotCandidates[slotIndex].game, name: slotCandidates[slotIndex].name, uuid: 'backfill',
          version: { major: 0, minor: 6, build: 0, class: 'Version' },
          items_handling: 0, tags: ['TextOnly'], password: '',
        }]));

      } else if (p.cmd === 'Connected') {
        apPlayers = p.players || [];
        const games = [...new Set(Object.values(p.slot_info || {}).map(s => s.game).filter(Boolean))];
        const keys = apPlayers.filter(pl => pl.slot > 0).map(pl => '_read_hints_' + (pl.team || 0) + '_' + pl.slot);
        console.log('Connected. Requesting DataPackage + hints for ' + keys.length + ' slots...');
        ws.send(JSON.stringify([{ cmd: 'GetDataPackage', games }, { cmd: 'Get', keys }]));

      } else if (p.cmd === 'DataPackage') {
        for (const g of Object.values((p.data && p.data.games) || {})) {
          for (const [n, id] of Object.entries(g.item_name_to_id || {})) itemMap.set(id, n);
          for (const [n, id] of Object.entries(g.location_name_to_id || {})) locMap.set(id, n);
        }
        console.log('DataPackage: ' + itemMap.size + ' items, ' + locMap.size + ' locations');

      } else if (p.cmd === 'Retrieved') {
        // Clear malformed rows from old bug (itemId was always null due to packet.item.id vs packet.item.item)
        await dbExecute('DELETE FROM game_hints WHERE gameId = 35 AND itemId IS NULL');
        console.log('Cleared old null-itemId rows.');

        const seen = new Set();
        let count = 0;
        for (const hintList of Object.values(p.keys || {})) {
          if (!Array.isArray(hintList)) continue;
          for (const h of hintList) {
            if (!h || typeof h !== 'object') continue;
            const rs = h.receiving_player, fs = h.finding_player;
            const locId = h.location, itemId = h.item;
            const dedupeKey = rs + ',' + fs + ',' + locId + ',' + itemId;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            const rName = (apPlayers.find(pl => pl.slot === rs) || {}).name || null;
            const fName = (apPlayers.find(pl => pl.slot === fs) || {}).name || null;
            await dbExecute(
              'INSERT INTO game_hints (gameId, receivingSlot, receiverName, finderSlot, finderName, itemId, itemName, locationId, locationName, flags, found, hintedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(gameId, receivingSlot, finderSlot, itemId, locationId) DO UPDATE SET found=excluded.found, itemName=excluded.itemName, locationName=excluded.locationName',
              [35, rs, rName, fs, fName, itemId, itemMap.get(itemId) || null, locId, locMap.get(locId) || null, h.item_flags || 0, h.found ? 1 : 0, Math.floor(Date.now() / 1000)]
            );
            count++;
          }
        }
        console.log('Done: inserted/updated ' + count + ' hints.');
        ws.close();
        process.exit(0);
      }
    }
  });

  ws.on('error', e => { console.error('WS error:', e.message); process.exit(1); });
  setTimeout(() => { console.error('Timeout'); ws.close(); process.exit(1); }, 15000);
})();
