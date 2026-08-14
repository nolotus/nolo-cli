/**
 * Skill discovery: filesystem scanning of SKILL.md files.
 *
 * Host-specific module — imports `node:fs`. Split out of turnContext.ts
 * (which is host-neutral and referenced by cross-host surfaces including
 * the RN renderer) so non-Node hosts don't pull `node:fs` into their bundle.
 *
 * The host-neutral `DiscoveredSkill` interface and `buildSkillDiscoveryLayer`
 * remain in turnContext.ts; this module only owns the fs-touching scan.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { buildSkillDiscoveryLayer, type DiscoveredSkill } from "./turnContext";

// Discovery only scans `.agents/skills` — the single skill source-of-truth.
// Each skill lives at `.agents/skills/<name>/SKILL.md`; `resolveSkillByName`
// (below) resolves by directory stem or frontmatter name within this dir.
const SKILL_SCAN_DIRS = [".agents/skills"] as const;
const MAX_DISCOVERED_SKILLS = 50;
// Total character budget for all skill descriptions in the discovery list.
// Modeled on Codex's "skills list ≤ 2% of context" approach: when the sum of
// descriptions exceeds this budget, each description is shortened proportionally
// (keeping the front — where authors should front-load activation triggers and
// key use cases, per the Agent Skills authoring guide) rather than hard-cut at
// a fixed per-skill limit. Current 12 skills total ~2k chars, well under budget.
const MAX_DISCOVERY_DESC_BUDGET = 4000;
// Floor per-skill description length when budget pressure requires shortening.
// Ensures every skill still gets a meaningful one-line summary.
const MIN_DESC_LENGTH = 80;

export function parseSkillFrontmatter(filePath: string): { name?: string; description?: string } {
  try {
    const content = readFileSync(filePath, "utf8").slice(0, 2048);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};
    // Parse the frontmatter as YAML via js-yaml (already a project dep, used in
    // skillDocProtocol.ts). This replaces a hand-rolled regex that broke twice:
    // once on the `>-` chomping indicator, once on blank-line paragraph breaks
    // in folded scalars. js-yaml handles all block scalar variants correctly.
    const fm = loadYaml(fmMatch[1]) as Record<string, unknown> | undefined;
    if (!fm || typeof fm !== "object") return {};
    const name = typeof fm.name === "string" ? fm.name : undefined;
    const rawDesc = fm.description;
    // js-yaml already unfolds folded/literal scalars into strings; for
    // non-string values fall back to String() so callers always get text.
    const description =
      typeof rawDesc === "string"
        ? rawDesc
        : rawDesc == null
          ? undefined
          : String(rawDesc);
    // name is a single-segment identifier; keep the 200-char guard as a safety
    // net for malformed frontmatter. description is capped at 200 chars per
    // skill (the discovery list is a menu — each entry should be short; authors
    // should front-load activation triggers so the cap preserves them). A
    // separate total-budget control in discoverSkills guards against skill-count
    // growth; the two layers are independent.
    const sanitizeName = (s: string | undefined) =>
      s?.trim().replace(/^["']|["']$/g, "").replace(/[\n\r]+/g, " ").slice(0, 200);
    const sanitizeDesc = (s: string | undefined) =>
      s?.trim().replace(/^["']|["']$/g, "").replace(/[\n\r]+/g, " ").slice(0, 200);
    return { name: sanitizeName(name), description: sanitizeDesc(description) };
  } catch { return {}; }
}

export function discoverSkills(cwd: string): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];
  for (const dir of SKILL_SCAN_DIRS) {
    if (skills.length >= MAX_DISCOVERED_SKILLS) break;
    const absDir = join(cwd, dir);
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) continue;
    try {
      for (const entry of readdirSync(absDir)) {
        if (skills.length >= MAX_DISCOVERED_SKILLS) break;
        const skillMdPath = join(absDir, entry, "SKILL.md");
        if (existsSync(skillMdPath)) {
          const { name, description } = parseSkillFrontmatter(skillMdPath);
          skills.push({ name: name ?? entry, description: description ?? "", relativePath: join(dir, entry, "SKILL.md") });
          continue;
        }
      }
    } catch { }
  }
  // Budget control (Codex-style): if total description length exceeds the
  // budget, shorten each description proportionally — keeping the front (where
  // authors should front-load activation triggers) and never below the floor.
  // Only kicks in when skill count grows large; current 12 skills (~2k) are
  // well under the 4000-char budget, so no shortening happens today.
  const totalDescLen = skills.reduce((sum, s) => sum + s.description.length, 0);
  if (totalDescLen > MAX_DISCOVERY_DESC_BUDGET && skills.length > 0) {
    const scale = MAX_DISCOVERY_DESC_BUDGET / totalDescLen;
    for (const s of skills) {
      const targetLen = Math.max(MIN_DESC_LENGTH, Math.floor(s.description.length * scale));
      if (s.description.length > targetLen) {
        s.description = s.description.slice(0, targetLen).trimEnd();
      }
    }
  }
  return skills;
}

/**
 * Resolve a single skill by name to its absolute SKILL.md path, reusing the
 * same scan source as `discoverSkills` (`.agents/skills/<name>/SKILL.md`).
 * This does not re-run the full scan — it probes the candidate path directly
 * and optionally scans siblings for a frontmatter-name match, so it stays
 * O(1) in the common case and never duplicates the discovery logic.
 *
 * Returns the resolved absolute path, or null when no candidate exists. The
 * caller decides what to do with a miss (the `loadSkill` tool returns an
 * available-skills list rather than throwing).
 *
 * Name matching mirrors `discoverSkills`'s advertising: a discovered
 * `.agents/skills/<dir>/SKILL.md` is identified by its directory entry, with
 * frontmatter `name:` as an alias. To stay consistent with advertised names
 * without re-reading frontmatter on every lookup, we match on the directory
 * stem and also accept a frontmatter-name match by reading the file only
 * when the stem doesn't match (so the common path stays cheap).
 */
