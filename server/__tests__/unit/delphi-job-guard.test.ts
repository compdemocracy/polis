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
  assessConversationLiveness,
  assessJobLiveness,
  configFingerprint,
  GuardRow,
  idempotencyGuardKey,
  IDEMPOTENCY_BINDING_WINDOW_MS,
  JobAdmissionStore,
  JobAdmissionUnavailableError,
  dynamoJobAdmissionStore,
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

/**
 * Wrap an injected store so that discovery runs the *real* classifier over the
 * injected conversation rows, instead of a canned sweep result.
 */
function dynamoBackedBy(store: JobAdmissionStore): JobAdmissionStore {
  return {
    ...store,
    sweepUnguardedActiveRoot:
      dynamoJobAdmissionStore.sweepUnguardedActiveRoot.bind({
        ...store,
        readJob: store.readJob,
      } as JobAdmissionStore),
  };
}

function makeStore(overrides: Partial<JobAdmissionStore>): JobAdmissionStore {
  return {
    admit: jest.fn(async () => ({ outcome: "admitted" as const })),
    readGuard: jest.fn(async () => null),
    readJob: jest.fn(async () => null),
    sweepLiveDescendants: jest.fn(async () => ({ kind: "none" as const })),
    sweepUnguardedActiveRoot: jest.fn(async () => ({ kind: "none" as const })),
    sweepConversation: jest.fn(async () => ({ kind: "none" as const })),
    adoptGuard: jest.fn(async () => true),
    bindAlias: jest.fn(async () => true),
    clearGuard: jest.fn(async () => true),
    clearAlias: jest.fn(async () => true),
    withdrawAdmission: jest.fn(async () => true),
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
      readJob: jest.fn(async () => ({
        status: "COMPLETED",
        process_exit_confirmed: true,
      })),
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
      readJob: jest.fn(async () => ({
        status: "COMPLETED",
        process_exit_confirmed: true,
      })),
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
      readJob: jest.fn(async () => null),
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
      readJob: jest.fn(async () => {
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
      readJob: jest.fn(async () => ({
        status: "COMPLETED",
        process_exit_confirmed: true,
      })),
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
      readJob: jest.fn(async () => ({
        status: "PENDING",
        process_exit_confirmed: true,
      })),
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
      readJob: jest.fn(async () => ({
        status: "COMPLETED",
        process_exit_confirmed: true,
      })),
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
      readJob: jest.fn(async () => ({
        status: "PENDING",
        process_exit_confirmed: true,
      })),
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
      readJob: jest.fn(async () => ({
        status: "PROCESSING",
        process_exit_confirmed: true,
      })),
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
      readJob: jest.fn(async () => ({
        status: "PENDING",
        process_exit_confirmed: true,
      })),
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

describe("admitDelphiJob: round-3 review", () => {
  it("keeps the guard on a FAILED root whose child process was never confirmed gone", async () => {
    // The old worker marked a job FAILED without stopping its subprocess, so
    // the orphan could still create a checker after the sweep. A FAILED root
    // that does not carry the worker's exit confirmation is not proof.
    const store = makeStore({
      admit: jest.fn(async () => ({ outcome: "scope_taken" as const })),
      readGuard: jest.fn(async () => liveGuard()),
      readJob: jest.fn(async () => ({ status: "FAILED" })),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    expect(result).toMatchObject({ outcome: "deduplicated", workLive: true });
    expect(store.clearGuard).not.toHaveBeenCalled();
  });

  it("releases a FAILED root once the worker confirms the process exited", async () => {
    const guards: (GuardRow | null)[] = [liveGuard(), null];
    const store = makeStore({
      admit: jest
        .fn()
        .mockResolvedValueOnce({ outcome: "scope_taken" })
        .mockResolvedValueOnce({ outcome: "admitted" }),
      readGuard: jest.fn(async () => guards.shift() ?? null),
      readJob: jest.fn(async () => ({
        status: "FAILED",
        process_exit_confirmed: true,
      })),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    expect(store.clearGuard).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "created" });
  });

  it("keeps the guard when a root submitted work it could not schedule a checker for", async () => {
    const store = makeStore({
      admit: jest.fn(async () => ({ outcome: "scope_taken" as const })),
      readGuard: jest.fn(async () => liveGuard()),
      readJob: jest.fn(async () => ({
        status: "COMPLETED",
        checker_schedule_failed: true,
      })),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    expect(result).toMatchObject({ outcome: "deduplicated", workLive: true });
    expect(store.clearGuard).not.toHaveBeenCalled();
  });

  it("reports live work on a keyed replay of a completed root with a live child", async () => {
    // The alias path must use the same effective-work assessment as the
    // unkeyed path, or a retry is told the work is finished when it is not.
    const aliasKey = idempotencyGuardKey(scope, "k");
    const store = makeStore({
      readGuard: jest.fn(async (guardKey: string) =>
        guardKey === aliasKey
          ? ({
              guard_key: aliasKey,
              job_id: "root",
              version: 1,
              conversation_id: scope.conversationId,
              job_type: scope.jobType,
              scope_guard_key: scopeGuardKey(scope),
              config_hash: configFingerprint(scope.jobConfig),
              binding_expires_at: new Date(Date.now() + 60_000).toISOString(),
            } as GuardRow)
          : null
      ),
      readJob: jest.fn(async () => ({
        status: "COMPLETED",
        process_exit_confirmed: true,
      })),
      sweepLiveDescendants: jest.fn(async () => ({
        kind: "found" as const,
        value: "batch_check_root_1",
      })),
    });

    const result = await admitDelphiJob(
      { scope, jobItem: jobItem(), idempotencyKey: "k" },
      store
    );
    expect(result).toMatchObject({
      outcome: "deduplicated",
      jobId: "root",
      jobStatus: "COMPLETED",
      workLive: true,
    });
  });

  it("binds a newly supplied key to the job it deduplicated onto", async () => {
    // Without this, the first keyed response carries a job id it never bound,
    // so the retry it invites starts a second run once the first finishes.
    const store = makeStore({
      readGuard: jest.fn(async (guardKey: string) =>
        guardKey.startsWith("s:") ? liveGuard() : null
      ),
      readJob: jest.fn(async () => ({ status: "PROCESSING" })),
    });

    const result = await admitDelphiJob(
      { scope, jobItem: jobItem(), idempotencyKey: "fresh" },
      store
    );

    expect(result).toMatchObject({
      outcome: "deduplicated",
      jobId: "existing-job",
    });
    expect(store.bindAlias).toHaveBeenCalledTimes(1);
    expect((store.bindAlias as jest.Mock).mock.calls[0][0]).toMatchObject({
      guard_key: idempotencyGuardKey(scope, "fresh"),
      job_id: "existing-job",
      scope_guard_key: scopeGuardKey(scope),
      conversation_id: scope.conversationId,
    });
  });

  it("binds a newly supplied key on adoption too", async () => {
    const store = makeStore({
      sweepUnguardedActiveRoot: jest.fn(async () => ({
        kind: "found" as const,
        value: "legacy-root",
      })),
      readJob: jest.fn(async () => ({ status: "PROCESSING" })),
    });

    const result = await admitDelphiJob(
      { scope, jobItem: jobItem(), idempotencyKey: "fresh" },
      store
    );

    expect(result).toMatchObject({ jobId: "legacy-root", adopted: true });
    expect((store.bindAlias as jest.Mock).mock.calls[0][0]).toMatchObject({
      job_id: "legacy-root",
    });
  });

  it("withdraws its own job when an unguarded producer raced it", async () => {
    // A producer outside the transaction cannot be fenced by a read. The
    // post-admission re-check compensates while the row is still unclaimed.
    const sweep = jest
      .fn()
      .mockResolvedValueOnce({ kind: "none" })
      .mockResolvedValueOnce({ kind: "found", value: "old-producer" })
      .mockResolvedValue({ kind: "found", value: "old-producer" });
    const store = makeStore({
      sweepUnguardedActiveRoot: sweep,
      readJob: jest.fn(async () => ({ status: "PENDING" })),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);

    expect(store.withdrawAdmission).toHaveBeenCalledWith(
      "job-1",
      scopeGuardKey(scope)
    );
    expect(result).toMatchObject({
      outcome: "deduplicated",
      jobId: "old-producer",
      adopted: true,
    });
  });

  it("keeps both rows, loudly, when its own job was already claimed", async () => {
    const sweep = jest
      .fn()
      .mockResolvedValueOnce({ kind: "none" })
      .mockResolvedValue({ kind: "found", value: "old-producer" });
    const store = makeStore({
      sweepUnguardedActiveRoot: sweep,
      withdrawAdmission: jest.fn(async () => false),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    // Nothing better is possible once a worker owns the row; the caller is
    // told about the job that exists rather than being lied to.
    expect(result).toMatchObject({ outcome: "created", jobId: "job-1" });
  });
});

describe("admitDelphiJob: round-4 review", () => {
  it("adopts a FAILED root whose process exit was never confirmed", async () => {
    // Discovery used to filter on status, so exactly the old-worker state the
    // guarded path treats as live was invisible to adoption.
    const store = makeStore({
      sweepUnguardedActiveRoot: jest.fn(async () => ({
        kind: "found" as const,
        value: "unconfirmed-root",
      })),
      readJob: jest.fn(async () => ({ status: "FAILED" })),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    expect(result).toMatchObject({
      outcome: "deduplicated",
      jobId: "unconfirmed-root",
      adopted: true,
      workLive: true,
    });
    expect(store.admit).not.toHaveBeenCalled();
  });

  it("acknowledges the job an idempotency key was already bound to", async () => {
    // A concurrent request bound the key to another root; answering with ours
    // would make the same key name two different jobs.
    const aliasKey = idempotencyGuardKey(scope, "raced");
    let aliasBound = false;
    const store = makeStore({
      readGuard: jest.fn(async (guardKey: string) => {
        if (guardKey === aliasKey) {
          return aliasBound
            ? ({
                guard_key: aliasKey,
                job_id: "other-root",
                version: 1,
                conversation_id: scope.conversationId,
                job_type: scope.jobType,
                scope_guard_key: scopeGuardKey(scope),
                config_hash: configFingerprint(scope.jobConfig),
                binding_expires_at: new Date(Date.now() + 60_000).toISOString(),
              } as GuardRow)
            : null;
        }
        return liveGuard();
      }),
      bindAlias: jest.fn(async () => {
        aliasBound = true;
        return false; // someone else got there first
      }),
      readJob: jest.fn(async () => ({ status: "PROCESSING" })),
    });

    const result = await admitDelphiJob(
      { scope, jobItem: jobItem(), idempotencyKey: "raced" },
      store
    );
    expect(result).toMatchObject({ jobId: "other-root" });
  });

  it("does not acknowledge a job whose guard has gone away underneath it", async () => {
    // Compensation, or a reset, can withdraw the guard and its row between
    // resolving one and returning it. Naming a dead id leaves the retry stuck.
    let reads = 0;
    const store = makeStore({
      readGuard: jest.fn(async () => (reads++ === 0 ? liveGuard() : null)),
      readJob: jest.fn(async (jobId: string) =>
        jobId === "existing-job" ? null : { status: "PENDING" }
      ),
    });

    const result = await admitDelphiJob({ scope, jobItem: jobItem() }, store);
    // Re-resolved rather than handing back the withdrawn job.
    expect(result.jobId).not.toBe("existing-job");
    expect(result.outcome).toBe("created");
  });

  it("withdraws the alias along with the job it compensated away", async () => {
    const sweep = jest
      .fn()
      .mockResolvedValueOnce({ kind: "none" })
      .mockResolvedValueOnce({ kind: "found", value: "old-producer" })
      .mockResolvedValue({ kind: "found", value: "old-producer" });
    const store = makeStore({
      sweepUnguardedActiveRoot: sweep,
      readJob: jest.fn(async () => ({ status: "PENDING" })),
    });

    await admitDelphiJob(
      { scope, jobItem: jobItem(), idempotencyKey: "raced" },
      store
    );

    expect(store.clearAlias).toHaveBeenCalledWith(
      expect.objectContaining({
        guard_key: idempotencyGuardKey(scope, "raced"),
        job_id: "job-1",
      })
    );
  });
});

describe("admitDelphiJob: round-5 review", () => {
  it("does not acknowledge an alias whose job row has been deleted", async () => {
    // Compensation removes the alias, the queue row and the guard in three
    // writes; a request landing between them used to be handed the id of a row
    // that had just gone.
    const aliasKey = idempotencyGuardKey(scope, "stale");
    let aliasPresent = true;
    const store = makeStore({
      readGuard: jest.fn(async (guardKey: string) =>
        guardKey === aliasKey && aliasPresent
          ? ({
              guard_key: aliasKey,
              job_id: "deleted-job",
              version: 1,
              conversation_id: scope.conversationId,
              job_type: scope.jobType,
              scope_guard_key: scopeGuardKey(scope),
              config_hash: configFingerprint(scope.jobConfig),
              binding_expires_at: new Date(Date.now() + 60_000).toISOString(),
            } as GuardRow)
          : null
      ),
      readJob: jest.fn(async (jobId: string) =>
        jobId === "deleted-job" ? null : { status: "PENDING" }
      ),
      clearAlias: jest.fn(async () => {
        aliasPresent = false;
        return true;
      }),
    });

    const result = await admitDelphiJob(
      { scope, jobItem: jobItem(), idempotencyKey: "stale" },
      store
    );

    expect(result.jobId).not.toBe("deleted-job");
    expect(store.clearAlias).toHaveBeenCalled();
  });

  it("does not spend the candidate budget on ordinary history", async () => {
    // Discovery stopped filtering on status in round 4, so a conversation's
    // finished runs would otherwise fill the cap and fail admission closed.
    const history = Array.from({ length: 60 }, (_, index) => ({
      job_id: `old-${index}`,
      conversation_id: scope.conversationId,
      job_type: scope.jobType,
      report_id: scope.reportId,
      status: "COMPLETED",
      process_exit_confirmed: true,
    }));
    const store = makeStore({
      sweepConversation: jest.fn(async () => ({
        kind: "found" as const,
        value: history,
      })),
    });

    const result = await admitDelphiJob(
      { scope, jobItem: jobItem() },
      dynamoBackedBy(store)
    );
    expect(result).toMatchObject({ outcome: "created" });
  });
});

describe("assessConversationLiveness", () => {
  it("reports a completed root with a live checker as live", async () => {
    const store = makeStore({
      sweepConversation: jest.fn(async () => ({
        kind: "found" as const,
        value: [
          { job_id: "root", status: "COMPLETED", process_exit_confirmed: true },
          { job_id: "checker", status: "PENDING", batch_job_id: "root" },
        ],
      })),
    });

    const { complete, liveByJobId } = await assessConversationLiveness(
      "4242",
      store
    );
    expect(complete).toBe(true);
    expect(liveByJobId.get("root")).toBe(true);
    expect(liveByJobId.get("checker")).toBe(true);
  });

  it("reports a finished conversation as not live", async () => {
    const store = makeStore({
      sweepConversation: jest.fn(async () => ({
        kind: "found" as const,
        value: [
          { job_id: "root", status: "COMPLETED", process_exit_confirmed: true },
          { job_id: "checker", status: "COMPLETED", batch_job_id: "root" },
        ],
      })),
    });

    const { liveByJobId } = await assessConversationLiveness("4242", store);
    expect(liveByJobId.get("root")).toBe(false);
  });

  it("says nothing rather than false when the sweep cannot be completed", async () => {
    // The whole point: an incomplete read must never become a client-visible
    // "finished", because the client stops polling on it.
    const store = makeStore({
      sweepConversation: jest.fn(async () => ({
        kind: "unknown" as const,
        reason: "synthetic",
      })),
    });

    const { complete, liveByJobId } = await assessConversationLiveness(
      "4242",
      store
    );
    expect(complete).toBe(false);
    expect(liveByJobId.size).toBe(0);
  });
});

describe("assessJobLiveness", () => {
  it("reports live work for a terminal root with a live descendant", async () => {
    const store = makeStore({
      readJob: jest.fn(async () => ({
        status: "COMPLETED",
        process_exit_confirmed: true,
      })),
      sweepLiveDescendants: jest.fn(async () => ({
        kind: "found" as const,
        value: "child",
      })),
    });

    await expect(assessJobLiveness(store, "root")).resolves.toMatchObject({
      status: "COMPLETED",
      live: true,
    });
  });

  it("reports finished only for a terminal, childless, confirmed root", async () => {
    const store = makeStore({
      readJob: jest.fn(async () => ({
        status: "COMPLETED",
        process_exit_confirmed: true,
      })),
    });

    await expect(assessJobLiveness(store, "root")).resolves.toMatchObject({
      live: false,
    });
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
