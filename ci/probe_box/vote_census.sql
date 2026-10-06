-- vote-census/1: fixed aggregate SELECTs. No identifiers or free text leave SQL.

-- section: values
WITH rows AS (
 SELECT 'votes'::text AS tab, vote, created AS stamp FROM public.votes
 UNION ALL SELECT 'latest', vote, modified FROM public.votes_latest_unique
), annotated AS (
 SELECT tab, CASE WHEN stamp IS NULL THEN 'unknown'
 WHEN stamp<0 OR stamp>=4133980800000 THEN 'out_of_range'
 ELSE 'y'||extract(year FROM to_timestamp(stamp/1000.0) AT TIME ZONE 'UTC')::int::text END AS yr,
 CASE WHEN vote=-1 THEN 'neg' WHEN vote=0 THEN 'zero' WHEN vote=1 THEN 'pos' WHEN vote IS NULL THEN 'null' ELSE 'other' END AS value FROM rows
), counts AS (
 SELECT tab,CASE WHEN grouping(yr)=1 THEN 'all' ELSE yr END AS yr,value,count(*) AS n
 FROM annotated GROUP BY GROUPING SETS ((tab,yr,value),(tab,value))
), years AS (SELECT 'y'||generate_series(1970,2100)::text AS yr
 UNION ALL SELECT unnest(ARRAY['unknown','out_of_range','all']))
SELECT t.tab||':'||y.yr||':'||v.value AS metric, coalesce(c.n,0)::bigint AS n
FROM (VALUES ('votes'),('latest')) t(tab) CROSS JOIN years y
CROSS JOIN (VALUES ('neg'),('zero'),('pos'),('null'),('other')) v(value)
LEFT JOIN counts c USING(tab,yr,value) ORDER BY 1;

-- section: witness
-- Bulk scan fence avoids one history-index probe per comment on skewed conversations.
WITH author_rows AS (
 SELECT c.zid,c.tid,c.pid,v.vote,v.created FROM public.comments c
 JOIN (SELECT zid,tid,pid,vote,created FROM public.votes OFFSET 0) v
 ON (v.zid,v.tid,v.pid)=(c.zid,c.tid,c.pid)
), first_time AS (
 SELECT zid,tid,pid,min(created) AS first_ms,bool_or(created IS NULL) AS unknown_time
 FROM author_rows GROUP BY zid,tid,pid
), first_rows AS (
 SELECT f.zid,f.tid,f.pid,f.first_ms,f.unknown_time,count(*) AS n,
 count(DISTINCT coalesce(a.vote::text,'null')) AS variants,min(a.vote) AS first_vote,
 bool_or(a.vote IS NULL) AS first_null
 FROM first_time f JOIN author_rows a USING(zid,tid,pid)
 WHERE a.created IS NOT DISTINCT FROM f.first_ms
 GROUP BY f.zid,f.tid,f.pid,f.first_ms,f.unknown_time
), changed AS (
 SELECT f.zid,f.tid,f.pid,
 bool_or(a.created>f.first_ms AND a.vote IS DISTINCT FROM f.first_vote)
   AND NOT f.unknown_time AND f.variants=1 AS changed
 FROM first_rows f JOIN author_rows a USING(zid,tid,pid)
 GROUP BY f.zid,f.tid,f.pid,f.first_ms,f.first_vote,f.unknown_time,f.variants
), classified AS (
 SELECT c.zid,c.tid,c.pid,
 CASE WHEN f.n IS NULL THEN 'none' WHEN f.unknown_time THEN 'unknown_time'
 WHEN f.variants>1 THEN 'ambiguous' ELSE CASE WHEN f.first_vote=-1 THEN 'neg' WHEN f.first_vote=0 THEN 'zero' WHEN f.first_vote=1 THEN 'pos' WHEN f.first_vote IS NULL THEN 'null' ELSE 'other' END END AS value,
 coalesce(f.n>1,false) AS tied,coalesce(ch.changed,false) AS changed
 -- Compare the entire key as one equality: a merge on zid alone with tid/pid
 -- as join filters becomes quadratic inside one large conversation.
 FROM public.comments c LEFT JOIN first_rows f ON ARRAY[c.zid,c.tid,c.pid]=ARRAY[f.zid,f.tid,f.pid]
 LEFT JOIN changed ch ON ARRAY[c.zid,c.tid,c.pid]=ARRAY[ch.zid,ch.tid,ch.pid]
), conv AS (
 SELECT z.zid, count(c.tid) AS comments,
 count(*) FILTER(WHERE value='neg') AS neg,count(*) FILTER(WHERE value='pos') AS pos,
 count(*) FILTER(WHERE value NOT IN ('neg','pos','none')) AS unsuitable
 FROM (SELECT zid FROM public.conversations UNION SELECT zid FROM public.comments) z
 LEFT JOIN classified c USING(zid) GROUP BY z.zid
), buckets AS (
 SELECT zid,CASE WHEN neg>0 AND pos=0 AND unsuitable=0 THEN 'all_neg'
 WHEN pos>0 AND neg=0 AND unsuitable=0 THEN 'all_pos'
 WHEN neg=0 AND pos=0 THEN 'none' ELSE 'mixed' END AS bucket FROM conv
)
SELECT 'value:'||v.value AS metric,count(c.tid)::bigint AS n
FROM (VALUES ('neg'),('zero'),('pos'),('null'),('other'),('ambiguous'),('unknown_time'),('none')) v(value)
LEFT JOIN classified c USING(value) GROUP BY v.value
UNION ALL SELECT 'bucket:'||b.bucket,count(x.zid) FROM
 (VALUES ('all_neg'),('all_pos'),('mixed'),('none')) b(bucket) LEFT JOIN buckets x USING(bucket) GROUP BY b.bucket
