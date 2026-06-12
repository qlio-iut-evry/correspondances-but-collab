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

function renderUserBadge() {
  const badge = document.getElementById('user-badge');
  if (!badge || !CURRENT_USER) return;
  badge.innerHTML = `
    <span style="font-size:11px;opacity:.85">${CURRENT_USER.display_name}</span>
    <button onclick="signOut()" title="Se déconnecter"
      style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);
             color:#fff;border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer">
      Déconnexion
    </button>`;
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
async function selectProject(projectId) {
  CURRENT_PROJECT_ID = projectId;
  await loadProjectState();
  subscribeToRealtime();
  renderProjectBadge();
}

function renderProjectBadge() {
  const badge = document.getElementById('project-badge');
  if (!badge) return;
  const proj = (window._projects||[]).find(p=>p.id===CURRENT_PROJECT_ID);
  if (proj) {
    badge.textContent = proj.name;
    badge.style.display = '';
  }
}

// ── Chargement de l'état depuis Supabase ──────────────────────────────────────

/**
 * Charge tout l'état du projet depuis Supabase
 * et remplace le S (state) local de l'appli.
 */
async function loadProjectState() {
  if (!CURRENT_PROJECT_ID) return;

  const [ovRes, valRes, kwRes, famRes, typRes, histRes] = await Promise.all([
    db.from('overrides')       .select('*').eq('project_id', CURRENT_PROJECT_ID),
    db.from('validations')     .select('*').eq('project_id', CURRENT_PROJECT_ID),
    db.from('kw_overrides')    .select('*').eq('project_id', CURRENT_PROJECT_ID),
    db.from('family_overrides').select('*').eq('project_id', CURRENT_PROJECT_ID),
    db.from('type_overrides')  .select('*').eq('project_id', CURRENT_PROJECT_ID),
    db.from('history')         .select('*, profiles(display_name,email)')
                               .eq('project_id', CURRENT_PROJECT_ID)
                               .order('created_at', { ascending: false })
                               .limit(200)
  ]);

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

  // Reconstruire S.kwOverrides
  S.kwOverrides = {};
  (kwRes.data || []).forEach(r => { S.kwOverrides[r.resource_code] = r.keywords; });

  // Reconstruire S.familyOverrides
  S.familyOverrides = {};
  (famRes.data || []).forEach(r => { S.familyOverrides[r.resource_code] = r.family; });

  // Reconstruire S.typeOverrides
  S.typeOverrides = {};
  (typRes.data || []).forEach(r => { S.typeOverrides[r.resource_code] = r.is_transversal; });

  // Reconstruire S.hist
  S.hist = (histRes.data || []).map(r => ({
    code: r.resource_code, type: r.action_type,
    msg: r.description, ts: r.created_at,
    user: r.profiles?.display_name || r.profiles?.email || '?'
  }));

  console.log('[Sync] État chargé depuis Supabase');
  if (S.loaded) { recomputeMatching(); renderCorr(); updateStats(); }
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
  await db.from('overrides').upsert({
    project_id: CURRENT_PROJECT_ID,
    new_code: newCode,
    old_code: oldCode || null,
    updated_at: new Date().toISOString(),
    updated_by: CURRENT_USER.id
  }, { onConflict: 'project_id,new_code' });
}

/** Supprime un override */
async function deleteOverride(newCode) {
  if (!CURRENT_PROJECT_ID) return;
  await db.from('overrides')
    .delete()
    .eq('project_id', CURRENT_PROJECT_ID)
    .eq('new_code', newCode);
}

/** Sauvegarde une validation */
async function syncValidation(newCode, status, comment, validatedOldCode) {
  if (!CURRENT_PROJECT_ID) return;
  if (!status) {
    await db.from('validations')
      .delete()
      .eq('project_id', CURRENT_PROJECT_ID)
      .eq('new_code', newCode);
    return;
  }
  await db.from('validations').upsert({
    project_id: CURRENT_PROJECT_ID,
    new_code: newCode, status,
    comment: comment || null,
    validated_old_code: validatedOldCode || null,
    updated_at: new Date().toISOString(),
    updated_by: CURRENT_USER.id
  }, { onConflict: 'project_id,new_code' });
}

/** Sauvegarde un override de mots-clés */
async function syncKwOverride(resourceCode, keywords) {
  if (!CURRENT_PROJECT_ID) return;
  if (!keywords || keywords.length === 0) {
    await db.from('kw_overrides')
      .delete()
      .eq('project_id', CURRENT_PROJECT_ID)
      .eq('resource_code', resourceCode);
    return;
  }
  await db.from('kw_overrides').upsert({
    project_id: CURRENT_PROJECT_ID,
    resource_code: resourceCode,
    keywords: keywords,
    updated_at: new Date().toISOString(),
    updated_by: CURRENT_USER.id
  }, { onConflict: 'project_id,resource_code' });
}

/** Sauvegarde un override de famille */
async function syncFamilyOverride(resourceCode, family) {
  if (!CURRENT_PROJECT_ID) return;
  await db.from('family_overrides').upsert({
    project_id: CURRENT_PROJECT_ID,
    resource_code: resourceCode,
    family,
    updated_at: new Date().toISOString(),
    updated_by: CURRENT_USER.id
  }, { onConflict: 'project_id,resource_code' });
}

/** Sauvegarde un override de type */
async function syncTypeOverride(resourceCode, isTransversal) {
  if (!CURRENT_PROJECT_ID) return;
  await db.from('type_overrides').upsert({
    project_id: CURRENT_PROJECT_ID,
    resource_code: resourceCode,
    is_transversal: isTransversal,
    updated_at: new Date().toISOString(),
    updated_by: CURRENT_USER.id
  }, { onConflict: 'project_id,resource_code' });
}

/** Enregistre une entrée dans l'historique */
async function syncHistory(resourceCode, actionType, description, details) {
  if (!CURRENT_PROJECT_ID) return;
  await db.from('history').insert({
    project_id: CURRENT_PROJECT_ID,
    resource_code: resourceCode,
    action_type: actionType,
    description,
    details: details || null,
    created_by: CURRENT_USER.id,
    user_email: CURRENT_USER.email
  });
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

  // Patch S.validations via Proxy
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
    }
  });

  // Patch S.kwOverrides via Proxy
  const _origKw = S.kwOverrides || {};
  S.kwOverrides = new Proxy(_origKw, {
    set(target, prop, value) {
      target[prop] = value;
      if (CURRENT_PROJECT_ID) syncKwOverride(prop, value).catch(console.error);
      return true;
    }
  });

  // Patch S.familyOverrides via Proxy
  const _origFam = S.familyOverrides || {};
  S.familyOverrides = new Proxy(_origFam, {
    set(target, prop, value) {
      target[prop] = value;
      if (CURRENT_PROJECT_ID) syncFamilyOverride(prop, value).catch(console.error);
      return true;
    }
  });

  // Patch S.typeOverrides via Proxy
  const _origType = S.typeOverrides || {};
  S.typeOverrides = new Proxy(_origType, {
    set(target, prop, value) {
      target[prop] = value;
      if (CURRENT_PROJECT_ID) syncTypeOverride(prop, value).catch(console.error);
      return true;
    }
  });

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
        <div onclick="selectProjectFromModal('${p.id}','${p.name.replace(/'/g,"\\'")}',this)"
          style="padding:12px 16px;border:2px solid #e2e8f0;border-radius:8px;cursor:pointer;
                 margin-bottom:8px;transition:all .15s;background:#fff"
          onmouseover="this.style.borderColor='#1e3a5f';this.style.background='#eff6ff'"
          onmouseout="this.style.borderColor='#e2e8f0';this.style.background='#fff'">
          <div style="font-weight:700;color:#1e293b">${p.name}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px">${p.old_program_name||'?'} → ${p.new_program_name||'?'} · ${new Date(p.created_at).toLocaleDateString('fr')}</div>
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
      <div>
        <div style="font-weight:700;color:#1e293b">${p.name}</div>
        <div style="font-size:11px;color:#64748b">${p.old_program_name||'?'} → ${p.new_program_name||'?'}</div>
      </div>
      <span style="font-size:11px;color:#94a3b8">${new Date(p.created_at).toLocaleDateString('fr')}</span>
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
    <span id="project-badge" style="display:none;background:rgba(255,255,255,.2);color:#fff;
      font-size:11px;padding:3px 10px;border-radius:12px;font-weight:600;white-space:nowrap"></span>
    <span id="sync-indicator" style="font-size:11px;color:rgba(255,255,255,.8);white-space:nowrap"></span>
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
