ALTER TABLE entries ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(summary,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(plain_text,'')), 'C')
) STORED;
CREATE INDEX IF NOT EXISTS entries_search_vector_gin_idx ON entries USING gin(search_vector);
CREATE INDEX IF NOT EXISTS entries_title_trgm_idx ON entries USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS entries_summary_trgm_idx ON entries USING gin (summary gin_trgm_ops);
CREATE INDEX IF NOT EXISTS entries_plain_text_trgm_idx ON entries USING gin (plain_text gin_trgm_ops);
