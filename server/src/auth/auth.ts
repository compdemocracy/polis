import _ from "underscore";
import logger from "../utils/logger";
import pg from "../db/pg-query";

// ===== UTILITY FUNCTIONS =====

const deleteSuzinvite = async (suzinvite: string): Promise<void> => {
  try {
    await pg.query("DELETE FROM suzinvites WHERE suzinvite = ($1);", [
      suzinvite,
    ]);
  } catch (err) {
    logger.error("polis_err_removing_suzinvite", err);
  }
};

export { deleteSuzinvite };
