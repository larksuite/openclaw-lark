/**
 * Type-level compatibility layer for the retired `openclaw/plugin-sdk` root export
 * (removed from OpenClaw in #111451; see larksuite/openclaw-lark#598/#605).
 *
 * All of these are compile-time-only type imports: tsc erases them, so they never
 * appear in the published CJS output and cannot trigger runtime resolution errors.
 * Runtime value imports must use real subpaths (see index.ts / reply-dispatcher.ts).
 */
export type {
  OpenClawPluginApi,
  PluginRuntime,
  ChannelPlugin,
  ChannelMessageActionAdapter,
} from 'openclaw/plugin-sdk/channel-plugin-common';
export { emptyPluginConfigSchema } from 'openclaw/plugin-sdk/channel-plugin-common';
export type { OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry';
/** Legacy project-name alias, removed upstream in the 2026.8 SDK sweep. */
export type ClawdbotConfig = import('openclaw/plugin-sdk/plugin-entry').OpenClawConfig;
export type { RuntimeEnv } from 'openclaw/plugin-sdk/runtime-env';
export type { WizardPrompter } from 'openclaw/plugin-sdk/setup';
export type { RuntimeLogger } from 'openclaw/plugin-sdk/core';
export type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
