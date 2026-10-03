/**
 * POST /api/v3/delphi/jobs refuses a job_type the Delphi poller does not run.
 *
 * The poller used to send any unknown job_type (a typo included) to
 * run_delphi.py, which starts by deleting the conversation's results. The
 * route now refuses it before anything is looked up or queued.
 */
import { describe, expect, jest, test, beforeEach } from "@jest/globals";
import { Request, Response } from "express";

const admitDelphiJob = jest.fn();
jest.mock("../../src/routes/delphi/jobGuard", () => ({
  admitDelphiJob: (...args: unknown[]) => admitDelphiJob(...args),
  JobAdmissionUnavailableError: class extends Error {},
  JOB_QUEUE_TABLE: "Delphi_JobQueue",
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: jest.fn(), queryP_readOnly: jest.fn() },
}));
jest.mock("../../src/utils/parameter", () => ({
  getZidFromReport: jest.fn(),
}));
jest.mock("../../src/utils/logger");

import {
  DELPHI_JOB_TYPES,
  handle_POST_delphi_jobs,
} from "../../src/routes/delphi/jobs";

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  return res as Response & { statusCode: number; body: any };
}

function makeReq(body: Record<string, unknown>): Request {
  return { p: { delphiEnabled: true }, body } as unknown as Request;
}

describe("POST /delphi/jobs job_type allow-list", () => {
  beforeEach(() => admitDelphiJob.mockReset());

  test.each(["FULL_PIPELIN", "full_pipeline", "", "DROP_EVERYTHING"])(
    "refuses unknown job_type %p with 400 and queues nothing",
    async (jobType) => {
      const res = makeRes();
      await handle_POST_delphi_jobs(
        makeReq({ conversation_id: "1", job_type: jobType }),
        res
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/Unknown job_type/);
      expect(admitDelphiJob).not.toHaveBeenCalled();
    }
  );

  test.each([null, 7, ["FULL_PIPELINE"]])(
    "refuses a non-string job_type %p",
    async (jobType) => {
      const res = makeRes();
      await handle_POST_delphi_jobs(
        makeReq({ conversation_id: "1", job_type: jobType }),
        res
      );
      expect(res.statusCode).toBe(400);
      expect(admitDelphiJob).not.toHaveBeenCalled();
    }
  );

  test("the allow-list is the three types the poller runs", () => {
    expect([...DELPHI_JOB_TYPES].sort()).toEqual([
      "AWAITING_NARRATIVE_BATCH",
      "CREATE_NARRATIVE_BATCH",
      "FULL_PIPELINE",
    ]);
  });

  test("an omitted job_type still defaults to FULL_PIPELINE and is admitted", async () => {
    admitDelphiJob.mockImplementation(async () => {
      throw new Error("stop after admission");
    });
    const res = makeRes();
    await handle_POST_delphi_jobs(makeReq({ conversation_id: "1" }), res);
    expect(admitDelphiJob).toHaveBeenCalledTimes(1);
    const call = admitDelphiJob.mock.calls[0][0] as any;
    expect(call.scope.jobType).toBe("FULL_PIPELINE");
  });
});
