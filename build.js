#!/usr/bin/env node
/**
 * build.js — régénère la copie de supabase-sync.js recopiée en dur dans
 * index.html à partir du fichier source, au lieu de la recopier à la main.
 *
 * Contexte (voir CLAUDE.md §3/§4/§6) : index.html est un bundle
 * auto-suffisant qui embarque une copie inline de supabase-sync.js (couche
 * de synchro Supabase) entre deux marqueurs stables. Jusqu'ici, chaque
 * modification de la couche de synchro devait être reportée à la main dans
 * les deux fichiers, sans aucun garde-fou — source d'une divergence
 * silencieuse entre le code "source" et le bundle réellement déployé.
 * Ce script élimine cette étape manuelle tout en respectant la contrainte
 * du projet ("un seul fichier, ouvrable sans serveur", aucun framework,
 * aucun package.json) : pas de dépendance, juste `fs`/`path` du cœur de
 * Node, à exécuter directement avec `node build.js`.
 *
 * Usage :
 *   node build.js          régénère index.html (no-op si déjà à jour)
 *   node build.js --check  ne modifie rien ; sort en erreur (code 1) si les
 *                          deux fichiers ont divergé — utilisable comme
 *                          garde-fou avant un commit.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, 'index.html');
const SYNC_PATH = path.join(ROOT, 'supabase-sync.js');

// Marqueurs délimitant, dans index.html, la zone recopiée depuis
// supabase-sync.js. Doivent rester en phase avec le contenu réel du
// fichier : si l'un des deux est introuvable, le script s'arrête sans rien
// écrire plutôt que de deviner une zone approximative. Le \n du premier
// marqueur est ajusté au style de fin de ligne d'index.html au démarrage
// (voir plus bas) pour rester robuste si le fichier passe un jour en LF.
const START_MARKER_LF = '/**\n * supabase-sync.js';
const END_MARKER = '// ── NE PAS auto-init ici — initCollaboration() est appelé depuis index.html ──';

function main() {
  const checkOnly = process.argv.includes('--check');

  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const htmlUsesCRLF = html.includes('\r\n');
  const START_MARKER = htmlUsesCRLF ? START_MARKER_LF.replace(/\n/g, '\r\n') : START_MARKER_LF;
  // index.html est en CRLF ; supabase-sync.js, édité par des outils/OS
  // différents selon la personne, peut basculer en LF sans que ce soit une
  // vraie divergence de contenu — on aligne sa fin de ligne sur celle
  // d'index.html avant toute comparaison, pour ne pas signaler un faux
  // écart (ou pire, un vrai écart de contenu masqué par du bruit de fin de
  // ligne) à cause du seul style de retour à la ligne.
  let syncSrc = fs.readFileSync(SYNC_PATH, 'utf8').replace(/\r\n/g, '\n');
  if (htmlUsesCRLF) syncSrc = syncSrc.replace(/\n/g, '\r\n');
  // La copie collée dans index.html n'a jamais de retour à la ligne final
  // (elle est immédiatement suivie de `\n  </script>`) — supabase-sync.js,
  // lui, en a un en fin de fichier comme tout fichier texte normal.
  syncSrc = syncSrc.replace(/[\r\n]+$/, '');

  const startIdx = html.indexOf(START_MARKER);
  if (startIdx === -1) {
    console.error('build.js: marqueur de début introuvable dans index.html — structure changée, script à mettre à jour avant de relancer.');
    process.exit(2);
  }
  const endMarkerIdx = html.indexOf(END_MARKER, startIdx);
  if (endMarkerIdx === -1) {
    console.error('build.js: marqueur de fin introuvable dans index.html — structure changée, script à mettre à jour avant de relancer.');
    process.exit(2);
  }
  const endIdx = endMarkerIdx + END_MARKER.length;

  const currentInline = html.slice(startIdx, endIdx);
  if (currentInline === syncSrc) {
    console.log('build.js: index.html est déjà synchronisé avec supabase-sync.js — rien à faire.');
    return;
  }

  if (checkOnly) {
    console.error('build.js: DÉSYNCHRONISÉ — la copie inline dans index.html ne correspond plus à supabase-sync.js.');
    console.error('build.js: lancer `node build.js` pour la régénérer avant de committer.');
    process.exit(1);
  }

  const newHtml = html.slice(0, startIdx) + syncSrc + html.slice(endIdx);
  fs.writeFileSync(INDEX_PATH, newHtml);
  console.log('build.js: index.html régénéré à partir de supabase-sync.js.');
}

main();
