-- Migration 0004 — colonne "side" (old/new) sur les 4 tables d'overrides
-- par ressource, pour distinguer une ancienne et une nouvelle ressource
-- qui partagent le même code (ex. R1.01 existe des deux côtés) : sans
-- cette colonne, modifier les mots-clés/famille/type/compétences de l'une
-- écrasait silencieusement ceux de l'autre.
-- NE PAS exécuter isolément sur le projet Supabase existant : déjà en
-- place. Référence historique — voir README.md.

DO $$
DECLARE
  tbl TEXT;
  cname TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['kw_overrides','family_overrides','type_overrides','competence_overrides']
  LOOP
    -- Ajouter la colonne side si absente
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS side TEXT NOT NULL DEFAULT ''new''', tbl);
    -- S'assurer que la contrainte de format existe (ignore si déjà présente)
    BEGIN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (side IN (''old'',''new''))', tbl, tbl||'_side_check');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    -- Retrouver et supprimer l'ancienne contrainte UNIQUE(project_id, resource_code)
    SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = tbl AND con.contype = 'u'
      AND con.conkey = (
        SELECT array_agg(attnum ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = rel.oid AND attname IN ('project_id','resource_code')
      );
    IF cname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, cname);
    END IF;
    -- Ajouter la nouvelle contrainte incluant side, si absente
    BEGIN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE(project_id, resource_code, side)', tbl, tbl||'_project_resource_side_key');
    EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

INSERT INTO schema_migrations (version) VALUES ('0004_side_column')
ON CONFLICT (version) DO NOTHING;
