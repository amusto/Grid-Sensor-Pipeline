/**
 * Shared types for the case-routing layer (P9).
 *
 * `CaseSystem` is the discriminator across all channel adapters.
 * Adding a future channel adds a literal here and a new entry in
 * `CHANNEL_HANDLERS` (channels/index.ts). The Zod schemas in
 * routing-strategy.ts and narrative-generator.ts are independently
 * scoped to which channels participate in routing decisions vs
 * narrative generation; CaseSystem is the broader registry.
 *
 * `ChannelResult` is the uniform return shape every adapter
 * produces — real (email, future SES) or stubbed (sms). The
 * dispatcher in P9.4 aggregates these into the
 * delivered/failed/skipped tuples for partial-success behavior.
 */

export type CaseSystem = 'email' | 'sms';

export type ChannelStatus = 'delivered' | 'failed' | 'skipped';

export interface ChannelResult {
  /** Which channel produced this result. */
  channel: CaseSystem;
  /** Outcome of the dispatch attempt. */
  status: ChannelStatus;
  /** Synthetic `MOCK-...` for stubs; real ID for real adapters. */
  caseId: string;
  /** Deep-link to the external system, where one exists. */
  externalUrl?: string;
  /** Populated only when `status === 'failed'`. */
  error?: string;
  /** Wall-clock latency in milliseconds for the dispatch call. */
  latencyMs: number;
}
