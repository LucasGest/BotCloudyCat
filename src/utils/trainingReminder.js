const { getDb } = require('./firebase');
const { logError } = require('./logger');

// Rappel des entraînements Premier planifiés sur le site
// (premierStrats/entrainements/items) : 2 heures avant le début, un message
// dans #entraînements avec un ping du rôle Premier. Un seul rappel par séance,
// marqué dans Firestore (reminderSentAt) pour survivre aux redémarrages. Le
// site remet ce marqueur à zéro si la date ou l'heure de la séance change.

const TRAINING_CHANNEL_ID = '1574011774783721555'; // 🏋️・entraînements
const PREMIER_ROLE_ID = '1573715870822178907'; // 🏆・Premier
const SITE_URL = 'https://premiercloudy.vercel.app';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const REMIND_BEFORE_MS = 2 * 60 * 60 * 1000;
const TIME_ZONE = 'Europe/Paris';

// Date du jour à Paris, au format AAAA-MM-JJ.
function parisDate(date = new Date()) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// « 2026-11-22 » + « 21:00 » (heure de Paris) → instant précis, quel que soit
// le fuseau du serveur (Render tourne en UTC).
function parisToInstant(date, heure) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = heure.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value])
  );
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return guess - (shown - guess);
}

function dureeText(min) {
  if (!min) return null;
  return min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? String(min % 60).padStart(2, '0') : ''}` : `${min} min`;
}

// Texte venu du site : sans mention possible.
const clean = (s) => String(s ?? '').replace(/[@#<>`*_~|]/g, '').slice(0, 60);

async function buildMessage(guild, s) {
  const presences = Object.entries(s.presences || {});
  const oui = presences.filter(([, p]) => p.statut === 'oui').map(([, p]) => clean(p.nom));
  const non = presences.filter(([, p]) => p.statut === 'non').map(([, p]) => clean(p.nom));
  const answered = new Set(presences.map(([id]) => id));
  const role = guild.roles.cache.get(PREMIER_ROLE_ID);
  const silent = role ? [...role.members.values()].filter((m) => !m.user.bot && !answered.has(m.id)).map((m) => clean(m.displayName)) : [];

  const duree = dureeText(s.duree);
  const lines = [
    `<@&${PREMIER_ROLE_ID}> Rappel : entraînement **${clean(s.type)}** aujourd'hui à ${s.heure.replace(':', 'h')}${duree ? ` (${duree})` : ''}.`,
    s.notes ? clean(String(s.notes).replace(/\s+/g, ' ')).slice(0, 200) : null,
    `Présents : ${oui.length ? oui.join(', ') : 'personne pour l\'instant'}`,
    non.length ? `Absents : ${non.join(', ')}` : null,
    silent.length ? `Pas encore répondu : ${silent.join(', ')}` : null,
    `Indiquez votre présence sur ${SITE_URL}`
  ];
  return lines.filter(Boolean).join('\n');
}

async function checkTrainings(client) {
  const db = getDb();
  if (!db) return;

  const today = parisDate();
  const snap = await db.collection('premierStrats').doc('entrainements').collection('items').where('date', '==', today).get();
  if (snap.empty) return;

  const now = Date.now();
  const due = snap.docs.filter((doc) => {
    const s = doc.data();
    if (s.reminderSentAt || !/^\d{2}:\d{2}$/.test(s.heure || '')) return false;
    const start = parisToInstant(s.date, s.heure);
    // Dans la fenêtre des 2 heures avant le début ; une séance déjà commencée
    // (bot éteint au bon moment) n'est pas rappelée en retard.
    return now >= start - REMIND_BEFORE_MS && now < start;
  });
  if (!due.length) return;

  const channel = await client.channels.fetch(TRAINING_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    console.warn(`Salon des entraînements ${TRAINING_CHANNEL_ID} introuvable.`);
    return;
  }

  for (const doc of due) {
    const content = await buildMessage(channel.guild, doc.data());
    await channel.send({ content, allowedMentions: { roles: [PREMIER_ROLE_ID] } });
    await doc.ref.update({ reminderSentAt: new Date().toISOString() });
  }
}

function startTrainingReminder(client) {
  const run = () => checkTrainings(client).catch((error) => logError('Rappel des entraînements', error));
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}

module.exports = { startTrainingReminder, parisToInstant, parisDate, buildMessage };
