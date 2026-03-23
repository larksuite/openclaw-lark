declare module 'openclaw/plugin-sdk' {
  export type BindingTargetKind = 'subagent' | 'session';
  export type BindingStatus = 'active' | 'ending' | 'ended';
  export type SessionBindingPlacement = 'current' | 'child';

  export type ConversationRef = {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };

  export type SessionBindingRecord = {
    bindingId: string;
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversation: ConversationRef;
    status: BindingStatus;
    boundAt: number;
    expiresAt?: number;
    metadata?: Record<string, unknown>;
  };

  export type SessionBindingBindInput = {
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversation: ConversationRef;
    placement?: SessionBindingPlacement;
    metadata?: Record<string, unknown>;
    ttlMs?: number;
  };

  export type SessionBindingUnbindInput = {
    bindingId?: string;
    targetSessionKey?: string;
    reason: string;
  };

  export type SessionBindingCapabilities = {
    adapterAvailable: boolean;
    bindSupported: boolean;
    unbindSupported: boolean;
    placements: SessionBindingPlacement[];
  };

  export type SessionBindingSpawnConversationInput = {
    channel: string;
    accountId: string;
    to?: string;
    threadId?: string | number;
  };

  export type SessionBindingAdapter = {
    channel: string;
    accountId: string;
    capabilities?: {
      placements?: SessionBindingPlacement[];
      bindSupported?: boolean;
      unbindSupported?: boolean;
    };
    resolveConversationForSpawn?: (input: SessionBindingSpawnConversationInput) => ConversationRef | null;
    bind?: (input: SessionBindingBindInput) => Promise<SessionBindingRecord | null>;
    listBySession: (targetSessionKey: string) => SessionBindingRecord[];
    resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
    touch?: (bindingId: string, at?: number) => void;
    unbind?: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
  };

  export type SessionBindingService = {
    bind: (input: SessionBindingBindInput) => Promise<SessionBindingRecord>;
    getCapabilities: (params: { channel: string; accountId: string }) => SessionBindingCapabilities;
    resolveConversationForSpawn?: (input: SessionBindingSpawnConversationInput) => ConversationRef | null;
    listBySession: (targetSessionKey: string) => SessionBindingRecord[];
    resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
    touch: (bindingId: string, at?: number) => void;
    unbind: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
  };

  export function registerSessionBindingAdapter(adapter: SessionBindingAdapter): void;
  export function unregisterSessionBindingAdapter(params: { channel: string; accountId: string }): void;
  export function getSessionBindingService(): SessionBindingService;
  export function resolveConversationIdFromTargets(params: {
    threadId?: string | number;
    targets: Array<string | undefined | null>;
  }): string | undefined;
}
