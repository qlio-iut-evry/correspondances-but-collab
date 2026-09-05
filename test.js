#!/usr/bin/env node
/**
 * test.js — filet de tests minimal pour index.html, sans dépendance ni
 * package.json (juste `assert`/`vm`/`fs` du cœur de Node), à l'image de
 * build.js. Ne remplace pas des tests d'intégration en vrai navigateur,
 * mais protège contre la régression de bugs réels déjà rencontrés sur ce
 * projet — la logique de score/famille/type est pure logique métier, sans
 * DOM, donc testable directement en extrayant les fonctions concernées du
 * bundle plutôt qu'en les réécrivant ailleurs (ce qui les ferait dériver).
 *
 * Usage : node test.js   (sort en code 1 si un test échoue)
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const INDEX_PATH = path.join(__dirname, 'index.html');
const html = fs.readFileSync(INDEX_PATH, 'utf8');

// ── Extraction du bloc de logique métier pure (score, famille, type) ───────
// Bornes stables : de la définition d'eH() à la ligne juste avant le
// commentaire "BIJECTIVE MATCHING" — repérage par contenu, pas par numéro de
// ligne (cf. build.js), pour survivre aux futures modifications du fichier.
const LOGIC_START = 'function eH(s){';
const LOGIC_END = '// ===== BIJECTIVE MATCHING =====';

function extractLogicBlock() {
  const startIdx = html.indexOf(LOGIC_START);
  if (startIdx === -1) throw new Error('test.js: bloc de logique introuvable (marqueur de début) — index.html a changé, adapter LOGIC_START.');
  const endIdx = html.indexOf(LOGIC_END, startIdx);
  if (endIdx === -1) throw new Error('test.js: bloc de logique introuvable (marqueur de fin) — index.html a changé, adapter LOGIC_END.');
  return html.slice(startIdx, endIdx);
}

// Sandbox minimal : les fonctions extraites lisent S.* et appellent
// document.querySelectorAll() dans deux fonctions non utilisées par ces
// tests (getActiveParcours/onParcChange) — un stub suffit, elles ne sont
// jamais invoquées ci-dessous.
function makeSandbox() {
  const S = { old: [], new: [], rows: [], weights: null, validations: {}, typeOverrides: {}, familyOverrides: {} };
  const sandbox = { S, document: { querySelectorAll: () => [] }, console };
  vm.createContext(sandbox);
  vm.runInContext(extractLogicBlock(), sandbox, { filename: 'index.html (bloc logique)' });
  return sandbox;
}

// ── Mini test-runner (pas de framework, cf. CLAUDE.md §3) ──────────────────
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: e.message }); }
}

// ============================================================================
// 1. resourceFamily() — priorité de détection MTD/MP (régression réelle :
//    ces branches ont dû être placées AVANT les mappages de valeurs brutes
//    du PDF, sinon une ressource MTD dont la famille brute matchait déjà
//    "Numérique & SI" n'était jamais reclassée en "Transformation digitale").
// ============================================================================
{
  const { S, resourceFamily } = makeSandbox();

  test('resourceFamily: ressource MTD auto-détectée malgré une famille brute concurrente', () => {
    S.familyOverrides = {};
    const r = { code: 'R3.MTD.13', side: 'new', parcours_code: 'MTD', family: 'Numerique & SI', titre: "Introduction a l'entreprise digitale" };
    assert.strictEqual(resourceFamily(r), 'Transformation digitale');
  });

  test('resourceFamily: ressource MP auto-détectée malgré une famille brute concurrente', () => {
    S.familyOverrides = {};
    const r = { code: 'R3.MP.13', side: 'new', parcours_code: 'MP', family: 'Management', titre: 'Introduction au management' };
    assert.strictEqual(resourceFamily(r), 'Management Production');
  });

  test('resourceFamily: un override manuel reste prioritaire sur la détection auto MTD', () => {
    const r = { code: 'R3.MTD.13', side: 'new', parcours_code: 'MTD', family: 'Numerique & SI', titre: "Introduction a l'entreprise digitale" };
    S.familyOverrides = { 'new:R3.MTD.13': 'Gestion & Entreprise' };
    assert.strictEqual(resourceFamily(r), 'Gestion & Entreprise');
    S.familyOverrides = {};
  });
}

// ============================================================================
// 2. isTransversalCode() / isTransversalSide() — règle de position et
//    priorité d'un override manuel de type sur la règle automatique.
// ============================================================================
{
  const { isTransversalCode, isTransversalSide, S } = makeSandbox();

  test('isTransversalCode: position ≤6 = transversal (hors S6)', () => {
    assert.strictEqual(isTransversalCode('R3.05'), true);
    assert.strictEqual(isTransversalCode('R3.07'), false);
  });

  test('isTransversalCode: seuil réduit à 5 pour le semestre 6', () => {
    assert.strictEqual(isTransversalCode('R6.05'), true);
    assert.strictEqual(isTransversalCode('R6.06'), false);
  });

  test('isTransversalCode: code de parcours (3 segments) toujours métier', () => {
    assert.strictEqual(isTransversalCode('R3.MTD.02'), false);
  });

  test('isTransversalSide: un override manuel prime sur la règle automatique', () => {
    S.typeOverrides = {};
    assert.strictEqual(isTransversalSide('R3.07', 'new', false), false);
    S.typeOverrides = { 'new:R3.07': 'transversal' };
    assert.strictEqual(isTransversalSide('R3.07', 'new', false), true);
    S.typeOverrides = {};
  });
}

// ============================================================================
// 3. adjScore() — véto absolu transversal ↔ métier, quels que soient les
//    autres critères (score parfait sur tout le reste, mais type incompatible).
// ============================================================================
{
  const { adjScore } = makeSandbox();

  test('adjScore: score forcé à 0 si transversal/métier incompatibles', () => {
    const row = {
      oldCode: 'R1.01', newCode: 'R1.07',
      oldTransversal: true, newTransversal: false,
      titleScore: 100, textScore: 100, semesterDiff: 0,
      sharedKeywords: 'x,y,z', oldFamily: 'X', newFamily: 'X'
    };
    assert.strictEqual(adjScore(row), 0);
  });
}

// ============================================================================
// 4. compareRow() + adjScore() — une paire absente de S.rows (jamais
//    précalculée) doit produire un score réel, pas silencieusement 0.
//    Régression réelle : avant ce correctif, choisir manuellement une paire
//    hors du sous-ensemble précalculé affichait "0.0% — À vérifier" même
//    pour deux ressources manifestement proches.
// ============================================================================
{
  const { S, compareRow, adjScore } = makeSandbox();

  test('compareRow+adjScore: paire non précalculée → score réel, pas 0 par défaut', () => {
    S.rows = []; // aucune paire précalculée
    const oldRes = { code: 'R5.IMP.31', side: 'old', titre: "Animation d'un systeme de production", parcours_code: 'PSC', semestre: 5, family: 'Production & Flux', competences: [], mots_cles: ['production', 'systeme'] };
    const newRes = { code: 'R5.MTD.14', side: 'new', titre: "Animation d'un systeme de production numerique", parcours_code: 'MTD', semestre: 5, family: 'Production & Flux', competences: [], mots_cles: ['production', 'systeme', 'numerique'] };
    const row = compareRow(oldRes, newRes);
    assert.ok(row, 'compareRow doit renvoyer une ligne pour une paire valide');
    const score = adjScore(row);
    assert.ok(score >= 20, `adjScore ne doit pas retomber près de 0 pour une paire manifestement proche (obtenu ${score})`);
  });
}

// ============================================================================
// 5. kpisFromPairs() — cœur du calcul partagé entre l'Excel, le PDF et le
//    bandeau à l'écran (R47). Protège contre la régression exacte déjà
//    rencontrée : les deux exports moyennaient le score différemment et
//    affichaient deux valeurs différentes pour un même projet.
// ============================================================================
{
  const { kpisFromPairs } = makeSandbox();

  test('kpisFromPairs: score moyen, changement de parité et doublons calculés correctement', () => {
    const pairs = [
      { oldCode: 'A', oldSemestre: 1, newSemestre: 1, score: 100 },
      { oldCode: 'B', oldSemestre: 2, newSemestre: 1, score: 50 },  // parité différente (pair→impair)
      { oldCode: 'A', oldSemestre: 1, newSemestre: 3, score: 80 },  // 'A' réutilisée → doublon
    ];
    const k = kpisFromPairs(pairs);
    assert.strictEqual(k.matchedCount, 3);
    assert.strictEqual(k.avg, (100 + 50 + 80) / 3);
    assert.strictEqual(k.crossSemCount, 1);
    assert.strictEqual(k.crossSemRate, Math.round(1 / 3 * 100));
    assert.deepStrictEqual([...k.duplicatedOld], ['A']);
  });
}

// ============================================================================
// 6. Cohérence documentaire — le Guide intégré (#modal-help, §12) cite les
//    poids des 6 profils de pondération : ce test vérifie qu'ils
//    correspondent toujours à l'objet PROFILES réellement utilisé par
//    l'appli, pour détecter automatiquement une dérive de la doc (cf.
//    amélioration #10 — le Guide avait déjà dérivé plusieurs fois cette
//    session sans qu'aucun outil ne le signale).
// ============================================================================
{
  const stripAccents = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

  test('Guide §12 : les poids affichés correspondent à PROFILES', () => {
    const profilesMatch = html.match(/const PROFILES=(\{.*?\});/);
    assert.ok(profilesMatch, 'PROFILES introuvable dans index.html — adapter le test si sa définition a changé.');
    const PROFILES = vm.runInNewContext('(' + profilesMatch[1] + ')');
    const WEIGHT_ORDER = ['code', 'titre', 'texte', 'famille', 'semestre', 'mots_cles'];

    // Section 12 du Guide uniquement (pas la légende de score/etc. — on
    // borne la recherche entre le titre de §12 et celui de §13).
    const s12Start = html.indexOf('12. Pondération et profils');
    const s13Start = html.indexOf('13. Import CSV', s12Start);
    assert.ok(s12Start !== -1 && s13Start !== -1, 'Sections 12/13 du Guide introuvables — adapter le test si le Guide a été restructuré.');
    const guideSection = html.slice(s12Start, s13Start);

    const re = /<strong>([^<]+)<\/strong><br>(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/g;
    const profilesByNormalizedName = {};
    Object.keys(PROFILES).forEach(k => { profilesByNormalizedName[stripAccents(k)] = { key: k, weights: PROFILES[k] }; });

    let m, checked = 0;
    while ((m = re.exec(guideSection))) {
      const [, name, ...nums] = m;
      const normName = stripAccents(name.trim());
      const entry = profilesByNormalizedName[normName];
      assert.ok(entry, `Profil "${name}" cité dans le Guide mais absent de PROFILES (ou nom différent).`);
      WEIGHT_ORDER.forEach((key, i) => {
        assert.strictEqual(
          Number(nums[i]), entry.weights[key],
          `Guide §12, profil "${name}", poids "${key}" : le Guide affiche ${nums[i]} mais PROFILES['${entry.key}'].${key} vaut ${entry.weights[key]}.`
        );
      });
      checked++;
    }
    assert.strictEqual(checked, Object.keys(PROFILES).length, `${checked} profil(s) trouvé(s) dans le Guide, ${Object.keys(PROFILES).length} attendu(s) (dans PROFILES) — un profil a peut-être été ajouté/retiré d'un seul côté.`);
  });
}

// ── Rapport ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
results.forEach(r => console.log((r.ok ? '✓' : '✗') + ' ' + r.name + (r.ok ? '' : '\n    ' + r.error)));
console.log(`\n${results.length - failed.length}/${results.length} tests passés.`);
if (failed.length) process.exit(1);
