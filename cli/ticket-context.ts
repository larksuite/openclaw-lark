import { withTicket, type LarkTicket } from '../src/core/lark-ticket';

export interface CliTicketOptions {
  accountId?: string;
  chatId: string;
  userOpenId?: string;
  chatType?: 'p2p' | 'group';
}

export function createCliTicket(options: CliTicketOptions): LarkTicket {
  return {
    messageId: `cli_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    chatId: options.chatId,
    accountId: options.accountId ?? 'default',
    startTime: Date.now(),
    senderOpenId: options.userOpenId,
    chatType: options.chatType ?? 'p2p',
  };
}

export function runWithCliTicket<T>(options: CliTicketOptions, fn: () => T | Promise<T>): T | Promise<T> {
  return withTicket(createCliTicket(options), fn);
}
