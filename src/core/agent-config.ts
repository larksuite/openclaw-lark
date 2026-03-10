// SPDX-License-Identifier: MIT
/**
 * Agent configuration helpers for the Lark/Feishu channel plugin.
 *
 * Reads agent-level configuration (identity, skills, tools, subagents)
 * from the top-level `agents.list` in OpenClawConfig.  These helpers
 * bridge the gap between the SDK's agent infrastructure and the Feishu
 * plugin's dispatch/reply layers.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';

// ---------------------------------------------------------------------------
// Internal types (mirroring SDK agent config shape without importing internals)
// ---------------------------------------------------------------------------

/** Minimal agent identity fields used by the Feishu plugin. */
interface AgentIdentity {
  name?: string;
  emoji?: string;
  avatar?: string;
}

/** Minimal agent tools policy fields. */
interface AgentToolsPolicy {
  allow?: string[];
  deny?: string[];
}

/** Shape of an agent entry in `config.agents.list`. */
interface AgentEntry {
  id: string;
  name?: string;
  skills?: string[];
  identity?: AgentIdentity;
  tools?: AgentToolsPolicy & Record<string, unknown>;
  subagents?: {
    allowAgents?: string[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve the full list of configured agents from config.
 *
 * @param cfg - The top-level application config.
 * @returns Array of agent entries, or empty array if none configured.
 */
export function listConfiguredAgents(cfg: ClawdbotConfig): AgentEntry[] {
  const agents = (cfg as Record<string, unknown>).agents as { list?: AgentEntry[] } | undefined;
  return agents?.list ?? [];
}

/**
 * Look up a specific agent's configuration by its ID.
 *
 * @param cfg - The top-level application config.
 * @param agentId - The agent ID to search for.
 * @returns The matching agent entry, or `undefined` if not found.
 */
export function resolveAgentEntry(cfg: ClawdbotConfig, agentId: string): AgentEntry | undefined {
  return listConfiguredAgents(cfg).find((a) => a.id === agentId);
}

/**
 * Resolve a human-readable display name for an agent.
 *
 * Priority: `identity.name` > `name` > `undefined`.
 *
 * @param cfg - The top-level application config.
 * @param agentId - The agent ID.
 * @returns The display name, or `undefined` if none configured.
 */
export function getAgentDisplayName(cfg: ClawdbotConfig, agentId: string): string | undefined {
  const entry = resolveAgentEntry(cfg, agentId);
  if (!entry) return undefined;
  return entry.identity?.name ?? entry.name;
}

/**
 * Resolve the per-agent skills filter.
 *
 * @param cfg - The top-level application config.
 * @param agentId - The agent ID.
 * @returns Skill allowlist, or `undefined` if no agent-level filter.
 */
export function getAgentSkillsFilter(cfg: ClawdbotConfig, agentId: string): string[] | undefined {
  return resolveAgentEntry(cfg, agentId)?.skills;
}

/**
 * Resolve the per-agent tools policy (allow/deny lists).
 *
 * @param cfg - The top-level application config.
 * @param agentId - The agent ID.
 * @returns Tools policy object, or `undefined` if none configured.
 */
export function getAgentToolsPolicy(cfg: ClawdbotConfig, agentId: string): AgentToolsPolicy | undefined {
  const entry = resolveAgentEntry(cfg, agentId);
  if (!entry?.tools) return undefined;
  const { allow, deny } = entry.tools;
  if (!allow && !deny) return undefined;
  return { allow, deny };
}

/**
 * Merge agent-level and group-level skill filters.
 *
 * When both are present, the effective filter is the intersection:
 * a skill must appear in both lists to be included.  When only one
 * is present, that list is used as-is.
 *
 * @param agentSkills - Per-agent skill allowlist (from AgentConfig.skills).
 * @param groupSkills - Per-group skill allowlist (from FeishuGroupConfig.skills).
 * @returns Merged skill filter, or `undefined` if neither is set.
 */
export function mergeSkillFilters(
  agentSkills: string[] | undefined,
  groupSkills: string[] | undefined,
): string[] | undefined {
  if (!agentSkills && !groupSkills) return undefined;
  if (!agentSkills) return groupSkills;
  if (!groupSkills) return agentSkills;

  // Intersection: group filter narrows the agent filter.
  const agentSet = new Set(agentSkills);
  return groupSkills.filter((s) => agentSet.has(s));
}

/**
 * Check whether a tool name is permitted by an agent's tool policy.
 *
 * Evaluation order:
 *   1. If `deny` list exists and tool matches → denied.
 *   2. If `allow` list exists and tool does NOT match → denied.
 *   3. Otherwise → allowed.
 *
 * Supports glob-like patterns with trailing `*` (e.g. `feishu_calendar_*`).
 *
 * @param toolName - The tool name being invoked.
 * @param policy - The agent's tool policy.
 * @returns `true` if the tool is allowed, `false` if denied.
 */
export function isToolAllowedByPolicy(toolName: string, policy: AgentToolsPolicy | undefined): boolean {
  if (!policy) return true;

  if (policy.deny && policy.deny.length > 0) {
    if (matchesAnyPattern(toolName, policy.deny)) return false;
  }

  if (policy.allow && policy.allow.length > 0) {
    return matchesAnyPattern(toolName, policy.allow);
  }

  return true;
}

/**
 * Check whether a string matches any of the given patterns.
 * Supports trailing `*` as a simple wildcard.
 */
function matchesAnyPattern(value: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
      if (value.startsWith(pattern.slice(0, -1))) return true;
    } else if (value === pattern) {
      return true;
    }
  }
  return false;
}
