-- Name uniqueness per folder, case-insensitive, ignoring tombstones.
-- A composite unique including deleted_at would enforce nothing: NULLs are distinct in PostgreSQL.
CREATE UNIQUE INDEX node_name_uniq ON "Node" ("parentId", lower(name)) WHERE "deletedAt" IS NULL;

-- Prefix LIKE only uses a btree index with an explicit pattern operator class.
CREATE INDEX node_path_prefix ON "Node" ("roomId", path varchar_pattern_ops);

-- Substring name search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX node_name_trgm ON "Node" USING gin (name gin_trgm_ops);
