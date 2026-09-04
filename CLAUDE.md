# CLAUDE.md — correspondances-but-collab

## 1. Projet

Version collaborative multi-utilisateurs de l'application de correspondance de
ressources pédagogiques BUT/QLIO. Ajoute une couche d'authentification et de
synchronisation temps réel (Supabase) au-dessus de l'application client-side
`correspondances_ressources.html` (projet parent, dossier `..`), **sans modifier
sa logique métier d'origine**.

- Repo GitHub : https://github.com/qlio-iut-evry/correspondances-but-collab
- Déployé sur GitHub Pages : https://qlio-iut-evry.github.io/correspondances-but-collab/
- Backend : projet Supabase (Postgres + Auth + Realtime), région West EU (Ireland)

## 2. Règles de travail sur ce projet

1. Ne jamais coder sans spec validée par l'utilisateur.
2. Pour tout choix technique important, toujours proposer 2 options.
3. Signaler immédiatement toute ambiguïté plutôt que d'inventer une réponse.
4. Ajouter un commentaire `// R[n]` sur chaque règle métier implémentée dans le code.
5. Ne pas modifier plus d'un fichier à la fois sans le signaler explicitement.
6. Si un fichier dépasse 300 lignes, proposer un découpage avant de continuer
   — **exception connue** : `index.html` (~5 200 lignes / 5,2 Mo) est un bundle
   auto-suffisant généré par assemblage (app + SDK Supabase + couche de sync).
   Le découpage doit être discuté avec l'utilisateur car il casserait la
   contrainte « un seul fichier, ouvrable sans serveur » héritée du projet
   parent — proposer un script de build plutôt qu'un éclatement manuel.

## 3. Stack technique exacte

- **Aucun framework, aucun build tool, aucun `package.json`.** HTML/CSS/JS
  vanilla à 99,4 % (statistique GitHub), pas de transpilation, pas de bundler.
- **Frontend** : une seule page applicative `index.html`, servie statiquement.
- **Auth** : Supabase Auth (email/mot de passe + lien magique OTP), via le SDK
  officiel `@supabase/supabase-js@2` :
  - `auth.html` le charge depuis le CDN jsDelivr (`<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2">`).
  - `index.html`, lui, embarque le SDK **en dur** (bundle UMD `supabase-js@2.108.1`
    recopié inline autour de la ligne 303) plutôt que de le charger par CDN.
- **Backend** : Supabase (Postgres géré + API REST/Realtime auto-générée).
  Aucun serveur applicatif custom.
- **Synchronisation temps réel** : Supabase Realtime (`postgres_changes`) sur
  6 tables, via `supabase-sync.js` (source éditable, ~29 Ko) dont le contenu
  est également recopié inline dans `index.html` (à partir de la ligne ~4535,
  fonctions `patchAppFunctions()` / `initCollaboration()`), avec auto-init
  800 ms après `window.load`.
- **Hébergement** : GitHub Pages, branche `main`, racine du repo.
- **Pas de variables d'environnement** : la config Supabase (URL + clé `anon`)
  est codée en dur dans `auth.html` et `supabase-sync.js` — c'est voulu, la clé
  `anon` est publique par design Supabase (protection via RLS, voir §6).

## 4. Architecture des dossiers

```
correspondances-but-collab/
├── README.md            Guide d'installation pas-à-pas (Supabase, déploiement)
├── auth.html             Page de connexion / inscription (email+mdp, magic link)
├── index.html            Appli principale — bundle auto-suffisant (app + SDK + sync)
├── supabase-sync.js       Source éditable de la couche de synchro (voir §3)
├── supabase.min.js        Source éditable du SDK Supabase bundlé dans index.html
└── sql/
    └── schema.sql         Schéma Postgres complet (tables, RLS, policies, Realtime)
```

Il n'y a **pas de script de build** dans ce repo (contrairement au projet
parent qui a `generate_app.py`) : `supabase-sync.js` et `supabase.min.js` sont
les sources de référence, mais rien n'automatise leur recopie dans
`index.html` — la synchronisation entre les deux est actuellement **manuelle**.
C'est un point de fragilité à garder en tête (voir §6).

