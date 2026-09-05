# Migrations SQL

Avant ce dossier, chaque changement de schéma s'accumulait indéfiniment dans
`sql/schema.sql`, rejoué à la main dans Supabase SQL Editor, sans aucune
trace de ce qui avait réellement été appliqué sur un projet Supabase donné.
`schema_migrations` (créée par `sql/schema.sql`) comble ça en gardant une
ligne par migration appliquée.

`0001_init.sql` à `0005_extras.sql` sont l'historique — le contenu exact de
ce qui a été appliqué à la main avant ce système, séparé en fichiers
numérotés pour référence. Ils ne servent qu'à documenter l'existant : la
première section ci-dessous couvre le cas où on en a réellement besoin.

## Pour un nouveau projet Supabase

Rien à faire ici : `sql/schema.sql` contient déjà tout, y compris
l'enregistrement des 5 premières migrations (`0001` à `0005`) dans
`schema_migrations`. Coller `sql/schema.sql` dans le SQL Editor suffit (voir
`README.md` à la racine) — ne pas rejouer `0001_init.sql` etc. en plus, ce
serait redondant (et sans risque, grâce aux gardes `IF NOT EXISTS`, mais
inutile).

## Pour le projet Supabase existant (déjà en prod avant ce système)

Les tables/colonnes des migrations `0001` à `0005` sont déjà en place (elles
ont été appliquées à la main au fil du temps) — seule la table
`schema_migrations` elle-même n'existe pas encore dessus. Exécuter une fois
`bootstrap.sql` : il crée `schema_migrations` et
enregistre ces 5 migrations comme déjà appliquées, sans toucher à aucune
table de données. Idempotent — sans risque de le lancer plusieurs fois.

## Pour ajouter une nouvelle migration

1. Créer `sql/migrations/000N_description_courte.sql` (N = numéro suivant).
2. Écrire du SQL **idempotent** (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
   blocs `DO $$ ... IF NOT EXISTS (...) THEN ... END IF; END $$;` pour les
   policies/contraintes — voir les fichiers existants comme modèle).
3. Terminer le fichier par :
   ```sql
   INSERT INTO schema_migrations (version) VALUES ('000N_description_courte')
   ON CONFLICT (version) DO NOTHING;
   ```
4. Donner ce fichier à l'utilisateur pour qu'il l'exécute dans Supabase SQL
   Editor (CLAUDE.md §6 : ne jamais l'exécuter soi-même sur le projet réel).
5. Vérifier après coup avec :
   ```sql
   SELECT version, applied_at FROM schema_migrations ORDER BY applied_at;
   ```
   — si la ligne n'y est pas, la migration n'a pas été rejouée sur ce
   projet.

Ne plus ajouter de nouveau bloc à la fin de `sql/schema.sql` pour un
changement de schéma après l'installation initiale — un nouveau fichier
numéroté ici, à la place.
