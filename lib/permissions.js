const { PermissionFlagsBits } = require('discord.js');
const config = require('../config.json');

module.exports = {
  isAdmin(member) {
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    return (config.adminRoles ?? []).some((roleId) => member.roles.cache.has(roleId));
  },
};