export function resolveSkillByName(cwd: string, name: string): string | null {
  const trimmed = name.trim();
  // Reject empty / path-traversal inputs before touching the filesystem:
  // a name containing `/`, `\`, or `..` could escape the skill directories and
  // resolve an arbitrary .md. Skill names are single-segment identifiers
  // (e.g. `nolo-commit`), so these characters are never valid here.
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    return null;
  }
  // .agents/skills/<name>/SKILL.md — match by directory stem or frontmatter name.
  const agentsDir = join(cwd, ".agents", "skills", trimmed);
  const agentsSkillMd = join(agentsDir, "SKILL.md");
  if (existsSync(agentsSkillMd)) return agentsSkillMd;
  // Frontmatter-name match: scan sibling dirs whose frontmatter name equals
  // the requested name. Kept narrow — only runs when the stem match missed.
  const agentsParent = join(cwd, ".agents", "skills");
  if (existsSync(agentsParent) && statSync(agentsParent).isDirectory()) {
    try {
      for (const entry of readdirSync(agentsParent)) {
        const candidate = join(agentsParent, entry, "SKILL.md");
        if (!existsSync(candidate)) continue;
        // Per-file try/catch: one malformed SKILL.md must not abort the scan
        // of its siblings. (parseSkillFrontmatter already swallows YAML
        // errors; this guards readdirSync/stat edge cases and future changes.)
        try {
          const { name: fmName } = parseSkillFrontmatter(candidate);
          if (fmName && fmName === trimmed) return candidate;
        } catch { /* skip unreadable/bad file, keep scanning */ }
      }
    } catch { /* best-effort, mirror discoverSkills' swallow */ }
  }
  return null;
}

/**
 * One-call helper for host entry points (CLI agentRunCommand, TUI
 * readlineWorkspace, desktop runtime) to build the skill-discovery context
 * block. Encapsulates discoverSkills + buildSkillDiscoveryLayer + best-effort
 * try/catch so every entry point gets identical behavior and a new entry
 * point can't accidentally omit the scan (the exact bug that made skills
 * invisible to CLI agents).
 *
 * Returns the layer content string ready to push into extraContextBlocks,
 * or null when no skills were found / the scan failed.
 */
export function buildSkillDiscoveryContextBlock(cwd: string): string | null {
  try {
    const discovered = discoverSkills(cwd);
    const layer = buildSkillDiscoveryLayer(discovered, cwd);
    return layer?.content ?? null;
  } catch {
    // Skill discovery is best-effort; a scan failure must not abort the run.
    return null;
  }
}