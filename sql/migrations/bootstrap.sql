-- ════════════════════════════════════════════════════════════════
-- BOOTSTRAP — à exécuter UNE FOIS sur le projet Supabase existant
-- (rackahuqnfekncnzrsge), qui a déjà les tables/colonnes des migrations
-- 0001 à 0005 (appliquées à la main au fil des sessions précédentes) mais
-- pas encore la table de suivi schema_migrations elle-même.
--
-- Ne crée/modifie AUCUNE table de données, ne touche à aucune ligne
-- existante — seulement schema_migrations. Idempotent (sans risque de le
-- relancer plusieurs fois). Voir sql/migrations/README.md.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='schema_migrations' AND policyname='auth_full_access'
  ) THEN
    CREATE POLICY "auth_full_access" ON schema_migrations
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES
  ('0001_init'),
  ('0002_active_parcours'),
  ('0003_competence_overrides'),
  ('0004_side_column'),
  ('0005_extras')
ON CONFLICT (version) DO NOTHING;

-- Vérification :
-- SELECT version, applied_at FROM schema_migrations ORDER BY applied_at;
-- doit renvoyer les 5 lignes ci-dessus.
