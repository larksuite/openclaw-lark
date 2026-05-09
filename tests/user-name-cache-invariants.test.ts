import { describe, expect, it } from 'vitest';
import { UserNameCache } from '../src/messaging/inbound/user-name-cache-store';

describe('UserNameCache: kind annotation', () => {
  it('setWithKind stores kind alongside name', () => {
    const cache = new UserNameCache();
    cache.setWithKind('ou_a', 'Alice', 'user');
    cache.setWithKind('ou_b', 'BotB', 'bot');

    // existing get(openId) still returns the name string
    expect(cache.get('ou_a')).toBe('Alice');
    expect(cache.get('ou_b')).toBe('BotB');

    // new lookupByName exposes the principal kind
    expect(cache.lookupByName('Alice')).toEqual([{ openId: 'ou_a', name: 'Alice', kind: 'user' }]);
    expect(cache.lookupByName('BotB')).toEqual([{ openId: 'ou_b', name: 'BotB', kind: 'bot' }]);
  });

  it('set without kind keeps kind undefined', () => {
    const cache = new UserNameCache();
    cache.set('ou_x', 'Xeno');
    const matches = cache.lookupByName('Xeno');
    expect(matches).toEqual([{ openId: 'ou_x', name: 'Xeno', kind: undefined }]);
  });
});

describe('UserNameCache: reverse-index invariants', () => {
  it('rename: rewriting an openId with a different name removes the old reverse bucket', () => {
    const cache = new UserNameCache();
    cache.setWithKind('ou_a', 'Alice', 'user');
    cache.setWithKind('ou_a', 'AliceRenamed', 'user');

    expect(cache.lookupByName('Alice')).toEqual([]);
    expect(cache.lookupByName('AliceRenamed')).toEqual([
      { openId: 'ou_a', name: 'AliceRenamed', kind: 'user' },
    ]);
  });

  it('two openIds sharing same name: both appear in reverse bucket; deleting one preserves the other', () => {
    const cache = new UserNameCache();
    cache.setWithKind('ou_a', 'Zhang', 'user');
    cache.setWithKind('ou_b', 'Zhang', 'user');

    const both = cache.lookupByName('Zhang');
    expect(both).toHaveLength(2);
    expect(both.map((m) => m.openId).sort()).toEqual(['ou_a', 'ou_b']);

    // overwrite ou_a with a different name; ou_b should remain
    cache.setWithKind('ou_a', 'OtherName', 'user');

    expect(cache.lookupByName('Zhang')).toEqual([
      { openId: 'ou_b', name: 'Zhang', kind: 'user' },
    ]);
  });

  it('LRU eviction also removes the entry from the reverse index', () => {
    const cache = new UserNameCache(/*maxSize*/ 2);
    cache.setWithKind('ou_a', 'Alice', 'user');
    cache.setWithKind('ou_b', 'Bob', 'user');
    cache.setWithKind('ou_c', 'Charlie', 'user'); // triggers evict of ou_a

    expect(cache.get('ou_a')).toBeUndefined();
    expect(cache.lookupByName('Alice')).toEqual([]); // critical: reverse index cleaned
    expect(cache.lookupByName('Bob')).toEqual([
      { openId: 'ou_b', name: 'Bob', kind: 'user' },
    ]);
    expect(cache.lookupByName('Charlie')).toEqual([
      { openId: 'ou_c', name: 'Charlie', kind: 'user' },
    ]);
  });
});

