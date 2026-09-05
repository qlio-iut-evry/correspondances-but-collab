/**
 * supabase-sync.js
 * Couche de synchronisation Supabase pour l'appli collaborative.
 * Ce fichier remplace localStorage par des appels API Supabase
 * et écoute les changements en temps réel des autres utilisateurs.
 *
 * ⚙️  CONFIGURATION : renseigner les deux constantes ci-dessous
 *     (Supabase > Project Settings > API)
 */

const SUPABASE_URL  = 'https://rackahuqnfekncnzrsge.supabase.co';   // ← à remplacer
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhY2thaHVxbmZla25jbnpyc2dlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzYxNDcsImV4cCI6MjA5Njc1MjE0N30.ZgmuZeDCoA3F7BHOLNcMGI2XCCOgVoSLk-VDAzO0t_o';         // ← à remplacer

// ── Initialisation du client Supabase ────────────────────────────────────────
var db = null;
try {
  var _sbCreate = (typeof supabase !== 'undefined') ? supabase.createClient : null;
  if (!_sbCreate) throw new Error('SDK Supabase non chargé');
  db = _sbCreate(SUPABASE_URL, SUPABASE_ANON);
  console.log('[Supabase] Client initialisé ✅');
} catch(e) {
  console.error('[Supabase] Erreur init client:', e.message);
}

// ── État global collaboratif ──────────────────────────────────────────────────
let CURRENT_PROJECT_ID = null;   // UUID du projet actif
let CURRENT_USER       = null;   // { id, email, display_name }
let _realtimeChannel   = null;   // canal Supabase Realtime
let _lastSaveTs        = null;   // Date de la dernière écriture réussie vers Supabase

/** Met à jour l'horodatage et l'indicateur "Dernière sauvegarde" — n'appeler
 * qu'après une écriture confirmée sans erreur par Supabase. */
function markSaved(){
  _lastSaveTs = new Date();
  const el = document.getElementById('last-save-indicator');
  if (el) el.textContent = '💾 Enregistré à ' + _lastSaveTs.toLocaleTimeString('fr-FR');
}

// ── Authentification ──────────────────────────────────────────────────────────

/**
 * Vérifie si l'utilisateur est connecté.
 * Si non, redirige vers auth.html.
 */
async function requireAuth() {
  if (!db) {
    console.error('[Auth] db non initialisé — SDK Supabase manquant');
    showAuthBanner();
    return false;
  }
  try {
    // Diagnostic localStorage
    const sbKeys = Object.keys(localStorage).filter(k => k.includes('supabase') || k.startsWith('sb-'));
    console.log('[Auth] Clés localStorage Supabase:', sbKeys);

    const { data: { session }, error } = await db.auth.getSession();
    console.log('[Auth] Session:', session ? session.user.email : 'aucune', error || '');
    if (!session) {
      showAuthBanner();
      return false;
    }
    CURRENT_USER = {
      id:           session.user.id,
      email:        session.user.email,
      display_name: session.user.user_metadata?.display_name
                    || session.user.email.split('@')[0]
    };
    renderUserBadge(CURRENT_USER);
    return true;
  } catch(e) {
    console.warn('[Auth] Erreur vérification session:', e);
    showAuthBanner();
    return false;
  }
}

function showAuthBanner() {
  const existing = document.getElementById('auth-warning-banner');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'auth-warning-banner';
  // Bandeau fin en bas de page, ne masque pas le header
  banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99998;' +
    'background:#1e3a5f;color:#fff;font-size:12px;padding:6px 16px;' +
    'display:flex;align-items:center;justify-content:center;gap:12px;' +
    'box-shadow:0 -2px 8px rgba(0,0,0,.2)';
  banner.innerHTML =
    '<span>🔒 Non connecté — mode local uniquement</span>' +
    '<a href="auth.html?noredirect=1" style="background:rgba(255,255,255,.2);color:#fff;' +
    'padding:3px 10px;border-radius:5px;font-weight:700;text-decoration:none;font-size:11px">' +
    'Se connecter</a>' +
    '<button onclick="this.parentElement.remove()" style="background:none;border:none;' +
    'color:rgba(255,255,255,.5);cursor:pointer;font-size:14px;line-height:1" title="Fermer">✕</button>';
  document.body.appendChild(banner);
}

async function signOut() {
  await db.auth.signOut();
  window.location.href = 'auth.html';
}

// ── Gestion des projets ───────────────────────────────────────────────────────

/** Charge la liste des projets disponibles */
async function loadProjects() {
  const { data, error } = await db
    .from('projects')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false });
  if (error) { console.error('loadProjects:', error); return []; }
  return data;
}

/** Crée un nouveau projet */
async function createProject(name, oldProgramName, newProgramName) {
  const { data, error } = await db
    .from('projects')
    .insert({ name, old_program_name: oldProgramName,
               new_program_name: newProgramName, created_by: CURRENT_USER.id })
    .select().single();
  if (error) throw error;
  return data;
}

/** Sélectionne le projet actif et charge son état */
// R48: loadProjectState() peut désormais échouer (réseau ou erreur Supabase)
// et renvoie false dans ce cas plutôt que de laisser l'appelant continuer
// sur un état non chargé. Ici, on revient à CURRENT_PROJECT_ID précédent en
// cas d'échec — sinon l'ID du nouveau projet resterait actif alors que
// l'écran affiche encore les données de l'ancien, et toute action de
// l'utilisateur (valider, remplacer...) écrirait silencieusement dans le
// mauvais projet.
async function selectProject(projectId) {
  const previousId = CURRENT_PROJECT_ID;
  CURRENT_PROJECT_ID = projectId;
  const ok = await loadProjectState();
  if (!ok) { CURRENT_PROJECT_ID = previousId; return; }
  applyProjectSettings((window._projects||[]).find(p=>p.id===projectId));
  subscribeToRealtime();
  renderProjectBadge();
}

/** Recharge l'état du projet actuellement sélectionné depuis Supabase
 * (bouton 🔄 dans l'en-tête), sans repasser par la modale de sélection. */
async function reloadCurrentProject(){
  if (!CURRENT_PROJECT_ID) return;
  const ok = await loadProjectState();
  if (!ok) return;
  applyProjectSettings((window._projects||[]).find(p=>p.id===CURRENT_PROJECT_ID));
  if (typeof showToast === 'function') showToast('🔄 Projet rechargé depuis Supabase', 'success');
}

