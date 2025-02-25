-- Create math_python_main table for storing Python math worker results
CREATE TABLE math_python_main (
  zid INTEGER NOT NULL REFERENCES conversations(zid),
  data jsonb NOT NULL,
  last_vote_timestamp BIGINT NOT NULL,
  caching_tick BIGINT NOT NULL DEFAULT 0,
  math_tick BIGINT NOT NULL DEFAULT -1, -- this will get its value from math_ticks
  modified BIGINT DEFAULT now_as_millis(),
  UNIQUE(zid)
);

-- Create index for faster lookups by conversation ID
CREATE INDEX math_python_main_idx ON math_python_main USING btree (zid);

-- Add helpful comment
COMMENT ON TABLE math_python_main IS 'Stores mathematical computation results from Python math worker, similar to math_main but without math_env separation'; 