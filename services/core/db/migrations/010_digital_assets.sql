CREATE TABLE IF NOT EXISTS digital_assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL CONSTRAINT digital_assets_owner_id_fkey REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    renewal_price numeric(12,2) NOT NULL,
    renewal_url text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT digital_assets_name_length_check
        CHECK (char_length(name) BETWEEN 1 AND 160 AND name = btrim(name)),
    CONSTRAINT digital_assets_date_range_check
        CHECK (end_date >= start_date),
    CONSTRAINT digital_assets_renewal_price_check
        CHECK (renewal_price >= 0),
    CONSTRAINT digital_assets_renewal_url_length_check
        CHECK (char_length(renewal_url) BETWEEN 1 AND 2048 AND renewal_url = btrim(renewal_url))
);

CREATE INDEX IF NOT EXISTS digital_assets_owner_end_date_name_idx
    ON digital_assets(owner_id, end_date ASC, name ASC, id ASC);
