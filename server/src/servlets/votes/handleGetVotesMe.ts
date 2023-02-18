export default function handle_GET_votes_me(
  req: { p: { zid: any; uid?: any; pid: any } },
  res: any
) {
  getPid(req.p.zid, req.p.uid, function (err: any, pid: number) {
    if (err || pid < 0) {
      fail(res, 500, "polis_err_getting_pid", err);
      return;
    }
    pgQuery_readOnly(
      "SELECT * FROM votes WHERE zid = ($1) AND pid = ($2);",
      [req.p.zid, req.p.pid],
      function (err: any, docs: { rows: string | any[] }) {
        if (err) {
          fail(res, 500, "polis_err_get_votes_by_me", err);
          return;
        }
        for (let i = 0; i < docs.rows.length; i++) {
          docs.rows[i].weight = docs.rows[i].weight / 32767;
        }
        finishArray(res, docs.rows);
      }
    );
  });
}