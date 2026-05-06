/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * VC meeting invited event handler for the Lark/Feishu channel plugin.
 *
 * Handles `vc.bot.meeting_invited_v1` by converting the event into a
 * synthetic natural-language inbound and dispatching it through the
 * standard OpenClaw agent pipeline.
 */

import * as crypto from 'node:crypto'
import type { ClawdbotConfig, RuntimeEnv } from 'openclaw/plugin-sdk'
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history'
import type { FeishuVcMeetingInvitedEvent, MessageContext, VcMeetingInvitedSyntheticEvent } from '../types'
import { SYNTHETIC_VC_CHAT_ID, SYNTHETIC_VC_CHAT_TYPE } from '../../core/synthetic-target'
import { getLarkAccount } from '../../core/accounts'
import { larkLogger } from '../../core/lark-logger'
import { dispatchToAgent } from './dispatch'
import { sendPairingReply } from './gate-effects'
import { readFeishuAllowFromStore } from './gate'
import { resolveFeishuAllowlistMatch } from './policy'
import { resolveVcSender } from './vc-sender'

const logger = larkLogger('inbound/vc-meeting-invited-handler')

function buildSyntheticEvent(
  event: FeishuVcMeetingInvitedEvent,
): VcMeetingInvitedSyntheticEvent | null {
  const meetingNo = event.meeting?.meeting_no?.trim() ?? ''

  // Both meeting_no and inviter identity are required for this event.
  if (!meetingNo) {
    return null
  }

  const sender = resolveVcSender(event)
  if (!sender.senderId) {
    return null
  }

  return {
    eventType: 'vc.bot.meeting_invited_v1',
    source: 'feishu-vc-event',
    eventId: event.event_id?.trim() || undefined,
    meetingId: event.meeting?.id?.trim() || undefined,
    meetingNo,
    topic: event.meeting?.topic?.trim() || undefined,
    senderId: sender.senderId,
    senderOpenId: sender.senderOpenId,
    senderUserId: sender.senderUserId,
    senderUnionId: sender.senderUnionId,
    senderName: sender.senderName,
    inviteTime: event.invite_time?.trim() || undefined,
  }
}

function buildSyntheticContext(event: VcMeetingInvitedSyntheticEvent): MessageContext {
  // Keep the synthetic inbound prompt in English for now: it is an
  // agent-facing intent string rather than user-visible copy, and the final
  // reply language is still governed by the agent/session prompt stack.
  // If we later need locale-aware synthetic prompts, this is the single place
  // to introduce a template or config-based language switch.
  const syntheticText = `Join the meeting with meeting number ${event.meetingNo}.`
  const syntheticMessageId = event.eventId
    ? `vc-invited:event:${event.eventId}`
    : `vc-invited:${event.meetingNo}:${event.inviteTime ?? crypto.randomUUID()}`

  // VC-invited events have no real chat/thread — they are service-to-service
  // triggers. Using the inviter's open_id as chatId would cause downstream
  // senders (reply / card / media) to fire off unsolicited DMs to the inviter
  // whenever the agent produced any output. Use a synthetic sentinel instead
  // and let IM-facing deliverers short-circuit on it (see SYNTHETIC_VC_CHAT_ID).
  return {
    chatId: SYNTHETIC_VC_CHAT_ID,
    messageId: syntheticMessageId,
    senderId: event.senderId,
    senderName: event.senderName,
    chatType: SYNTHETIC_VC_CHAT_TYPE,
    content: syntheticText,
    contentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    rawMessage: {
      message_id: syntheticMessageId,
      chat_id: SYNTHETIC_VC_CHAT_ID,
      chat_type: SYNTHETIC_VC_CHAT_TYPE,
      message_type: 'text',
      content: JSON.stringify({ text: syntheticText }),
      create_time: event.inviteTime ?? String(Date.now()),
    },
    rawSender: {
      sender_id: {
        ...(event.senderOpenId ? { open_id: event.senderOpenId } : {}),
        ...(event.senderUserId ? { user_id: event.senderUserId } : {}),
        ...(event.senderUnionId ? { union_id: event.senderUnionId } : {}),
      },
      sender_type: 'user',
    },
  }
}

