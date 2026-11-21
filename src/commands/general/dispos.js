const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags
} = require('discord.js');
const { getDb } = require('../../utils/firebase');
const { isStaffMember } = require('../../utils/permissions');

// Sondage de disponibilités de l'équipe Premier. Un message par semaine dans
// #dispos ; chaque joueur coche ses jours dans le menu, le message se met à
// jour et liste ceux qui n'ont pas encore répondu. Les réponses sont gardées
// dans Firestore (une fiche par message), donc le sondage survit aux
// redémarrages du bot et reste ouvert le temps que tout le monde réponde.

const COLLECTION = 'premierDispos';
const DISPOS_CHANNEL_NAME = '🗓️・dispos';
const PREMIER_ROLE_NAME = '🏆・Premier';
const IGL_ROLE_NAME = '🎙️・IGL';
const TEAM_SIZE = 5;
const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

// Lundi (AAAA-MM-JJ, heure de Paris) de la semaine choisie.
function mondayOf(offsetWeeks) {
  const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }) + 'T00:00:00Z');
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  today.setUTCDate(today.getUTCDate() - sinceMonday + 7 * offsetWeeks);
  return today.toISOString().slice(0, 10);
}

function dayDate(monday, index) {
  const d = new Date(monday + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + index);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function findRole(guild, name) {
  return guild.roles.cache.find((role) => role.name === name) ?? null;
}

function isPremierMember(member) {
  return member.roles.cache.some((role) => role.name === PREMIER_ROLE_NAME || role.name === IGL_ROLE_NAME);
}

async function premierPlayerIds(guild) {
  // Discord limite les récupérations complètes de membres : en cas de refus,
  // on se contente des membres déjà en cache.
  await guild.members.fetch().catch(() => {});
  const ids = new Set();
  for (const name of [PREMIER_ROLE_NAME, IGL_ROLE_NAME]) {
    findRole(guild, name)?.members.forEach((member) => {
      if (!member.user.bot) ids.add(member.id);
    });
  }
  return [...ids];
}

function buildEmbed(poll, playerIds) {
  const responses = poll.responses ?? {};
  const lines = DAYS.map((day, i) => {
    const available = Object.entries(responses)
      .filter(([, days]) => days.includes(i))
      .map(([id]) => `<@${id}>`);
    const status = available.length >= TEAM_SIZE ? '  **équipe complète**' : '';
    const names = available.length > 0 ? available.join(', ') : '-';
    return `**${day} ${dayDate(poll.monday, i)}** · ${available.length}/${TEAM_SIZE}${status}\n${names}`;
  });

  const unavailable = Object.entries(responses).filter(([, days]) => days.length === 0).map(([id]) => `<@${id}>`);
  const waiting = playerIds.filter((id) => !(id in responses)).map((id) => `<@${id}>`);

  const embed = new EmbedBuilder()
    .setColor(0xfd4556)
    .setTitle(`Disponibilités Premier · semaine du ${dayDate(poll.monday, 0)}`)
    .setDescription(
      'Choisissez dans le menu les jours où vous pouvez jouer. Vous pouvez modifier votre réponse à tout moment.\n\n' +
        lines.join('\n\n')
    )
    .addFields(
      { name: 'Pas disponibles cette semaine', value: unavailable.join(', ') || '-' },
      { name: `En attente de réponse (${waiting.length})`, value: waiting.join(', ') || 'Tout le monde a répondu.' }
    )
    .setFooter({ text: `Lancé par ${poll.createdBy}` });

  return embed;
}

function buildComponents(monday) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`dispos:jours:${monday}`)
    .setPlaceholder('Mes jours disponibles')
    .setMinValues(1)
    .setMaxValues(DAYS.length)
    .addOptions(DAYS.map((day, i) => ({ label: `${day} ${dayDate(monday, i)}`, value: String(i) })));

  const none = new ButtonBuilder()
    .setCustomId(`dispos:aucun:${monday}`)
    .setLabel('Pas dispo cette semaine')
    .setStyle(ButtonStyle.Secondary);

  return [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(none)];
}