/** Applique à l'interface les réglages stockés sur le projet (parcours actifs,
 * pondérations) — appelé à la sélection d'un projet et lors d'un rechargement. */
function applyProjectSettings(proj){
  if (!proj) return;
  const active = Array.isArray(proj.active_parcours) && proj.active_parcours.length
    ? new Set(proj.active_parcours)
    : new Set(['TC','MP','PSC','PSMI','MTD']);
  document.querySelectorAll('#parcBar input[type=checkbox]').forEach(cb=>{ cb.checked = active.has(cb.value); });
  document.querySelectorAll('.parc-cb').forEach(el=>{
    const cb=el.querySelector('input');
    if (cb) el.classList.toggle('checked', cb.checked);
  });
  if (proj.weights && Object.keys(proj.weights).length && typeof normalizeWeightMap==='function') {
    S.weights = normalizeWeightMap(proj.weights);
    if (typeof updateWeightUI==='function') updateWeightUI(S.weights);
  }
  if (S.loaded && typeof recomputeMatching==='function') {
    recomputeMatching(); updateStats(); renderCorr();
  }
}

/** Sauvegarde les parcours actifs et les pondérations sur le projet courant. */
async function syncProjectSettings(){
  if (!CURRENT_PROJECT_ID || typeof getActiveParcours!=='function') return;
  const active_parcours = [...getActiveParcours()];
  const { error } = await db.from('projects')
    .update({ active_parcours, weights: S.weights || null })
    .eq('id', CURRENT_PROJECT_ID);
  if (error) console.error('[Sync] syncProjectSettings:', error); else markSaved();
}

function renderProjectBadge() {
  const badge = document.getElementById('project-badge');
  if (!badge) return;
  const proj = (window._projects||[]).find(p=>p.id===CURRENT_PROJECT_ID);
  if (proj) {
    badge.textContent = proj.name + ' ▾';
    badge.style.display = '';
  }
}

// ── Chargement de l'état depuis Supabase ──────────────────────────────────────

/**
 * Charge tout l'état du projet depuis Supabase
 * et remplace le S (state) local de l'appli.
 */
async function loadProjectState() {
  if (!CURRENT_PROJECT_ID) return false;

  // R48: avant ce correctif, un échec réseau ici (fetch rejeté) faisait
  // planter loadProjectState() avec une promesse rejetée non gérée : aucun
  // message, l'action (sélection/rechargement de projet) échouait en
  // silence. Une erreur Supabase renvoyée normalement ({data:null,error})
  // était pire encore — le code traitait `data:null` comme "projet vide"
  // (`ovRes.data || []`) et écrasait silencieusement l'état en mémoire par
  // un état vide, donnant l'impression que toutes les correspondances
  // avaient disparu. Les deux cas sont maintenant détectés explicitement et
  // renvoient false sans toucher à S, en avertissant l'utilisateur.
  let ovRes, valRes, kwRes, famRes, typRes, compRes, extRes, histRes;
  try {
    [ovRes, valRes, kwRes, famRes, typRes, compRes, extRes, histRes] = await Promise.all([
      db.from('overrides')       .select('*').eq('project_id', CURRENT_PROJECT_ID),
      db.from('validations')     .select('*').eq('project_id', CURRENT_PROJECT_ID),
      db.from('kw_overrides')    .select('*').eq('project_id', CURRENT_PROJECT_ID),
      db.from('family_overrides').select('*').eq('project_id', CURRENT_PROJECT_ID),
      db.from('type_overrides')  .select('*').eq('project_id', CURRENT_PROJECT_ID),
      db.from('competence_overrides').select('*').eq('project_id', CURRENT_PROJECT_ID),
      db.from('extras')          .select('*').eq('project_id', CURRENT_PROJECT_ID),
      db.from('history')         .select('*, profiles(display_name,email)')
                                 .eq('project_id', CURRENT_PROJECT_ID)
                                 .order('created_at', { ascending: false })
                                 .limit(200)
    ]);
  } catch (e) {
    console.error('[Sync] loadProjectState: échec réseau', e);
    if (typeof showToast === 'function') showToast('⚠️ Impossible de charger le projet (problème réseau) — réessayez', 'error');
    return false;
  }

  const failed = [['overrides',ovRes],['validations',valRes],['kw_overrides',kwRes],['family_overrides',famRes],
    ['type_overrides',typRes],['competence_overrides',compRes],['extras',extRes],['history',histRes]]
    .find(([,r]) => r?.error);
  if (failed) {
    console.error('[Sync] loadProjectState: erreur sur', failed[0], failed[1].error);
    if (typeof showToast === 'function') showToast(`⚠️ Erreur de chargement du projet (${failed[0]}) — état conservé, réessayez`, 'error');
    return false;
  }

  // Reconstruire S.overrides
  S.overrides = {};
  (ovRes.data || []).forEach(r => { S.overrides[r.new_code] = r.old_code || null; });

  // Reconstruire S.validations
  S.validations = {};
  (valRes.data || []).forEach(r => {
    S.validations[r.new_code] = {
      status: r.status, comment: r.comment,
      ts: r.updated_at, validatedOldCode: r.validated_old_code,
      updatedBy: r.profiles?.display_name || r.profiles?.email
    };
  });

  // Reconstruire S.kwOverrides (clé composée side:code — cf. ovKey)
  S.kwOverrides = {};
  (kwRes.data || []).forEach(r => { S.kwOverrides[ovKey(r.side,r.resource_code)] = r.keywords; });

  // Reconstruire S.familyOverrides
  S.familyOverrides = {};
  (famRes.data || []).forEach(r => { S.familyOverrides[ovKey(r.side,r.resource_code)] = r.family; });

  // Reconstruire S.typeOverrides (colonne BOOLEAN → string 'transversal'/'metier' attendue par l'appli)
  S.typeOverrides = {};
  (typRes.data || []).forEach(r => { S.typeOverrides[ovKey(r.side,r.resource_code)] = r.is_transversal ? 'transversal' : 'metier'; });

  // Reconstruire S.competenceOverrides
  S.competenceOverrides = {};
  (compRes.data || []).forEach(r => { S.competenceOverrides[ovKey(r.side,r.resource_code)] = r.competences; });

  // Reconstruire S.extras (plusieurs lignes possibles par new_code)
  S.extras = {};
  (extRes.data || []).forEach(r => {
    (S.extras[r.new_code] ||= []).push(r.old_code);
  });

  // Reconstruire S.hist
  S.hist = (histRes.data || []).map(r => ({
    code: r.resource_code, type: r.action_type,
    msg: r.description, ts: r.created_at,
    user: r.profiles?.display_name || r.profiles?.email || '?'
  }));

  // R18: pousser les mots-clés/compétences du projet chargé sur les objets
  // ressources eux-mêmes (r.mots_cles / r.competences) — sinon S.kwOverrides /
  // S.competenceOverrides seraient à jour mais l'affichage resterait sur les
  // valeurs extraites du PDF ou d'un projet précédent tant qu'un autre appel
  // n'aurait pas déclenché ce recalcul.
  if (typeof applyKwOverrides === 'function') applyKwOverrides();
  if (typeof applyCompetenceOverrides === 'function') applyCompetenceOverrides();

  // Les lignes ci-dessus réassignent S.overrides/S.validations/... à des objets
  // bruts : réinstaller les Proxy de synchro avant que l'utilisateur ne modifie
  // quoi que ce soit, sinon ces modifications ne seraient plus propagées.
  installSyncProxies();

  console.log('[Sync] État chargé depuis Supabase');
  if (S.loaded) { recomputeMatching(); renderCorr(); updateStats(); }
  return true;
}

