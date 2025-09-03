import { failJson } from "../utils/fail";
import { doSendEinvite } from "./einvites";
import pg from "../db/pg-query";

function handle_POST_einvites(
  req: { p: { email: any } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: {}): void; new (): any };
    };
  }
) {
  const email = req.p.email;
  doSendEinvite(req, email)
    .then(function () {
      res.status(200).json({});
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_sending_einvite", err);
    });
}

function handle_GET_einvites(
  req: { p: { einvite: any } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: any): void; new (): any };
    };
  }
) {
  const einvite = req.p.einvite;

  pg.queryP("select * from einvites where einvite = ($1);", [einvite])
    .then(function (rows: string | any[]) {
      if (!rows.length) {
        throw new Error("polis_err_missing_einvite");
      }
      res.status(200).json(rows[0]);
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_fetching_einvite", err);
    });
}

export { handle_GET_einvites, handle_POST_einvites };
