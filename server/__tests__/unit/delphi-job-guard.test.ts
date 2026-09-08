/**
 * P-003 S3 — failure and resolution paths of the Delphi active-work guard.
 *
 * These use an injected {@link JobAdmissionStore} rather than DynamoDB Local,
 * because the interesting cases are the ones DynamoDB is not supposed to
 * produce: a missing guard table, a lost acknowledgement, a descendant sweep
 * that cannot be completed, and a transaction where more than one condition
 * fails at once. The rule under test is that no path may authorise a second
 * paid provider run, and no uncertain answer may release a guard.
 */
import {
  admitDelphiJob,
  configFingerprint,
  GuardRow,
  idempotencyGuardKey,
  IDEMPOTENCY_BINDING_WINDOW_MS,
  JobAdmissionStore,
  JobAdmissionUnavailableError,
  scopeGuardKey,
} from "../../src/routes/delphi/jobGuard";

const scope = {
  conversationId: "4242",
  reportId: "r-synthetic",
  jobType: "FULL_PIPELINE",
  jobConfig: JSON.stringify({ include_moderation: false }),
};

const otherConfigScope = {
  ...scope,
  jobConfig: JSON.stringify({ include_moderation: true }),
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
    sweepLiveDescendants: jest.fn(async () => ({ kind: "none" as const })),
    sweepUnguardedActiveRoot: jest.fn(async () => ({ kind: "none" as const })),
    adoptGuard: jest.fn(async () => true),
    clearGuard: jest.fn(async () => true),
    clearAlias: jest.fn(async () => true),
    ...overrides,
  };
}

describe("admitDelphiJob: substrate failures fail closed", () => {
  it("refuses admission when the guard table does not exist", async () => {
    const store = makeStore({
      admit: jest.fn(async () => {
        throw namedError("ResourceNotFoundException");
      }),
    });

    // No un-deduplicated fallback: writing the job without a guard is exactly
    // how a second paid provider run happens.
    await expect(
      admitDelphiJob({ scope, jobItem: jobItem() }, store)
    ).rejects.toBeInstanceOf(JobAdmissionUnavailableError);
  });

  it("refuses admission when existing active work cannot be verified", async () => {
    const store = makeStore({
      sweepUnguardedActiveRoot: jest.fn(async () => ({
        kind: "unknown" as const,
        reason: "synthetic",
      })),
    });

    await expect(
      admitDelphiJob({ scope, jobItem: jobItem() }, store)
    ).rejects.toBeInstanceOf(JobAdmissionUnavailableError);
    expect(store.admit).not.toHaveBeenCalled();
  });

  it("rethrows an ambiguous failure, writing nothing", async () => {
    const store = makeStore({
      admit: jest.fn(async () => {
        throw namedError("ProvisionedThroughputExceededException");
      }),
    });

    await expect(
      admitDelphiJob({ scope, jobItem: jobItem() }, store)
    ).rejects.toThrow("ProvisionedThroughputExceededException");
  });
});

