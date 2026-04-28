// Worker pool — one Bun Worker per active session.
//
// The pool owns Worker lifetimes and the message protocol defined in
// sessionWorker.ts. It doesn't know about users, Mongo, or HTTP; see
// sessionManager.ts for those concerns.
//
// Design choices:
// - We don't recycle Workers across sessions. socc's STATE singleton is
//   full of per-session bookkeeping and clearing it by hand is fragile.
//   Terminate → respawn is simpler and the startup cost is tolerable.
// - Turn events fan out through a per-turn AsyncIterableIterator. The
//   Hono SSE handler consumes it; if the client disconnects, the handler
//   calls abortTurn() and the Worker bails out of query().

import type {
  WorkerEventMessage,
  WorkerInboundMessage,
  WorkerInitMessage,
  WorkerOutboundMessage,
  WorkerTurnEndMessage,
} from '../sessionWorker.ts'

export type SessionInit = Omit<WorkerInitMessage, 'type'>

export type TurnEvent =
  | { kind: 'engine'; event: unknown }
  | {
      kind: 'tool_request'
      requestId: string
      name: string
      args: Record<string, unknown>
    }
  | { kind: 'end'; reason: 'complete' | 'aborted' | 'error'; errorMessage?: string }

// Notification fired when a Worker becomes unusable (crash, internal
// terminate, or fatal init failure). The pool DOES NOT auto-remove the
// dead slot from its index — callers (sessionManager) decide whether to
// clean up immediately or keep it for retry.
export type WorkerDiedEvent = {
  sessionId: string
  reason: 'crash' | 'terminated' | 'init_failed'
  message: string
}

export class WorkerPool {
  private readonly workers = new Map<string, WorkerSlot>()
  private readonly maxConcurrent: number
  private onWorkerDied: ((ev: WorkerDiedEvent) => void) | null
  // Explicit Worker entry-point override (used in integration tests to
  // inject a synthetic worker without relying on env vars).
  private readonly workerUrlOverride: string | null

  constructor(options: {
    maxConcurrent: number
    onWorkerDied?: (ev: WorkerDiedEvent) => void
    workerUrl?: string
  }) {
    this.maxConcurrent = options.maxConcurrent
    this.onWorkerDied = options.onWorkerDied ?? null
    this.workerUrlOverride = options.workerUrl ?? null
  }

  // Subscribe to worker-died events post-construction. Last writer wins;
  // we don't fan-out because there's exactly one logical owner
  // (sessionManager). Returns the previous handler if any (handy for
  // tests that want to chain).
  setOnWorkerDied(
    handler: ((ev: WorkerDiedEvent) => void) | null,
  ): ((ev: WorkerDiedEvent) => void) | null {
    const prev = this.onWorkerDied
    this.onWorkerDied = handler
    return prev
  }

  has(sessionId: string): boolean {
    return this.workers.has(sessionId)
  }

  size(): number {
    return this.workers.size
  }

  // Idempotent: a second spawn for the same sessionId is a no-op if the
  // slot is healthy, or a silent replace if it crashed.
  async spawn(init: SessionInit): Promise<void> {
    const existing = this.workers.get(init.sessionId)
    if (existing && !existing.dead) return
    if (existing?.dead) this.workers.delete(init.sessionId)

    if (this.workers.size >= this.maxConcurrent) {
      throw new PoolCapacityError(
        `max concurrent sessions reached (${this.maxConcurrent})`,
      )
    }

    const slot = new WorkerSlot(
      init,
      (reason, message) => {
        if (this.onWorkerDied) {
          this.onWorkerDied({ sessionId: init.sessionId, reason, message })
        }
      },
      this.workerUrlOverride ?? undefined,
    )
    this.workers.set(init.sessionId, slot)
    try {
      await slot.ready()
    } catch (err) {
      this.workers.delete(init.sessionId)
      slot.terminate()
      throw err
    }
  }

