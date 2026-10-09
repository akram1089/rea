import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { PRODUCT_IDENTITY } from "../identity.js";

const SKILL_FILES = [
  "SKILL.md",
  "references/native-and-artifacts.md",
  "references/javascript-applications.md",
  "references/android-applications.md",
  "references/runtime-observation.md",
  "references/evidence-workflows.md",
] as const;

interface CanonicalSkillFile {
  readonly content: string;
  readonly destination: string;
  readonly original: string | undefined;
}

/** Root directory of the canonical REA skill bundle. */
export const canonicalSkillRoot = (home: string): string =>
  join(home, ".agents/skills", PRODUCT_IDENTITY.skillName);

const readOptionalText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
};

const canonicalSkillFiles = async (
  home: string,
): Promise<readonly CanonicalSkillFile[]> =>
  Promise.all(
    SKILL_FILES.map(async (relativePath) => {
      const destination = join(canonicalSkillRoot(home), relativePath);
      return {
        destination,
        content: await readFile(
          new URL(
            `../../skills/${PRODUCT_IDENTITY.skillName}/${relativePath}`,
            import.meta.url,
          ),
          "utf8",
        ),
        original: await readOptionalText(destination),
      };
    }),
  );

/** Report whether setup would change any file in the managed REA skill bundle. */
export const canonicalSkillNeedsInstall = async (
  home: string,
): Promise<boolean> => {
  try {
    return (await canonicalSkillFiles(home)).some(
      ({ content, original }) => original !== content,
    );
  } catch (cause: unknown) {
    // Unreadable skill state fails open to install so setup can repair it.
    void cause;
    return true;
  }
};

/** Verify whether a client-specific skill location links to or matches the canonical bundle. */
export const isClientSkillAligned = async (
  canonicalRoot: string,
  clientSkillPath: string,
): Promise<boolean> => {
  try {
    const stats = await lstat(clientSkillPath);
    if (stats.isSymbolicLink()) {
      try {
        const target = await readlink(clientSkillPath);
        const resolvedTarget = resolve(dirname(clientSkillPath), target);
        if (resolvedTarget === canonicalRoot) return true;
        const [realCanonical, realClient] = await Promise.all([
          realpath(canonicalRoot),
          realpath(clientSkillPath),
        ]);
        return realCanonical === realClient;
      } catch {
        return false;
      }
    }
    if (stats.isDirectory()) {
      for (const relativePath of SKILL_FILES) {
        const clientFile = join(clientSkillPath, relativePath);
        const canonicalFile = join(canonicalRoot, relativePath);
        const [clientContent, canonicalContent] = await Promise.all([
          readOptionalText(clientFile),
          readOptionalText(canonicalFile),
        ]);
        if (clientContent === undefined || clientContent !== canonicalContent) {
          return false;
        }
      }
      return true;
    }
    return false;
  } catch (cause: unknown) {
    void cause;
    return false;
  }
};

/** Report whether canonical or any client-specific skill location needs installation. */
export const skillNeedsInstallForClients = async (
  home: string,
  clientSkillPaths: readonly string[],
): Promise<boolean> => {
  if (await canonicalSkillNeedsInstall(home)) return true;
  const canonicalRoot = canonicalSkillRoot(home);
  for (const clientPath of clientSkillPaths) {
    if (!(await isClientSkillAligned(canonicalRoot, clientPath))) {
      return true;
    }
  }
  return false;
};

const writeText = (path: string, content: string): Promise<void> =>
  writeFileAtomic(path, content, { encoding: "utf8", mode: 0o600 });

const restoreSkillFiles = async (
  changed: readonly CanonicalSkillFile[],
): Promise<void> => {
  for (const { destination, original } of [...changed].reverse()) {
    if (original === undefined) await rm(destination, { force: true });
    else await writeText(destination, original);
  }
};

const copySkillBundle = async (
  canonicalRoot: string,
  destinationRoot: string,
): Promise<void> => {
  for (const relativePath of SKILL_FILES) {
    const src = join(canonicalRoot, relativePath);
    const dest = join(destinationRoot, relativePath);
    const content = await readFile(src, "utf8");
    const original = await readOptionalText(dest);
    if (original !== content) {
      await mkdir(dirname(dest), { recursive: true });
      if (original !== undefined) {
        await writeText(`${dest}.rea.backup`, original);
      }
      await writeText(dest, content);
      if ((await readFile(dest, "utf8")) !== content) {
        throw new Error(`skill readback mismatch: ${dest}`);
      }
    }
  }
};

/** Link the canonical skill into a client-specific skill folder, falling back to a direct copy. */
export const linkOrInstallClientSkill = async (
  canonicalRoot: string,
  clientSkillPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<"installed" | "unchanged" | "failed"> => {
  try {
    if (await isClientSkillAligned(canonicalRoot, clientSkillPath)) {
      return "unchanged";
    }
    await mkdir(dirname(clientSkillPath), { recursive: true });
    try {
      const stats = await lstat(clientSkillPath);
      if (stats.isSymbolicLink()) {
        await rm(clientSkillPath, { force: true });
      }
    } catch (cause: unknown) {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      ) {
        throw cause;
      }
    }
    const symlinkType = platform === "win32" ? "junction" : "dir";
    try {
      await symlink(canonicalRoot, clientSkillPath, symlinkType);
      return "installed";
    } catch {
      await copySkillBundle(canonicalRoot, clientSkillPath);
      return "installed";
    }
  } catch (cause: unknown) {
    void cause;
    return "failed";
  }
};

/** Transactionally install or upgrade the canonical REA skill and references. */
export const installCanonicalSkill = async (
  home: string,
): Promise<"installed" | "unchanged" | "failed"> => {
  let changed: readonly CanonicalSkillFile[] = [];
  try {
    const canonical = await canonicalSkillFiles(home);
    changed = canonical.filter(({ content, original }) => original !== content);
    if (changed.length === 0) return "unchanged";

    for (const { destination, original } of changed) {
      await mkdir(dirname(destination), { recursive: true });
      if (original !== undefined)
        await writeText(`${destination}.rea.backup`, original);
    }
    for (const { destination, content } of changed)
      await writeText(destination, content);
    for (const { destination, content } of changed)
      if ((await readFile(destination, "utf8")) !== content)
        throw new Error(`skill readback mismatch: ${destination}`);
    return "installed";
  } catch (cause: unknown) {
    // Install failure preserves the original error outcome; report cause inline.
    void cause;
    try {
      await restoreSkillFiles(changed);
    } catch (restoreCause: unknown) {
      // Per-file backups remain beside changed files for operator recovery.
      void restoreCause;
    }
    return "failed";
  }
};

/** Install canonical skill and link/install for any client skill locations. */
export const installSkillForClients = async (
  home: string,
  clientSkillPaths: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<"installed" | "unchanged" | "failed"> => {
  const canonicalResult = await installCanonicalSkill(home);
  if (canonicalResult === "failed") return "failed";

  const canonicalRoot = canonicalSkillRoot(home);
  let anyInstalled = canonicalResult === "installed";

  for (const clientPath of clientSkillPaths) {
    const clientResult = await linkOrInstallClientSkill(
      canonicalRoot,
      clientPath,
      platform,
    );
    if (clientResult === "failed") return "failed";
    if (clientResult === "installed") anyInstalled = true;
  }

  return anyInstalled ? "installed" : "unchanged";
};
