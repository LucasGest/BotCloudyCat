const { ActivityType, EmbedBuilder } = require('discord.js');
const { GAMES, IN_GAME_PREFIX, normalizeActivityName, resolveGame, inGameRoleName } = require('./games');
const { logError } = require('./logger');
const { safeAddRole } = require('./roleSafety');

const ACTIVITY_CHANNEL_ID = '1568628826320142414'; // #activité
const BASE_ROLE_ID = '1539944509566357557'; // ・Cloudy
const BOARD_DELAY_MS = 3_000;
const ROLE_LIMIT = 230;
const RESYNC_INTERVAL_MS = 60 * 60 * 1000; // revérification complète toutes les heures
// Rôles 🎮 des jeux détectés automatiquement : retirés après 2 heures sans
// jouer au jeu, vérifiés toutes les 2 heures. Les 4 jeux du serveur (boutons
// de #rôles, utilisés pour les pings) ne sont jamais retirés.
const GAME_ROLE_PREFIX = '🎮・';
const GAME_ROLE_IDLE_MS = 2 * 60 * 60 * 1000;
const GAME_ROLE_CHECK_MS = 2 * 60 * 60 * 1000;
const MAX_PLAYERS_PER_GAME = 15;
const BOARD_TITLE = '🎮 Qui joue en ce moment ?';

// Jeux en cours par membre, reconstruits depuis les présences : rien n'est
// enregistré, la liste repart de ce que Discord envoie au démarrage.
const playing = new Map();
const since = new Map(); // « membre|jeu » → début de la partie (ms)
// « membre|nom du rôle 🎮 » → dernière fois vu en train d'y jouer (ms). En
// mémoire : après un redémarrage, chacun repart avec 2 heures de répit.
const lastPlayed = new Map();
let lastGameRoleCheck = 0;
let boardTimer = null;
let resyncTimer = null;
const pendingRoles = new Map();

function gamesOf(presence) {
  return [...new Set(
    (presence?.activities ?? [])
      .filter((a) => a.type === ActivityType.Playing)
      .map((a) => normalizeActivityName(a.name))
      .filter(Boolean)
  )];
}

function displayName(name) {
  return resolveGame(name).label;
}

// Discord donne souvent l'heure de début de la partie ; sinon on la note à la détection.
function recordStarts(memberId, presence, names) {
  for (const key of since.keys()) {
    if (key.startsWith(`${memberId}|`) && !names.includes(key.slice(memberId.length + 1))) {
      since.delete(key);
    }
  }

  for (const activity of presence?.activities ?? []) {
    const name = normalizeActivityName(activity.name);
    const key = `${memberId}|${name}`;
    if (names.includes(name) && !since.has(key)) {
      since.set(key, activity.timestamps?.start?.getTime?.() ?? Date.now());
    }
  }
}

function setPlaying(memberId, presence, names) {
  if (names.length > 0) {
    playing.set(memberId, names);
  } else {
    playing.delete(memberId);
  }
  recordStarts(memberId, presence, names);
  const now = Date.now();
  for (const name of names) {
    lastPlayed.set(`${memberId}|${resolveGame(name).roleName}`, now);
  }
}

// Retire les rôles 🎮 automatiques des membres qui n'y ont pas joué depuis
// 2 heures, puis supprime les rôles devenus vides.
async function cleanupGameRoles(guild) {
  const official = new Set(GAMES.map((game) => game.roleName));
  const now = Date.now();
  let removed = 0;
  let deleted = 0;

  for (const role of [...guild.roles.cache.values()]) {
    if (!role.name.startsWith(GAME_ROLE_PREFIX) || official.has(role.name) || !role.editable) {
      continue;
    }

    for (const member of [...role.members.values()]) {
      const key = `${member.id}|${role.name}`;
      const stillPlaying = (playing.get(member.id) ?? []).some((name) => resolveGame(name).roleName === role.name);
      if (stillPlaying) {
        lastPlayed.set(key, now);
        continue;
      }
      if (!lastPlayed.has(key)) {
        lastPlayed.set(key, now); // jamais vu jouer depuis le démarrage : 2 heures de répit
        continue;
      }
      if (now - lastPlayed.get(key) >= GAME_ROLE_IDLE_MS) {
        await member.roles
          .remove(role, 'Ne joue plus à ce jeu depuis 2 heures')
          .then(() => {
            removed += 1;
            lastPlayed.delete(key);
          })
          .catch((error) => logError(`Retrait du rôle ${role.name}`, error));
      }
    }

    if (role.members.size === 0) {
      await role
        .delete('Plus aucun joueur')
        .then(() => (deleted += 1))
        .catch((error) => logError(`Suppression du rôle ${role.name}`, error));
    }
  }

  if (removed || deleted) {
    console.log(`Rôles de jeux : ${removed} retiré(s), ${deleted} rôle(s) supprimé(s).`);
  }
}

