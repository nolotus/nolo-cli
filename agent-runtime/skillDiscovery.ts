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
import type { DiscoveredSkill } from "./turnContext";

const SKILL_SCAN_DIRS = [".agents/skills", "docs/skills"] as const;
const MAX_DISCOVERED_SKILLS = 50;

export function parseSkillFrontmatter(filePath: string): { name?: string; description?: string } {
  try {
    const content = readFileSync(filePath, "utf8").slice(0, 2048);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    // description supports YAML block scalars: >, >-, >+, |, |-, |+
    // (folded/literal with chomping indicators). The content lives on the
    // following indented lines (including blank lines as paragraph separators
    // for folded scalars) until a dedented line (next top-level key or ---).
    const blockScalarMatch = fm.match(
      /^description:\s*([>|])([-+]?).*\n((?:[ \t]+.*\n?|[ \t]*\n)+)/m,
    );
    let description: string | undefined;
    if (blockScalarMatch) {
      const folded = blockScalarMatch[1] === ">";
      // Strip leading indentation from each line; drop pure-blank lines but
      // remember them as paragraph breaks for folded scalars.
      const lines = blockScalarMatch[3].split("\n").map((line) =>
        line.replace(/^[ \t]+/, ""),
      );
      if (folded) {
        // Folded: blank lines → paragraph break (join with space, collapse runs).
        description = lines
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      } else {
        // Literal: preserve newlines, drop trailing empty lines.
        description = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      }
    } else {
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      description = descMatch?.[1];
    }
    const sanitize = (s: string | undefined) =>
      s?.trim().replace(/^["']|["']$/g, "").replace(/[\n\r]/g, " ").slice(0, 200);
    return { name: sanitize(nameMatch?.[1]), description: sanitize(description) };
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