UNION ALL SELECT 'bucket_value:'||b.bucket||':'||v.value,count(c.tid) FROM
 (VALUES ('all_neg'),('all_pos'),('mixed'),('none')) b(bucket)
 CROSS JOIN (VALUES ('neg'),('zero'),('pos'),('null'),('other'),('ambiguous'),('unknown_time'),('none')) v(value)
 LEFT JOIN buckets x ON x.bucket=b.bucket LEFT JOIN classified c ON c.zid=x.zid AND c.value=v.value
 GROUP BY b.bucket,v.value
UNION ALL SELECT 'comments',count(*) FROM classified
UNION ALL SELECT 'conversations',count(*) FROM buckets
UNION ALL SELECT 'first_time_tied',count(*) FROM classified WHERE tied
UNION ALL SELECT 'changed_comments',count(*) FROM classified WHERE changed
UNION ALL SELECT 'changed_authors',count(DISTINCT(zid,pid)) FROM classified WHERE changed
UNION ALL SELECT 'changed_conversations',count(DISTINCT zid) FROM classified WHERE changed
UNION ALL SELECT 'authors',count(DISTINCT(zid,pid)) FROM classified;

-- section: witness_nonzero
-- Compact closed keys: year:import cohort:class:measure; see the runbook.
-- Unknown non-zero timestamps and out-of-domain-only votes remain explicit.
WITH author_rows AS (
 SELECT c.zid,c.tid,c.pid,v.vote,v.created FROM public.comments c
 JOIN (SELECT zid,tid,pid,vote,created FROM public.votes OFFSET 0) v
 ON (v.zid,v.tid,v.pid)=(c.zid,c.tid,c.pid)
 WHERE NOT c.is_seed
), first_time AS (
 SELECT zid,tid,pid,min(created) FILTER(WHERE vote IN(-1,1)) AS first_ms,
 bool_or(created IS NULL AND vote IN(-1,1)) AS unknown_time,
 bool_or(vote IS NOT NULL AND vote NOT IN(-1,0,1)) AS other
 FROM author_rows GROUP BY zid,tid,pid
), first_rows AS (
 SELECT f.*,bool_or(a.vote=-1) AS minus,bool_or(a.vote=1) AS plus
 FROM first_time f LEFT JOIN author_rows a ON (a.zid,a.tid,a.pid)=(f.zid,f.tid,f.pid)
 AND a.created=f.first_ms AND a.vote IN(-1,1)
 GROUP BY f.zid,f.tid,f.pid,f.first_ms,f.unknown_time,f.other
), classified AS (
 SELECT c.zid,CASE WHEN c.original_id IS NULL THEN 'n' ELSE 'i' END AS cohort,
 CASE WHEN c.created IS NULL THEN 'u' WHEN c.created<0 OR c.created>=4133980800000 THEN 'x'
 ELSE extract(year FROM to_timestamp(c.created/1000.0) AT TIME ZONE 'UTC')::int::text END AS yr,
 CASE WHEN f.zid IS NULL THEN 'n' WHEN f.unknown_time THEN 'u'
 WHEN f.first_ms IS NULL THEN CASE WHEN f.other THEN 'o' ELSE 'p' END
 WHEN f.minus AND f.plus THEN 't' WHEN f.minus THEN '-' ELSE '+' END AS class
 -- Compare the entire key as one equality: a merge on zid alone with tid/pid
 -- as join filters becomes quadratic inside one large conversation.
 FROM public.comments c LEFT JOIN first_rows f ON ARRAY[c.zid,c.tid,c.pid]=ARRAY[f.zid,f.tid,f.pid] WHERE NOT c.is_seed
), counts AS (
 SELECT yr,cohort,class,count(*) AS comments,count(DISTINCT zid) AS conversations
 FROM classified GROUP BY yr,cohort,class
 UNION ALL SELECT 'a',cohort,class,count(*),count(DISTINCT zid)
 FROM classified GROUP BY cohort,class
), years AS (SELECT generate_series(1970,2100)::text yr UNION ALL SELECT unnest(ARRAY['u','x','a']))
SELECT y.yr||':'||i.cohort||':'||k.class||':'||m.measure AS metric,
 coalesce(CASE m.measure WHEN 'c' THEN n.comments ELSE n.conversations END,0)::bigint AS n
