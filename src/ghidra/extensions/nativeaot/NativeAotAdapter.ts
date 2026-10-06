import { z } from "zod";
import type { GhidraExtensionAdapter } from "../GhidraExtensions.js";

const report = z
  .object({
    id: z.literal("nativeaot"),
    integration_api: z.literal(1),
    source_revision: z.literal("effeb734fc570c32650f88b159608979dc7b423e"),
    source_revision_authority: z.literal("build-reported-unattested"),
    status: z.enum([
      "complete",
      "partial",
      "not_applicable",
      "unsupported",
      "failed",
    ]),
    reason: z.string().nullable(),
    method_tables: z.number().int().nonnegative(),
    diagnostics: z.array(z.string()),
    header_address: z.string().optional(),
    discovery: z.enum(["symbol", "signature-heuristic"]).optional(),
    format_major: z.number().int().optional(),
    format_minor: z.number().int().optional(),
    derived_memory: z
      .object({
        address: z.string(),
        size_bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        file_offset: z.null(),
      })
      .optional(),
    coverage: z
      .strictObject({
        frozen_object_candidates: z.number().int().nonnegative(),
        frozen_objects_annotated: z.number().int().nonnegative(),
        basis: z.literal(
          "rehydrated-pointer-candidates-and-committed-instance-types",
        ),
      })
      .optional(),
    types: z
      .array(z.object({ address: z.string(), type: z.string() }))
      .optional(),
  })
  .strict();

/** NativeAOT-specific prerequisites and report interpretation behind the extension boundary. */
export const nativeAotAdapter: GhidraExtensionAdapter = {
  id: "nativeaot",
  entryClass: "rea.extensions.nativeaot.NativeAotExtension",
  configuredPath: (config) => config.ghidraNativeAotJar,
  unsupportedReason: (target, platform) =>
    platform !== "linux"
      ? "NativeAOT recovery is verified on Linux only; omit REA_GHIDRA_NATIVEAOT_JAR for ordinary native analysis."
      : !["elf", "pe"].includes(target.format) ||
          target.architecture !== "x86_64" ||
          target.managed === true
        ? "NativeAOT recovery requires an x86-64 ELF or native PE target on Linux; PE/CLI and ReadyToRun assemblies use inspect_managed_artifact; omit REA_GHIDRA_NATIVEAOT_JAR for ordinary native analysis."
        : null,
  validate: (value) => {
    if (
      value.status === "failed" &&
      typeof value.result.loader_failure === "string" &&
      value.result.loader_failure === value.reason
    )
      return null;
    const parsed = report.safeParse(value.result);
    if (
      !parsed.success ||
      parsed.data.status !== value.status ||
      parsed.data.reason !== value.reason
    )
      return "NativeAOT extension returned a malformed or inconsistent producer report.";
    if (
      ["complete", "partial"].includes(value.status) &&
      (parsed.data.method_tables === 0 ||
        parsed.data.format_major !== 9 ||
        parsed.data.format_minor !== 1 ||
        parsed.data.types?.length !== parsed.data.method_tables ||
        parsed.data.derived_memory === undefined)
    )
      return "NativeAOT recovery omitted its supported format, method-table inventory or derived-memory identity.";
    return null;
  },
  limitations: [
    "Optional NativeAOT recovery is verified for .NET 8.0.22 RTR 9.1 Linux x64 ELF and Windows x64 PE targets on a Linux host. Other runtime layouts, target architectures and hosts are unsupported.",
    "Type names and relationships use recovery heuristics; original C# source and custom field layouts are not recovered. Rehydrated analysis-memory bytes are derived, without original file offsets or runtime observations.",
    "The configured extension retains its actual JAR digest. Its reported source revision is not an attestation of caller-supplied build bytes.",
  ],
};
