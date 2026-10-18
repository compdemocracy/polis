/**
 * The participation path's scope: which work runs on the participation pools.
 *
 * Votes, comments, the next statement and participationInit enter this scope
 * as the first handler of their routes (app.ts). Everything that request does
 * after it, its middleware, its handler and the bookkeeping it schedules, is
 * in the scope, and db/pg-query.ts gives every query made in it a connection
 * from the participation pools. Work that did not come through one of those
 * routes is never in the scope, so it has no way to reach those pools.
 *
 * The pool is chosen by where the work came from, not at each call site, so
 * there is no flag or pool name for a query to pass or to get wrong. In-flight
 * reads that requests share (utils/pca.ts) are kept apart per scope, so a
 * participation request never waits on a read issued outside it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const participationScope = new AsyncLocalStorage<true>();

/**
 * Express middleware, first in the chain of each participation route: the
 * rest of the request runs on the participation pools.
 */
export function onParticipationPools(
  _req: unknown,
  _res: unknown,
  next: () => void
): void {
  participationScope.run(true, next);
}

/** Whether the current work came through onParticipationPools. */
export function onParticipationPath(): boolean {
  return participationScope.getStore() === true;
}
