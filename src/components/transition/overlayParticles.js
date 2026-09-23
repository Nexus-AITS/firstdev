/** Static style data for the ENTER NEXUS overlay particles. */

export const HEX_ECHO = "polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)";
export const SHARD_CLIP = "polygon(50% 0%, 100% 100%, 0% 80%)";

export const SHARD_STYLES = Array.from({ length: 26 }, (_, i) => ({
  size: 14 + ((i * 37) % 24),
  rot: (i * 47) % 360,
  tone: ["#7c3aed", "#d8b4fe", "#a855f7"][i % 3],
}));

export const SWARM_STYLES = Array.from({ length: 42 }, (_, i) => ({
  size: 2 + (i % 4),
  tone: i % 5 === 0 ? "#f5d78e" : i % 2 ? "#a855f7" : "#d8b4fe",
  left: (i * 53) % 100,
  top: (i * 29) % 100,
}));
