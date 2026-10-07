/**
 * The deterministic test catalog (IDE-09): a registry index in the real format, and its
 * packages' contents. TEST FIXTURES ONLY -- for unit tests, UI tests and offline development
 * through `LocalMarketplaceProvider`. Not production marketplace data, and never offered as a
 * marketplace in the application.
 */

const HASH = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

export interface FixturePackage {
  /** The manifest the package holds (its `yavin-extension.json`). */
  manifest: Record<string, unknown>;
  /** Its entry point's code, if any. */
  code?: string;
  /** A package the installer must refuse (`unsafe`), or one that is not there (`missing`). */
  broken?: "unsafe" | "missing";
}

const manifest = (
  publisher: string,
  name: string,
  displayName: string,
  version: string,
  extra: Record<string, unknown> = {},
) => ({
  publisher,
  name,
  displayName,
  version,
  description: `${displayName} (test fixture).`,
  engines: { yavin: "^2.0.0" },
  ...extra,
});

const greeter = (command: string, text: string) => `
module.exports.activate = function (context, yavin) {
  context.subscriptions.push(yavin.commands.registerCommand(${JSON.stringify(command)}, function () {
    yavin.window.showInformationMessage(${JSON.stringify(text)});
    return ${JSON.stringify(text)};
  }));
};`;

const commandOf = (id: string, title: string, category: string) => ({
  activationEvents: [`onCommand:${id}`],
  main: "extension.js",
  contributes: { commands: [{ command: id, title, category }] },
});

export const FIXTURE_PACKAGES: Record<string, FixturePackage> = {
  "packages/acme.python-tools-1.2.0.yvx": {
    manifest: manifest(
      "acme",
      "python-tools",
      "Python Tools",
      "1.2.0",
      commandOf("acme.python-tools.check", "Check Environment", "Python Tools"),
    ),
    code: greeter("acme.python-tools.check", "Python Tools: environment OK"),
  },
  "packages/acme.docker-tools-0.9.1.yvx": {
    manifest: manifest(
      "acme",
      "docker-tools",
      "Docker Tools",
      "0.9.1",
      commandOf("acme.docker-tools.status", "Show Status", "Docker Tools"),
    ),
    code: greeter("acme.docker-tools.status", "Docker Tools: no containers"),
  },
  "packages/acme.midnight-theme-1.0.0.yvx": {
    manifest: manifest("acme", "midnight-theme", "Midnight Settings", "1.0.0", {
      contributes: {
        configuration: {
          properties: {
            "acme.midnight-theme.contrast": {
              type: "enum",
              enum: ["normal", "high"],
              default: "normal",
              description: "Contrast.",
            },
          },
        },
      },
    }),
  },
  "packages/acme.updater-1.0.0.yvx": {
    manifest: manifest(
      "acme",
      "updater",
      "Updater Demo",
      "1.0.0",
      commandOf("acme.updater.which", "Which Version", "Updater"),
    ),
    code: greeter("acme.updater.which", "Updater 1.0.0"),
  },
  "packages/acme.updater-1.1.0.yvx": {
    manifest: manifest(
      "acme",
      "updater",
      "Updater Demo",
      "1.1.0",
      commandOf("acme.updater.which", "Which Version", "Updater"),
    ),
    code: greeter("acme.updater.which", "Updater 1.1.0"),
  },
  "packages/acme.quiet-1.0.0.yvx": {
    manifest: manifest(
      "acme",
      "quiet",
      "Quiet Mode",
      "1.0.0",
      commandOf("acme.quiet.toggle", "Toggle", "Quiet Mode"),
    ),
    code: greeter("acme.quiet.toggle", "Quiet Mode toggled"),
  },
  "packages/acme.verbose-2.0.0.yvx": {
    manifest: manifest(
      "acme",
      "verbose",
      "Verbose Docs",
      "2.0.0",
      commandOf("acme.verbose.hello", "Hello", "Verbose Docs"),
    ),
    code: greeter("acme.verbose.hello", "Verbose hello"),
  },
  "packages/acme.no-icon-1.0.0.yvx": {
    manifest: manifest(
      "acme",
      "no-icon",
      "No Icon",
      "1.0.0",
      commandOf("acme.no-icon.run", "Run", "No Icon"),
    ),
    code: greeter("acme.no-icon.run", "No Icon ran"),
  },
  "packages/acme.quiet-addon-1.0.0.yvx": {
    manifest: manifest("acme", "quiet-addon", "Quiet Addon", "1.0.0", {
      ...commandOf("acme.quiet-addon.go", "Go", "Quiet Addon"),
      extensionDependencies: ["acme.quiet"],
    }),
    code: greeter("acme.quiet-addon.go", "Quiet Addon went"),
  },
  "packages/acme.broken-package-1.0.0.yvx": {
    manifest: manifest("acme", "broken-package", "Broken Package", "1.0.0"),
    broken: "unsafe",
  },
  "packages/acme.missing-package-1.0.0.yvx": {
    manifest: manifest("acme", "missing-package", "Missing Package", "1.0.0"),
    broken: "missing",
  },
  "packages/acme.future-tools-3.0.0.yvx": {
    manifest: manifest("acme", "future-tools", "Future Tools", "3.0.0", {
      engines: { yavin: "^3.0.0" },
    }),
  },
};

const LONG = Array.from(
  { length: 60 },
  (_, i) =>
    `Paragraph ${i + 1}: Verbose Docs explains everything in great detail, at length, so the details page has to scroll.`,
).join("\n\n");

