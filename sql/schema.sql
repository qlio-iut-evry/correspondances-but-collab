-- ============================================================
-- SCHÉMA SUPABASE — Correspondances Programme National du BUT
-- Coller dans : Supabase > SQL Editor > New Query > Run
-- ============================================================

-- ── Profils utilisateurs (complète auth.users) ──────────────
CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Création automatique du profil à l'inscription
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, split_part(NEW.email,'@',1));
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── Projets (un projet = un couple ancien/nouveau programme) ──
CREATE TABLE projects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  old_program_name TEXT,
  new_program_name TEXT,
  -- Clés attendues par adjScore() côté client : code, titre, texte, famille, semestre, mots_cles (somme = 100)
  weights          JSONB DEFAULT '{"code":30,"titre":20,"texte":20,"famille":15,"semestre":10,"mots_cles":5}',
  active_parcours  JSONB DEFAULT '["TC","MP","PSC","PSMI","MTD"]',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  created_by       UUID REFERENCES profiles(id),
  is_active        BOOLEAN DEFAULT TRUE
);

-- ── Overrides (associations manuelles newCode → oldCode) ──────
CREATE TABLE overrides (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  new_code    TEXT NOT NULL,
  old_code    TEXT,           -- NULL = "aucune correspondance" explicite
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES profiles(id),
  UNIQUE(project_id, new_code)
);

-- ── Validations (statut par nouvelle ressource) ───────────────
CREATE TABLE validations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  new_code           TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('valide','a_revoir','refuse')),
  comment            TEXT,
  validated_old_code TEXT,
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_by         UUID REFERENCES profiles(id),
  UNIQUE(project_id, new_code)
);

-- ── Overrides mots-clés ───────────────────────────────────────
-- "side" (old/new) distingue une ressource ancienne d'une ressource nouvelle
-- qui partagent le même code (ex. R1.01 existe des deux côtés) — sans cette
-- colonne, modifier l'un écraserait silencieusement l'override de l'autre.
CREATE TABLE kw_overrides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_code TEXT NOT NULL,
  side          TEXT NOT NULL DEFAULT 'new' CHECK (side IN ('old','new')),
  keywords      JSONB NOT NULL DEFAULT '[]',
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_by    UUID REFERENCES profiles(id),
  UNIQUE(project_id, resource_code, side)
);

-- ── Overrides familles ────────────────────────────────────────
CREATE TABLE family_overrides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_code TEXT NOT NULL,
  side          TEXT NOT NULL DEFAULT 'new' CHECK (side IN ('old','new')),
  family        TEXT NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_by    UUID REFERENCES profiles(id),
  UNIQUE(project_id, resource_code, side)
);

-- ── Overrides types (transversal / métier) ────────────────────
CREATE TABLE type_overrides (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_code  TEXT NOT NULL,
  side           TEXT NOT NULL DEFAULT 'new' CHECK (side IN ('old','new')),
  is_transversal BOOLEAN NOT NULL,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_by     UUID REFERENCES profiles(id),
  UNIQUE(project_id, resource_code, side)
);

-- ── Overrides compétences ciblées ──────────────────────────────
CREATE TABLE competence_overrides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_code TEXT NOT NULL,
  side          TEXT NOT NULL DEFAULT 'new' CHECK (side IN ('old','new')),
  competences   JSONB NOT NULL DEFAULT '[]',
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_by    UUID REFERENCES profiles(id),
  UNIQUE(project_id, resource_code, side)
);

-- ── Historique (journal d'audit) ──────────────────────────────
CREATE TABLE history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_code TEXT,
  action_type   TEXT NOT NULL,
  description   TEXT,
  details       JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  created_by    UUID REFERENCES profiles(id),
  user_email    TEXT
);

-- ── Index pour les performances ───────────────────────────────
CREATE INDEX idx_overrides_project    ON overrides(project_id);
CREATE INDEX idx_validations_project  ON validations(project_id);
CREATE INDEX idx_kw_project           ON kw_overrides(project_id);
CREATE INDEX idx_family_project       ON family_overrides(project_id);
CREATE INDEX idx_type_project         ON type_overrides(project_id);
CREATE INDEX idx_competence_project   ON competence_overrides(project_id);
CREATE INDEX idx_history_project      ON history(project_id);
CREATE INDEX idx_history_created_at   ON history(created_at DESC);

-- ── Row Level Security (RLS) ──────────────────────────────────
-- Principe : tout utilisateur authentifié peut tout lire/écrire
-- (équipe pédagogique de confiance — pas besoin de permissions fines)

ALTER TABLE profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects        ENABLE ROW LEVEL SECURITY;
ALTER TABLE overrides       ENABLE ROW LEVEL SECURITY;
ALTER TABLE validations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE kw_overrides    ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE type_overrides  ENABLE ROW LEVEL SECURITY;
ALTER TABLE competence_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE history         ENABLE ROW LEVEL SECURITY;

-- Policies : accès complet pour les utilisateurs authentifiés
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles','projects','overrides','validations',
                             'kw_overrides','family_overrides','type_overrides',
                             'competence_overrides','history']
  LOOP
    EXECUTE format('CREATE POLICY "auth_full_access" ON %I
      FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ── Realtime (abonnements temps réel) ─────────────────────────
-- Activer la réplication pour les tables collaboratives
ALTER PUBLICATION supabase_realtime ADD TABLE overrides;
ALTER PUBLICATION supabase_realtime ADD TABLE validations;
ALTER PUBLICATION supabase_realtime ADD TABLE kw_overrides;
ALTER PUBLICATION supabase_realtime ADD TABLE family_overrides;
ALTER PUBLICATION supabase_realtime ADD TABLE type_overrides;
ALTER PUBLICATION supabase_realtime ADD TABLE competence_overrides;
ALTER PUBLICATION supabase_realtime ADD TABLE history;

-- ════════════════════════════════════════════════════════════════
-- MIGRATION — à exécuter dans Supabase > SQL Editor > New query
-- pour un projet Supabase déjà créé (ne pas relancer tout le fichier
-- ci-dessus, les CREATE TABLE échoueraient sur les tables existantes).
-- Idempotent : peut être exécutée plusieurs fois sans risque.
-- ════════════════════════════════════════════════════════════════
ALTER TABLE projects ADD COLUMN IF NOT EXISTS active_parcours JSONB DEFAULT '["TC","MP","PSC","PSMI","MTD"]';

-- Édition des compétences ciblées (bouton "Compétences ciblées" dans le
-- panneau de détail / la modale d'édition d'une ressource) :
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

-- Distinguer ancien/nouveau programme dans les overrides famille/type/
-- mots-clés/compétences : sans cette colonne, une ressource ancienne et une
-- ressource nouvelle partageant le même code (ex. R1.01 des deux côtés,
-- fréquent sur ce jeu de données) se marchaient dessus silencieusement —
-- modifier les mots-clés de l'une pouvait écraser ceux de l'autre.
-- Idempotente : peut être exécutée plusieurs fois sans risque.
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
