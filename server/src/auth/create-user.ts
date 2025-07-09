import _ from "underscore";
import Password from "./password";
import pg from "../db/pg-query";

function generateAndRegisterZinvite(zid: number, generateShort: any) {
  let len = 10;
  if (generateShort) {
    len = 6;
  }
  return Password.generateTokenP(len, false).then(function (zinvite: string) {
    return pg
      .queryP(
        "INSERT INTO zinvites (zid, zinvite, created, uuid) VALUES ($1, $2, default, gen_random_uuid());",
        [zid, zinvite]
      )
      .then(function (_rows: any) {
        return zinvite;
      });
  });
}

export { generateAndRegisterZinvite };

export default { generateAndRegisterZinvite };