## 5. Conventions de nommage

- **Fichiers** : `snake_case` ou `kebab-case` en minuscules (`supabase-sync.js`,
  `schema.sql`).
- **Tables SQL** : `snake_case` au pluriel (`overrides`, `validations`,
  `kw_overrides`, `family_overrides`, `type_overrides`, `history`, `profiles`,
  `projects`). Préfixes `kw_`, `family_`, `type_` pour les tables d'overrides
  spécifiques à un type de champ.
- **Colonnes SQL** : `snake_case` (`project_id`, `new_code`, `old_code`,
  `updated_by`, `created_at`).
- **Fonctions JS** : `camelCase`, verbe en préfixe selon l'action —
  `sync*` (écriture vers Supabase : `syncOverride`, `syncValidation`,
  `syncHistory`…), `load*` (lecture : `loadProjects`, `loadProjectState`),
  `render*` (DOM : `renderUserBadge`, `renderProjectSelector`), `show*`
  (affichage UI ponctuel : `showToast`, `showProjectModal`, `showMsg`).
- **IDs DOM** : `kebab-case` (`project-badge`, `sync-indicator`, `user-badge`,
  `tab-data`, `modal-proj-name`).
- **État global JS** : objet `S` (state de l'app d'origine, héritée du projet
  parent) manipulé via `Proxy` pour intercepter les écritures et les
  propager vers Supabase (`S.overrides`, `S.validations`, `S.kwOverrides`,
  `S.familyOverrides`, `S.typeOverrides`) ; variables globales `UPPER_SNAKE`
  pour le contexte de session (`CURRENT_PROJECT_ID`, `CURRENT_USER`).

## 6. Fichiers critiques — ne pas modifier sans validation explicite

- **`sql/schema.sql`** : toute modification doit être rejouée manuellement
  dans Supabase (SQL Editor). Pas de système de migrations — un changement de
  schéma non appliqué en base cassera silencieusement la synchro. Ne jamais
  supprimer/renommer une colonne référencée par `supabase-sync.js` sans
  vérifier les deux côtés.
- **Clés Supabase codées en dur** (`SUPABASE_URL` / `SUPABASE_ANON` dans
  `auth.html` et `supabase-sync.js`) : la clé `anon` est publique par design
  (sécurité déléguée aux policies RLS), donc pas un secret à retirer — mais
  **ne jamais y substituer une `service_role` key**, et ne changer ces valeurs
  que si le projet Supabase change réellement.
- **`index.html`** : fichier bundle, ne pas éditer une section (app / SDK /
  sync) sans reporter le même changement dans sa source correspondante
  (`supabase-sync.js` ou `supabase.min.js`), sous peine de divergence
  silencieuse entre la source « propre » et le bundle réellement déployé.
- **RLS policies** (`auth_full_access` sur chaque table) : actuellement
  « tout utilisateur authentifié peut tout lire/écrire » (équipe de confiance,
  pas de permissions fines). Ne pas durcir sans validation — casserait le
  fonctionnement collaboratif actuel.
- **`README.md`** : documente une procédure d'installation manuelle
  (copier-coller de clés, étapes GitHub Pages). Le tenir à jour si la
  procédure change, sinon un·e collègue reproduira une install cassée.

## 7. Règles de commit

- Le remote est `origin` → `main` (pas de branche `develop`, pas de PR
  process observé sur l'historique actuel — 3 commits, tous directement sur
  `main`).
- **Aucun commit ni push automatique** : ne créer de commit que si
  l'utilisateur le demande explicitement (cf. consignes générales de session).
- Ne jamais commiter de `service_role key` Supabase ou tout secret autre que
  la clé `anon` (qui, elle, est destinée à être publique).
- Messages de commit constatés : courts, à l'impératif, en français
  (« Ajout des fichiers du projet », « Fix sélecteur de projet », « Modale
  sélection projet obligatoire ») — suivre ce style.
- Avant de pousser un changement à `index.html`, vérifier que la page
  s'ouvre sans erreur console (pas de build/test automatisé dans ce repo).
