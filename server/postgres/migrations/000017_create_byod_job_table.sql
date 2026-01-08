CREATE TYPE job_status AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TABLE byod_import_jobs (
    id SERIAL PRIMARY KEY,
    zid INTEGER NOT NULL,
    s3_key TEXT NOT NULL,
    status job_status DEFAULT 'pending',
    stage TEXT DEFAULT 'init',
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_byod_jobs_zid ON byod_import_jobs(zid);