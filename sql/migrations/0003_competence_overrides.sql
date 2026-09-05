-- Migration 0003 — table competence_overrides (édition des compétences
-- ciblées d'une ressource).
-- NE PAS exécuter isolément sur le projet Supabase existant : déjà en
-- place. Référence historique — voir README.md.

CREATE TABLE IF NOT EXISTS competence_overrides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_code TEXT NOT NULL,
  competences   JSONB NOT NULL DEFAULT '[]',
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_by    UUID REFERENCES profiles(id),
  UNIQUE(project_id, resource_code)
);
CREATE INDEX IF NOT EXISTS idx_competence_project ON competence_overrides(project_id);
ALTER TABLE competence_overrides ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='competence_overrides' AND policyname='auth_full_access'
  ) THEN
    CREATE POLICY "auth_full_access" ON competence_overrides
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='competence_overrides'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE competence_overrides;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('0003_competence_overrides')
ON CONFLICT (version) DO NOTHING;
