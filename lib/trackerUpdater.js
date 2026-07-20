const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { dbQueryOne, dbQueryAll, dbExecute } = require('../database');
const processManager = require('./processManager');

const FLAG_ICON = (flags) => {
  if (flags & 1) return '⭐';
  if (flags & 4) return '☠️';
  if (flags & 2) return '🔵';
  return '▪️';
};

function _chunkLinesForEmbed(lines, maxLen = 4096) {
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const next = cur ? `${cur}\n\n${line}` : line;
    if (next.length > maxLen) {
      if (cur) chunks.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : ['_No data tracked yet._'];
}

async function buildGlobalEmbeds(gameId) {
  const game = await dbQueryOne('SELECT * FROM games WHERE id = ?', [gameId]);
  let players;
  try { players = JSON.parse(game?.players ?? '[]'); } catch { players = []; }

  const [sentRows, recvRows, goalRows, hintRows] = await Promise.all([
    dbQueryAll('SELECT senderName, COUNT(*) as count FROM game_items WHERE gameId = ? GROUP BY senderName', [gameId]),
    dbQueryAll('SELECT receiverName, COUNT(*) as count FROM game_items WHERE gameId = ? GROUP BY receiverName', [gameId]),
    dbQueryAll('SELECT playerName FROM game_goals WHERE gameId = ?', [gameId]),
    dbQueryAll('SELECT receiverName, COUNT(*) as total, SUM(found) as found FROM game_hints WHERE gameId = ? GROUP BY receiverName', [gameId]),
  ]);

  const sentMap = Object.fromEntries((sentRows ?? []).map((r) => [r.senderName,   r.count]));
  const recvMap = Object.fromEntries((recvRows ?? []).map((r) => [r.receiverName, r.count]));
  const goalSet = new Set((goalRows ?? []).map((g) => g.playerName));
  const hintMap = Object.fromEntries((hintRows ?? []).map((r) => [r.receiverName, r]));

  let locationCounts = {};
  try { locationCounts = JSON.parse(game.locationCounts ?? '{}'); } catch {}
  const apClient = processManager.getClient(gameId);

  const lines = players.map((p) => {
    const sent  = sentMap[p.name] ?? 0;
    const recv  = recvMap[p.name] ?? 0;
    const goal  = goalSet.has(p.name) ? '✅' : '❌';
    const h     = hintMap[p.name];
    const hints = h ? `${h.found}/${h.total}` : '0/0';
    // Primary: exact count from game archive; AP name may differ from YAML name (e.g. Player{number} → Player1)
    let total = locationCounts[p.name] ?? null;
    if (total == null && apClient) {
      const apSlot = apClient.players?.find((ap) => ap.name === p.name)
                  ?? apClient.players?.find((ap) => ap.game === p.game);
      if (apSlot) total = locationCounts[apSlot.name] ?? null;
    }
    const checksStr = total != null ? `${sent}/${total}` : String(sent);
    return `**${p.name}** (${p.game})\n┣ Checks: ${checksStr} │ Recv: ${recv} │ Hints: ${hints} │ Goal: ${goal}`;
  });

  const chunks = _chunkLinesForEmbed(lines, 4096);
  const totalPages = chunks.length;

  return chunks.map((description, idx) => (
    new EmbedBuilder()
      .setTitle(`Tracker: ${game?.gameName ?? 'Unknown'}` + (totalPages > 1 ? ` (page ${idx + 1}/${totalPages})` : ''))
      .setColor(0x00b0f4)
      .setDescription(description)
      .setFooter({ text: `Game #${gameId} • Hints: found/total • Live` })
      .setTimestamp()
  ));
}

async function buildPersonalEmbed(gameId, player, hideFound = false) {
  const [recvTotal, sentTotal, goalRow, recentItems, hints, outgoingHints] = await Promise.all([
    dbQueryOne('SELECT COUNT(*) as count FROM game_items WHERE gameId = ? AND receiverName = ?', [gameId, player.name]),
    dbQueryOne('SELECT COUNT(*) as count FROM game_items WHERE gameId = ? AND senderName = ?', [gameId, player.name]),
    dbQueryOne('SELECT completedAt FROM game_goals WHERE gameId = ? AND playerName = ?', [gameId, player.name]),
    dbQueryAll(
      'SELECT senderName, itemName, locationName, flags FROM game_items WHERE gameId = ? AND receiverName = ? ORDER BY sentAt DESC LIMIT 3',
      [gameId, player.name]
    ),
    dbQueryAll(
      `SELECT finderName, itemName, locationName, flags, found
       FROM game_hints WHERE gameId = ? AND receiverName = ?
       ORDER BY found ASC, (flags & 1) DESC, (flags & 2) DESC, hintedAt ASC`,
      [gameId, player.name]
    ),
    dbQueryAll(
      `SELECT receiverName, itemName, locationName, flags, found
       FROM game_hints WHERE gameId = ? AND finderName = ?
       ORDER BY found ASC, (flags & 1) DESC, (flags & 2) DESC, hintedAt ASC`,
      [gameId, player.name]
    ),
  ]);

  let itemList = (recentItems ?? [])
    .map((i) => `${FLAG_ICON(i.flags)} **${i.itemName ?? '???'}** ← ${i.senderName ?? '?'} (${i.locationName ?? '?'})`)
    .join('\n') || '_No items received yet._';
  if (itemList.length > 1020) itemList = itemList.slice(0, 1020) + '…';

  let hintList = '_No hints yet._';
  if (hints?.length) {
    const visibleHints = hideFound ? hints.filter((h) => !h.found) : hints;
    if (visibleHints.length === 0) {
      hintList = '_All hints found!_';
    } else {
      hintList = visibleHints.map((h) => {
        const icon = FLAG_ICON(h.flags);
        const line = `${icon} **${h.itemName ?? '???'}** @ ${h.locationName ?? '?'} *(${h.finderName ?? '?'})*`;
        return h.found ? `~~${line}~~` : line;
      }).join('\n');
      if (hintList.length > 1020) hintList = hintList.slice(0, 1020) + '…';
    }
  }

  let outgoingList = '_Nobody is waiting on your world._';
  if (outgoingHints?.length) {
    const visibleOutgoing = hideFound ? outgoingHints.filter((h) => !h.found) : outgoingHints;
    if (visibleOutgoing.length === 0) {
      outgoingList = '_All outgoing hints checked!_';
    } else {
      outgoingList = visibleOutgoing.map((h) => {
        const icon = FLAG_ICON(h.flags);
        const line = `${icon} **${h.itemName ?? '???'}** @ ${h.locationName ?? '?'} → ${h.receiverName ?? '?'}`;
        return h.found ? `~~${line}~~` : line;
      }).join('\n');
      if (outgoingList.length > 1020) outgoingList = outgoingList.slice(0, 1020) + '…';
    }
  }

  const unfoundHints    = (hints ?? []).filter((h) => !h.found).length;
  const totalHints      = (hints ?? []).length;
  const unfoundOutgoing = (outgoingHints ?? []).filter((h) => !h.found).length;
  const totalOutgoing   = (outgoingHints ?? []).length;

  const game2 = await dbQueryOne('SELECT locationCounts FROM games WHERE id = ?', [gameId]);
  let locationCounts2 = {};
  try { locationCounts2 = JSON.parse(game2?.locationCounts ?? '{}'); } catch {}
  let total2 = locationCounts2[player.name] ?? null;
  if (total2 == null) {
    const apClient2 = processManager.getClient(gameId);
    if (apClient2) {
      const apSlot2 = apClient2.players?.find((ap) => ap.name === player.name)
                   ?? apClient2.players?.find((ap) => ap.game === player.game);
      if (apSlot2) total2 = locationCounts2[apSlot2.name] ?? null;
    }
  }
  const checksValue = total2 != null ? `${sentTotal?.count ?? 0}/${total2}` : String(sentTotal?.count ?? 0);

  return new EmbedBuilder()
    .setTitle(`${player.name} — ${player.game}`)
    .setColor(0x00cc44)
    .addFields(
      { name: 'Checks done',    value: checksValue, inline: true },
      { name: 'Items received', value: String(recvTotal?.count ?? 0), inline: true },
      { name: 'Goal',           value: goalRow ? `✅ <t:${goalRow.completedAt}:R>` : '❌ Not yet', inline: true },
      { name: '​', value: '​' },
      { name: `Hints for me (${unfoundHints} remaining / ${totalHints} total)`, value: hintList },
      { name: '​', value: '​' },
      { name: `Hints in my world (${unfoundOutgoing} unchecked / ${totalOutgoing} total)`, value: outgoingList },
      { name: '​', value: '​' },
      { name: `Last ${recentItems?.length ?? 0} items received`, value: itemList },
    )
    .setFooter({ text: `Game #${gameId} • ⭐ prog  🔵 useful  ☠️ trap  ▪️ filler  ~~strikethrough~~ = found • Live` })
    .setTimestamp();
}

function buildPersonalPayload(embed, gameId, hideFound) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`trackerhide_${gameId}`)
      .setLabel(hideFound ? '👁 Show found' : '🙈 Hide found')
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

