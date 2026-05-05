const { EventEmitter } = require('events');
const WebSocket = require('ws');

const RETRY_DELAY_MS = 5000;

class ArchipelagoClient extends EventEmitter {
  constructor(port, knownPlayers = [], { ssl = false } = {}) {
    super();
    this.port = port;
    this._ssl = ssl;
    this.players = [];
    this.ws = null;
    this._closed = false;
    this._tryNextSlot = false;
    this._itemIdToName = new Map();
    this._locationIdToName = new Map();
    this._slotToGame = new Map();
    this._locationCountByGame = new Map();
    this._dataPackageLoaded = false;
    this._pendingHints = [];
    // AP server requires `name` to match a real slot; connect under each player slot in turn.
    // Tag TextOnly + items_handling 0 keeps this connection passive (no item collisions
    // even though the bot shares a slot with the actual player client).
    this._slotCandidates = knownPlayers.map((p) => ({ name: p.name, game: p.game ?? p.gameName ?? '' }));
    this._slotIndex = 0;
  }

  connect() {
    if (this._closed) return;
    if (this._slotCandidates.length === 0) {
      console.warn(`[ap-client:${this.port}] No slot candidates — cannot connect.`);
      return;
    }
    this._pendingHints = [];
    try {
      const url = `${this._ssl ? 'wss' : 'ws'}://127.0.0.1:${this.port}`;
      // rejectUnauthorized:false because we connect to 127.0.0.1 but cert is issued for the public domain
      this.ws = new WebSocket(url, { rejectUnauthorized: false });
    } catch (e) {
      this._scheduleRetry();
      return;
    }

    this.ws.on('message', (data) => {
      let packets;
      try { packets = JSON.parse(data.toString()); } catch { return; }
      for (const packet of packets) {
        if (packet.cmd === 'RoomInfo') {
          const slot = this._slotCandidates[this._slotIndex];
          if (!slot) { try { this.ws.close(); } catch (_) {} continue; }
          this.ws.send(JSON.stringify([{
            cmd: 'Connect',
            game: slot.game,
            name: slot.name,
            uuid: 'archipelabot-spectator',
            version: { major: 0, minor: 6, build: 7, class: 'Version' },
            items_handling: 0,
            tags: ['TextOnly'],
            password: '',
          }]));
        } else if (packet.cmd === 'ConnectionRefused') {
          // Advance to next slot candidate; if exhausted, do a timed retry from the start
          this._slotIndex++;
          if (this._slotIndex < this._slotCandidates.length) {
            this._tryNextSlot = true;
          } else {
            this._slotIndex = 0;
          }
          try { this.ws.close(); } catch (_) {}
        } else if (packet.cmd === 'Connected') {
          this._slotIndex = 0;
          this._dataPackageLoaded = false;
          this.players = packet.players || [];
          for (const [slotStr, info] of Object.entries(packet.slot_info ?? {})) {
            this._slotToGame.set(parseInt(slotStr, 10), info.game ?? '');
          }
          this.emit('connected');

          // Request data packages to resolve item/location IDs to names
          try {
            const gameNames = [...new Set(
              Object.values(packet.slot_info ?? {}).map((s) => s.game).filter(Boolean)
            )];
            this.ws.send(JSON.stringify([{ cmd: 'GetDataPackage', games: gameNames }]));
          } catch (_) {}

          // Fetch all current hints + goal statuses from server data storage (backfill on reconnect)
          try {
            const realPlayers = this.players.filter((p) => p.slot > 0);
            const hintKeys = realPlayers.map((p) => `_read_hints_${p.team ?? 0}_${p.slot}`);
            const statusKeys = realPlayers.map((p) => `_read_client_status_${p.team ?? 0}_${p.slot}`);
            const keys = [...hintKeys, ...statusKeys];
            if (keys.length > 0) {
              this.ws.send(JSON.stringify([{ cmd: 'Get', keys }]));
            }
          } catch (_) {}

        } else if (packet.cmd === 'DataPackage') {
          const games = packet.data?.games ?? {};
          let itemCount = 0;
          let locCount = 0;
          for (const gameData of Object.values(games)) {
            for (const [name, id] of Object.entries(gameData.item_name_to_id ?? {})) {
              this._itemIdToName.set(id, name);
              itemCount++;
            }
            for (const [name, id] of Object.entries(gameData.location_name_to_id ?? {})) {
              this._locationIdToName.set(id, name);
              locCount++;
            }
          }
          for (const [gameName, gameData] of Object.entries(games)) {
            this._locationCountByGame.set(gameName, Object.keys(gameData.location_name_to_id ?? {}).length);
          }
          console.log(`[ap-client:${this.port}] DataPackage loaded: ${itemCount} items, ${locCount} locations`);

          // Resolve names for any hints that arrived before the DataPackage and emit them
          this._dataPackageLoaded = true;
          for (const hint of this._pendingHints) {
            hint.itemName = this._itemIdToName.get(hint.itemId) ?? null;
            hint.locationName = this._locationIdToName.get(hint.locationId) ?? null;
            this.emit('hint', hint);
          }
          this._pendingHints = [];

        } else if (packet.cmd === 'Retrieved') {
          // Response to Get _read_hints_* — all hints currently stored on the AP server
          const keysData = packet.keys ?? {};
          // Deduplicate: same hint appears in both receiver's and finder's key
          const seen = new Set();
          const newHints = [];
          for (const hintList of Object.values(keysData)) {
            if (!Array.isArray(hintList)) continue;
            for (const h of hintList) {
              if (!h || typeof h !== 'object') continue;
              const receivingSlot = h.receiving_player;
              const finderSlot = h.finding_player;
              const locationId = h.location;
              const itemId = h.item;
              const dedupeKey = `${receivingSlot},${finderSlot},${locationId},${itemId}`;
              if (seen.has(dedupeKey)) continue;
              seen.add(dedupeKey);
              newHints.push({
                receivingSlot,
                receiverName: this.players.find((p) => p.slot === receivingSlot)?.name ?? null,
                finderSlot,
                finderName: this.players.find((p) => p.slot === finderSlot)?.name ?? null,
                itemId,
                itemName: this._itemIdToName.get(itemId) ?? null,
                locationId,
                locationName: this._locationIdToName.get(locationId) ?? null,
                flags: h.item_flags ?? 0,
                found: !!h.found,
              });
            }
          }
          if (this._dataPackageLoaded) {
            for (const hint of newHints) this.emit('hint', hint);
          } else {
            this._pendingHints.push(...newHints);
          }

          // Backfill goal completions — CLIENT_GOAL = 30
          for (const [key, value] of Object.entries(keysData)) {
            if (!key.startsWith('_read_client_status_')) continue;
            if (value !== 30) continue;
            const parts = key.split('_');
            const slot = parseInt(parts[parts.length - 1], 10);
            const player = this.players.find((p) => p.slot === slot);
            if (player) this.emit('goal', { text: null, playerName: player.name, slot });
          }

        } else if (packet.cmd === 'PrintJSON') {
          const text = this._formatText(packet.data);
          this.emit('message', { text, type: packet.type, packet });
          if (packet.type === 'ItemSend') {
            const senderSlot = packet.item?.player;
            const receiverSlot = packet.receiving;
            this.emit('itemSend', {
              text,
              receivingSlot: receiverSlot,
              receiverName: this.players.find((p) => p.slot === receiverSlot)?.name ?? null,
              senderName: this.players.find((p) => p.slot === senderSlot)?.name ?? null,
              itemName: this._itemIdToName.get(packet.item?.item) ?? null,
              locationName: this._locationIdToName.get(packet.item?.location) ?? null,
              item: packet.item,
              isProgression: !!(packet.item?.flags & 1),
            });
          }
          if (packet.type === 'Goal') {
            // AP server puts the goaling slot at top level (MultiServer.py broadcast_text_all)
            const slot = packet.slot;
            const playerName = this.players.find((p) => p.slot === slot)?.name ?? null;
            console.log(`[ap-client:${this.port}] Goal resolved — name: ${playerName}, slot: ${slot}`);
            if (playerName) this.emit('goal', { text, playerName, slot });
          }
          if (packet.type === 'Hint') {
            const receiverSlot = packet.receiving;
            const finderSlot = packet.item?.player;
            this.emit('hint', {
              text,
              receivingSlot: receiverSlot,
              receiverName: this.players.find((p) => p.slot === receiverSlot)?.name ?? null,
              finderSlot,
              finderName: this.players.find((p) => p.slot === finderSlot)?.name ?? null,
              itemId: packet.item?.item ?? null,
              itemName: this._itemIdToName.get(packet.item?.item) ?? null,
              locationId: packet.item?.location ?? null,
              locationName: this._locationIdToName.get(packet.item?.location) ?? null,
              flags: packet.item?.flags ?? 0,
              found: packet.found ?? false,
            });
          }
        }
      }
    });

    this.ws.on('close', () => {
      if (this._closed) return;
      if (this._tryNextSlot) {
        this._tryNextSlot = false;
        this.connect(); // immediate retry with the next slot candidate
      } else {
        this._scheduleRetry();
      }
    });

    this.ws.on('error', () => {
      // 'close' fires after 'error', retry handled there
    });
  }

  _formatText(data) {
    return (data || []).map((part) => {
      switch (part.type) {
        case 'player_id': {
          const slot = parseInt(part.text, 10);
          const p = this.players.find((pl) => pl.slot === slot);
          return p?.alias || p?.name || part.text;
        }
        case 'item_id':
          return this._itemIdToName.get(parseInt(part.text, 10)) ?? part.text;
        case 'location_id':
          return this._locationIdToName.get(parseInt(part.text, 10)) ?? part.text;
        default:
          return part.text ?? '';
      }
    }).join('');
  }

  _scheduleRetry() {
    if (this._closed) return;
    setTimeout(() => this.connect(), RETRY_DELAY_MS);
  }

  getPlayerBySlot(slot) {
    return this.players.find((p) => p.slot === slot) ?? null;
  }

  getTotalLocationsForSlot(slot) {
    const game = this._slotToGame.get(slot);
    if (!game) return null;
    return this._locationCountByGame.get(game) ?? null;
  }

  close() {
    this._closed = true;
    try { this.ws?.close(); } catch (_) {}
  }
}

module.exports = ArchipelagoClient;
