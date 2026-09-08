/**
 * P-003 S3 — failure-path behaviour of the Delphi active-work guard.
 *
 * These use an injected {@link JobAdmissionStore} rather than DynamoDB Local,
 * because the interesting cases are the ones DynamoDB is not supposed to
 * produce: a missing guard table on a deploy, a lost acknowledgement, and an
 * unreadable descendant sweep. The rule under test is that no failure path may
 * authorise a second paid provider run, and no failure path may turn a
 * DynamoDB fault into a worse outcome than the pre-guard behaviour.
 */
import {
  admitDelphiJob,
  GuardRow,
  idempotencyGuardKey,
  JobAdmissionStore,
  scopeGuardKey,
} from "../../src/routes/delphi/jobGuard";

const scope = {
  conversationId: "4242",
  reportId: "r-synthetic",
  jobType: "FULL_PIPELINE",
  jobConfig: JSON.stringify({ include_moderation: false }),
};

function jobItem(jobId = "job-1") {
  return {
    job_id: jobId,
    status: "PENDING",
    conversation_id: scope.conversationId,
    job_config: scope.jobConfig,
  };
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function liveGuard(jobId = "existing-job"): GuardRow {
  return {
    guard_key: scopeGuardKey(scope),
    job_id: jobId,
    version: 1,
    conversation_id: scope.conversationId,
    report_id: scope.reportId,
    job_type: scope.jobType,
  };
}

function makeStore(overrides: Partial<JobAdmissionStore>): JobAdmissionStore {
  return {
    admit: jest.fn(async () => ({ outcome: "admitted" as const })),
    readGuard: jest.fn(async () => null),
    readJobStatus: jest.fn(async () => null),
    hasLiveDescendants: jest.fn(async () => false),
    clearGuard: jest.fn(async () => true),
    putJobUnguarded: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe("admitDelphiJob failure paths", () => {
  it("degrades to an unguarded put when the guard table does not exist", async () => {
    const store = makeStore({
      admit: jest.fn(async () => {
        throw namedError("ResourceNotFoundException");
      }),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);

    // A guard-table deploy gap must not take submission down; it degrades to
    // exactly the pre-S3 behaviour and says so in the response.
    expect(result).toEqual({
      outcome: "created",
      jobId: "job-1",
      jobStatus: "PENDING",
      degraded: true,
    });
    expect(store.putJobUnguarded).toHaveBeenCalledTimes(1);
  });

  it("propagates a queue-table failure from the degraded path", async () => {
    const store = makeStore({
      admit: jest.fn(async () => {
        throw namedError("ResourceNotFoundException");
      }),
      putJobUnguarded: jest.fn(async () => {
        throw namedError("ResourceNotFoundException");
      }),
    });

    await expect(
      admitDelphiJob({ scope, jobItem: jobItem() }, store)
    ).rejects.toThrow("ResourceNotFoundException");
  });

  it("resolves a lost acknowledgement onto the existing job", async () => {
    const store = makeStore({
      admit: jest.fn(async () => {
        throw namedError("TimeoutError");
      }),
      readGuard: jest.fn(async () => liveGuard()),
      readJobStatus: jest.fn(async () => "PROCESSING"),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);

    expect(result).toEqual({
      outcome: "deduplicated",
      jobId: "existing-job",
      jobStatus: "PROCESSING",
    });
    expect(store.putJobUnguarded).not.toHaveBeenCalled();
  });

  it("rethrows an ambiguous failure when no guard exists, writing nothing", async () => {
    const store = makeStore({
      admit: jest.fn(async () => {
        throw namedError("ProvisionedThroughputExceededException");
      }),
    });

    await expect(
      admitDelphiJob({ scope, jobItem: jobItem() }, store)
    ).rejects.toThrow("ProvisionedThroughputExceededException");
    expect(store.putJobUnguarded).not.toHaveBeenCalled();
  });

  it("keeps the guard when the descendant sweep cannot be read", async () => {
    const clearGuard = jest.fn(async () => true);
    const store = makeStore({
      admit: jest.fn(async () => ({ outcome: "scope_taken" as const })),
      readGuard: jest.fn(async () => liveGuard()),
      readJobStatus: jest.fn(async () => "COMPLETED"),
      hasLiveDescendants: jest.fn(async () => {
        throw namedError("InternalServerError");
      }),
      clearGuard,
    });

    await expect(
      admitDelphiJob({ scope, jobItem: jobItem() }, store)
    ).rejects.toThrow("InternalServerError");
    expect(clearGuard).not.toHaveBeenCalled();
  });

  it("treats an unknown status as live work", async () => {
    const store = makeStore({
      admit: jest.fn(async () => ({ outcome: "scope_taken" as const })),
      readGuard: jest.fn(async () => liveGuard()),
      readJobStatus: jest.fn(async () => "UNKNOWN"),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    expect(result.outcome).toBe("deduplicated");
    expect(store.clearGuard).not.toHaveBeenCalled();
  });

  it("retries the admission after clearing a stale guard", async () => {
    const admit = jest
      .fn()
      .mockResolvedValueOnce({ outcome: "scope_taken" })
      .mockResolvedValueOnce({ outcome: "admitted" });
    const store = makeStore({
      admit,
      readGuard: jest.fn(async () => liveGuard()),
      readJobStatus: jest.fn(async () => "COMPLETED"),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);

    expect(store.clearGuard).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ outcome: "created", degraded: false });
  });

  it("mints a new id when the generated job id already exists", async () => {
    const admit = jest
      .fn()
      .mockResolvedValueOnce({ outcome: "job_id_taken" })
      .mockResolvedValueOnce({ outcome: "admitted" });
    const store = makeStore({ admit });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);

    expect(result.outcome).toBe("created");
    expect((result as any).jobId).not.toBe("job-1");
    expect((result as any).jobId.startsWith("job-1_")).toBe(true);
  });

  it("fails a reused idempotency key that carries a different scope", async () => {
    const idemKey = idempotencyGuardKey(scope, "abc");
    const store = makeStore({
      admit: jest.fn(async () => ({ outcome: "idempotency_taken" as const })),
      readGuard: jest.fn(async (key: string) =>
        key === idemKey
          ? ({
              guard_key: idemKey,
              job_id: "other-job",
              version: 1,
              conversation_id: scope.conversationId,
              job_type: scope.jobType,
              scope_guard_key: "s:different",
            } as GuardRow)
          : null
      ),
    });

    const result = await admitDelphiJob(
      { scope, jobItem: jobItem(), idempotencyKey: "abc" },
      store
    );

    expect(result).toEqual({
      outcome: "idempotency_conflict",
      jobId: "other-job",
    });
  });
});

describe("scopeGuardKey", () => {
  it("is stable across key order and whitespace in the job config", () => {
    expect(
      scopeGuardKey({
        ...scope,
        jobConfig: '{"a":1,"b":{"c":2,"d":3}}',
      })
    ).toBe(
      scopeGuardKey({
        ...scope,
        jobConfig: '{ "b": { "d": 3, "c": 2 }, "a": 1 }',
      })
    );
  });

  it("separates conversations, job types, reports and configs", () => {
    const base = scopeGuardKey(scope);
    expect(scopeGuardKey({ ...scope, conversationId: "4243" })).not.toBe(base);
    expect(
      scopeGuardKey({ ...scope, jobType: "CREATE_NARRATIVE_BATCH" })
    ).not.toBe(base);
    expect(scopeGuardKey({ ...scope, reportId: "r-other" })).not.toBe(base);
    expect(
      scopeGuardKey({
        ...scope,
        jobConfig: JSON.stringify({ include_moderation: true }),
      })
    ).not.toBe(base);
  });

  it("does not leak the conversation id into the key", () => {
    expect(scopeGuardKey(scope)).not.toContain(scope.conversationId);
    expect(scopeGuardKey(scope)).not.toContain(String(scope.reportId));
  });
});
