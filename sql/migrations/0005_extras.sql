-- Migration 0005 — table extras (partage exceptionnel secondaire).
-- Quand plusieurs ressources anciennes sont cochées à la fois dans la
-- modale d'association, la première devient l'affectation principale
-- (table overrides) et les suivantes sont des "extras" : une ancienne
-- ressource supplémentaire rattachée à la même nouvelle ressource.
-- NE PAS exécuter isolément sur le projet Supabase existant : déjà en
-- place. Référence historique — voir README.md.

CREATE TABLE IF NOT EXISTS extras (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  new_code    TEXT NOT NULL,
  old_code    TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES profiles(id),
  UNIQUE(project_id, new_code, old_code)
);
CREATE INDEX IF NOT EXISTS idx_extras_project ON extras(project_id);
ALTER TABLE extras ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='extras' AND policyname='auth_full_access'
  ) THEN
    CREATE POLICY "auth_full_access" ON extras
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='extras'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE extras;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('0005_extras')
ON CONFLICT (version) DO NOTHING;