function matchesAnySenderId(params: {
  allowFrom: Array<string | number>
  senderIds: Array<string | undefined>
}): boolean {
  const candidates = [...new Set(params.senderIds.map((id) => id?.trim()).filter(Boolean) as string[])]
  return candidates.some((candidate) =>
    resolveFeishuAllowlistMatch({
      allowFrom: params.allowFrom,
      senderId: candidate,
    }).allowed,
  )
}

export async function handleFeishuVcMeetingInvited(params: {
  cfg: ClawdbotConfig
  event: FeishuVcMeetingInvitedEvent
  runtime?: RuntimeEnv
  chatHistories?: Map<string, HistoryEntry[]>
  accountId?: string
}): Promise<void> {
  const { cfg, event, runtime, chatHistories, accountId } = params
  const log = runtime?.log ?? ((...args: unknown[]) => logger.info(args.map(String).join(' ')))
  const error = runtime?.error ?? ((...args: unknown[]) => logger.error(args.map(String).join(' ')))

  const syntheticEvent = buildSyntheticEvent(event)
  if (!syntheticEvent) {
    log(`feishu[${accountId}]: vc invited event missing meeting_no or inviter identity, skipping`)
    return
  }

  const account = getLarkAccount(cfg, accountId)
  const accountScopedCfg: ClawdbotConfig = {
    ...cfg,
    channels: { ...cfg.channels, feishu: account.config },
  }
  const accountFeishuCfg = account.config

  // ---- Access policy enforcement (DM-style) ----
  // VC invited events are user-triggered service events. Align their access
  // semantics with direct-message/comment flows so unpaired users cannot
  // trigger agent behavior through event ingress.
  const dmPolicy = accountFeishuCfg?.dmPolicy ?? 'pairing'
  if (dmPolicy === 'disabled') {
    log(`feishu[${accountId}]: vc invited event rejected (dmPolicy=disabled)`)
    return
  }

  if (dmPolicy !== 'open') {
    const configAllowFrom = accountFeishuCfg?.allowFrom ?? []
    const storeAllowFrom = await readFeishuAllowFromStore(account.accountId).catch(() => [] as string[])
    const combinedAllowFrom = [...configAllowFrom, ...storeAllowFrom]

    const allowed = matchesAnySenderId({
      allowFrom: combinedAllowFrom,
      senderIds: [
        syntheticEvent.senderOpenId,
        syntheticEvent.senderUserId,
        syntheticEvent.senderUnionId,
      ],
    })

    if (!allowed) {
      if (dmPolicy === 'pairing') {
        if (syntheticEvent.senderOpenId) {
          log(`feishu[${accountId}]: vc inviter not paired, creating pairing request`)
          try {
            await sendPairingReply({
              senderId: syntheticEvent.senderOpenId,
              chatId: syntheticEvent.senderOpenId,
              accountId: account.accountId,
              accountScopedCfg,
            })
          } catch (pairingErr) {
            log(`feishu[${accountId}]: failed to create pairing request for vc inviter: ${String(pairingErr)}`)
          }
        } else {
          log(`feishu[${accountId}]: vc inviter not paired and has no open_id for pairing reply, rejecting`)
        }
      } else {
        log(`feishu[${accountId}]: vc invited event rejected (dmPolicy=${dmPolicy}, inviter not in allowlist)`)
      }
      return
    }
  }

  const ctx = buildSyntheticContext(syntheticEvent)

  log(
    `feishu[${accountId}]: vc meeting invited, dispatching synthetic inbound` +
      ` sender=${syntheticEvent.senderId} meeting_no=${syntheticEvent.meetingNo}`,
  )

  try {
    await dispatchToAgent({
      ctx,
      permissionError: undefined,
      mediaPayload: {},
      extraInboundFields: {
        SyntheticEventType: syntheticEvent.eventType,
        VcMeetingId: syntheticEvent.meetingId,
        VcMeetingNo: syntheticEvent.meetingNo,
        VcMeetingTopic: syntheticEvent.topic,
        VcInviterOpenId: syntheticEvent.senderOpenId,
        VcInviteTime: syntheticEvent.inviteTime,
      },
      quotedContent: undefined,
      account,
      accountScopedCfg,
      runtime,
      chatHistories,
      historyLimit: 0,
      // VC events do not originate from a real IM message.
      replyToMessageId: undefined,
      commandAuthorized: false,
      skipTyping: true,
    })
  } catch (err) {
    error(`feishu[${accountId}]: error dispatching vc invited synthetic inbound: ${String(err)}`)
  }
}
