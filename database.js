const config = require('./config.json');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(config.sqliteFile || ':memory:');

module.exports = {
  dbInit: async () => {
    const tableQueries = [
      `
      CREATE TABLE IF NOT EXISTS games (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        guildId VARCHAR(128) NOT NULL,
        channelId VARCHAR(128),
        gameFile TEXT,
        port INTEGER,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        players TEXT,
        gameName TEXT,
        startedAt INTEGER,
        endedAt INTEGER
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS lobbies (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        guildId TEXT NOT NULL,
        channelId TEXT NOT NULL,
        creatorId TEXT NOT NULL,
        name TEXT NOT NULL,
        statusMessageId TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        createdAt INTEGER NOT NULL
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS lobby_players (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        lobbyId INTEGER NOT NULL,
        userId TEXT NOT NULL,
        playerName TEXT,
        gameName TEXT,
        yamlPath TEXT,
        joinedAt INTEGER NOT NULL,
        UNIQUE (lobbyId, userId)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS apworlds (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        version TEXT,
        filePath TEXT NOT NULL,
        installedAt INTEGER
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS notifications (
        userId TEXT NOT NULL,
        gameId INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (userId, gameId)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS game_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gameId INTEGER NOT NULL,
        senderName TEXT,
        receiverName TEXT,
        itemName TEXT,
        locationName TEXT,
        flags INTEGER NOT NULL DEFAULT 0,
        sentAt INTEGER NOT NULL
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS game_goals (
        gameId INTEGER NOT NULL,
        playerName TEXT NOT NULL,
        completedAt INTEGER NOT NULL,
        PRIMARY KEY (gameId, playerName)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS player_trackers (
        gameId INTEGER NOT NULL,
        playerName TEXT NOT NULL,
        threadId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        PRIMARY KEY (gameId, playerName)
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS game_hints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gameId INTEGER NOT NULL,
        receivingSlot INTEGER NOT NULL,
        receiverName TEXT,
        finderSlot INTEGER NOT NULL,
        finderName TEXT,
        itemId INTEGER,
        itemName TEXT,
        locationId INTEGER,
        locationName TEXT,
        flags INTEGER NOT NULL DEFAULT 0,
        found INTEGER NOT NULL DEFAULT 0,
        hintedAt INTEGER NOT NULL,
        UNIQUE(gameId, receivingSlot, finderSlot, itemId, locationId)
      )
      `
    ];
    for (let query of tableQueries) {
      await module.exports.dbExecute(query);
    }
    await module.exports.dbExecute(`ALTER TABLE games ADD COLUMN feedLevel TEXT NOT NULL DEFAULT 'none'`).catch(() => {});
    await module.exports.dbExecute(`ALTER TABLE games ADD COLUMN trackerMessageId TEXT`).catch(() => {});
    await module.exports.dbExecute(`ALTER TABLE lobbies ADD COLUMN options TEXT`).catch(() => {});
    await module.exports.dbExecute(`ALTER TABLE games ADD COLUMN gameOptions TEXT NOT NULL DEFAULT '{}'`).catch(() => {});
    await module.exports.dbExecute(`ALTER TABLE games ADD COLUMN locationCounts TEXT`).catch(() => {});
    // Clean up malformed hint rows from the packet.item.id bug (correct field is packet.item.item)
    await module.exports.dbExecute(`DELETE FROM game_hints WHERE itemId IS NULL`).catch(() => {});
  },

  // Execute a query on the database
  dbExecute: (sql, params=[]) => new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      // Reject on errors, provide the error
      if (err) { return reject(err); }

      // Execution is complete
      resolve();
    });
  }),

  dbQueryOne: (sql, params=[]) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      // Reject on errors, provide the error
      if (err) { return reject(err); }

      // Send back the row object
      resolve(row || null);
    });
  }),

  dbQueryAll: (sql, params=[]) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      // Reject on errors, provide the error
      if (err) { return reject(err); }

      // Send back the rows array
      resolve((rows.length === 0) ? null : rows);
    });
  }),
};