FROM years y CROSS JOIN (VALUES('n'),('i')) i(cohort)
 CROSS JOIN (VALUES('n'),('p'),('t'),('-'),('+'),('u'),('o')) k(class)
 CROSS JOIN (VALUES('c'),('z')) m(measure)
 LEFT JOIN counts n USING(yr,cohort,class)
UNION ALL SELECT 'excluded_seed',count(*) FROM public.comments WHERE is_seed
UNION ALL SELECT 'excluded_unknown_seed',count(*) FROM public.comments WHERE is_seed IS NULL;

-- section: nulls
WITH s AS (SELECT (extract(epoch FROM transaction_timestamp())*1000)::bigint ms), rows AS (
 SELECT 'votes'::text tab,zid,pid,tid,created stamp FROM public.votes WHERE vote IS NULL
 UNION ALL SELECT 'latest',zid,pid,tid,modified FROM public.votes_latest_unique WHERE vote IS NULL
), annotated AS (SELECT r.*,CASE WHEN stamp IS NULL THEN 'unknown' WHEN stamp>s.ms THEN 'future' WHEN s.ms::numeric-stamp<86400000 THEN 'day' WHEN s.ms::numeric-stamp<2592000000 THEN 'month' WHEN s.ms::numeric-stamp<31536000000 THEN 'year' ELSE 'older' END AS age FROM rows r CROSS JOIN s)
SELECT t.tab||':age:'||a.age AS metric,count(r.tab)::bigint AS n FROM
 (VALUES ('votes'),('latest')) t(tab)
 CROSS JOIN (VALUES ('unknown'),('future'),('day'),('month'),('year'),('older')) a(age)
 LEFT JOIN annotated r USING(tab,age) GROUP BY t.tab,a.age
UNION ALL SELECT t.tab||':rows',count(r.tab) FROM (VALUES ('votes'),('latest')) t(tab)
 LEFT JOIN rows r USING(tab) GROUP BY t.tab
UNION ALL SELECT t.tab||':conversations',count(DISTINCT r.zid) FROM (VALUES ('votes'),('latest')) t(tab)
 LEFT JOIN rows r USING(tab) GROUP BY t.tab
UNION ALL SELECT 'latest:has_earlier_nonnull',count(*) FROM public.votes_latest_unique l
 WHERE l.vote IS NULL AND EXISTS (SELECT 1 FROM public.votes v
 WHERE (v.zid,v.pid,v.tid)=(l.zid,l.pid,l.tid) AND v.vote IS NOT NULL AND v.created<l.modified)
