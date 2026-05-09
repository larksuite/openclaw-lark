import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllSentinelStores,
  getSentinelStore,
  type SentinelEntry,
} from '../src/messaging/inbound/sentinel-store';

describe('SentinelStore', () => {
  beforeEach(() => clearAllSentinelStores());
  afterEach(() => clearAllSentinelStores());

  it('record then consume returns entries; second consume returns empty', () => {
    const store = getSentinelStore('acct1');
    const e: SentinelEntry = { name: 'Alice', reason: 'not_found' };
    store.recordSentinels('thread1', [e]);

    expect(store.consumeSentinels('thread1')).toEqual([e]);
    expect(store.consumeSentinels('thread1')).toEqual([]);
  });

  it('multiple records on same thread accumulate (de-dup by name)', () => {
    const store = getSentinelStore('acct1');
    store.recordSentinels('thread1', [{ name: 'Alice', reason: 'not_found' }]);
    store.recordSentinels('thread1', [
      { name: 'Bob', reason: 'not_found' },
      { name: 'Alice', reason: 'not_found' }, // duplicate, should de-dup
    ]);
    const out = store.consumeSentinels('thread1');
    expect(out.map((s) => s.name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('TTL expiry returns empty on consume', async () => {
    const store = getSentinelStore('acct1', /*maxThreads*/ 200, /*ttlMs*/ 1);
    store.recordSentinels('thread1', [{ name: 'X', reason: 'not_found' }]);
    await new Promise((res) => setTimeout(res, 5));
    expect(store.consumeSentinels('thread1')).toEqual([]);
  });

  it('different threads are isolated', () => {
    const store = getSentinelStore('acct1');
    store.recordSentinels('threadA', [{ name: 'A', reason: 'not_found' }]);
    store.recordSentinels('threadB', [{ name: 'B', reason: 'not_found' }]);
    expect(store.consumeSentinels('threadA').map((s) => s.name)).toEqual(['A']);
    expect(store.consumeSentinels('threadB').map((s) => s.name)).toEqual(['B']);
  });

  it('LRU eviction beyond maxThreads', () => {
    const store = getSentinelStore('acct1', /*maxThreads*/ 3);
    store.recordSentinels('t1', [{ name: 'A', reason: 'not_found' }]);
    store.recordSentinels('t2', [{ name: 'B', reason: 'not_found' }]);
    store.recordSentinels('t3', [{ name: 'C', reason: 'not_found' }]);
    store.recordSentinels('t4', [{ name: 'D', reason: 'not_found' }]); // triggers evict
    expect(store.consumeSentinels('t1')).toEqual([]); // t1 evicted
    expect(store.consumeSentinels('t4').map((s) => s.name)).toEqual(['D']);
  });

  it('different accounts are isolated', () => {
    getSentinelStore('acct1').recordSentinels('thread1', [{ name: 'X', reason: 'not_found' }]);
    expect(getSentinelStore('acct2').consumeSentinels('thread1')).toEqual([]);
  });
});
