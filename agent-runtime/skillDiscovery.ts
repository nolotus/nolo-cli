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
 * Resolve a single skill by name to its absolute SKILL.md path, reusing the
 * same scan sources and resolution order as `discoverSkills`
 * (`.agents/skills/<name>/SKILL.md` → `docs/skills/<name>.md`). This does not
 * re-run the full scan — it probes the two candidate paths directly, so it
 * stays O(1) and never duplicates the discovery logic.
 *
 * Returns the resolved absolute path, or null when no candidate exists. The
 * caller decides what to do with a miss (the `loadSkill` tool returns an
 * available-skills list rather than throwing).
 *
 * Name matching mirrors `discoverSkills`'s fallback: a discovered
 * `.agents/skills/<dir>/SKILL.md` is identified by its directory entry, and a
 * `docs/skills/<file>.md` by the file stem. Frontmatter `name:` is not
 * consulted here — discovery's source-of-truth for the on-disk path is the
 * directory/file name, and `loadSkill` must accept the same names discovery
 * advertises (it advertises frontmatter `name` when present, with the
 * directory/file stem as fallback). To stay consistent with advertised names
 * without re-reading frontmatter on every lookup, we match on the directory
 * / file stem and also accept a frontmatter-name match by reading the file
 * only when the stem doesn't match (so the common path stays cheap).
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
  // docs/skills/<name>.md — match by file stem or frontmatter name.
  const docsFlat = join(cwd, "docs", "skills", `${trimmed}.md`);
  if (existsSync(docsFlat)) return docsFlat;
  const docsDir = join(cwd, "docs", "skills");
  if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
    try {
      for (const entry of readdirSync(docsDir)) {
        if (!entry.endsWith(".md")) continue;
        const candidate = join(docsDir, entry);
        try {
          const { name: fmName } = parseSkillFrontmatter(candidate);
          if (fmName && fmName === trimmed) return candidate;
        } catch { /* skip unreadable/bad file, keep scanning */ }
      }
    } catch { /* best-effort */ }
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