// Crée le rôle au premier joueur détecté. Deux détections simultanées du même
// jeu attendent la même création au lieu de créer le rôle en double.
async function getOrCreateRole(guild, name, options = {}) {
  const existing = guild.roles.cache.find((role) => role.name === name);
  if (existing) {
    return existing;
  }
  if (pendingRoles.has(name)) {
    return pendingRoles.get(name);
  }
  if (guild.roles.cache.size >= ROLE_LIMIT) {
    return null; // Discord limite un serveur à 250 rôles
  }

  const creation = (async () => {
    const role = await guild.roles.create({ name, permissions: [], reason: 'Jeu détecté', ...options });
    // Les rôles « En jeu » sont affichés à part : au-dessus de ・Cloudy et des rôles
    // achetés (🎟️, couleurs), pour regrouper les joueurs pendant la partie.
    const base = guild.roles.cache.get(BASE_ROLE_ID);
    // Juste au-dessus des rôles achetés, jamais au-dessus des autres « En jeu » : sinon
    // chaque nouveau jeu montait d'un cran jusqu'à atteindre le rôle du bot (Missing Permissions).
    const above = [base, ...guild.roles.cache.filter((r) => r.name.startsWith('🎟️・') || r.name.startsWith('Couleur • ')).values()].filter(Boolean);
    if (options.hoist && base) {
      const target = Math.max(...above.map((r) => r.position)) + 1;
      await role.setPosition(target).catch((error) => logError('Position du rôle En jeu', error));
    }
    return role;
  })()
    .catch((error) => {
      logError(`Création du rôle ${name}`, error);
      return null;
    })
    .finally(() => pendingRoles.delete(name));

  pendingRoles.set(name, creation);
  return creation;
}

async function syncMemberRoles(member, names) {
  if (member.user.bot) {
    return;
  }

  const guild = member.guild;
  const games = new Map(names.map(resolveGame).map((game) => [game.key, game]));

  for (const game of games.values()) {
    // Le rôle 🎮 du jeu reste pendant la partie et 2 heures après (voir cleanupGameRoles).
    const gameRole = await getOrCreateRole(guild, game.roleName);
    if (gameRole?.editable && !member.roles.cache.has(gameRole.id)) {
      await safeAddRole(member, gameRole, 'Jeu détecté').catch((error) => logError(`Rôle ${game.label}`, error));
    }

    const inGameRole = await getOrCreateRole(guild, inGameRoleName(game), { hoist: true } /* sans couleur : ne cache pas la couleur achetée */);
    if (inGameRole?.editable && !member.roles.cache.has(inGameRole.id)) {
      await safeAddRole(member, inGameRole, 'Partie en cours').catch((error) => logError(`Rôle En jeu ${game.label}`, error));
    }
  }

  const wanted = new Set([...games.values()].map(inGameRoleName));
  for (const role of [...guild.roles.cache.values()]) {
    if (role.name.startsWith(IN_GAME_PREFIX) && !wanted.has(role.name) && role.editable && member.roles.cache.has(role.id)) {
      await member.roles.remove(role, 'Partie terminée').catch((error) => logError(`Rôle ${role.name}`, error));
    }
  }
}

// Les rôles « En jeu » des jeux hors des 4 du serveur disparaissent quand plus
// personne n'y joue, pour ne pas remplir la liste des rôles.
async function cleanupInGameRoles(guild) {
  const inUse = new Set([...playing.values()].flat().map((name) => inGameRoleName(resolveGame(name))));
  const permanent = new Set(GAMES.map(inGameRoleName));

  for (const role of [...guild.roles.cache.values()]) {
    if (role.name.startsWith(IN_GAME_PREFIX) && !permanent.has(role.name) && !inUse.has(role.name) && role.editable) {
      await role.delete('Plus personne ne joue à ce jeu').catch((error) => logError(`Suppression du rôle ${role.name}`, error));
    }
  }
}

