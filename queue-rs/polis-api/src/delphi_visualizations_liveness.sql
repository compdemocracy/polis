WITH RECURSIVE selected AS (
        SELECT j.*, n.graph_id FROM public.delphi_jobs j
        LEFT JOIN public.delphi_graph_nodes n USING (env,job_id)
        LEFT JOIN public.delphi_graphs g ON g.env=n.env AND g.graph_id=n.graph_id
        WHERE j.env=$1 AND j.zid::text=$2 AND ($3::text IS NULL OR g.scope_key=$3)
      ), related(root_id,job_id) AS (
        SELECT s.job_id,s.job_id FROM selected s
        UNION
        SELECT r.root_id,c.job_id FROM related r
        JOIN public.delphi_jobs c ON c.env=$1 AND c.parent_job_id=r.job_id
      ), work AS (
        SELECT root_id,job_id FROM related
        UNION
        SELECT s.job_id,n.job_id FROM selected s
        JOIN public.delphi_graph_nodes n ON n.env=s.env AND n.graph_id=s.graph_id
      )
      SELECT v.job_id,v.status,v.created_at,v.completed_at, EXISTS (
        SELECT 1 FROM work w
        JOIN public.delphi_jobs j ON j.env=$1 AND j.job_id=w.job_id
        LEFT JOIN public.polis_queue_jobs q ON q.env=j.env AND q.job_id=j.job_id
        WHERE w.root_id=s.job_id AND (
          COALESCE(q.state,j.status) NOT IN ('succeeded','dead','cancelled')
          OR EXISTS (SELECT 1 FROM public.polis_queue_attempts a
            WHERE a.env=j.env AND a.job_id=j.job_id AND a.process_exit_confirmed_at IS NULL)
          OR EXISTS (SELECT 1 FROM public.delphi_provider_requests p
            WHERE p.env=j.env AND p.job_id=j.job_id
              AND p.state IN ('intent','submission_unknown','submitted'))
        )
      ) AS work_live
      FROM selected s JOIN public.delphi_result_jobs v ON v.env=s.env AND v.job_id=s.job_id::text
      ORDER BY v.job_id LIMIT 1001
