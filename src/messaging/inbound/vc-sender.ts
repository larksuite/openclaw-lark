/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Shared sender-identity resolution for the VC meeting-invited event.
 *
 * Both the raw event handler (for diagnostics / dedup / ownership check)
 * and the synthetic inbound builder (for dispatchToAgent) need a single,
 * deterministic fallback chain. Keeping a dedicated module avoids drift
 * between the two code paths when the event schema changes again.
 */

import type { FeishuVcMeetingInvitedEvent } from '../types'

/** Which bucket the final senderId was picked from. */
export type VcSenderFallback = 'inviter' | 'none'

export interface ResolvedVcSender {
  /**
   * Final sender id used for logging / extraInboundFields. Sender is defined
   * as the real inviter only; if inviter identity is missing, the event
   * should be skipped instead of degrading to bot/config ids.
   */
  senderId: string
  /** Raw inviter-level open_id (if present); useful for agent "at inviter" use-cases. */
  senderOpenId?: string
  /** Raw inviter-level user_id (if present). */
  senderUserId?: string
  /** Raw inviter-level union_id (if present). */
  senderUnionId?: string
  /** Human-readable name from inviter.user_name. */
  senderName?: string
  /** Which bucket the senderId fell back to. */
  fromFallback: VcSenderFallback
}

/**
 * Trim a possibly-null identifier and treat the empty string as missing.
 *
 * The event schema marks open_id / user_id / union_id as nullable and we
 * have observed tenants returning empty strings in practice, so `||`/`??`
 * alone are not enough.
 */
function pickId(value?: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

/**
 * Resolve the effective sender identity for a `vc.bot.meeting_invited_v1`
 * event. See {@link ResolvedVcSender} for the field contract.
 *
 * Sender resolution order (first non-empty wins):
 *   1. inviter.id.open_id → user_id → union_id
 *   2. empty string + fromFallback='none'
 */
export function resolveVcSender(
  event: FeishuVcMeetingInvitedEvent,
): ResolvedVcSender {
  const inviterId = event.inviter?.id

  const inviterOpenId = pickId(inviterId?.open_id)
  const inviterUserId = pickId(inviterId?.user_id)
  const inviterUnionId = pickId(inviterId?.union_id)

  let senderId = ''
  let fromFallback: VcSenderFallback = 'none'

  if (inviterOpenId ?? inviterUserId ?? inviterUnionId) {
    senderId = inviterOpenId ?? inviterUserId ?? inviterUnionId ?? ''
    fromFallback = 'inviter'
  }

  return {
    senderId,
    senderOpenId: inviterOpenId,
    senderUserId: inviterUserId,
    senderUnionId: inviterUnionId,
    senderName: pickId(event.inviter?.user_name) ?? undefined,
    fromFallback,
  }
}