/** The index, as a registry would publish it. Hello World is the real sample's identity. */
export function fixtureIndex(helloWorld?: { manifest: Record<string, unknown> }) {
  let n = 0;
  const version = (path: string, v: string, publishedAt: string, yavin = "^2.0.0") => ({
    version: v,
    publishedAt,
    engines: { yavin },
    package: path,
    sha256: HASH(++n),
    size: 1000 + n,
  });
  const entry = (
    id: string,
    displayName: string,
    description: string,
    categories: string[],
    versions: ReturnType<typeof version>[],
    extra: Record<string, unknown> = {},
  ) => {
    const [publisher, name] = id.split(".");
    const pkg = FIXTURE_PACKAGES[versions[0].package];
    const contributes = (pkg?.manifest.contributes ?? {}) as {
      commands?: { command: string; title: string; category?: string }[];
      configuration?: { properties: Record<string, { description: string }> };
    };
    return {
      id,
      publisher,
      name,
      displayName,
      publisherDisplayName: publisher === "acme" ? "Acme Test Co." : "Yavin",
      description,
      categories,
      tags: [],
      icon: `icons/${id}.png`,
      readme: `docs/${id}/README.md`,
      changelog: `docs/${id}/CHANGELOG.md`,
      license: "MIT",
      extensionKind: pkg?.code ? "code" : "declarative",
      contributes: {
        commands: (contributes.commands ?? []).map((c) => ({
          command: c.command,
          title: c.category ? `${c.category}: ${c.title}` : c.title,
        })),
        settings: Object.entries(contributes.configuration?.properties ?? {}).map(([id, s]) => ({
          id,
          description: s.description,
        })),
      },
      versions,
      ...extra,
    };
  };
  if (helloWorld)
    FIXTURE_PACKAGES["packages/yavin-samples.hello-world-2.0.0.yvx"] = {
      manifest: helloWorld.manifest,
    };
  return {
    schema: 1,
    name: "Test Catalog",
    categories: [
      { id: "languages", label: "Languages" },
      { id: "themes", label: "Themes" },
      { id: "productivity", label: "Productivity" },
      { id: "samples", label: "Samples" },
      { id: "other", label: "Other" },
    ],
    recommended: ["acme.docker-tools", "acme.python-tools"],
    extensions: [
      entry(
        "yavin-samples.hello-world",
        "Hello World (sample)",
        "Yavin's sample extension.",
        ["samples"],
        [version("packages/yavin-samples.hello-world-2.0.0.yvx", "2.0.0", "2026-10-06")],
      ),
      entry(
        "acme.python-tools",
        "Python Tools",
        "Python environment checks.",
        ["languages"],
        [version("packages/acme.python-tools-1.2.0.yvx", "1.2.0", "2026-09-01")],
        { tags: ["python"] },
      ),
      entry(
        "acme.docker-tools",
        "Docker Tools",
        "Container status at a glance.",
        ["productivity"],
        [version("packages/acme.docker-tools-0.9.1.yvx", "0.9.1", "2026-09-02")],
        { tags: ["containers", "docker"] },
      ),
      entry(
        "acme.midnight-theme",
        "Midnight Settings",
        "A declarative settings pack.",
        ["themes"],
        [version("packages/acme.midnight-theme-1.0.0.yvx", "1.0.0", "2026-09-03")],
      ),
      entry(
        "acme.future-tools",
        "Future Tools",
        "Needs a newer Yavin.",
        ["other"],
        [version("packages/acme.future-tools-3.0.0.yvx", "3.0.0", "2026-09-04", "^3.0.0")],
      ),
      entry(
        "acme.broken-package",
        "Broken Package",
        "Its package is unsafe.",
        ["other"],
        [version("packages/acme.broken-package-1.0.0.yvx", "1.0.0", "2026-09-05")],
      ),
      entry(
        "acme.missing-package",
        "Missing Package",
        "Its package is not there.",
        ["other"],
        [version("packages/acme.missing-package-1.0.0.yvx", "1.0.0", "2026-09-05")],
      ),
      entry(
        "acme.updater",
        "Updater Demo",
        "Has an update.",
        ["productivity"],
        [
          version("packages/acme.updater-1.1.0.yvx", "1.1.0", "2026-09-07"),
          version("packages/acme.updater-1.0.0.yvx", "1.0.0", "2026-09-06"),
        ],
      ),
      entry(
        "acme.quiet",
        "Quiet Mode",
        "Often installed disabled.",
        ["productivity"],
        [version("packages/acme.quiet-1.0.0.yvx", "1.0.0", "2026-09-08")],
      ),
      entry(
        "acme.verbose",
        "Verbose Docs",
        LONG.slice(0, 480),
        ["other"],
        [version("packages/acme.verbose-2.0.0.yvx", "2.0.0", "2026-09-09")],
      ),
      entry(
        "acme.no-icon",
        "No Icon",
        "Has no icon.",
        ["other"],
        [version("packages/acme.no-icon-1.0.0.yvx", "1.0.0", "2026-09-10")],
        { icon: undefined },
      ),
      entry(
        "acme.quiet-addon",
        "Quiet Addon",
        "Needs Quiet Mode installed.",
        ["productivity"],
        [version("packages/acme.quiet-addon-1.0.0.yvx", "1.0.0", "2026-09-11")],
      ),
    ],
  };
}

export const FIXTURE_DOCUMENTS: Record<string, string> = {
  "docs/acme.verbose/README.md": `# Verbose Docs\n\n${LONG}`,
};

/** A 1x1 PNG, for fixture icons. */
export const FIXTURE_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