describe('UserNameCache: chat members snapshots', () => {
  it('recordChatBots writes chatBots entry and seeds nameByOpenId with kind=bot', () => {
    const cache = new UserNameCache();
    cache.recordChatBots('oc_chat1', [
      { openId: 'ou_bot1', name: 'BotOne' },
      { openId: 'ou_bot2', name: 'BotTwo' },
    ]);

    const entry = cache.getChatBots('oc_chat1');
    expect(entry).not.toBeNull();
    expect(entry!.members).toHaveLength(2);

    // bots also seeded into name forward + reverse with kind='bot'
    expect(cache.get('ou_bot1')).toBe('BotOne');
    expect(cache.lookupByName('BotOne')).toEqual([{ openId: 'ou_bot1', name: 'BotOne', kind: 'bot' }]);
  });

  it('recordChatMembers writes chatMembers entry with mixed kind', () => {
    const cache = new UserNameCache();
    cache.recordChatMembers('oc_chat2', [
      { openId: 'ou_u1', name: 'Alice', kind: 'user' },
      { openId: 'ou_b1', name: 'Robo', kind: 'bot' },
    ]);

    const entry = cache.getChatMembers('oc_chat2');
    expect(entry!.members).toHaveLength(2);
    expect(cache.lookupByName('Alice')).toEqual([{ openId: 'ou_u1', name: 'Alice', kind: 'user' }]);
    expect(cache.lookupByName('Robo')).toEqual([{ openId: 'ou_b1', name: 'Robo', kind: 'bot' }]);
  });

  it('getChatBots returns null after TTL', () => {
    const cache = new UserNameCache(500, 1); // 1 ms TTL
    cache.recordChatBots('oc_chat3', [{ openId: 'ou_x', name: 'X' }]);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cache.getChatBots('oc_chat3')).toBeNull();
        resolve();
      }, 10);
    });
  });

  it('clear wipes chatBots and chatMembers too', () => {
    const cache = new UserNameCache();
    cache.recordChatBots('oc_a', [{ openId: 'ou_a', name: 'A' }]);
    cache.recordChatMembers('oc_b', [{ openId: 'ou_b', name: 'B', kind: 'user' }]);

    cache.clear();

    expect(cache.getChatBots('oc_a')).toBeNull();
    expect(cache.getChatMembers('oc_b')).toBeNull();
    expect(cache.get('ou_a')).toBeUndefined();
    expect(cache.get('ou_b')).toBeUndefined();
  });
});

describe('UserNameCache: in-flight dedup', () => {
  it('set/get/clear preserve promise identity per key, with key isolation', () => {
    const cache = new UserNameCache();
    const p1 = Promise.resolve();
    const p2 = Promise.resolve();

    cache.setInflight('bots:oc_a', p1);
    cache.setInflight('members:oc_a', p2);
    expect(cache.getInflight('bots:oc_a')).toBe(p1);
    expect(cache.getInflight('members:oc_a')).toBe(p2);

    cache.clearInflight('bots:oc_a');
    expect(cache.getInflight('bots:oc_a')).toBeUndefined();
    expect(cache.getInflight('members:oc_a')).toBe(p2); // sibling untouched
  });
});

describe('UserNameCache: chat-members LRU and rewrite', () => {
  it('evictChats removes oldest chat when maxChats is exceeded', () => {
    const cache = new UserNameCache(/*maxSize*/ 500, /*ttlMs*/ 30 * 60 * 1000, /*maxChats*/ 2);
    cache.recordChatBots('oc_a', [{ openId: 'ou_a', name: 'A' }]);
    cache.recordChatBots('oc_b', [{ openId: 'ou_b', name: 'B' }]);
    cache.recordChatBots('oc_c', [{ openId: 'ou_c', name: 'C' }]); // triggers evict of oc_a

    expect(cache.getChatBots('oc_a')).toBeNull();
    expect(cache.getChatBots('oc_b')).not.toBeNull();
    expect(cache.getChatBots('oc_c')).not.toBeNull();
  });

  it('recordChatBots on existing chatId bumps LRU position', () => {
    const cache = new UserNameCache(500, 30 * 60 * 1000, /*maxChats*/ 2);
    cache.recordChatBots('oc_a', [{ openId: 'ou_a', name: 'A' }]);
    cache.recordChatBots('oc_b', [{ openId: 'ou_b', name: 'B' }]);

    // Re-record oc_a — it should move to the tail (newest)
    cache.recordChatBots('oc_a', [{ openId: 'ou_a', name: 'A' }]);

    cache.recordChatBots('oc_c', [{ openId: 'ou_c', name: 'C' }]); // should evict oc_b (oldest), not oc_a

    expect(cache.getChatBots('oc_a')).not.toBeNull(); // bumped, survived
    expect(cache.getChatBots('oc_b')).toBeNull();      // oldest, evicted
    expect(cache.getChatBots('oc_c')).not.toBeNull();
  });
});
