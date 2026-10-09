import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  canonicalSkillNeedsInstall,
  canonicalSkillRoot,
  installCanonicalSkill,
  installSkillForClients,
  isClientSkillAligned,
  linkOrInstallClientSkill,
  skillNeedsInstallForClients,
} from "../../../src/application/SetupSkill.js";
import {
  runDoctor,
  systemDoctorHost,
} from "../../../src/application/Doctor.js";
import { createDoctorHostFixture } from "../../../src/application/Doctor.fixture.js";
import { runSetup } from "../../../src/application/Setup.js";
import { systemSetupHost } from "../../../src/application/SetupHost.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import {
  runUninstall,
  systemUninstallHost,
} from "../../../src/application/Uninstall.js";
import { options } from "../../../src/application/Setup.fixture.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { z } from "zod";
import { skillReferenceIssues } from "../../../scripts/lib/docs-facts.mjs";

describe("canonical skill transaction", () => {
  it("backs up and upgrades a stale managed skill without touching siblings", async () => {
    const home = await createTestTempDirectory("rea-skill-test-");
    const destination = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    const sibling = join(home, ".agents/skills/unrelated/SKILL.md");
    const nativeGuide = join(
      dirname(destination),
      "references/native-and-artifacts.md",
    );
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(dirname(nativeGuide), { recursive: true });
    await mkdir(dirname(sibling), { recursive: true });
    await writeFile(destination, "stale managed skill\n");
    await writeFile(nativeGuide, "stale filesystem-write permission grant\n");
    await writeFile(sibling, "unrelated skill\n");

    expect(await canonicalSkillNeedsInstall(home)).toBe(true);
    expect(await installCanonicalSkill(home)).toBe("installed");
    expect(await readFile(`${destination}.rea.backup`, "utf8")).toBe(
      "stale managed skill\n",
    );
    const installedSkill = await readFile(destination, "utf8");
    expect(installedSkill).toBe(
      await readFile(
        new URL(
          "../../../skills/reverse-engineer-anything/SKILL.md",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(installedSkill).toContain(
      `version: "${PRODUCT_IDENTITY.skillVersion}"`,
    );
    expect(installedSkill).toContain("call available analysis tools");
    expect(installedSkill).toContain("obtain approval before setup writes");
    expect(await readFile(`${nativeGuide}.rea.backup`, "utf8")).toBe(
      "stale filesystem-write permission grant\n",
    );
    for (const reference of [
      "native-and-artifacts.md",
      "javascript-applications.md",
      "android-applications.md",
      "runtime-observation.md",
      "evidence-workflows.md",
    ]) {
      const installed = await readFile(
        join(dirname(destination), "references", reference),
        "utf8",
      );
      expect(installed).toBe(
        await readFile(
          new URL(
            `../../../skills/reverse-engineer-anything/references/${reference}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(installed).not.toMatch(
        /filesystem-write permission grant|native_mount_approved|only with explicit approval|Obtain the per-call/u,
      );
    }
    expect(installedSkill).toContain(
      "use normal repository tools and do not run REA",
    );
    expect(installedSkill).toContain(
      `tool_count: ${String(TOOL_CONTRACTS.length)}`,
    );
    expect(installedSkill).not.toContain("catalog_digest:");
    expect(await readFile(sibling, "utf8")).toBe("unrelated skill\n");
    expect(
      await readFile(
        join(
          home,
          ".agents/skills/reverse-engineer-anything/references/javascript-applications.md",
        ),
        "utf8",
      ),
    ).toContain("analyze_javascript_application");
    expect(await canonicalSkillNeedsInstall(home)).toBe(false);
    expect(await installCanonicalSkill(home)).toBe("unchanged");
    expect(await skillReferenceIssues(dirname(destination))).toEqual([]);
  });

  it("binds portable conformance to the generated skill bytes that setup installs", async () => {
    const home = await createTestTempDirectory("rea-skill-commitment-");
    expect(await installCanonicalSkill(home)).toBe("installed");
    const paths = [
      "SKILL.md",
      "references/android-applications.md",
      "references/evidence-workflows.md",
      "references/javascript-applications.md",
      "references/native-and-artifacts.md",
      "references/runtime-observation.md",
    ];
    const records = await Promise.all(
      paths.map(async (path) => {
        const bytes = await readFile(
          join(home, ".agents/skills/reverse-engineer-anything", path),
        );
        return `${path}\0${createHash("sha256").update(bytes).digest("hex")}\n`;
      }),
    );
    const manifest = z
      .object({
        skill_digests: z.array(
          z.object({ skill_id: z.string(), sha256: z.string() }),
        ),
      })
      .parse(
        JSON.parse(
          await readFile(
            "docs/verification/managed-conformance-manifest.json",
            "utf8",
          ),
        ),
      );
    expect(manifest.skill_digests).toContainEqual({
      skill_id: "reverse-engineer-anything",
      sha256: createHash("sha256").update(records.join("")).digest("hex"),
    });
  });
});

it("doctor verifies installed instructions and references even when metadata is current", async () => {
  const home = await createTestTempDirectory("rea-skill-doctor-");
  const destination = join(
    home,
    ".agents/skills/reverse-engineer-anything/SKILL.md",
  );
  const reference = join(
    dirname(destination),
    "references/evidence-workflows.md",
  );
  const system = systemDoctorHost({
    environment: { HOME: home, USERPROFILE: home },
  });
  const host = createDoctorHostFixture({
    installedSkillIdentity: () =>
      system.installedSkillIdentity?.() ?? Promise.resolve(undefined),
  });
  expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
    "missing",
  );
  expect(await installCanonicalSkill(home)).toBe("installed");
  expect((await runDoctor(undefined, host)).identity?.skill).toMatchObject({
    state: "aligned",
    installed_catalog_digest: null,
  });
  const legacyDigest = "0".repeat(64);
  await writeFile(
    destination,
    (await readFile(destination, "utf8")).replace(
      `  tool_count: ${String(TOOL_CONTRACTS.length)}`,
      `  tool_count: ${String(TOOL_CONTRACTS.length)}\n  catalog_digest: "${legacyDigest}"`,
    ),
  );
  expect((await runDoctor(undefined, host)).identity?.skill).toMatchObject({
    state: "stale",
    installed_catalog_digest: legacyDigest,
  });
  expect(await installCanonicalSkill(home)).toBe("installed");
  for (const path of [destination, reference]) {
    const canonical = await readFile(path, "utf8");
    await writeFile(path, `${canonical}\nLocally changed instructions.\n`);
    expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
      "stale",
    );
    expect(await installCanonicalSkill(home)).toBe("installed");
    expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
      "aligned",
    );
  }
  await rm(reference);
  expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
    "stale",
  );
  expect(await installCanonicalSkill(home)).toBe("installed");
  expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
    "aligned",
  );
});

describe("client skill linking and lifecycle", () => {
  it("installs canonical skill and links into Claude Code personal skill location", async () => {
    const home = await createTestTempDirectory("rea-claude-skill-");
    const claudeSkill = join(
      home,
      ".claude/skills",
      PRODUCT_IDENTITY.skillName,
    );
    expect(await skillNeedsInstallForClients(home, [claudeSkill])).toBe(true);
    expect(await installSkillForClients(home, [claudeSkill])).toBe("installed");

    const canonicalRoot = canonicalSkillRoot(home);
    expect(await readFile(join(canonicalRoot, "SKILL.md"), "utf8")).toContain(
      PRODUCT_IDENTITY.skillName,
    );
    expect(await readFile(join(claudeSkill, "SKILL.md"), "utf8")).toContain(
      PRODUCT_IDENTITY.skillName,
    );

    expect(await isClientSkillAligned(canonicalRoot, claudeSkill)).toBe(true);
    expect(await skillNeedsInstallForClients(home, [claudeSkill])).toBe(false);
    expect(await installSkillForClients(home, [claudeSkill])).toBe("unchanged");
  });

  it("repairs a broken or pointing-elsewhere client skill link", async () => {
    const home = await createTestTempDirectory("rea-claude-repair-");
    const claudeSkill = join(
      home,
      ".claude/skills",
      PRODUCT_IDENTITY.skillName,
    );
    const otherDir = join(home, "other-directory");
    await mkdir(otherDir, { recursive: true });
    await mkdir(dirname(claudeSkill), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(
      otherDir,
      claudeSkill,
      process.platform === "win32" ? "junction" : "dir",
    );

    const canonicalRoot = canonicalSkillRoot(home);
    expect(await isClientSkillAligned(canonicalRoot, claudeSkill)).toBe(false);
    expect(await installSkillForClients(home, [claudeSkill])).toBe("installed");
    expect(await isClientSkillAligned(canonicalRoot, claudeSkill)).toBe(true);
    expect(await readFile(join(claudeSkill, "SKILL.md"), "utf8")).toContain(
      PRODUCT_IDENTITY.skillName,
    );
  });

  it("updates an existing directory with skill files when symlinking is not used", async () => {
    const home = await createTestTempDirectory("rea-claude-dir-");
    const canonical = canonicalSkillRoot(home);
    await installCanonicalSkill(home);

    const claudeSkill = join(
      home,
      ".claude/skills",
      PRODUCT_IDENTITY.skillName,
    );
    await mkdir(claudeSkill, { recursive: true });
    await writeFile(join(claudeSkill, "SKILL.md"), "stale claude skill\n");

    expect(await isClientSkillAligned(canonical, claudeSkill)).toBe(false);
    expect(await linkOrInstallClientSkill(canonical, claudeSkill)).toBe(
      "installed",
    );
    expect(
      await readFile(`${join(claudeSkill, "SKILL.md")}.rea.backup`, "utf8"),
    ).toBe("stale claude skill\n");
    expect(await isClientSkillAligned(canonical, claudeSkill)).toBe(true);
  });

  it("discloses Claude Code skill linking in setup plan and uninstalls cleanly", async () => {
    const home = await createTestTempDirectory("rea-claude-setup-");
    const clients = supportedClients(home);
    const client = clients.find(({ name }) => name === "claude_code");
    expect(client?.skillPath).toBe(
      join(home, ".claude/skills", PRODUCT_IDENTITY.skillName),
    );

    const doctorHost = {
      ...systemDoctorHost({ environment: { HOME: home, USERPROFILE: home } }),
      nodeVersion: "24.18.0",
    };
    const host = {
      ...systemSetupHost(doctorHost, { HOME: home, USERPROFILE: home }),
      nodeVersion: "24.18.0",
    };
    const plan = await runSetup(
      {
        ...options(true),
        clientIds: ["claude_code"],
        dryRun: true,
      },
      host,
    );
    const skillAction = plan.plannedActions.find(
      ({ id }) => id === "install_skill",
    );
    expect(skillAction).toBeDefined();
    expect(skillAction?.detail).toContain(
      "link into Claude Code's skills directory",
    );

    const result = await runSetup(
      {
        ...options(true),
        clientIds: ["claude_code"],
      },
      host,
    );
    expect(result.status).toBe("ready");
    expect(
      await readFile(join(client!.skillPath!, "SKILL.md"), "utf8"),
    ).toContain(PRODUCT_IDENTITY.skillName);

    const uninstalled = await runUninstall(
      false,
      systemUninstallHost(home, undefined, { HOME: home, USERPROFILE: home }),
    );
    expect(uninstalled.status).toBe("complete");
    await expect(
      readFile(join(client!.skillPath!, "SKILL.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(canonicalSkillRoot(home), "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("respects CLAUDE_CONFIG_DIR environment override", () => {
    const customClaudeDir = join("/custom", "my-claude");
    const clients = supportedClients("/home/user", "linux", {
      CLAUDE_CONFIG_DIR: customClaudeDir,
    });
    const claudeClient = clients.find(({ name }) => name === "claude_code");
    expect(claudeClient?.configPath).toBe(
      join(customClaudeDir, ".claude.json"),
    );
    expect(claudeClient?.skillPath).toBe(
      join(customClaudeDir, "skills", PRODUCT_IDENTITY.skillName),
    );
  });
});
