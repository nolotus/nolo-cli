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

const SKILL_SCAN_DIRS = [".agents/skills", "docs/skills"] as const;
const MAX_DISCOVERED_SKILLS = 50;

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
    const sanitize = (s: string | undefined) =>
      s?.trim().replace(/^["']|["']$/g, "").replace(/[\n\r]+/g, " ").slice(0, 200);
    return { name: sanitize(name), description: sanitize(description) };
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
        if (dir === "docs/skills" && entry.endsWith(".md")) {
          const flatPath = join(absDir, entry);
          const { name, description } = parseSkillFrontmatter(flatPath);
          skills.push({ name: name ?? entry.replace(/\.md$/, ""), description: description ?? "", relativePath: join(dir, entry) });
        }
      }
    } catch { }
  }
  return skills;
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