describe("admitDelphiJob: release needs authoritative proof", () => {
  it("keeps the guard when the descendant sweep cannot be completed", async () => {
    const store = makeStore({
      admit: jest.fn(async () => ({ outcome: "scope_taken" as const })),
      readGuard: jest.fn(async () => liveGuard()),
      readJobStatus: jest.fn(async () => "COMPLETED"),
      sweepLiveDescendants: jest.fn(async () => ({
        kind: "unknown" as const,
        reason: "synthetic read failure",
      })),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);

    expect(result).toMatchObject({
      outcome: "deduplicated",
      jobId: "existing-job",
      workLive: true,
    });
    expect(store.clearGuard).not.toHaveBeenCalled();
  });

  it("keeps the guard when a descendant is still live", async () => {
    const store = makeStore({
      admit: jest.fn(async () => ({ outcome: "scope_taken" as const })),
      readGuard: jest.fn(async () => liveGuard()),
      readJobStatus: jest.fn(async () => "COMPLETED"),
      sweepLiveDescendants: jest.fn(async () => ({
        kind: "found" as const,
        value: "batch_check_existing-job_1",
      })),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    expect(result).toMatchObject({ outcome: "deduplicated", workLive: true });
    expect(store.clearGuard).not.toHaveBeenCalled();
  });

  it("keeps the guard when the root row has been removed", async () => {
    // A removed root is uncertainty, not proof that the paid work ended.
    const store = makeStore({
      admit: jest.fn(async () => ({ outcome: "scope_taken" as const })),
      readGuard: jest.fn(async () => liveGuard()),
      readJobStatus: jest.fn(async () => null),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    expect(result).toMatchObject({
      outcome: "deduplicated",
      jobStatus: "UNKNOWN",
      workLive: true,
    });
    expect(store.clearGuard).not.toHaveBeenCalled();
  });

  it("keeps the guard when the root status is unreadable", async () => {
    const store = makeStore({
      admit: jest.fn(async () => ({ outcome: "scope_taken" as const })),
      readGuard: jest.fn(async () => liveGuard()),
      readJobStatus: jest.fn(async () => {
        throw namedError("InternalServerError");
      }),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    expect(result).toMatchObject({ outcome: "deduplicated", workLive: true });
    expect(store.clearGuard).not.toHaveBeenCalled();
  });

  it("releases only on a terminal root with a completed empty sweep", async () => {
    const admit = jest
      .fn()
      .mockResolvedValueOnce({ outcome: "scope_taken" })
      .mockResolvedValueOnce({ outcome: "admitted" });
    const guards: (GuardRow | null)[] = [liveGuard(), null];
    const store = makeStore({
      admit,
      readGuard: jest.fn(async () => guards.shift() ?? null),
      readJobStatus: jest.fn(async () => "COMPLETED"),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);

    expect(store.clearGuard).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "created", workLive: true });
  });
});

describe("admitDelphiJob: idempotency binding", () => {
  const aliasKey = idempotencyGuardKey(scope, "abc");
  const configHash = configFingerprint(scope.jobConfig);

  function aliasRow(overrides: Partial<GuardRow> = {}): GuardRow {
    return {
      guard_key: aliasKey,
      job_id: "alias-job",
      version: 1,
      conversation_id: scope.conversationId,
      job_type: scope.jobType,
      scope_guard_key: scopeGuardKey(scope),
      config_hash: configHash,
      binding_expires_at: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    };
  }

  it("reports a conflict even when the target scope is occupied", async () => {
    // The defect: the transaction cancels on both the scope and the alias, and
    // dispatching on the first cancellation reason returned the scope's job
    // while silently ignoring that the key was bound to a different payload.
    const store = makeStore({
      admit: jest.fn(async () => ({ outcome: "scope_taken" as const })),
      readGuard: jest.fn(async (key: string) =>
        key === aliasKey
          ? aliasRow({ config_hash: "some-other-payload" })
          : liveGuard()
      ),
      readJobStatus: jest.fn(async () => "PENDING"),
    });

    const result = await admitDelphiJob(
      { scope, jobItem: jobItem(), idempotencyKey: "abc" },
      store
    );

    expect(result).toEqual({
      outcome: "idempotency_conflict",
      jobId: "alias-job",
    });
  });

  it("reports a conflict when the same key is reused for another scope", async () => {
    const store = makeStore({
      readGuard: jest.fn(async (key: string) =>
        key === idempotencyGuardKey(otherConfigScope, "abc")
          ? aliasRow({ scope_guard_key: "s:some-other-scope" })
          : null
      ),
    });

    const result = await admitDelphiJob(
      { scope: otherConfigScope, jobItem: jobItem(), idempotencyKey: "abc" },
      store
    );

    expect(result).toMatchObject({ outcome: "idempotency_conflict" });
    expect(store.admit).not.toHaveBeenCalled();
  });

  it("replays a bound key onto its recorded job after completion", async () => {
    // The alias outlives the scope guard for the declared binding window, so a
    // retry after a fast completion does not start a second run.
    const store = makeStore({
      readGuard: jest.fn(async (key: string) =>
        key === aliasKey ? aliasRow() : null
      ),
      readJobStatus: jest.fn(async () => "COMPLETED"),
    });

    const result = await admitDelphiJob(
      { scope, jobItem: jobItem(), idempotencyKey: "abc" },
      store
    );

    expect(result).toEqual({
      outcome: "deduplicated",
      jobId: "alias-job",
      jobStatus: "COMPLETED",
      workLive: false,
    });
    expect(store.admit).not.toHaveBeenCalled();
  });

  it("admits a new run once the binding window has passed", async () => {
    const expired = aliasRow({
      binding_expires_at: new Date(
        Date.now() - IDEMPOTENCY_BINDING_WINDOW_MS - 1000
      ).toISOString(),
    });
    let cleared = false;
    const store = makeStore({
      readGuard: jest.fn(async (key: string) =>
        key === aliasKey && !cleared ? expired : null
      ),
      clearAlias: jest.fn(async () => {
        cleared = true;
        return true;
      }),
    });

    const result = await admitDelphiJob(
      { scope, jobItem: jobItem(), idempotencyKey: "abc" },
      store
    );

    expect(store.clearAlias).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "created" });
  });

  it("resolves a lost acknowledgement onto the job the write created", async () => {
    // The transaction errors after it landed. Re-reading the guard is what
    // tells the difference between "wrote nothing" and "lost the reply".
    const guards: (GuardRow | null)[] = [null, liveGuard()];
    const store = makeStore({
      admit: jest.fn(async () => {
        throw namedError("TimeoutError");
      }),
      readGuard: jest.fn(async () => guards.shift() ?? null),
      readJobStatus: jest.fn(async () => "PENDING"),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    expect(result).toMatchObject({
      outcome: "deduplicated",
      jobId: "existing-job",
      jobStatus: "PENDING",
    });
  });

  it("still reports an ambiguous failure that left nothing behind", async () => {
    const store = makeStore({
      admit: jest.fn(async () => {
        throw namedError("TimeoutError");
      }),
    });

    await expect(
      admitDelphiJob({ scope, jobItem: jobItem() }, store)
    ).rejects.toThrow("TimeoutError");
  });
});

describe("admitDelphiJob: migration", () => {
  it("adopts an active root that predates the guard table", async () => {
    const store = makeStore({
      sweepUnguardedActiveRoot: jest.fn(async () => ({
        kind: "found" as const,
        value: "legacy-root",
      })),
      readJobStatus: jest.fn(async () => "PROCESSING"),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);

    expect(store.adoptGuard).toHaveBeenCalledTimes(1);
    expect(store.admit).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: "deduplicated",
      jobId: "legacy-root",
      jobStatus: "PROCESSING",
      workLive: true,
      adopted: true,
    });
  });

  it("retries when another request adopts the same root first", async () => {
    const sweep = jest
      .fn()
      .mockResolvedValueOnce({ kind: "found", value: "legacy-root" })
      .mockResolvedValue({ kind: "none" });
    const guards: (GuardRow | null)[] = [null, liveGuard("legacy-root")];
    const store = makeStore({
      sweepUnguardedActiveRoot: sweep,
      adoptGuard: jest.fn(async () => false),
      readGuard: jest.fn(async () => guards.shift() ?? null),
      readJobStatus: jest.fn(async () => "PENDING"),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    expect(result).toMatchObject({
      outcome: "deduplicated",
      jobId: "legacy-root",
    });
  });
});

describe("admitDelphiJob: identity", () => {
  it("mints a new id when the generated job id already exists", async () => {
    const admit = jest
      .fn()
      .mockResolvedValueOnce({ outcome: "job_id_taken" })
      .mockResolvedValueOnce({ outcome: "admitted" });
    const store = makeStore({ admit });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);

    expect(result.outcome).toBe("created");
    expect((result as any).jobId.startsWith("job-1_")).toBe(true);
  });
});

describe("scopeGuardKey", () => {
  it("is not affected by the job config", () => {
    // Rev3 excludes simultaneous work by conversation + report + job type. Two
    // configs still reset and publish into the same structures, so a config
    // change is not a concurrency exemption.
    expect(scopeGuardKey(otherConfigScope)).toBe(scopeGuardKey(scope));
  });

  it("separates conversations, job types and reports", () => {
    const base = scopeGuardKey(scope);
    expect(scopeGuardKey({ ...scope, conversationId: "4243" })).not.toBe(base);
    expect(
      scopeGuardKey({ ...scope, jobType: "CREATE_NARRATIVE_BATCH" })
    ).not.toBe(base);
    expect(scopeGuardKey({ ...scope, reportId: "r-other" })).not.toBe(base);
  });

  it("does not leak the conversation id into the key", () => {
    expect(scopeGuardKey(scope)).not.toContain(scope.conversationId);
    expect(scopeGuardKey(scope)).not.toContain(String(scope.reportId));
  });
});

describe("configFingerprint", () => {
  it("is stable across key order and whitespace", () => {
    expect(configFingerprint('{"a":1,"b":{"c":2,"d":3}}')).toBe(
      configFingerprint('{ "b": { "d": 3, "c": 2 }, "a": 1 }')
    );
  });

  it("distinguishes different payloads", () => {
    expect(configFingerprint('{"include_moderation":false}')).not.toBe(
      configFingerprint('{"include_moderation":true}')
    );
  });
});