// ── Sauvegarde vers Supabase ──────────────────────────────────────────────────

/** Remplace saveState() de l'appli originale */
async function saveState() {
  // Rien à faire ici : chaque opération est sauvegardée individuellement
  // Cette fonction est appelée par l'appli originale — on la neutralise
}

/** Sauvegarde un override */
async function syncOverride(newCode, oldCode) {
  if (!CURRENT_PROJECT_ID) return;
  const { error } = await db.from('overrides').upsert({
    project_id: CURRENT_PROJECT_ID,
    new_code: newCode,
    old_code: oldCode || null,
    updated_at: new Date().toISOString(),
    updated_by: CURRENT_USER.id
  }, { onConflict: 'project_id,new_code' });
  if (error) console.error('[Sync] syncOverride:', error); else markSaved();
}

/** Supprime un override */
async function deleteOverride(newCode) {
  if (!CURRENT_PROJECT_ID) return;
  const { error } = await db.from('overrides')
    .delete()
    .eq('project_id', CURRENT_PROJECT_ID)
    .eq('new_code', newCode);
  if (error) console.error('[Sync] deleteOverride:', error); else markSaved();
}

/** Sauvegarde une validation */
async function syncValidation(newCode, status, comment, validatedOldCode) {
  if (!CURRENT_PROJECT_ID) return;
  if (!status) {
    const { error } = await db.from('validations')
      .delete()
      .eq('project_id', CURRENT_PROJECT_ID)
      .eq('new_code', newCode);
    if (error) console.error('[Sync] syncValidation (delete):', error); else markSaved();
    return;
  }
  const { error } = await db.from('validations').upsert({
    project_id: CURRENT_PROJECT_ID,
    new_code: newCode, status,
    comment: comment || null,
    validated_old_code: validatedOldCode || null,
    updated_at: new Date().toISOString(),
    updated_by: CURRENT_USER.id
  }, { onConflict: 'project_id,new_code' });
  if (error) console.error('[Sync] syncValidation:', error); else markSaved();
}

/** Écriture/suppression générique pour les tables d'overrides à clé
 * (project_id, resource_code, side) : kw_overrides, competence_overrides,
 * family_overrides, type_overrides. Ces 4 tables ne différaient que par le
 * nom de table, le nom de colonne, et — avant cette factorisation — une
 * incohérence réelle (syncFamilyOverride n'avait pas la branche "valeur vide
 * → suppression" que kw/competence avaient, ce qui aurait fait échouer un
 * upsert avec family:'' contre la contrainte NOT NULL de la colonne).
 * value=null/undefined/[] déclenche une suppression ; toute autre valeur
 * (y compris `false`) est upsertée. */
async function syncOverrideValue(table, valueField, resourceCode, value, side) {
  if (!CURRENT_PROJECT_ID) return;
  side = side==='old' ? 'old' : 'new';
  const isEmpty = value===null || value===undefined || (Array.isArray(value) && value.length===0);
  if (isEmpty) {
    const { error } = await db.from(table)
      .delete()
      .eq('project_id', CURRENT_PROJECT_ID)
      .eq('resource_code', resourceCode)
      .eq('side', side);
    if (error) console.error('[Sync] '+table+' (delete):', error); else markSaved();
    return;
  }
  const { error } = await db.from(table).upsert({
    project_id: CURRENT_PROJECT_ID,
    resource_code: resourceCode,
    side: side,
    [valueField]: value,
    updated_at: new Date().toISOString(),
    updated_by: CURRENT_USER.id
  }, { onConflict: 'project_id,resource_code,side' });
  if (error) console.error('[Sync] '+table+':', error); else markSaved();
}

/** Sauvegarde un override de mots-clés */
async function syncKwOverride(resourceCode, keywords, side) {
  return syncOverrideValue('kw_overrides', 'keywords', resourceCode, keywords, side);
}

/** Sauvegarde un override de compétences ciblées */
async function syncCompetenceOverride(resourceCode, competences, side) {
  return syncOverrideValue('competence_overrides', 'competences', resourceCode, competences, side);
}

/** Sauvegarde un override de famille */
async function syncFamilyOverride(resourceCode, family, side) {
  return syncOverrideValue('family_overrides', 'family', resourceCode, family, side);
}

/** Supprime un override de famille (retour à l'analyse automatique) */
async function deleteFamilyOverride(resourceCode, side) {
  return syncOverrideValue('family_overrides', 'family', resourceCode, null, side);
}

/** Sauvegarde un override de type. S.typeOverrides stocke la string
 * 'transversal'/'metier' partout dans l'appli, alors que la colonne est
 * BOOLEAN — conversion faite ici, à la frontière. */
