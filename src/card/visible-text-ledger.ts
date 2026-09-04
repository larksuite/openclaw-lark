/**
 * Keeps the user-visible assistant text in event order.
 *
 * Partial replies are cumulative snapshots of the current assistant message,
 * while deliveries are authoritative completed payloads.  The explicit
 * assistant-message boundary lets us preserve text across tool calls without
 * guessing from snapshot length or content.
 */

export type VisibleTextDeliveryKind = 'block' | 'final';

export interface VisibleTextPartialUpdate {
  /** Complete cumulative snapshot when the producer provides one. */
  text?: string;
  /** Incremental text used by newer/third-party producers without a snapshot. */
  delta?: string;
  /** The supplied snapshot or delta replaces the current message. */
  replace?: true;
}

interface VisibleTextSegment {
  text: string;
  delivered: boolean;
}

function isRelatedSnapshot(left: string, right: string): boolean {
  const normalizedLeft = left.trimEnd();
  const normalizedRight = right.trimEnd();
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(normalizedRight) ||
    normalizedRight.startsWith(normalizedLeft)
  );
}

function isStrictlyMoreSpecificExtension(
  activeText: string,
  finalText: string,
  historicalSegments: readonly VisibleTextSegment[],
): boolean {
  const normalizedActive = activeText.trimEnd();
  const normalizedFinal = finalText.trimEnd();
  if (!normalizedFinal.startsWith(normalizedActive)) return false;

  const longestHistoricalPrefix = historicalSegments.reduce((longest, segment) => {
    const historicalText = segment.text.trimEnd();
    return normalizedFinal.startsWith(historicalText) ? Math.max(longest, historicalText.length) : longest;
  }, 0);

  return normalizedActive.length > longestHistoricalPrefix;
}

export class VisibleTextLedger {
  private readonly committed: VisibleTextSegment[] = [];
  private readonly finalByAssistantMessageIndex = new Map<number, VisibleTextSegment>();
  private readonly ambiguousHistoricalFinalIndexes = new Set<number>();
  private activePartial = '';
  private messageOpen = false;
  private awaitingPostToolMessageStart = false;

  /** Finish the previous partial before a new assistant message starts. */
  beginAssistantMessage(): void {
    if (this.awaitingPostToolMessageStart) {
      // onToolStart seals the pre-tool message synchronously. Core may deliver
      // the matching message-start callback after the first post-tool partial;
      // consume that callback as confirmation instead of sealing the new text.
      this.awaitingPostToolMessageStart = false;
      this.messageOpen = true;
      return;
    }

    this.commitPartial();
    this.messageOpen = true;
  }

  /**
   * Seal the pre-tool assistant message before any awaited work begins.
   * Repeated tool lifecycle events share one pending start acknowledgement.
   */
  beginToolBoundary(): void {
    this.commitPartial();
    this.messageOpen = false;
    this.awaitingPostToolMessageStart = true;
  }

  /** Replace the current assistant message with its latest cumulative snapshot. */
  updatePartial(text: string): void {
    if (!text.trim()) return;
    this.applyPartial({ text });
  }

  /** Apply either a cumulative snapshot or a modern delta/replace update. */
  applyPartial(update: VisibleTextPartialUpdate): string {
    this.messageOpen = true;

    if (update.replace === true) {
      this.activePartial = update.text ?? update.delta ?? '';
      return this.activePartial;
    }

    if (update.text !== undefined) {
      this.activePartial = update.text;
      return this.activePartial;
    }

    if (update.delta !== undefined) {
      this.activePartial += update.delta;
    }

    return this.activePartial;
  }

  /** Remove a partial that resolved to a non-visible sentinel such as NO_REPLY. */
  clearPartial(): void {
    this.activePartial = '';
  }