UNION ALL SELECT 'votes:followed_by_nonnull',count(*) FROM public.votes n WHERE n.vote IS NULL AND EXISTS (
 SELECT 1 FROM public.votes v WHERE (v.zid,v.pid,v.tid)=(n.zid,n.pid,n.tid)
 AND v.vote IS NOT NULL AND v.created>n.created);

-- section: latest
WITH keys AS (
 SELECT zid,pid,tid,max(created) AS stamp,bool_or(created IS NULL) AS unknown_time,
 count(*) AS rows FROM public.votes GROUP BY zid,pid,tid
), last_rows AS (
 SELECT k.zid,k.pid,k.tid,k.stamp,k.unknown_time,
 count(*) AS ties,count(DISTINCT coalesce(v.vote::text,'null')) AS variants,
 array_agg(coalesce(v.vote::text,'null')) AS vals
 FROM keys k JOIN public.votes v USING(zid,pid,tid) WHERE v.created IS NOT DISTINCT FROM k.stamp
 GROUP BY k.zid,k.pid,k.tid,k.stamp,k.unknown_time
), joined AS (
 SELECT k.zid IS NOT NULL AS raw_present,l.zid IS NOT NULL AS latest_present,
 k.unknown_time,k.ties,k.variants,
 coalesce(l.vote::text,'null')=ANY(k.vals) AS compatible,
 l.modified IS NOT DISTINCT FROM k.stamp AS same_time
 FROM last_rows k FULL JOIN public.votes_latest_unique l USING(zid,pid,tid)
)
SELECT x.metric,x.n::bigint AS n FROM (
 SELECT count(*) FILTER(WHERE raw_present) AS raw_keys,
 count(*) FILTER(WHERE latest_present) AS latest_keys,
 count(*) FILTER(WHERE raw_present AND NOT latest_present) AS raw_only,
 count(*) FILTER(WHERE latest_present AND NOT raw_present) AS latest_only,
 count(*) FILTER(WHERE raw_present AND unknown_time) AS unknown_order,
 count(*) FILTER(WHERE raw_present AND ties>1) AS latest_time_ties,
 count(*) FILTER(WHERE raw_present AND variants>1) AS latest_value_ambiguous,
 count(*) FILTER(WHERE raw_present AND latest_present AND NOT unknown_time AND NOT compatible) AS value_disagreement,
 count(*) FILTER(WHERE raw_present AND latest_present AND NOT unknown_time AND NOT same_time) AS timestamp_disagreement,
 count(*) FILTER(WHERE raw_present<>latest_present OR (raw_present AND latest_present AND NOT unknown_time AND (NOT compatible OR NOT same_time))) AS definite_disagreement FROM joined
) totals CROSS JOIN LATERAL (VALUES
 ('raw_keys',raw_keys),
 ('latest_keys',latest_keys),
 ('raw_only',raw_only),
 ('latest_only',latest_only),
 ('unknown_order',unknown_order),
 ('latest_time_ties',latest_time_ties),
 ('latest_value_ambiguous',latest_value_ambiguous),
 ('value_disagreement',value_disagreement),
 ('timestamp_disagreement',timestamp_disagreement),
 ('definite_disagreement',definite_disagreement)) x(metric,n);

-- section: changes
WITH k AS (
 SELECT zid,pid,tid,count(*) AS n,count(DISTINCT coalesce(vote::text,'null')) AS variants
 FROM public.votes GROUP BY zid,pid,tid
), h AS (SELECT *,CASE WHEN n=1 THEN 'one' WHEN n=2 THEN 'two' WHEN n BETWEEN 3 AND 5 THEN 'three_five'
 WHEN n BETWEEN 6 AND 10 THEN 'six_ten' WHEN n BETWEEN 11 AND 100 THEN 'eleven_hundred' ELSE 'over_hundred' END bucket FROM k)
SELECT 'rows_per_key:'||b.bucket AS metric,count(h.zid)::bigint AS n FROM
 (VALUES ('one'),('two'),('three_five'),('six_ten'),('eleven_hundred'),('over_hundred')) b(bucket)
 LEFT JOIN h USING(bucket) GROUP BY b.bucket