async function syncTypeOverride(resourceCode, isTransversal, side) {
  const boolValue = isTransversal==null ? null : (isTransversal === 'transversal');
  return syncOverrideValue('type_overrides', 'is_transversal', resourceCode, boolValue, side);
}

/** Supprime un override de type (retour à l'analyse automatique) */
async function deleteTypeOverride(resourceCode, side) {
  return syncOverrideValue('type_overrides', 'is_transversal', resourceCode, null, side);
}

/** Sauvegarde les ressources "extras" (partage exceptionnel secondaire)
 * d'une ressource nouvelle : remplace toutes ses lignes existantes par la
 * liste fournie (delete-puis-insert — plus simple qu'un diff ligne à ligne
 * pour un tableau généralement court de 0 à 2 éléments). */
async function syncExtras(newCode, oldCodes) {
  if (!CURRENT_PROJECT_ID) return;
  const { error: delError } = await db.from('extras')
    .delete()
    .eq('project_id', CURRENT_PROJECT_ID)
    .eq('new_code', newCode);
  if (delError) { console.error('[Sync] syncExtras (delete):', delError); return; }
  if (!oldCodes || !oldCodes.length) { markSaved(); return; }
  const { error: insError } = await db.from('extras').insert(
    oldCodes.map(oc => ({
      project_id: CURRENT_PROJECT_ID, new_code: newCode, old_code: oc,
      updated_by: CURRENT_USER.id
    }))
  );
  if (insError) console.error('[Sync] syncExtras (insert):', insError); else markSaved();
}

/** Supprime, pour le projet courant, toutes les lignes des tables données.
 * Utilisé par les boutons de réinitialisation groupée (Réinitialiser les
 * validations, Réinitialisation complète) pour que le reset local se
 * répercute bien côté base — sinon les anciennes lignes reviennent au
 * prochain chargement du projet. */
async function clearProjectTables(tables){
  if (!CURRENT_PROJECT_ID) return;
  let anyError = false;
  for (const t of tables) {
    const { error } = await db.from(t).delete().eq('project_id', CURRENT_PROJECT_ID);
    if (error) { console.error('[Sync] clearProjectTables ('+t+'):', error); anyError = true; }
  }
  // Ne marquer "enregistré" que si toutes les suppressions ont réussi — sinon
  // l'utilisateur croit le reset persisté alors que Supabase garde les
  // anciennes lignes, qui reviendraient au prochain chargement du projet.
  if (!anyError) markSaved();
  else if (typeof showToast==='function') showToast('⚠️ Échec de la réinitialisation — réessayez', 'error');
}

/** Enregistre une entrée dans l'historique */
async function syncHistory(resourceCode, actionType, description, details) {
  if (!CURRENT_PROJECT_ID) return;
  const { error } = await db.from('history').insert({
    project_id: CURRENT_PROJECT_ID,
    resource_code: resourceCode,
    action_type: actionType,
    description,
    details: details || null,
    created_by: CURRENT_USER.id,
    user_email: CURRENT_USER.email
  });
  if (error) console.error('[Sync] syncHistory:', error); else markSaved();
}

// ── Realtime : écoute des changements des collègues ───────────────────────────

