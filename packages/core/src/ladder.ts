/** packages/core/src/ladder.ts */

import { sha256Hex } from "./canonicalize.ts";
import type { ClusterLadder, LadderLevel } from "./types.ts";

export type { ClusterLadder, LadderLevel };

export function emptyLadder(cluster_id: string): ClusterLadder {
  return {
    cluster_id,
    injected: [],
    cooldown_until_seq: 0,
  };
}

export async function fingerprint(
  level: LadderLevel,
  cluster_id: string,
  template_version: string,
): Promise<string> {
  return sha256Hex(`${level}|${cluster_id}|${template_version}`);
}

export function nextLevel(cluster: ClusterLadder, mvp: boolean): LadderLevel {
  const hasSoft = cluster.injected.some((i) => i.level === "soft");
  const hasHard = cluster.injected.some((i) => i.level === "hard");
  const hasHuman = cluster.injected.some((i) => i.level === "human");
  if (!hasSoft) return "soft";
  if (mvp) return "exhausted";
  if (!hasHard) return "hard";
  if (!hasHuman) return "human";
  return "exhausted";
}