  /**
   * Record an authoritative delivery.
   *
   * Matching is intentionally limited to an active snapshot or an unsettled
   * streamed segment.  Already delivered segments are never globally deduped,
   * so identical text from two real assistant messages remains visible twice.
   */
  appendDelivery(text: string, kind: VisibleTextDeliveryKind, assistantMessageIndex?: number): void {
    if (!text.trim()) return;

    if (kind === 'block') {
      // A block may be an independently delivered say()/progress message.
      // Without message identity, preserving both visible events is safer than
      // collapsing them merely because their text shares a prefix.
      this.commitPartial();
      this.committed.push({ text, delivered: true });
      this.messageOpen = false;
      return;
    }

    if (assistantMessageIndex !== undefined) {
      const existingFinal = this.finalByAssistantMessageIndex.get(assistantMessageIndex);
      if (existingFinal) {
        // Once identity has been attached by an unambiguous reconciliation,
        // later replays/corrections for that identity may safely update it.
        existingFinal.text = text;
        existingFinal.delivered = true;
        return;
      }
    }

    if (!this.activePartial && this.messageOpen) {
      // An explicit start with no partial is still a real message slot. Do not
      // consume an identical sealed message merely because the text matches.
      this.appendFinal(text, assistantMessageIndex);
      return;
    }

    const activeMatches = Boolean(this.activePartial && isRelatedSnapshot(this.activePartial, text));
    const matchingHistoricalSegments = this.committed.filter(
      (segment) => !segment.delivered && isRelatedSnapshot(segment.text, text),
    );
    const exactHistoricalMatch = matchingHistoricalSegments.find(
      (segment) => segment.text.trimEnd() === text.trimEnd(),
    );
    if (exactHistoricalMatch) {
      // Exact replay can settle the earliest matching historical snapshot.
      // If the active message also matches, or more than one historical
      // snapshot is related, ownership is ambiguous. Preserve the visible
      // count, but quarantine this identity so a later correction cannot edit
      // the wrong real message through a newly unique text match.
      const historicalOwnerIsUnambiguous = !activeMatches && matchingHistoricalSegments.length === 1;
      if (assistantMessageIndex !== undefined && !historicalOwnerIsUnambiguous) {
        this.ambiguousHistoricalFinalIndexes.add(assistantMessageIndex);
      }

      exactHistoricalMatch.text = text;
      exactHistoricalMatch.delivered = true;
      if (
        historicalOwnerIsUnambiguous &&
        (assistantMessageIndex === undefined || !this.ambiguousHistoricalFinalIndexes.has(assistantMessageIndex))
      ) {
        this.attachFinalIdentity(exactHistoricalMatch, assistantMessageIndex);
      }
      return;
    }

    if (assistantMessageIndex !== undefined && this.ambiguousHistoricalFinalIndexes.has(assistantMessageIndex)) {
      // This identity can no longer be inferred onto any existing segment.
      // Keep the current partial, then bind the authoritative final to the new
      // segment created for this observation.
      this.commitPartial();
      this.appendFinal(text, assistantMessageIndex);
      return;
    }

    if (this.activePartial) {
      if (
        activeMatches &&
        (matchingHistoricalSegments.length === 0 ||
          isStrictlyMoreSpecificExtension(this.activePartial, text, matchingHistoricalSegments))
      ) {
        this.settleActiveFinal(text, assistantMessageIndex);
        return;
      }

      // A final related to both a sealed message and the active message (or to
      // neither) has insufficient identity to prove which one it replaces.
      // Preserve every observation instead of rewriting the wrong message.
      this.commitPartial();
      this.appendFinal(text, assistantMessageIndex);
      return;
    }

    this.appendFinal(text, assistantMessageIndex);
  }

  render(): string {
    const segments = this.committed.map((segment) => segment.text);
    if (this.activePartial) segments.push(this.activePartial);
    return segments.join('\n\n');
  }

  hasVisibleText(): boolean {
    return Boolean(this.activePartial || this.committed.length > 0);
  }

  private commitPartial(): void {
    if (!this.activePartial) return;
    this.committed.push({ text: this.activePartial, delivered: false });
    this.activePartial = '';
  }

  private settleActiveFinal(text: string, assistantMessageIndex?: number): void {
    const segment = { text, delivered: true };
    this.committed.push(segment);
    this.activePartial = '';
    this.messageOpen = false;
    this.attachFinalIdentity(segment, assistantMessageIndex);
  }

  private appendFinal(text: string, assistantMessageIndex?: number): void {
    const segment = { text, delivered: true };
    this.committed.push(segment);
    this.messageOpen = false;
    this.attachFinalIdentity(segment, assistantMessageIndex);
  }

  private attachFinalIdentity(segment: VisibleTextSegment, assistantMessageIndex?: number): void {
    if (assistantMessageIndex !== undefined) {
      this.finalByAssistantMessageIndex.set(assistantMessageIndex, segment);
    }
  }
}