  // Streams TurnEvents for a single user turn. The iterator closes after
  // {kind:'end'}; callers must drain it or call abortTurn() to avoid
  // leaking the current turn's state inside the Worker.
  async *run(sessionId: string, turnId: string, text: string): AsyncGenerator<TurnEvent> {
    const slot = this.workers.get(sessionId)
    if (!slot) throw new SessionNotFoundError(sessionId)
    if (slot.dead) throw new SessionNotFoundError(sessionId)

    const stream = slot.beginTurn(turnId)
    slot.post({ type: 'prompt', turnId, text })
    try {
      for await (const ev of stream) yield ev
    } finally {
      slot.endTurn(turnId)
    }
  }

  abortTurn(sessionId: string, turnId?: string): void {
    const slot = this.workers.get(sessionId)
    if (!slot || slot.dead) return
    slot.post({ type: 'abort', turnId })
  }

  // Sends a tool_response back to the Worker that emitted the matching
  // tool_request. Silently no-op for unknown sessions / dead slots so
  // the SSE handler doesn't have to special-case shutdown races.
  forwardToolResponse(
    sessionId: string,
    msg: {
      requestId: string
      ok: boolean
      data?: unknown
      errorCode?: string
      errorMessage?: string
    },
  ): void {
    const slot = this.workers.get(sessionId)
    if (!slot || slot.dead) return
    slot.post({
      type: 'tool_response',
      requestId: msg.requestId,
      ok: msg.ok,
      data: msg.data,
      errorCode: msg.errorCode,
      errorMessage: msg.errorMessage,
    })
  }

  // Terminates a single session's Worker. Safe to call for unknown ids.
  shutdown(sessionId: string): void {
    const slot = this.workers.get(sessionId)
    if (!slot) return
    this.workers.delete(sessionId)
    slot.post({ type: 'shutdown' })
    // Give the worker a moment to flush; then hard-terminate.
    setTimeout(() => slot.terminate(), 100)
  }

  // Terminate everything. Used on process shutdown.
  shutdownAll(): void {
    for (const id of [...this.workers.keys()]) this.shutdown(id)
  }
}

// A single slot in the pool — wraps one Worker and its in-flight turn.
class WorkerSlot {
  readonly sessionId: string
  private worker: Worker
  private readyPromise: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (err: Error) => void
  private readonly notifyDied: (
    reason: 'crash' | 'terminated' | 'init_failed',
    message: string,
  ) => void
  // True after notifyDied has fired once — the pool's onWorkerDied
  // callback is at-most-once per slot. This matters because both the
  // worker's `error` event and an explicit terminate() can race.
  private diedNotified = false
  // Current turn plumbing. Only one turn is in flight at a time; the
  // Worker enforces this too, but gating at the slot saves a round trip.
  private turn: {
    id: string
    queue: TurnEvent[]
    waiters: Array<(v: IteratorResult<TurnEvent>) => void>
    ended: boolean
  } | null = null
  dead = false

