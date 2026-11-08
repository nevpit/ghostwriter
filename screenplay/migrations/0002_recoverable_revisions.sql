-- 0002: recoverable revisions
-- Version: 2
--
-- The initial schema enforced UNIQUE(project_id, content_hash) so a project could
-- never hold two byte-identical snapshots. That is incompatible with plan M3
-- snapshot restoration / latest-change undo: "restoring an earlier snapshot
-- creates a NEW revision so history remains available." Recovery must be able to
-- create a revision whose content already exists, so the hash index is relaxed
-- to a plain (non-unique) lookup index. Each revision row still has a unique id
-- (PRIMARY KEY), so the audit trail stays unambiguous.

DROP INDEX IF EXISTS idx_revisions_hash;
CREATE INDEX IF NOT EXISTS idx_revisions_hash ON revisions(project_id, content_hash);
UPDATE meta SET value = '2' WHERE key = 'schema_version';