UNION ALL SELECT 'keys',count(*) FROM k
UNION ALL SELECT 'multirow_keys',count(*) FROM k WHERE n>1
UNION ALL SELECT 'distinct_value_changed_keys',count(*) FROM k WHERE variants>1
UNION ALL SELECT 'extra_rows',coalesce(sum(n-1),0)::bigint FROM k
UNION ALL SELECT 'max_rows_per_key',coalesce(max(n),0)::bigint FROM k;

-- section: orphans
WITH rows AS (
 SELECT 'votes'::text tab,zid,pid,tid FROM public.votes UNION ALL SELECT 'latest',zid,pid,tid FROM public.votes_latest_unique
), counts AS (
 SELECT r.tab,count(*) FILTER(WHERE c.zid IS NULL) AS comments,
 count(*) FILTER(WHERE p.zid IS NULL) AS participants,
 count(*) FILTER(WHERE z.zid IS NULL) AS conversations,
 count(*) FILTER(WHERE c.zid IS NULL OR p.zid IS NULL OR z.zid IS NULL) AS any_missing
 FROM rows r LEFT JOIN public.comments c ON (c.zid,c.tid)=(r.zid,r.tid)
 LEFT JOIN public.participants p ON (p.zid,p.pid)=(r.zid,r.pid)
 LEFT JOIN public.conversations z ON z.zid=r.zid GROUP BY r.tab
)
SELECT t.tab||':'||k.kind AS metric,coalesce(CASE k.kind WHEN 'comment' THEN comments
 WHEN 'participant' THEN participants WHEN 'conversation' THEN conversations ELSE any_missing END,0)::bigint AS n
FROM (VALUES('votes'),('latest')) t(tab) CROSS JOIN (VALUES('comment'),('participant'),('conversation'),('any')) k(kind)
LEFT JOIN counts USING(tab);

-- section: math
WITH s AS (SELECT (extract(epoch FROM transaction_timestamp())*1000)::bigint ms),
 raw AS (SELECT CASE WHEN math_env='prod' THEN 'prod' WHEN math_env='python' THEN 'python'
 WHEN math_env IS NULL THEN 'null' ELSE 'other' END AS env, * FROM public.math_main),
 -- Each actual label retains its own latest row internally; unknown labels only aggregate at output.
 latest AS (SELECT DISTINCT ON(zid,math_env) * FROM raw ORDER BY zid,math_env,modified DESC NULLS LAST),
 annotated AS (SELECT l.*,CASE WHEN modified IS NULL THEN 'unknown' WHEN modified>s.ms THEN 'future' WHEN s.ms::numeric-modified<86400000 THEN 'day' WHEN s.ms::numeric-modified<2592000000 THEN 'month' WHEN s.ms::numeric-modified<31536000000 THEN 'year' ELSE 'older' END AS age FROM latest l CROSS JOIN s),
 votes AS (SELECT zid,max(created) stamp FROM public.votes GROUP BY zid)
SELECT 'rows:'||e.env AS metric,count(r.zid)::bigint AS n FROM
 (VALUES ('prod'),('python'),('other'),('null')) e(env) LEFT JOIN raw r USING(env) GROUP BY e.env
UNION ALL SELECT 'age:'||e.env||':'||a.age,count(l.zid) FROM
 (VALUES ('prod'),('python'),('other'),('null')) e(env)
 CROSS JOIN (VALUES ('unknown'),('future'),('day'),('month'),('year'),('older')) a(age)
 LEFT JOIN annotated l USING(env,age) GROUP BY e.env,a.age
UNION ALL SELECT 'votes_newer_than_watermark:'||e.env,count(DISTINCT l.zid) FROM
 (VALUES ('prod'),('python'),('other'),('null')) e(env) LEFT JOIN latest l ON l.env=e.env
 AND EXISTS (SELECT 1 FROM votes v WHERE v.zid=l.zid AND v.stamp>l.last_vote_timestamp) GROUP BY e.env
UNION ALL SELECT 'votes_newer_than_modified:'||e.env,count(DISTINCT l.zid) FROM
 (VALUES ('prod'),('python'),('other'),('null')) e(env) LEFT JOIN latest l ON l.env=e.env
 AND EXISTS (SELECT 1 FROM votes v WHERE v.zid=l.zid AND v.stamp>l.modified) GROUP BY e.env
