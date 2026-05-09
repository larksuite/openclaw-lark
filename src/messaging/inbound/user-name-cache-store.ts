/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Account-scoped cache registry for Feishu user display names.
 *
 * Stores forward (openId → name + kind) and reverse (normalizedName → Set<openId>)
 * indexes for mention resolution. Per-account, LRU + TTL.
 */

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_CHATS = 200;

export type PrincipalKind = 'user' | 'bot';

interface NameEntry {
  name: string;
  kind?: PrincipalKind;
  expireAt: number;
}

export interface MentionMatch {
  openId: string;
  name: string;
  kind?: PrincipalKind;
}

export interface ChatMember {
  openId: string;
  name: string;
  kind: PrincipalKind;
}

export interface ChatMembersEntry {
  members: ChatMember[];
  expireAt: number;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export class UserNameCache {
  private nameByOpenId = new Map<string, NameEntry>();
  private openIdsByName = new Map<string, Set<string>>();
  private maxSize: number;
  private ttlMs: number;
  private chatBots = new Map<string, ChatMembersEntry>();
  private chatMembers = new Map<string, ChatMembersEntry>();
  private inFlight = new Map<string, Promise<void>>();
  private maxChats: number;

  constructor(
    maxSize = DEFAULT_MAX_SIZE,
    ttlMs = DEFAULT_TTL_MS,
    maxChats = DEFAULT_MAX_CHATS,
  ) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.maxChats = maxChats;
  }

  has(openId: string): boolean {
    const entry = this.nameByOpenId.get(openId);
    if (!entry) return false;
    if (entry.expireAt <= Date.now()) {
      this.deleteOpenId(openId);
      return false;
    }
    return true;
  }

  get(openId: string): string | undefined {
    const entry = this.nameByOpenId.get(openId);
    if (!entry) return undefined;
    if (entry.expireAt <= Date.now()) {
      this.deleteOpenId(openId);
      return undefined;
    }
    // LRU bump
    this.nameByOpenId.delete(openId);
    this.nameByOpenId.set(openId, entry);
    return entry.name;
  }

  set(openId: string, name: string): void {
    this.writeEntry(openId, name, undefined);
  }

  setWithKind(openId: string, name: string, kind: PrincipalKind): void {
    this.writeEntry(openId, name, kind);
  }

  lookupByName(name: string): MentionMatch[] {
    const key = normalizeName(name);
    const ids = this.openIdsByName.get(key);
    if (!ids || ids.size === 0) return [];

    const matches: MentionMatch[] = [];
    for (const openId of ids) {
      const entry = this.nameByOpenId.get(openId);
      if (!entry) continue;
      if (entry.expireAt <= Date.now()) {
        this.deleteOpenId(openId);
        continue;
      }
      matches.push({ openId, name: entry.name, kind: entry.kind });
    }
    return matches;
  }

  setMany(entries: Iterable<[string, string]>): void {
    for (const [openId, name] of entries) {
      this.writeEntryNoEvict(openId, name, undefined);
    }
    this.evict();
  }

  filterMissing(openIds: string[]): string[] {
    return openIds.filter((id) => !this.has(id));
  }

  getMany(openIds: string[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const id of openIds) {
      if (this.has(id)) {
        result.set(id, this.get(id) ?? '');
      }
    }
    return result;
  }

  recordChatBots(chatId: string, members: Array<{ openId: string; name: string }>): void {
    const enriched: ChatMember[] = members.map((m) => ({ ...m, kind: 'bot' as PrincipalKind }));
    this.chatBots.delete(chatId);
    this.chatBots.set(chatId, { members: enriched, expireAt: Date.now() + this.ttlMs });
    this.evictChats(this.chatBots);
    for (const m of enriched) {
      if (m.openId) this.writeEntryNoEvict(m.openId, m.name, 'bot');
    }
    this.evict();
  }

  recordChatMembers(chatId: string, members: ChatMember[]): void {
    const enriched = members.slice();
    this.chatMembers.delete(chatId);
    this.chatMembers.set(chatId, { members: enriched, expireAt: Date.now() + this.ttlMs });
    this.evictChats(this.chatMembers);
    for (const m of enriched) {
      if (m.openId) this.writeEntryNoEvict(m.openId, m.name, m.kind);
    }
    this.evict();
  }

  getChatBots(chatId: string): ChatMembersEntry | null {
    const entry = this.chatBots.get(chatId);
    if (!entry) return null;
    if (entry.expireAt <= Date.now()) {
      this.chatBots.delete(chatId);
      return null;
    }
    return entry;
  }

  getChatMembers(chatId: string): ChatMembersEntry | null {
    const entry = this.chatMembers.get(chatId);
    if (!entry) return null;
    if (entry.expireAt <= Date.now()) {
      this.chatMembers.delete(chatId);
      return null;
    }
    return entry;
  }

  getInflight(key: string): Promise<void> | undefined {
    return this.inFlight.get(key);
  }

  setInflight(key: string, promise: Promise<void>): void {
    this.inFlight.set(key, promise);
  }

  clearInflight(key: string): void {
    this.inFlight.delete(key);
  }

  clear(): void {
    this.nameByOpenId.clear();
    this.openIdsByName.clear();
    this.chatBots.clear();
    this.chatMembers.clear();
    this.inFlight.clear();
  }

  // ----- private helpers -----

  private writeEntry(openId: string, name: string, kind: PrincipalKind | undefined): void {
    this.writeEntryNoEvict(openId, name, kind);
    this.evict();
  }

  private writeEntryNoEvict(openId: string, name: string, kind: PrincipalKind | undefined): void {
    // remove from old reverse bucket if name changed
    const old = this.nameByOpenId.get(openId);
    if (old) {
      const oldKey = normalizeName(old.name);
      const newKey = normalizeName(name);
      if (oldKey !== newKey) {
        this.removeFromReverse(oldKey, openId);
      }
    }

    this.nameByOpenId.delete(openId);
    this.nameByOpenId.set(openId, { name, kind, expireAt: Date.now() + this.ttlMs });

    const key = normalizeName(name);
    let bucket = this.openIdsByName.get(key);
    if (!bucket) {
      bucket = new Set();
      this.openIdsByName.set(key, bucket);
    }
    bucket.add(openId);
  }

  private deleteOpenId(openId: string): void {
    const entry = this.nameByOpenId.get(openId);
    if (!entry) return;
    this.nameByOpenId.delete(openId);
    this.removeFromReverse(normalizeName(entry.name), openId);
  }

  private removeFromReverse(key: string, openId: string): void {
    const bucket = this.openIdsByName.get(key);
    if (!bucket) return;
    bucket.delete(openId);
    if (bucket.size === 0) {
      this.openIdsByName.delete(key);
    }
  }

  private evictChats(map: Map<string, ChatMembersEntry>): void {
    while (map.size > this.maxChats) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private evict(): void {
    while (this.nameByOpenId.size > this.maxSize) {
      const oldest = this.nameByOpenId.keys().next().value;
      if (oldest === undefined) break;
      this.deleteOpenId(oldest);
    }
  }
}

const registry = new Map<string, UserNameCache>();

export function getUserNameCache(accountId: string): UserNameCache {
  let c = registry.get(accountId);
  if (!c) {
    c = new UserNameCache();
    registry.set(accountId, c);
  }
  return c;
}

export function clearUserNameCache(accountId?: string): void {
  if (accountId !== undefined) {
    registry.get(accountId)?.clear();
    registry.delete(accountId);
  } else {
    for (const c of registry.values()) c.clear();
    registry.clear();
  }
}
