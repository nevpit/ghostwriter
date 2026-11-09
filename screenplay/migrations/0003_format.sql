-- 0003: per-project document format
-- Version: 3
--
-- Phase 1 registers a second document engine (prose). A project's format decides
-- which engine parses/validates/renders it and must survive restarts, so it is
-- persisted per project. Additive: every existing row keeps the original
-- 'screenplay' format via the column DEFAULT, so no data migration is needed.

ALTER TABLE projects ADD COLUMN format TEXT NOT NULL DEFAULT 'screenplay';
UPDATE meta SET value = '3' WHERE key = 'schema_version';