function subscribeToRealtime() {
  if (_realtimeChannel) db.removeChannel(_realtimeChannel);

  _realtimeChannel = db
    .channel(`project-${CURRENT_PROJECT_ID}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'overrides',
      filter: `project_id=eq.${CURRENT_PROJECT_ID}`
    }, onRemoteChange)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'validations',
      filter: `project_id=eq.${CURRENT_PROJECT_ID}`
    }, onRemoteChange)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'kw_overrides',
      filter: `project_id=eq.${CURRENT_PROJECT_ID}`
    }, onRemoteChange)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'family_overrides',
      filter: `project_id=eq.${CURRENT_PROJECT_ID}`
    }, onRemoteChange)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'type_overrides',
      filter: `project_id=eq.${CURRENT_PROJECT_ID}`
    }, onRemoteChange)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'competence_overrides',
      filter: `project_id=eq.${CURRENT_PROJECT_ID}`
    }, onRemoteChange)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'extras',
      filter: `project_id=eq.${CURRENT_PROJECT_ID}`
    }, onRemoteChange)
    .subscribe(status => {
      updateSyncIndicator(status === 'SUBSCRIBED' ? 'online' : 'connecting');
    });
}

/** Appelé quand un collègue modifie quelque chose */
async function onRemoteChange(payload) {
  console.log('[Realtime] Changement distant:', payload.table, payload.eventType);
  showSyncToast(`Mise à jour reçue (${payload.table})`);
  await loadProjectState();  // Rechargement complet de l'état
}

// ── Indicateurs visuels ───────────────────────────────────────────────────────

function updateSyncIndicator(status) {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  const cfg = {
    online:      { color: '#16a34a', dot: '●', label: 'En ligne' },
    connecting:  { color: '#f59e0b', dot: '◌', label: 'Connexion…' },
    offline:     { color: '#dc2626', dot: '○', label: 'Hors ligne' }
  }[status] || { color: '#94a3b8', dot: '○', label: status };
  el.innerHTML = `<span style="color:${cfg.color};font-size:11px">${cfg.dot} ${cfg.label}</span>`;
}

function showSyncToast(msg) {
  let toast = document.getElementById('sync-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'sync-toast';
    toast.style.cssText = `position:fixed;bottom:70px;right:20px;background:#1e3a5f;color:#fff;
      padding:8px 14px;border-radius:8px;font-size:12px;z-index:9999;
      box-shadow:0 4px 12px rgba(0,0,0,.3);transition:opacity .3s`;
    document.body.appendChild(toast);
  }
  toast.textContent = '🔄 ' + msg;
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}

// ── Patch des fonctions de l'appli originale ──────────────────────────────────
// Ces patches interceptent les modifications et les envoient à Supabase
// Ils s'exécutent APRÈS le chargement complet de l'appli originale.

// Installe (ou réinstalle) les Proxy de synchro sur S.overrides / S.validations /
// S.kwOverrides / S.familyOverrides / S.typeOverrides. Doit être rappelée
// chaque fois que l'une de ces propriétés est réassignée à un objet brut
// (ex. dans loadProjectState) : une réassignation directe remplace le Proxy
// existant, ce qui arrêtait silencieusement la synchro vers Supabase après
// la sélection d'un projet.
// R20: S.kwOverrides/familyOverrides/typeOverrides/competenceOverrides sont
// désormais clés par "side:code" (cf. ovKey côté app) pour ne pas confondre
// une ressource ancienne et une ressource nouvelle qui partagent le même
// code. On décompose la clé ici pour l'envoyer à Supabase sous forme de deux
// colonnes (resource_code, side).
function parseOvKey(key){
  const s = String(key);
  const i = s.indexOf(':');
  return i < 0 ? { side: 'new', code: s } : { side: s.slice(0,i), code: s.slice(i+1) };
}

// Factorise les 4 Proxy identiques sur les maps clées "side:code"
// (kwOverrides/competenceOverrides/familyOverrides/typeOverrides) : même
// décomposition de clé, même appel set→syncFn(code,value,side) /
// delete→deleteFn(code,side). Avant cette factorisation, ces 4 blocs
// étaient copiés-collés à l'identique dans ce fichier (et une seconde fois
// dans index.html).
function makeOverrideKeyProxy(orig, syncFn, deleteFn) {
  return new Proxy(orig || {}, {
    set(target, prop, value) {
      target[prop] = value;
      if (CURRENT_PROJECT_ID) { const {side,code}=parseOvKey(prop); syncFn(code, value, side).catch(console.error); }
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop];
      if (CURRENT_PROJECT_ID) { const {side,code}=parseOvKey(prop); deleteFn(code, side).catch(console.error); }
      return true;
    }
  });
}

function installSyncProxies() {
  const _origOverrides = S.overrides || {};
  S.overrides = new Proxy(_origOverrides, {
    set(target, prop, value) {
      const changed = target[prop] !== value;
      target[prop] = value;
      if (changed && CURRENT_PROJECT_ID) {
        if (value === undefined) deleteOverride(prop).catch(console.error);
        else syncOverride(prop, value).catch(console.error);
      }
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop];
      if (CURRENT_PROJECT_ID) deleteOverride(prop).catch(console.error);
      return true;
    }
  });

  const _origValidations = S.validations || {};
  S.validations = new Proxy(_origValidations, {
    set(target, prop, value) {
      target[prop] = value;
      if (CURRENT_PROJECT_ID && typeof prop === 'string') {
        const v = value;
        syncValidation(prop, v?.status, v?.comment, v?.validatedOldCode)
          .catch(console.error);
      }
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop];
      if (CURRENT_PROJECT_ID) syncValidation(prop, null).catch(console.error);
      return true;
    }
  });

  S.kwOverrides = makeOverrideKeyProxy(S.kwOverrides,
    syncKwOverride, (code,side) => syncKwOverride(code,null,side));

  S.competenceOverrides = makeOverrideKeyProxy(S.competenceOverrides,
    syncCompetenceOverride, (code,side) => syncCompetenceOverride(code,null,side));

  S.familyOverrides = makeOverrideKeyProxy(S.familyOverrides,
    syncFamilyOverride, deleteFamilyOverride);

  S.typeOverrides = makeOverrideKeyProxy(S.typeOverrides,
    syncTypeOverride, deleteTypeOverride);

  // R32: S.extras est clé par new_code seul (pas de compound "side:code" —
  // ce mécanisme ne concerne que les ressources nouvelles), donc pas besoin
  // de makeOverrideKeyProxy/parseOvKey ici, contrairement aux 4 Proxy
  // ci-dessus.
  const _origExtras = S.extras || {};
  S.extras = new Proxy(_origExtras, {
    set(target, prop, value) {
      target[prop] = value;
      if (CURRENT_PROJECT_ID) syncExtras(prop, value).catch(console.error);
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop];
      if (CURRENT_PROJECT_ID) syncExtras(prop, []).catch(console.error);
      return true;
    }
  });
}

function patchAppFunctions() {

  // Patch addHist → syncHistory
  const _origAddHist = window.addHist;
  window.addHist = function(code, type, msg) {
    if (_origAddHist) _origAddHist(code, type, msg);
    syncHistory(code, type, msg).catch(console.error);
  };

  // Patch saveState → no-op (on sauvegarde à chaque opération)
  window.saveState = async function() { /* géré par supabase-sync */ };

  // Patch setOverride (si existant) ou intercepter S.overrides
  // On surveille les modifications de S.overrides via Proxy
  installSyncProxies();

  console.log('[Sync] Patches appliqués sur S');
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function initCollaboration() {
  const ok = await requireAuth();
  if (!ok) return;

  // Afficher le badge utilisateur dans le header
  if (CURRENT_USER) renderUserBadge(CURRENT_USER);
  setSyncStatus('🔄 Chargement…');

  // Charger les projets disponibles
  try {
    window._projects = await loadProjects();
    renderProjectSelector();
    setSyncStatus('✅ Connecté', 'rgba(134,239,172,.9)');
    // Ouvrir la modale de sélection de projet
    showProjectModal();
  } catch(e) {
    setSyncStatus('⚠️ Erreur sync', '#fca5a5');
    console.error('[Collab] Erreur chargement projets:', e);
  }
}

function showProjectModal() {
  // Supprimer modale existante
  const existing = document.getElementById('project-modal-overlay');
  if (existing) existing.remove();

  const projects = window._projects || [];

  const overlay = document.createElement('div');
  overlay.id = 'project-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.7);' +
    'display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px)';

  const projectList = projects.length === 0
    ? '<p style="color:#64748b;font-size:13px;text-align:center;margin:8px 0 16px">Aucun projet existant — créez-en un ci-dessous.</p>'
    : projects.map(p => `
        <div onclick="selectProjectFromModal('${p.id}','${eA(p.name)}',this)"
          style="padding:12px 16px;border:2px solid #e2e8f0;border-radius:8px;cursor:pointer;
                 margin-bottom:8px;transition:all .15s;background:#fff;display:flex;
                 justify-content:space-between;align-items:center;gap:8px"
          onmouseover="this.style.borderColor='#1e3a5f';this.style.background='#eff6ff'"
          onmouseout="this.style.borderColor='#e2e8f0';this.style.background='#fff'">
          <div style="min-width:0">
            <div style="font-weight:700;color:#1e293b">${eH(p.name)}</div>
            <div style="font-size:11px;color:#64748b;margin-top:2px">${eH(p.old_program_name||'?')} → ${eH(p.new_program_name||'?')} · ${new Date(p.created_at).toLocaleDateString('fr')}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button onclick="event.stopPropagation();cloneProject('${p.id}')" title="Cloner ce projet"
              style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:6px;
                     padding:5px 9px;font-size:11px;font-weight:600;cursor:pointer">⎘ Cloner</button>
            <button onclick="event.stopPropagation();showDeleteProjectModal('${p.id}')" title="Supprimer ce projet"
              style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:6px;
                     padding:5px 9px;font-size:11px;font-weight:600;cursor:pointer">🗑</button>
          </div>
        </div>`).join('');

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:32px;width:480px;max-width:95vw;
                box-shadow:0 25px 60px rgba(0,0,0,.3);max-height:80vh;overflow-y:auto">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:32px;margin-bottom:8px">📂</div>
        <h2 style="font-size:18px;font-weight:800;color:#1e293b;margin:0 0 4px">Sélectionner un projet</h2>
        <p style="font-size:13px;color:#64748b;margin:0">Chaque projet correspond à un couple de programmes à comparer</p>
      </div>

      ${projectList}

      <div style="border-top:1px solid #f1f5f9;padding-top:16px;margin-top:8px">
        <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">
          Nouveau projet
        </div>
        <div style="display:flex;gap:8px">
          <input id="modal-proj-name" type="text" placeholder="Ex : QLIO 2022 → IMP 2026"
            style="flex:1;padding:9px 12px;border:1px solid #cbd5e1;border-radius:7px;font-size:13px;outline:none"
            onkeydown="if(event.key==='Enter') createProjectFromModal()"
            onfocus="this.style.borderColor='#1e3a5f'" onblur="this.style.borderColor='#cbd5e1'"/>
          <button onclick="createProjectFromModal()"
            style="background:#1e3a5f;color:#fff;border:none;border-radius:7px;
                   padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">
            Créer
          </button>
        </div>
      </div>

      <div style="border-top:1px solid #f1f5f9;padding-top:16px;margin-top:16px">
        <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">
          Importer un projet
        </div>
        <p style="font-size:11px;color:#64748b;margin:0 0 8px">Depuis un fichier généré par « 📦 Exporter le projet » — crée toujours un nouveau projet, jamais d'écrasement.</p>
        <label style="display:flex;align-items:center;justify-content:center;gap:6px;border:1.5px dashed #cbd5e1;border-radius:7px;padding:10px;font-size:13px;color:#475569;cursor:pointer;font-weight:600">
          📂 Choisir un fichier .json
          <input type="file" accept=".json" style="display:none" onchange="importProjectFile(this)"/>
        </label>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  // Focus sur le champ si aucun projet
  if (projects.length === 0) {
    setTimeout(() => document.getElementById('modal-proj-name')?.focus(), 100);
  }
}

async function selectProjectFromModal(projectId, projectName, el) {
  await selectProject(projectId);
  // Fermer la modale
  document.getElementById('project-modal-overlay')?.remove();
  setProjectBadge(projectName);
  showToast('✅ Projet "' + projectName + '" chargé', 'success');
}

async function createProjectFromModal() {
  const name = document.getElementById('modal-proj-name')?.value?.trim();
  if (!name) {
    document.getElementById('modal-proj-name').style.borderColor = '#ef4444';
    return;
  }
  try {
    const proj = await createProject(name, S.oldName || '', S.newName || '');
    window._projects = window._projects || [];
    window._projects.unshift(proj);
    await selectProject(proj.id);
    document.getElementById('project-modal-overlay')?.remove();
    setProjectBadge(name);
    renderProjectSelector();
    showToast('✅ Projet "' + name + '" créé et activé', 'success');
  } catch(e) {
    alert('Erreur création : ' + e.message);
  }
}

/** Clone un projet existant : réglages (pondérations, parcours actifs) + tout
 * l'état actuel (overrides, validations, familles/types modifiés, mots-clés)
 * sont copiés dans un nouveau projet indépendant. L'historique n'est PAS
 * copié — celui du clone démarre vide, celui de l'original reste intact. */
async function cloneProject(sourceProjectId){
  const src = (window._projects||[]).find(p=>p.id===sourceProjectId);
  if (!src) return;
  const newName = prompt('Nom du projet cloné :', src.name + ' (copie)');
  if (!newName || !newName.trim()) return;
  try {
    const { data: proj, error: e1 } = await db.from('projects').insert({
      name: newName.trim(),
      old_program_name: src.old_program_name,
      new_program_name: src.new_program_name,
      weights: src.weights,
      active_parcours: src.active_parcours,
      created_by: CURRENT_USER.id
    }).select().single();
    if (e1) throw e1;

    const tablesToClone = ['overrides','validations','kw_overrides','family_overrides','type_overrides','competence_overrides','extras'];
    for (const t of tablesToClone) {
      const { data: rows, error: e2 } = await db.from(t).select('*').eq('project_id', sourceProjectId);
      if (e2) throw e2;
      if (rows && rows.length) {
        const copies = rows.map(({id, project_id, updated_at, updated_by, ...rest}) => ({
          ...rest, project_id: proj.id,
          updated_at: new Date().toISOString(), updated_by: CURRENT_USER.id
        }));
        const { error: e3 } = await db.from(t).insert(copies);
        if (e3) throw e3;
      }
    }

    window._projects = window._projects || [];
    window._projects.unshift(proj);
    renderProjectSelector();
    document.getElementById('project-modal-overlay')?.remove();
    await selectProject(proj.id);
    setProjectBadge(newName.trim());
    showToast('✅ Projet cloné : "' + newName.trim() + '"', 'success');
  } catch(e) {
    alert('Erreur lors du clonage : ' + e.message);
  }
}

// R40: recrée un projet à partir d'un fichier généré par
// exportProjectJSON() — même principe que cloneProject() (nouveau projet +
// copie des tables liées), mais depuis un fichier plutôt qu'un projet
// Supabase existant. Crée TOUJOURS un nouveau projet, jamais d'écrasement
// d'un projet existant.
async function importProjectFile(input){
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch(e) {
    alert('Fichier invalide (JSON illisible) : ' + e.message);
    return;
  }
  if (!payload || typeof payload !== 'object' || !payload.meta) {
    alert('Ce fichier ne ressemble pas à un export de projet valide.');
    return;
  }
  const defaultName = (payload.meta.name || 'Projet importé') + ' (import)';
  const newName = prompt('Nom du projet importé :', defaultName);
  if (!newName || !newName.trim()) return;

  try {
    const { data: proj, error: e1 } = await db.from('projects').insert({
      name: newName.trim(),
      old_program_name: payload.meta.old_program_name || '',
      new_program_name: payload.meta.new_program_name || '',
      weights: payload.meta.weights || null,
      active_parcours: payload.meta.active_parcours || null,
      created_by: CURRENT_USER.id
    }).select().single();
    if (e1) throw e1;

    const batches = [];
    const ov = Object.entries(payload.overrides || {});
    if (ov.length) batches.push(['overrides', ov.map(([new_code, old_code]) => ({
      project_id: proj.id, new_code, old_code: old_code || null, updated_by: CURRENT_USER.id
    }))]);

    const val = Object.entries(payload.validations || {});
    if (val.length) batches.push(['validations', val.map(([new_code, v]) => ({
      project_id: proj.id, new_code, status: v.status, comment: v.comment || null,
      validated_old_code: v.validatedOldCode || null, updated_by: CURRENT_USER.id
    }))]);

    const kw = Object.entries(payload.kwOverrides || {});
    if (kw.length) batches.push(['kw_overrides', kw.map(([key, keywords]) => {
      const {side, code} = parseOvKey(key);
      return {project_id: proj.id, resource_code: code, side, keywords, updated_by: CURRENT_USER.id};
    })]);

    const fam = Object.entries(payload.familyOverrides || {});
    if (fam.length) batches.push(['family_overrides', fam.map(([key, family]) => {
      const {side, code} = parseOvKey(key);
      return {project_id: proj.id, resource_code: code, side, family, updated_by: CURRENT_USER.id};
    })]);

    const typ = Object.entries(payload.typeOverrides || {});
    if (typ.length) batches.push(['type_overrides', typ.map(([key, type]) => {
      const {side, code} = parseOvKey(key);
      return {project_id: proj.id, resource_code: code, side, is_transversal: type==='transversal', updated_by: CURRENT_USER.id};
    })]);

    const comp = Object.entries(payload.competenceOverrides || {});
    if (comp.length) batches.push(['competence_overrides', comp.map(([key, competences]) => {
      const {side, code} = parseOvKey(key);
      return {project_id: proj.id, resource_code: code, side, competences, updated_by: CURRENT_USER.id};
    })]);

    const extrasRows = Object.entries(payload.extras || {}).flatMap(([new_code, oldCodes]) =>
      (oldCodes || []).map(old_code => ({project_id: proj.id, new_code, old_code, updated_by: CURRENT_USER.id}))
    );
    if (extrasRows.length) batches.push(['extras', extrasRows]);

    for (const [table, rows] of batches) {
      const { error } = await db.from(table).insert(rows);
      if (error) throw error;
    }

    window._projects = window._projects || [];
    window._projects.unshift(proj);
    renderProjectSelector();
    document.getElementById('project-modal-overlay')?.remove();
    await selectProject(proj.id);
    setProjectBadge(newName.trim());
    showToast('✅ Projet "' + newName.trim() + '" importé', 'success');
  } catch(e) {
    alert('Erreur lors de l\'import : ' + e.message);
  }
}

/** Affiche une modale d'avertissement avant suppression définitive d'un projet
 * (la suppression est en cascade côté base : toutes les correspondances,
 * validations, overrides et l'historique du projet disparaissent avec lui). */
function showDeleteProjectModal(projectId){
  const proj = (window._projects||[]).find(p=>p.id===projectId);
  if (!proj) return;
  const existing = document.getElementById('delete-project-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'delete-project-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.7);' +
    'display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px)';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:28px;width:420px;max-width:92vw;box-shadow:0 25px 60px rgba(0,0,0,.3)">
      <div style="text-align:center;margin-bottom:8px">
        <div style="font-size:32px;margin-bottom:8px">⚠️</div>
        <h2 style="font-size:17px;font-weight:800;color:#1e293b;margin:0 0 10px">Supprimer « ${eH(proj.name)} » ?</h2>
        <p style="font-size:13px;color:#64748b;margin:0;line-height:1.6;text-align:left">
          Cette action est <strong>définitive</strong>. Toutes les correspondances, validations,
          modifications de famille ou de type, mots-clés personnalisés et l'historique de ce
          projet seront <strong style="color:#dc2626">supprimés sans possibilité de récupération</strong>.
        </p>
      </div>
      <div style="display:flex;gap:10px;margin-top:20px">
        <button onclick="document.getElementById('delete-project-modal-overlay').remove()"
          style="flex:1;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:8px;
                 padding:10px;font-size:13px;font-weight:700;cursor:pointer">Annuler</button>
        <button onclick="confirmDeleteProject('${projectId}')"
          style="flex:1;background:#dc2626;color:#fff;border:none;border-radius:8px;
                 padding:10px;font-size:13px;font-weight:700;cursor:pointer">🗑 Supprimer définitivement</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function confirmDeleteProject(projectId){
  const proj = (window._projects||[]).find(p=>p.id===projectId);
  document.getElementById('delete-project-modal-overlay')?.remove();
  try {
    const { error } = await db.from('projects').delete().eq('id', projectId);
    if (error) throw error;
    window._projects = (window._projects||[]).filter(p=>p.id!==projectId);
    renderProjectSelector();
    if (CURRENT_PROJECT_ID === projectId) {
      CURRENT_PROJECT_ID = null;
      setProjectBadge(null);
      showProjectModal();
    }
    if (typeof showToast==='function') showToast('🗑 Projet "'+(proj?.name||'')+'" supprimé', 'success');
  } catch(e) {
    alert('Erreur lors de la suppression : ' + e.message);
  }
}

function renderProjectSelector() {
  // Chercher le conteneur existant, sinon le créer dans tab-data
  let container = document.getElementById('project-selector-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'project-selector-container';
    container.style.cssText = 'margin-bottom:12px';
    const tabData = document.getElementById('tab-data');
    if (tabData) tabData.prepend(container);
    else return;
  }

  if (window._projects.length === 0) {
    // Aucun projet : proposer d'en créer un
    container.innerHTML = `
      <div style="background:#fffbeb;border:1px solid #fde047;border-radius:10px;padding:16px;margin-bottom:16px;text-align:center">
        <div style="font-weight:700;color:#92400e;margin-bottom:8px">Aucun projet existant</div>
        <input id="new-proj-name" type="text" placeholder="Nom du projet (ex : QLIO → IMP 2026)"
          style="padding:7px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;width:320px;margin-right:8px"/>
        <button onclick="createNewProject()"
          style="background:#1e3a5f;color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;cursor:pointer;font-weight:600">
          Créer le projet
        </button>
      </div>`;
    return;
  }

  const opts = window._projects.map(p => `
    <div onclick="selectProject('${p.id}')"
      style="padding:10px 14px;border:2px solid #e2e8f0;border-radius:8px;cursor:pointer;
             display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;
             transition:all .15s"
      onmouseover="this.style.borderColor='#1e3a5f';this.style.background='#eff6ff'"
      onmouseout="this.style.borderColor='#e2e8f0';this.style.background='#fff'">
      <div style="min-width:0">
        <div style="font-weight:700;color:#1e293b">${eH(p.name)}</div>
        <div style="font-size:11px;color:#64748b">${eH(p.old_program_name||'?')} → ${eH(p.new_program_name||'?')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <span style="font-size:11px;color:#94a3b8">${new Date(p.created_at).toLocaleDateString('fr')}</span>
        <button onclick="event.stopPropagation();cloneProject('${p.id}')" title="Cloner ce projet"
          style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:6px;
                 padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer">⎘</button>
        <button onclick="event.stopPropagation();showDeleteProjectModal('${p.id}')" title="Supprimer ce projet"
          style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:6px;
                 padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer">🗑</button>
      </div>
    </div>`).join('');

  container.innerHTML = `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:16px">
      <div style="font-weight:700;color:#1e3a5f;margin-bottom:12px;font-size:14px">📂 Sélectionner un projet</div>
      ${opts}
      <div style="border-top:1px solid #f1f5f9;padding-top:10px;margin-top:4px">
        <input id="new-proj-name" type="text" placeholder="Nouveau projet…"
          style="padding:6px 10px;border:1px solid #cbd5e1;border-radius:5px;font-size:12px;width:240px;margin-right:6px"/>
        <button onclick="createNewProject()"
          style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:5px;
                 padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600">
          + Nouveau
        </button>
      </div>
    </div>`;
}

async function createNewProject() {
  const name = document.getElementById('new-proj-name')?.value?.trim();
  if (!name) return;
  try {
    const proj = await createProject(name, '', '');
    window._projects.unshift(proj);
    await selectProject(proj.id);
    renderProjectSelector();
  } catch(e) {
    alert('Erreur création projet : ' + e.message);
  }
}

// ── Interface utilisateur (créée dynamiquement) ───────────────────────────────

function renderUserBadge(user) {
  // Chercher le header pour y injecter le badge
  const hdr = document.querySelector('.hdr') || document.querySelector('[class*="hdr"]');
  if (!hdr) return;

  // Supprimer un badge existant
  const existing = document.getElementById('collab-ui');
  if (existing) existing.remove();

  const ui = document.createElement('div');
  ui.id = 'collab-ui';
  ui.style.cssText = 'display:flex;align-items:center;gap:8px;margin-left:auto;flex-shrink:0';
  ui.innerHTML = `
    <span id="project-badge" onclick="showProjectModal()" title="Cliquer pour changer de projet" style="display:none;cursor:pointer;background:rgba(255,255,255,.2);color:#fff;
      font-size:11px;padding:3px 10px;border-radius:12px;font-weight:600;white-space:nowrap"></span>
    <button onclick="reloadCurrentProject()" title="Recharger les données du projet depuis Supabase" style="background:rgba(255,255,255,.1);color:rgba(255,255,255,.8);
      border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:2px 6px;font-size:12px;cursor:pointer">🔄</button>
    <span id="sync-indicator" style="font-size:11px;color:rgba(255,255,255,.8);white-space:nowrap"></span>
    <span id="last-save-indicator" style="font-size:11px;color:rgba(255,255,255,.65);white-space:nowrap">💾 Pas encore enregistré cette session</span>
    <div id="user-badge" style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.15);
      padding:4px 10px;border-radius:20px;font-size:12px;color:#fff;cursor:default" title="${user.email}">
      <span>👤</span>
      <span style="font-weight:600">${user.display_name || user.email.split('@')[0]}</span>
    </div>
    <button onclick="doLogout()" style="background:rgba(255,255,255,.1);color:rgba(255,255,255,.8);
      border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:4px 8px;font-size:11px;
      cursor:pointer" title="Se déconnecter">⏏</button>
  `;
  hdr.appendChild(ui);
}

function setSyncStatus(text, color) {
  const el = document.getElementById('sync-indicator');
  if (el) { el.textContent = text; el.style.color = color || 'rgba(255,255,255,.8)'; }
}

function setProjectBadge(name) {
  const el = document.getElementById('project-badge');
  if (!el) return;
  if (name) { el.textContent = '📂 ' + name; el.style.display = 'inline'; }
  else { el.style.display = 'none'; }
}

function showToast(msg, type) {
  const t = document.createElement('div');
  const bg = type === 'error' ? '#fef2f2' : type === 'success' ? '#f0fdf4' : '#eff6ff';
  const border = type === 'error' ? '#fecaca' : type === 'success' ? '#bbf7d0' : '#bfdbfe';
  const color = type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '#1d4ed8';
  t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:99999;padding:12px 20px;
    background:${bg};border:1px solid ${border};color:${color};border-radius:10px;
    font-size:13px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.1);
    animation:fadeIn .2s ease`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

async function doLogout() {
  await db.auth.signOut();
  window.location.href = 'auth.html';
}

// ── NE PAS auto-init ici — initCollaboration() est appelé depuis index.html ──
