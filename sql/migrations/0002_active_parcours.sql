-- Migration 0002 — colonne active_parcours sur projects.
-- NE PAS exécuter isolément sur le projet Supabase existant : déjà en
-- place. Référence historique — voir README.md.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS active_parcours JSONB DEFAULT '["TC","MP","PSC","PSMI","MTD"]';

INSERT INTO schema_migrations (version) VALUES ('0002_active_parcours')
ON CONFLICT (version) DO NOTHING;
