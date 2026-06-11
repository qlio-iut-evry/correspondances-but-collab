# Correspondances Programme National du BUT — Version collaborative

Version multi-utilisateurs avec base de données Supabase.  
Basée sur l'appli client-side `correspondances_ressources.html` — ce projet n'y touche pas.

---

## Architecture

```
auth.html          ← Page de connexion / inscription
index.html         ← Appli principale (à créer — voir étape 4)
supabase-sync.js   ← Couche de synchronisation Supabase
sql/schema.sql     ← Schéma de la base de données
```

---

## Installation pas à pas

### Étape 1 — Créer le projet Supabase (5 min)

1. Aller sur [supabase.com](https://supabase.com) → **Start for free**
2. Créer un compte (GitHub ou email)
3. Cliquer **New project**
   - Organisation : créer ou choisir
   - Nom : `correspondances-but`
   - Mot de passe base de données : choisir un mot de passe fort (le noter)
   - Région : `West EU (Ireland)` — le plus proche
4. Attendre ~2 minutes que le projet démarre

### Étape 2 — Créer la base de données

1. Dans Supabase → **SQL Editor** → **New query**
2. Copier-coller tout le contenu de `sql/schema.sql`
3. Cliquer **Run** (▶)
4. Vérifier : `Success. No rows returned` → ✅

### Étape 3 — Récupérer les clés API

1. Dans Supabase → **Project Settings** → **API**
2. Copier :
   - **Project URL** → `https://xxxxx.supabase.co`
   - **anon / public key** → longue chaîne commençant par `eyJ...`
3. Remplacer dans **`supabase-sync.js`** lignes 12-13 :
   ```javascript
   const SUPABASE_URL  = 'https://XXXXX.supabase.co';   // ← coller ici
   const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIs...';     // ← coller ici
   ```
4. Faire la même chose dans **`auth.html`** lignes correspondantes

### Étape 4 — Créer index.html

1. Copier `correspondances_ressources.html` (le fichier original)
2. Le renommer `index.html` dans ce dossier
3. Ouvrir `index.html` et trouver la balise `</head>`
4. Ajouter **avant** `</head>` :
   ```html
   <!-- Supabase SDK -->
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   ```
5. Trouver la balise `</body>` et ajouter **avant** :
   ```html
   <!-- Synchronisation collaborative -->
   <script src="supabase-sync.js"></script>
   ```
6. Dans le header (`<div class="hdr">`), ajouter après le titre :
   ```html
   <!-- Badge projet actif -->
   <span id="project-badge" style="display:none;background:rgba(255,255,255,.2);
     color:#fff;font-size:11px;padding:3px 10px;border-radius:12px;font-weight:600"></span>
   <!-- Indicateur de sync -->
   <span id="sync-indicator" style="font-size:11px;opacity:.85"></span>
   <!-- Badge utilisateur -->
   <div id="user-badge" style="display:flex;align-items:center;gap:8px;margin-left:auto"></div>
   ```
7. Dans l'onglet **Données** (tab-data), ajouter en haut du contenu :
   ```html
   <!-- Sélecteur de projet collaboratif -->
   <div id="project-selector-container"></div>
   ```
8. Après le chargement de `supabase-sync.js`, appeler le patch :
   ```html
   <script>
     // Appliquer les patches Supabase après init de S
     window.addEventListener('load', () => {
       setTimeout(patchAppFunctions, 500);
     });
   </script>
   ```

### Étape 5 — Activer l'authentification

1. Dans Supabase → **Authentication** → **Providers**
2. **Email** doit être activé (c'est le cas par défaut)
3. Optionnel : **Authentication** → **Email Templates** → personnaliser les emails

### Étape 6 — Inviter l'équipe

1. Ouvrir `auth.html` dans le navigateur
2. Créer votre compte (onglet **Créer un compte**)
3. Partager le lien `auth.html` avec vos collègues
4. Ils créent leur compte, vous travaillez tous sur le même projet

---

## Déploiement sur GitHub Pages

```bash
# Dans ce dossier
git init
git add .
git commit -m "Initial commit — version collaborative"
git branch -M main
git remote add origin https://github.com/VOTRE_COMPTE/correspondances-but-collab.git
git push -u origin main
```

Puis dans GitHub → Settings → Pages → Source : **main / root** → Save  
URL : `https://VOTRE_COMPTE.github.io/correspondances-but-collab/`

> ⚠️ Les clés Supabase dans le code sont **publiques** (anon key).  
> Elles ne donnent accès qu'aux données protégées par RLS.  
> Ne jamais mettre la `service_role` key dans le frontend.

---

## Fonctionnement collaboratif

| Action | Ce qui se passe |
|--------|-----------------|
| Un collègue valide R1.04 | Tous les autres voient le ✅ en temps réel |
| Modification de famille | Synchronisée immédiatement |
| Ajout/suppression mots-clés | Propagé à tous |
| Historique | Journal partagé avec le nom de l'auteur |
| Rechargement page | L'état est rechargé depuis la BDD |

---

## Structure de la base de données

| Table | Contenu |
|-------|---------|
| `projects` | Projets de correspondance (couple ancien/nouveau programme) |
| `overrides` | Associations manuelles (newCode → oldCode) |
| `validations` | Statuts de validation par ressource |
| `kw_overrides` | Mots-clés modifiés manuellement |
| `family_overrides` | Familles modifiées manuellement |
| `type_overrides` | Types modifiés (transversal/métier) |
| `history` | Journal d'audit (qui, quand, quoi) |
| `profiles` | Membres de l'équipe |
