const { dbQueryOne, dbExecute } = require('../database');
const processManager = require('./processManager');
const { scheduleTrackerUpdate } = require('./trackerUpdater');

const FEED_LEVELS = {
  none:       new Set([]),
  goals:      new Set(['Goal', 'Release', 'Collect', 'Hint']),
  items_prog: new Set(['ItemSend', 'Goal', 'Release', 'Collect', 'Hint']),
  items_all:  new Set(['ItemSend', 'Goal', 'Release', 'Collect', 'Hint', 'Join', 'Part', 'Chat']),
  full:       null, // null = relay everything
};

function shouldRelay(feedLevel, type, isProgression) {
  const allowed = feedLevel in FEED_LEVELS ? FEED_LEVELS[feedLevel] : FEED_LEVELS.none;
  if (allowed === null) return true;
  if (!allowed.has(type)) return false;
  if (feedLevel === 'items_prog' && type === 'ItemSend' && !isProgression) return false;
  return true;
}

async function getPlayerDiscordId(gameId, playerName) {
  const game = await dbQueryOne('SELECT players FROM games WHERE id = ?', [gameId]);
  if (!game) return null;
  let players;
  try { players = JSON.parse(game.players ?? '[]'); } catch { return null; }
  return players.find((p) => p.name === playerName && p.discordUserId)?.discordUserId ?? null;
}

async function attachGameNotifier(gameId, channel) {
  const apClient = processManager.getClient(gameId);
  if (!apClient) {
    console.warn(`[notifier-${gameId}] No AP client found`);
    return;
  }
  console.log(`[notifier-${gameId}] Attached to channel ${channel.id}`);

  apClient.on('message', async ({ text, type, packet }) => {
    try {
      const game = await dbQueryOne('SELECT feedLevel FROM games WHERE id = ?', [gameId]);
      const feedLevel = game?.feedLevel ?? 'none';
      const isProgression = !!(packet?.item?.flags & 1);
      if (!shouldRelay(feedLevel, type, isProgression)) return;
      await channel.send({ content: text.slice(0, 2000) });
    } catch (e) {
      console.error(`[notifier-${gameId}] message handler error:`, e.message);
    }
  });

  apClient.on('itemSend', async ({ text, receivingSlot, receiverName, senderName, itemName, locationName, item, isProgression }) => {
    // Always persist to DB for tracker
    try {
      await dbExecute(
        'INSERT INTO game_items (gameId, senderName, receiverName, itemName, locationName, flags, sentAt) VALUES (?,?,?,?,?,?,?)',
        [gameId, senderName, receiverName, itemName, locationName, item?.flags ?? 0, Math.floor(Date.now() / 1000)]
      );
      // Mark any hint for this location as found (AP server doesn't always send Hint PrintJSON on check)
      if (item?.player != null && item?.location != null) {
        await dbExecute(
          'UPDATE game_hints SET found = 1 WHERE gameId = ? AND finderSlot = ? AND locationId = ?',
          [gameId, item.player, item.location]
        );
      }
      scheduleTrackerUpdate(gameId, channel);
    } catch (e) {
      console.error(`[notifier-${gameId}] itemSend DB save error:`, e.message);
    }

    // Priority ping for progression items — sent to the player's tracker thread
    if (!isProgression) return;
    try {
      const player = apClient.getPlayerBySlot(receivingSlot);
      if (!player) return;
      const discordUserId = await getPlayerDiscordId(gameId, player.name);
      if (!discordUserId) return;
      const notif = await dbQueryOne(
        'SELECT enabled FROM notifications WHERE userId = ? AND gameId = ?',
        [discordUserId, gameId]
      );
      if (!notif?.enabled) return;
      const tracker = await dbQueryOne(
        'SELECT threadId FROM player_trackers WHERE gameId = ? AND playerName = ?',
        [gameId, player.name]
      );
      const target = tracker?.threadId
        ? (await channel.client.channels.fetch(tracker.threadId).catch(() => null)) ?? channel
        : channel;
      await target.send({ content: `<@${discordUserId}> ${text}`.slice(0, 2000) });
    } catch (e) {
      console.error(`[notifier-${gameId}] itemSend ping error:`, e.message);
    }
  });

  apClient.on('hint', async ({ receivingSlot, receiverName, finderSlot, finderName, itemId, itemName, locationId, locationName, flags, found }) => {
    try {
      await dbExecute(
        `INSERT INTO game_hints
           (gameId, receivingSlot, receiverName, finderSlot, finderName, itemId, itemName, locationId, locationName, flags, found, hintedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(gameId, receivingSlot, finderSlot, itemId, locationId)
         DO UPDATE SET found = excluded.found, itemName = excluded.itemName, locationName = excluded.locationName`,
        [gameId, receivingSlot, receiverName, finderSlot, finderName, itemId, itemName, locationId, locationName, flags, found ? 1 : 0, Math.floor(Date.now() / 1000)]
      );
      scheduleTrackerUpdate(gameId, channel);
    } catch (e) {
      console.error(`[notifier-${gameId}] hint DB save error:`, e.message);
    }

    // Ping the finder in their tracker thread (they have the item in their world)
    if (found) return; // already checked — no need to ping
    try {
      const finderDiscordId = await getPlayerDiscordId(gameId, finderName);
      if (!finderDiscordId) return;
      const notif = await dbQueryOne(
        'SELECT enabled FROM notifications WHERE userId = ? AND gameId = ?',
        [finderDiscordId, gameId]
      );
      if (!notif?.enabled) return;
      const tracker = await dbQueryOne(
        'SELECT threadId FROM player_trackers WHERE gameId = ? AND playerName = ?',
        [gameId, finderName]
      );
      const target = tracker?.threadId
        ? (await channel.client.channels.fetch(tracker.threadId).catch(() => null)) ?? channel
        : channel;
      const icon = (flags & 1) ? '⭐' : (flags & 4) ? '☠️' : (flags & 2) ? '🔵' : '▪️';
      await target.send({
        content: `<@${finderDiscordId}> 💡 **${receiverName}** hinted **${icon} ${itemName ?? '???'}** at \`${locationName ?? '?'}\` in your world!`,
      });
    } catch (e) {
      console.error(`[notifier-${gameId}] hint ping error:`, e.message);
    }
  });

  apClient.on('goal', async ({ playerName }) => {
    try {
      if (!playerName) return;
      await dbExecute(
        'INSERT OR REPLACE INTO game_goals (gameId, playerName, completedAt) VALUES (?,?,?)',
        [gameId, playerName, Math.floor(Date.now() / 1000)]
      );
      scheduleTrackerUpdate(gameId, channel);
    } catch (e) {
      console.error(`[notifier-${gameId}] goal DB save error:`, e.message);
    }
  });
}

module.exports = { attachGameNotifier };