async function handleTrackerHide(interaction, gameId) {
  await interaction.deferUpdate();
  const tracker = await dbQueryOne(
    'SELECT * FROM player_trackers WHERE gameId = ? AND threadId = ?',
    [gameId, interaction.channelId]
  );
  if (!tracker) return;
  const newHideFound = tracker.hideFound ? 0 : 1;
  await dbExecute(
    'UPDATE player_trackers SET hideFound = ? WHERE gameId = ? AND threadId = ?',
    [newHideFound, gameId, interaction.channelId]
  );
  const game = await dbQueryOne('SELECT players FROM games WHERE id = ?', [gameId]);
  let players; try { players = JSON.parse(game?.players ?? '[]'); } catch { players = []; }
  const player = players.find((p) => p.name === tracker.playerName);
  if (!player) return;
  const embed = await buildPersonalEmbed(gameId, player, !!newHideFound);
  await interaction.editReply(buildPersonalPayload(embed, gameId, !!newHideFound));
}

async function setupTrackers(gameId, channel, players) {
  try {
    const embeds = await buildGlobalEmbeds(gameId);
    const messageIds = [];
    for (const embed of embeds) {
      const msg = await channel.send({ embeds: [embed] });
      messageIds.push(msg.id);
    }
    await dbExecute(
      'UPDATE games SET trackerMessageId = ?, trackerMessageIds = ? WHERE id = ?',
      [messageIds[0] ?? null, JSON.stringify(messageIds), gameId]
    );

    for (const player of players) {
      if (!player.name) continue;
      try {
        const thread = await channel.threads.create({
          name: `tracker-${player.name.slice(0, 90)}`,
          autoArchiveDuration: 10080, // 1 week
        });
        const embed = await buildPersonalEmbed(gameId, player, true);
        const threadMsg = await thread.send(buildPersonalPayload(embed, gameId, true));
        await dbExecute(
          'INSERT OR REPLACE INTO player_trackers (gameId, playerName, threadId, messageId) VALUES (?,?,?,?)',
          [gameId, player.name, thread.id, threadMsg.id]
        );
      } catch (e) {
        console.error(`[tracker-${gameId}] failed to create thread for ${player.name}:`, e.message);
      }
    }
  } catch (e) {
    console.error(`[tracker-${gameId}] setupTrackers error:`, e.message);
  }
}