function buildBoard(guild) {
  const byGame = new Map();

  for (const [memberId, names] of playing) {
    for (const name of names) {
      const label = displayName(name);
      const players = byGame.get(label) ?? new Map();
      if (!players.has(memberId)) {
        players.set(memberId, since.get(`${memberId}|${name}`) ?? Date.now());
      }
      byGame.set(label, players);
    }
  }

  const sorted = [...byGame.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  const icon = guild?.iconURL?.({ size: 256 }) ?? null;
  const embed = new EmbedBuilder()
    .setColor(sorted.length ? 0x57f287 : 0x4f545c)
    .setAuthor({ name: 'CloudyCat · Activité', iconURL: icon ?? undefined })
    .setTitle(BOARD_TITLE)
    .setThumbnail(icon)
    .setFooter({ text: '🐾 Mis à jour en direct' })
    .setTimestamp();

  if (sorted.length === 0) {
    return embed.setDescription('😴 **Personne ne joue en ce moment…**\nLance une partie : tu apparaîtras ici en direct !');
  }

  const count = playing.size;
  embed.setDescription(
    `🟢 **${count}** joueur${count > 1 ? 's' : ''} en jeu sur **${sorted.length}** jeu${sorted.length > 1 ? 'x' : ''}\n` +
    '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬'
  );

  sorted.slice(0, 25).forEach(([label, members], index) => {
    const emoji = resolveGame(label).emoji;
    const hot = index === 0 && members.size > 1 ? ' 🔥' : '';
    const lines = [...members.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, MAX_PLAYERS_PER_GAME)
      .map(([id, start]) => `> <@${id}> · depuis <t:${Math.floor(start / 1000)}:R>`);

    if (members.size > MAX_PLAYERS_PER_GAME) {
      lines.push(`> *et ${members.size - MAX_PLAYERS_PER_GAME} autres…*`);
    }

    embed.addFields({
      name: `${emoji} ${label.slice(0, 200)} — ${members.size} joueur${members.size > 1 ? 's' : ''}${hot}`,
      value: lines.join('\n')
    });
  });

  return embed;
}

// Un seul message, modifié à chaque changement plutôt que de remplir le salon.
async function updateBoard(client) {
  const channel = await client.channels.fetch(ACTIVITY_CHANNEL_ID);
  const recent = await channel.messages.fetch({ limit: 100 });
  // Le salon contient aussi le top vocal du dimanche : on retrouve le tableau par son titre.
  const message = recent.find((m) => m.author.id === client.user.id && m.embeds?.[0]?.title === BOARD_TITLE);
  const payload = { embeds: [buildBoard(channel.guild)], allowedMentions: { parse: [] } };

  if (message) {
    await message.edit(payload);
  } else {
    await channel.send(payload);
  }
}

function scheduleBoardUpdate(client) {
  if (boardTimer) {
    return;
  }

  boardTimer = setTimeout(() => {
    boardTimer = null;
    updateBoard(client).catch((error) => logError("Salon d'activité", error));
  }, BOARD_DELAY_MS);
}

async function handlePresence(member, presence) {
  if (!member || member.user.bot) {
    return;
  }

  const names = gamesOf(presence);
  const before = playing.get(member.id) ?? [];

  if (names.join('|') === before.join('|')) {
    return;
  }

  setPlaying(member.id, presence, names);
  await syncMemberRoles(member, names);
  scheduleBoardUpdate(member.client);
}

// Repart de zéro depuis les présences actuelles : rattrape un événement manqué
// (coupure réseau, membre parti…) et retire les rôles « En jeu » oubliés.
async function resync(client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  await guild.members.fetch();

  playing.clear();
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) {
      continue;
    }

    const names = gamesOf(member.presence);
    setPlaying(member.id, member.presence, names);
    await syncMemberRoles(member, names);
  }

  for (const key of since.keys()) {
    if (!playing.has(key.split('|')[0])) {
      since.delete(key);
    }
  }

  await cleanupInGameRoles(guild);
  // La revérification tourne toutes les heures ; le ménage des rôles 🎮,
  // toutes les 2 heures (le premier passage, au démarrage, ne fait que noter).
  if (Date.now() - lastGameRoleCheck >= GAME_ROLE_CHECK_MS - 60_000) {
    lastGameRoleCheck = Date.now();
    await cleanupGameRoles(guild).catch((error) => logError('Ménage des rôles de jeux', error));
  }
  await updateBoard(client);
}

async function startGameActivity(client, guildId) {
  await resync(client, guildId);

  if (!resyncTimer) {
    resyncTimer = setInterval(() => {
      resync(client, guildId).catch((error) => logError('Détection des jeux (revérification)', error));
    }, RESYNC_INTERVAL_MS);
  }
}

module.exports = { handlePresence, startGameActivity, buildBoard, gamesOf, playing, cleanupGameRoles };
