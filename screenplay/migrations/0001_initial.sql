-- 0001: initial schema
-- Version: 1

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS projects (
    id                    TEXT PRIMARY KEY,
    title                 TEXT NOT NULL,
    author                TEXT NOT NULL DEFAULT '',
    active_revision_id    TEXT,
    active_rules_id       TEXT,
    renderer_config       TEXT NOT NULL DEFAULT '{}',
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);

-- Revisions are immutable, complete Fountain snapshots.
CREATE TABLE IF NOT EXISTS revisions (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id    TEXT,
    snapshot     TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    origin       TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_project ON revisions(project_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_revisions_hash ON revisions(project_id, content_hash);

-- Scene index, versioned with its revision.
CREATE TABLE IF NOT EXISTS scenes (
    revision_id  TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
    id           TEXT NOT NULL,
    scene_order  INTEGER NOT NULL,
    heading      TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset   INTEGER NOT NULL,
    parse_ok     INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (revision_id, id)
);
CREATE INDEX IF NOT EXISTS idx_scenes_order ON scenes(revision_id, scene_order);

CREATE TABLE IF NOT EXISTS rules_versions (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id   TEXT,
    body        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_project ON rules_versions(project_id, created_at);

CREATE TABLE IF NOT EXISTS proposals (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    base_revision_id  TEXT NOT NULL,
    rules_id          TEXT NOT NULL,
    operations        TEXT NOT NULL DEFAULT '[]',
    candidate_snapshot TEXT NOT NULL,
    candidate_hash    TEXT NOT NULL,
    checks            TEXT NOT NULL DEFAULT '[]',
    diff              TEXT NOT NULL DEFAULT '[]',
    status            TEXT NOT NULL DEFAULT 'pending',
    idempotency_key   TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_idem
    ON proposals(project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS exports (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision_id     TEXT NOT NULL,
    renderer_config TEXT NOT NULL DEFAULT '{}',
    artifact_path   TEXT NOT NULL,
    page_count      INTEGER,
    status          TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exports_project ON exports(project_id, created_at);

CREATE TABLE IF NOT EXISTS findings (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL,
    evidence    TEXT NOT NULL DEFAULT '[]',
    observation TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_project ON findings(project_id, created_at);