// Debounce: batch rapid events into one update every 5s per game
const _pending = new Map();

function scheduleTrackerUpdate(gameId, channel) {
  if (_pending.has(gameId)) return;
  _pending.set(gameId, setTimeout(async () => {
    _pending.delete(gameId);
    await _doUpdate(gameId, channel);
  }, 5000));
}

async function _doUpdate(gameId, channel) {
  try {
    const game = await dbQueryOne('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) return;

    // Update global tracker messages (supports multi-message paging).
    try {
      let messageIds = null;
      if (game.trackerMessageIds) {
        try { messageIds = JSON.parse(game.trackerMessageIds); } catch { messageIds = null; }
      }
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        messageIds = game.trackerMessageId ? [game.trackerMessageId] : [];
      }
      if (messageIds.length) {
        const embeds = await buildGlobalEmbeds(gameId);
        const nextIds = [];

        // Edit existing messages, create new ones if needed.
        for (let i = 0; i < embeds.length; i++) {
          const embed = embeds[i];
          const existingId = messageIds[i];
          if (existingId) {
            try {
              const msg = await channel.messages.fetch(existingId);
              await msg.edit({ embeds: [embed] });
              nextIds.push(existingId);
            } catch {
              const msg = await channel.send({ embeds: [embed] });
              nextIds.push(msg.id);
            }
          } else {
            const msg = await channel.send({ embeds: [embed] });
            nextIds.push(msg.id);
          }
        }

        // Delete any extra old pages that are no longer needed.
        for (let i = embeds.length; i < messageIds.length; i++) {
          const extraId = messageIds[i];
          try {
            const msg = await channel.messages.fetch(extraId);
            await msg.delete().catch(() => {});
          } catch (_) {}
        }

        await dbExecute(
          'UPDATE games SET trackerMessageId = ?, trackerMessageIds = ? WHERE id = ?',
          [nextIds[0] ?? null, JSON.stringify(nextIds), gameId]
        );
      }
    } catch (e) {
      console.error(`[tracker-${gameId}] global update error:`, e.message);
    }

    const trackers = await dbQueryAll('SELECT * FROM player_trackers WHERE gameId = ?', [gameId]);
    if (!trackers) return;

    let players;
    try { players = JSON.parse(game.players ?? '[]'); } catch { players = []; }

    await Promise.all(trackers.map(async (tracker) => {
      const player = players.find((p) => p.name === tracker.playerName);
      if (!player) return;
      try {
        const thread = await channel.client.channels.fetch(tracker.threadId);
        const msg = await thread.messages.fetch(tracker.messageId);
        const embed = await buildPersonalEmbed(gameId, player, !!tracker.hideFound);
        await msg.edit(buildPersonalPayload(embed, gameId, !!tracker.hideFound));
      } catch (e) {
        console.error(`[tracker-${gameId}] thread update error for ${tracker.playerName}:`, e.message);
      }
    }));
  } catch (e) {
    console.error(`[tracker-${gameId}] update error:`, e.message);
  }
}

module.exports = { setupTrackers, scheduleTrackerUpdate, buildGlobalEmbeds, buildPersonalEmbed, handleTrackerHide };
