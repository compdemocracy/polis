-- Catalog postconditions only; this file never replays migration DDL.
SELECT pg_temp.idx('votes_created_idx','CREATE INDEX votes_created_idx ON public.votes USING btree (created)')
 AND pg_temp.idx('comments_modified_idx','CREATE INDEX comments_modified_idx ON public.comments USING btree (modified)');
