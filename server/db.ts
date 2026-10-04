import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://endport:endport@localhost:5432/endport',
  max: 10,
});

export type Agent = { id: string };
export type Endpoint = {
  id: string;
  owner_id: string | null;
  slug: string;
  custom_domain: string | null;
  verification_token: string | null;
  domain_verified: boolean;
  access_mode: 'public' | 'restricted';
  capture_bodies: boolean;
  created_at: string;
};

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS endpoints (
      id text PRIMARY KEY,
      owner_id text REFERENCES agents(id) ON DELETE CASCADE,
      user_id text,
      slug text NOT NULL UNIQUE,
      custom_domain text UNIQUE,
      verification_token text,
      domain_verified boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS owner_id text REFERENCES agents(id) ON DELETE CASCADE;
    ALTER TABLE endpoints ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'public';
    ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS capture_bodies boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS share_links (
      id text PRIMARY KEY,
      endpoint_id text NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      label text NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS share_links_active ON share_links(endpoint_id, expires_at) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS tunnel_leases (
      endpoint_id text PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,
      connection_id text NOT NULL,
      instance_url text NOT NULL,
      lease_expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tunnel_leases_expiry ON tunnel_leases(lease_expires_at);
    CREATE TABLE IF NOT EXISTS dashboard_codes (
      endpoint_id text PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,
      code_hash text NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dashboard_codes_unique_hash ON dashboard_codes(code_hash);
    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      token_hash text PRIMARY KEY,
      endpoint_id text NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_logs (
      id text PRIMARY KEY,
      endpoint_id text NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
      method text NOT NULL,
      path text NOT NULL,
      status integer NOT NULL,
      duration_ms integer NOT NULL,
      bytes_in integer NOT NULL,
      bytes_out integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS origin_ms integer;
    ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS request_preview jsonb;
    ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS response_preview jsonb;
    CREATE INDEX IF NOT EXISTS request_logs_endpoint_time ON request_logs(endpoint_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS dashboard_sessions_expiry ON dashboard_sessions(expires_at);
  `);
}
