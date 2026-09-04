import { describe, expect, it } from 'vitest';
import { VisibleTextLedger } from '../src/card/visible-text-ledger';

describe('VisibleTextLedger', () => {
  it('treats partial replies as replaceable snapshots within one assistant message', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('The price is 128 yuan.');
    ledger.updatePartial('The corrected price is 108 yuan.');

    expect(ledger.render()).toBe('The corrected price is 108 yuan.');
  });

  it('preserves a pre-tool segment when the next assistant message is longer', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('I will check.');
    ledger.beginAssistantMessage();
    ledger.updatePartial('The lookup is complete, and this second segment is much longer.');

    expect(ledger.render()).toBe('I will check.\n\nThe lookup is complete, and this second segment is much longer.');
  });

  it('preserves identical text from two distinct assistant messages', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Please wait while I check.');
    ledger.beginAssistantMessage();
    ledger.updatePartial('Please wait while I check.');

    expect(ledger.render()).toBe('Please wait while I check.\n\nPlease wait while I check.');
  });

  it('keeps a final-only message when it repeats text from a sealed message', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Please wait while I check.');
    ledger.beginAssistantMessage();
    ledger.appendDelivery('Please wait while I check.', 'final');

    expect(ledger.render()).toBe('Please wait while I check.\n\nPlease wait while I check.');
  });

  it('uses a final delivery to settle the active partial without duplicating it', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('The result is');
    ledger.appendDelivery('The result is complete.', 'final');

    expect(ledger.render()).toBe('The result is complete.');
  });

  it('reconciles final deliveries with the matching streamed messages', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Before the tool call.');
    ledger.beginAssistantMessage();
    ledger.updatePartial('After the tool call.');
    ledger.appendDelivery('Before the tool call.', 'final');
    ledger.appendDelivery('After the tool call.', 'final');

    expect(ledger.render()).toBe('Before the tool call.\n\nAfter the tool call.');
  });

  it('does not rewrite a sealed message from prefix similarity alone', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Status: first phase');
    ledger.beginAssistantMessage();
    ledger.updatePartial('Status: second phase');
    ledger.beginAssistantMessage();
    ledger.updatePartial('The third phase is still running.');
    ledger.appendDelivery('Status: second phase complete', 'final');

    expect(ledger.render()).toBe(
      'Status: first phase\n\nStatus: second phase\n\nThe third phase is still running.\n\nStatus: second phase complete',
    );
  });

  it('keeps two prefix-related real messages after explicit boundaries', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('I will check.');
    ledger.beginAssistantMessage();
    ledger.appendDelivery('I will check. The answer is 42.', 'final');

    expect(ledger.render()).toBe('I will check.\n\nI will check. The answer is 42.');
  });

  it('settles the active message when its snapshot is the uniquely most specific final prefix', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Status');
    ledger.beginAssistantMessage();
    ledger.updatePartial('Status: second message');
    ledger.appendDelivery('Status: second message complete.', 'final');

    expect(ledger.render()).toBe('Status\n\nStatus: second message complete.');
  });

  it('uses an exact delayed final to settle the earlier message without touching the newer partial', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Status');
    ledger.beginAssistantMessage();
    ledger.updatePartial('Status: second phase');
    ledger.appendDelivery('Status', 'final');

    expect(ledger.render()).toBe('Status\n\nStatus: second phase');
  });

  it('keeps an independent block delivery between streamed messages', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Before the tool call.');
    ledger.appendDelivery('A separately delivered update.', 'block');
    ledger.beginAssistantMessage();
    ledger.updatePartial('After the tool call.');

    expect(ledger.render()).toBe('Before the tool call.\n\nA separately delivered update.\n\nAfter the tool call.');
  });

  it('does not collapse a prefix-related independent block into the active stream', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Checking order #123.');
    ledger.appendDelivery('Checking order #123. I handed it to logistics.', 'block');

    expect(ledger.render()).toBe('Checking order #123.\n\nChecking order #123. I handed it to logistics.');
  });

  it('does not treat a prefix-related final as a complete transcript without explicit identity', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Before the tool call.');
    ledger.beginAssistantMessage();
    ledger.updatePartial('After the tool call.');
    ledger.appendDelivery('Before the tool call.\n\nAfter the tool call.', 'final');

    expect(ledger.render()).toBe(
      'Before the tool call.\n\nAfter the tool call.\n\nBefore the tool call.\n\nAfter the tool call.',
    );
  });

  it('uses delivery identity only after it has been safely attached to a segment', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Before the tool call.');
    ledger.beginAssistantMessage();
    ledger.updatePartial('After the tool call.');
    ledger.appendDelivery('Before the tool call.', 'final', 7);
    ledger.appendDelivery('Before the tool call, now corrected.', 'final', 7);
    ledger.appendDelivery('After the tool call.', 'final', 8);

    expect(ledger.render()).toBe('Before the tool call, now corrected.\n\nAfter the tool call.');
  });

  it('settles identical streamed messages in FIFO order without merging either one', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('The same visible sentence.');
    ledger.beginAssistantMessage();
    ledger.updatePartial('The same visible sentence.');
    ledger.appendDelivery('The same visible sentence.', 'final');
    ledger.appendDelivery('The same visible sentence.', 'final');

    expect(ledger.render()).toBe('The same visible sentence.\n\nThe same visible sentence.');
  });

  it('keeps a block and a final that happens to begin with the block text', () => {
    const ledger = new VisibleTextLedger();

    ledger.appendDelivery('Status: complete.', 'block');
    ledger.appendDelivery('Status: complete. Here is the final recommendation.', 'final');

    expect(ledger.render()).toBe('Status: complete.\n\nStatus: complete. Here is the final recommendation.');
  });

  it('keeps an independent block and final even when their text and delivery index match', () => {
    const ledger = new VisibleTextLedger();

    ledger.appendDelivery('The same visible event.', 'block', 7);
    ledger.appendDelivery('The same visible event.', 'final', 7);

    expect(ledger.render()).toBe('The same visible event.\n\nThe same visible event.');
  });

  it('applies delta and replace updates only to the current message', () => {
    const ledger = new VisibleTextLedger();

    ledger.applyPartial({ delta: 'Current' });
    ledger.applyPartial({ delta: ' message' });
    ledger.beginAssistantMessage();
    ledger.applyPartial({ delta: 'Draft' });
    ledger.applyPartial({ text: 'Replacement', replace: true });

    expect(ledger.render()).toBe('Current message\n\nReplacement');
  });

  it('consumes a delayed post-tool message-start acknowledgement without splitting the new partial', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Before the tool.');
    ledger.beginToolBoundary();
    ledger.updatePartial('After the tool.');
    ledger.beginAssistantMessage();
    ledger.appendDelivery('After the tool.', 'final');

    expect(ledger.render()).toBe('Before the tool.\n\nAfter the tool.');
  });

  it('arms only one post-tool acknowledgement across repeated tool-start events', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Before the tool.');
    ledger.beginToolBoundary();
    ledger.beginToolBoundary();
    ledger.beginAssistantMessage();
    ledger.updatePartial('After the tool.');
    ledger.appendDelivery('After the tool.', 'final');

    expect(ledger.render()).toBe('Before the tool.\n\nAfter the tool.');
  });

  it('does not let an ambiguous delayed final clear a newer active partial', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('The original quote was 128 yuan.');
    ledger.beginAssistantMessage();
    ledger.updatePartial('I am continuing with the second question.');
    ledger.appendDelivery('Correction: the quote is 108 yuan.', 'final');

    expect(ledger.render()).toBe(
      'The original quote was 128 yuan.\n\nI am continuing with the second question.\n\nCorrection: the quote is 108 yuan.',
    );
  });

  it('does not let a shorter delayed final settle a prefix-related newer message', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Status: older message still streaming');
    ledger.beginAssistantMessage();
    ledger.updatePartial('Status: newer message still streaming');
    ledger.appendDelivery('Status:', 'final');

    expect(ledger.render()).toBe(
      'Status: older message still streaming\n\nStatus: newer message still streaming\n\nStatus:',
    );
  });

  it('does not bind a new delivery identity to the wrong one of two identical messages', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('The same visible sentence.');
    ledger.beginAssistantMessage();
    ledger.updatePartial('The same visible sentence.');
    ledger.appendDelivery('The same visible sentence.', 'final', 7);
    ledger.appendDelivery('The second sentence was corrected.', 'final', 7);

    expect(ledger.render()).toBe(
      'The same visible sentence.\n\nThe same visible sentence.\n\nThe second sentence was corrected.',
    );
  });

  it('quarantines an identity that ambiguously matches two historical messages', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('The same visible sentence.');
    ledger.beginAssistantMessage();
    ledger.updatePartial('The same visible sentence.');
    ledger.beginAssistantMessage();
    ledger.updatePartial('A newer independent message.');
    ledger.appendDelivery('The same visible sentence.', 'final', 7);
    ledger.appendDelivery('The same visible sentence.', 'final', 7);
    ledger.appendDelivery('A newer independent message, corrected.', 'final', 7);

    expect(ledger.render()).toBe(
      'The same visible sentence.\n\nThe same visible sentence.\n\nA newer independent message.\n\nA newer independent message, corrected.',
    );
  });

  it('keeps an unrelated final delivery together with the active stream', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('The streamed answer is still in progress.');
    ledger.appendDelivery('A separately delivered update.', 'final');

    expect(ledger.render()).toBe('The streamed answer is still in progress.\n\nA separately delivered update.');
  });

  it('can discard a silent active partial without removing earlier visible text', () => {
    const ledger = new VisibleTextLedger();

    ledger.updatePartial('Already delivered.');
    ledger.beginAssistantMessage();
    ledger.updatePartial('NO_RE');
    ledger.clearPartial();

    expect(ledger.render()).toBe('Already delivered.');
  });
});