UNION ALL SELECT 'missing_blob:'||e.env,count(v.zid) FROM
 (VALUES ('prod'),('python')) e(env) LEFT JOIN votes v ON NOT EXISTS (
 SELECT 1 FROM raw r WHERE r.zid=v.zid AND r.env=e.env) GROUP BY e.env
UNION ALL SELECT 'payload_not_object',count(*) FROM latest WHERE jsonb_typeof(data::jsonb) IS DISTINCT FROM 'object'
UNION ALL SELECT 'kebab_only_group_clusters',count(*) FROM latest WHERE jsonb_typeof(data::jsonb)='object'
 AND data::jsonb ? 'group-clusters' AND NOT data::jsonb ? 'group_clusters'
UNION ALL SELECT 'unknown_watermark',count(*) FROM latest WHERE last_vote_timestamp IS NULL
UNION ALL SELECT 'unknown_modified',count(*) FROM latest WHERE modified IS NULL;

-- section: sizes
SELECT 'votes:rows' AS metric,count(*)::bigint AS n FROM public.votes
UNION ALL SELECT 'latest:rows',count(*) FROM public.votes_latest_unique
UNION ALL SELECT 'votes:heap_bytes',pg_relation_size('public.votes'::regclass)
UNION ALL SELECT 'votes:table_bytes',pg_table_size('public.votes'::regclass)
UNION ALL SELECT 'votes:index_bytes',pg_indexes_size('public.votes'::regclass)
UNION ALL SELECT 'votes:total_bytes',pg_total_relation_size('public.votes'::regclass)
UNION ALL SELECT 'latest:heap_bytes',pg_relation_size('public.votes_latest_unique'::regclass)
UNION ALL SELECT 'latest:table_bytes',pg_table_size('public.votes_latest_unique'::regclass)
UNION ALL SELECT 'latest:index_bytes',pg_indexes_size('public.votes_latest_unique'::regclass)
UNION ALL SELECT 'latest:total_bytes',pg_total_relation_size('public.votes_latest_unique'::regclass);

-- section: transitions
WITH times AS (
 SELECT zid,pid,tid,created,count(DISTINCT coalesce(vote::text,'null')) AS variants,
 min(coalesce(vote::text,'null')) AS value FROM public.votes GROUP BY zid,pid,tid,created
), eligible AS (
 SELECT zid,pid,tid FROM times GROUP BY zid,pid,tid HAVING bool_and(created IS NOT NULL AND variants=1)
), ordered AS (
 SELECT t.*,row_number() OVER w AS ordinal,lag(value) OVER w AS previous
 FROM times t JOIN eligible e USING(zid,pid,tid)
 WINDOW w AS (PARTITION BY zid,pid,tid ORDER BY created)
), counts AS (
 SELECT zid,pid,tid,count(*) FILTER(WHERE ordinal>1 AND value IS DISTINCT FROM previous) AS changes
 FROM ordered GROUP BY zid,pid,tid
), histogram AS (
 SELECT *,CASE WHEN changes=0 THEN 'zero' WHEN changes=1 THEN 'one' WHEN changes=2 THEN 'two'
 WHEN changes<=5 THEN 'three_five' WHEN changes<=10 THEN 'six_ten' WHEN changes<=100 THEN 'eleven_hundred'
 ELSE 'over_hundred' END AS bucket FROM counts
)
SELECT 'changes_per_key:'||b.bucket AS metric,count(h.zid)::bigint AS n FROM
 (VALUES ('zero'),('one'),('two'),('three_five'),('six_ten'),('eleven_hundred'),('over_hundred')) b(bucket)
 LEFT JOIN histogram h USING(bucket) GROUP BY b.bucket
UNION ALL SELECT 'eligible_keys',count(*) FROM eligible
UNION ALL SELECT 'excluded_keys',count(*) FROM (SELECT zid,pid,tid FROM times GROUP BY zid,pid,tid) k
 WHERE NOT EXISTS(SELECT 1 FROM eligible e WHERE (e.zid,e.pid,e.tid)=(k.zid,k.pid,k.tid))
UNION ALL SELECT 'transitions',coalesce(sum(changes),0)::bigint FROM counts;
