/**
 * CHANNEL_HANDLERS registry — maps each `CaseSystem` to its adapter.
 *
 * The LangGraph "execute tools" node (P9.4) iterates this registry
 * over the routing-plan selections, dispatching each via the same
 * `Promise<ChannelResult>` interface.
 *
 * **Extension point.** Adding a future channel is a single new file
 * plus one entry here. No changes to the dispatcher, the routing
 * layer, the narrative generator, or the cases-table idempotency
 * code. This is the property pre-flight 7 of the decision log
 * commits to — *"adding a future channel is a one-file change."*
 *
 * **Current state (2026-05-13, P9.2 shipped).** Both channels in
 * the simplified scope are registered: `sms` (stubbed) and `email`
 * (real, via SNS). The registry constraint tightened from
 * `Partial<Record<...>>` to full `Record<...>` so TypeScript catches
 * any future `CaseSystem` literal added without a matching handler.
 */

import { callSmsStub, type SmsCallInput } from './sms-stub';
import { callEmail, type EmailCallInput } from './email';
import type { CaseSystem, ChannelResult } from '../types';

/**
 * A channel handler accepts whatever per-channel input shape its
 * adapter expects (intentionally `unknown` at the registry boundary
 * because each adapter has a distinct real-API input shape). The
 * dispatcher in P9.4 is responsible for mapping the LangGraph output
 * (routing + narratives + breach context) onto the right per-channel
 * input shape before invoking.
 */
type ChannelHandler = (input: unknown) => Promise<ChannelResult>;

export const CHANNEL_HANDLERS = {
  sms: callSmsStub as ChannelHandler,
  email: callEmail as ChannelHandler,
} satisfies Record<CaseSystem, ChannelHandler>;

// Re-exports for convenience at call sites.
export { callSmsStub, callEmail };
export type { SmsCallInput, EmailCallInput };