// Enregistre la réponse d'un joueur puis met à jour le message.
async function saveAnswer(interaction, days) {
  if (!isPremierMember(interaction.member)) {
    await interaction.reply({ content: "Ce sondage est réservé à l'équipe Premier.", flags: MessageFlags.Ephemeral });
    return;
  }

  const db = getDb();
  if (!db) {
    await interaction.reply({ content: 'Sauvegarde indisponible pour le moment, réessayez plus tard.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();
  const ref = db.collection(COLLECTION).doc(interaction.message.id);

  const poll = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data();
    data.responses = { ...(data.responses ?? {}), [interaction.user.id]: days };
    tx.update(ref, { [`responses.${interaction.user.id}`]: days });
    return data;
  });

  if (!poll) {
    await interaction.followUp({ content: 'Ce sondage est introuvable, demandez à l\'IGL d\'en relancer un.', flags: MessageFlags.Ephemeral });
    return;
  }

  const playerIds = await premierPlayerIds(interaction.guild);
  await interaction.message.edit({ embeds: [buildEmbed(poll, playerIds)], allowedMentions: { parse: [] } });

  const summary = days.length > 0 ? days.map((i) => DAYS[i].toLowerCase()).join(', ') : 'aucun jour';
  await interaction.followUp({ content: `Réponse enregistrée : ${summary}.`, flags: MessageFlags.Ephemeral });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dispos')
    .setDescription("Lance le sondage de disponibilités de l'équipe Premier dans #dispos.")
    .addStringOption((option) =>
      option
        .setName('semaine')
        .setDescription('Semaine concernée (par défaut : la semaine prochaine)')
        .addChoices({ name: 'Cette semaine', value: '0' }, { name: 'Semaine prochaine', value: '1' })
    ),

  async execute(interaction) {
    const member = interaction.member;
    if (!isStaffMember(member) && !member.roles.cache.some((role) => role.name === IGL_ROLE_NAME)) {
      await interaction.reply({ content: "Seuls l'IGL et le staff peuvent lancer le sondage.", flags: MessageFlags.Ephemeral });
      return;
    }

    const db = getDb();
    if (!db) {
      await interaction.reply({ content: 'Sauvegarde indisponible : le sondage ne peut pas être lancé.', flags: MessageFlags.Ephemeral });
      return;
    }

    const channel = interaction.guild.channels.cache.find((c) => c.name === DISPOS_CHANNEL_NAME);
    if (!channel) {
      await interaction.reply({ content: `Salon ${DISPOS_CHANNEL_NAME} introuvable.`, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const monday = mondayOf(Number(interaction.options.getString('semaine') ?? '1'));
    const poll = { monday, createdBy: interaction.user.username, responses: {} };
    const playerIds = await premierPlayerIds(interaction.guild);
    const premierRole = findRole(interaction.guild, PREMIER_ROLE_NAME);

    const message = await channel.send({
      content: premierRole ? `<@&${premierRole.id}> nouveau sondage de disponibilités.` : undefined,
      embeds: [buildEmbed(poll, playerIds)],
      components: buildComponents(monday),
      allowedMentions: { roles: premierRole ? [premierRole.id] : [] }
    });

    await db.collection(COLLECTION).doc(message.id).set({ ...poll, channelId: channel.id, createdAt: new Date() });
    await interaction.editReply(`Sondage publié dans ${channel}.`);
  },

  async handleSelectMenu(interaction, action) {
    if (action !== 'jours') return;
    const days = interaction.values.map(Number).filter((i) => i >= 0 && i < DAYS.length).sort((a, b) => a - b);
    await saveAnswer(interaction, days);
  },

  async handleButton(interaction, action) {
    if (action !== 'aucun') return;
    await saveAnswer(interaction, []);
  }
};