  constructor(
    init: SessionInit,
    notifyDied: (
      reason: 'crash' | 'terminated' | 'init_failed',
      message: string,
    ) => void,
    workerUrlOverride?: string,
  ) {
    this.sessionId = init.sessionId
    this.notifyDied = notifyDied
    // Resolve the Worker entry-point.
    //
    // Priority order:
    //   1. `workerUrlOverride` — injected by tests via WorkerPool constructor.
    //   2. Auto-detect: bundled (.mjs context) uses ./sessionWorker.mjs;
    //      dev (.ts context) uses ../sessionWorker.ts.
    let workerUrl: string
    if (workerUrlOverride) {
      workerUrl = workerUrlOverride
    } else {
      const isBundled = !import.meta.url.endsWith('.ts')
      workerUrl = isBundled
        ? new URL('./sessionWorker.mjs', import.meta.url).href
        : new URL('../sessionWorker.ts', import.meta.url).href
    }
    this.worker = new Worker(workerUrl, {
      type: 'module',
    })
    this.readyPromise = new Promise((res, rej) => {
      this.resolveReady = res
      this.rejectReady = rej
    })

    this.worker.addEventListener('message', (ev: MessageEvent<WorkerOutboundMessage>) => {
      this.onMessage(ev.data)
    })
    this.worker.addEventListener('error', (ev: ErrorEvent) => {
      this.onFatal(ev.message || 'worker error')
    })
    this.worker.addEventListener('messageerror', () => {
      this.onFatal('worker messageerror')
    })

    this.post({ type: 'init', ...init })
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  post(msg: WorkerInboundMessage): void {
    if (this.dead) return
    this.worker.postMessage(msg)
  }

  beginTurn(turnId: string): AsyncIterable<TurnEvent> {
    if (this.turn) {
      throw new TurnConflictError('another turn is in flight')
    }
    const turn: NonNullable<WorkerSlot['turn']> = {
      id: turnId,
      queue: [],
      waiters: [],
      ended: false,
    }
    this.turn = turn

    const iter: AsyncIterator<TurnEvent> = {
      next: () =>
        new Promise<IteratorResult<TurnEvent>>((resolve) => {
          if (turn.queue.length > 0) {
            resolve({ value: turn.queue.shift()!, done: false })
            return
          }
          if (turn.ended) {
            resolve({ value: undefined, done: true })
            return
          }
          turn.waiters.push(resolve)
        }),
    }
    return { [Symbol.asyncIterator]: () => iter }
  }

  endTurn(turnId: string): void {
    if (this.turn?.id === turnId) this.turn = null
  }

  private onMessage(msg: WorkerOutboundMessage): void {
    switch (msg.type) {
      case 'ready':
        this.resolveReady()
        return
      case 'event':
        this.pushTurn(msg.turnId, { kind: 'engine', event: (msg as WorkerEventMessage).event })
        return
      case 'tool_request': {
        // PRD §AI System Requirements: the Worker can't call Vantage
        // directly (it doesn't hold the JWT secret). It asks the server
        // by emitting tool_request; the SSE handler in index.ts catches
        // this kind, runs the HTTP round-trip, and replies with
        // forwardToolResponse() below.
        this.pushTurn(msg.turnId, {
          kind: 'tool_request',
          requestId: msg.requestId,
          name: msg.name,
          args: msg.args,
        })
        return
      }
      case 'turn_end': {
        const m = msg as WorkerTurnEndMessage
        this.pushTurn(m.turnId, {
          kind: 'end',
          reason: m.reason,
          errorMessage: m.errorMessage,
        })
        this.closeTurn(m.turnId)
        return
      }
      case 'error':
        if (msg.fatal) this.onFatal(msg.message)
        return
    }
  }

  private pushTurn(turnId: string, ev: TurnEvent): void {
    const t = this.turn
    if (!t || t.id !== turnId) return
    const waiter = t.waiters.shift()
    if (waiter) {
      waiter({ value: ev, done: false })
    } else {
      t.queue.push(ev)
    }
  }

  private closeTurn(turnId: string): void {
    const t = this.turn
    if (!t || t.id !== turnId) return
    t.ended = true
    while (t.waiters.length > 0) {
      const waiter = t.waiters.shift()!
      waiter({ value: undefined, done: true })
    }
  }

  private onFatal(message: string): void {
    const wasReady = this.dead === false && this.diedNotified === false
    this.dead = true
    if (this.turn) {
      this.pushTurn(this.turn.id, { kind: 'end', reason: 'error', errorMessage: message })
      this.closeTurn(this.turn.id)
    }
    this.rejectReady(new Error(message))
    if (wasReady) this.fireDied('crash', message)
  }

  // Called either by graceful shutdown (pool.shutdown) or by tests
  // simulating SIGKILL. Idempotent at the notifyDied level.
  terminate(): void {
    const firstCall = !this.dead && !this.diedNotified
    this.dead = true
    try {
      this.worker.terminate()
    } catch {
      // worker may already be gone; ignore
    }
    if (firstCall) this.fireDied('terminated', 'worker terminated')
  }

  private fireDied(
    reason: 'crash' | 'terminated' | 'init_failed',
    message: string,
  ): void {
    if (this.diedNotified) return
    this.diedNotified = true
    try {
      this.notifyDied(reason, message)
    } catch {
      // Listener errors must not poison slot teardown.
    }
  }
}

export class PoolCapacityError extends Error {
  readonly code = 'pool_capacity'
}

export class SessionNotFoundError extends Error {
  readonly code = 'session_not_found'
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} not found`)
  }
}

export class TurnConflictError extends Error {
  readonly code = 'turn_conflict'
}
