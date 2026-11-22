// Charte couleurs de CloudyBot : tous les messages du bot piochent ici.
// Changer une couleur de la DA = changer une ligne.
//
// Sur Discord, la couleur d'un message n'est que la barre à gauche : le noir
// et le bleu foncé de la charte n'y seraient pas visibles, ils servent au
// site vitrine. Les couleurs de pseudo vendues dans la boutique et celles des
// agents Valorant ne font pas partie de la DA et restent dans leurs fichiers.
module.exports = {
  VIOLET: 0x7b2ff7, // messages principaux
  VIOLET_CLAIR: 0xa77bff, // économie, classements, messages secondaires
  NEUTRE: 0x4f545c, // état inactif (personne ne joue, défi terminé)
  SUCCES: 0x3ecf8e, // réussite
  ERREUR: 0xff4655, // erreur, refus

  // Couleurs de la charte complète (site vitrine, visuels)
  BLEU_FONCE: 0x121a3e,
  NOIR: 0x08080f,
  TEXTE: 0xece9f5
};
