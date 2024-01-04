import * as fs from "fs";
import * as path from "path";

import * as github from "@actions/github";
import test, { ExecutionContext } from "ava";
import * as yaml from "js-yaml";
import * as sinon from "sinon";

import * as api from "./api-client";
import { getCachedCodeQL, PackDownloadOutput, setCodeQL } from "./codeql";
import * as configUtils from "./config-utils";
import { Language } from "./languages";
import { getRunnerLogger } from "./logging";
import { parseRepositoryNwo } from "./repository";
import {
  setupTests,
  mockLanguagesInRepo as mockLanguagesInRepo,
  makeVersionInfo,
} from "./testing-utils";
import {
  GitHubVariant,
  GitHubVersion,
  prettyPrintPack,
  UserError,
  withTmpDir,
} from "./util";

setupTests(test);

const sampleApiDetails = {
  auth: "token",
  externalRepoAuth: "token",
  url: "https://github.example.com",
  apiURL: undefined,
  registriesAuthTokens: undefined,
};

const gitHubVersion = { type: GitHubVariant.DOTCOM } as GitHubVersion;

// Returns the filepath of the newly-created file
function createConfigFile(inputFileContents: string, tmpDir: string): string {
  const configFilePath = path.join(tmpDir, "input");
  fs.writeFileSync(configFilePath, inputFileContents, "utf8");
  return configFilePath;
}

type GetContentsResponse = { content?: string } | Array<{}>;

function mockGetContents(
  content: GetContentsResponse,
): sinon.SinonStub<any, any> {
  // Passing an auth token is required, so we just use a dummy value
  const client = github.getOctokit("123");
  const response = {
    data: content,
  };
  const spyGetContents = sinon
    .stub(client.rest.repos, "getContent")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    .resolves(response as any);
  sinon.stub(api, "getApiClient").value(() => client);
  sinon.stub(api, "getApiClientWithExternalAuth").value(() => client);
  return spyGetContents;
}

function mockListLanguages(languages: string[]) {
  // Passing an auth token is required, so we just use a dummy value
  const client = github.getOctokit("123");
  const response = {
    data: {},
  };
  for (const language of languages) {
    response.data[language] = 123;
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  sinon.stub(client.rest.repos, "listLanguages").resolves(response as any);
  sinon.stub(api, "getApiClient").value(() => client);
}

test("load empty config", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    const logger = getRunnerLogger(true);
    const languages = "javascript,python";

    const codeQL = setCodeQL({
      async resolveQueries() {
        return {
          byLanguage: {
            javascript: { queries: ["query1.ql"] },
            python: { queries: ["query2.ql"] },
          },
          noDeclaredLanguage: {},
          multipleDeclaredLanguages: {},
        };
      },
      async packDownload(): Promise<PackDownloadOutput> {
        return { packs: [] };
      },
    });

    const config = await configUtils.initConfig(
      languages,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      "",
      "",
      { owner: "github", repo: "example" },
      tmpDir,
      codeQL,
      tmpDir,
      gitHubVersion,
      sampleApiDetails,
      logger,
    );

    t.deepEqual(
      config,
      await configUtils.getDefaultConfig(
        languages,
        undefined,
        undefined,
        undefined,
        false,
        false,
        "",
        "",
        { owner: "github", repo: "example" },
        tmpDir,
        codeQL,
        gitHubVersion,
        logger,
      ),
    );
  });
});

test("loading config saves config", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    const logger = getRunnerLogger(true);

    const codeQL = setCodeQL({
      async resolveQueries() {
        return {
          byLanguage: {
            javascript: { queries: ["query1.ql"] },
            python: { queries: ["query2.ql"] },
          },
          noDeclaredLanguage: {},
          multipleDeclaredLanguages: {},
        };
      },
      async packDownload(): Promise<PackDownloadOutput> {
        return { packs: [] };
      },
    });

    // Sanity check the saved config file does not already exist
    t.false(fs.existsSync(configUtils.getPathToParsedConfigFile(tmpDir)));

    // Sanity check that getConfig returns undefined before we have called initConfig
    t.deepEqual(await configUtils.getConfig(tmpDir, logger), undefined);

    const config1 = await configUtils.initConfig(
      "javascript,python",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      "",
      "",
      { owner: "github", repo: "example" },
      tmpDir,
      codeQL,
      tmpDir,
      gitHubVersion,
      sampleApiDetails,
      logger,
    );

    // The saved config file should now exist
    t.true(fs.existsSync(configUtils.getPathToParsedConfigFile(tmpDir)));

    // And that same newly-initialised config should now be returned by getConfig
    const config2 = await configUtils.getConfig(tmpDir, logger);
    t.not(config2, undefined);
    if (config2 !== undefined) {
      // removes properties assigned to undefined.
      const expectedConfig = JSON.parse(JSON.stringify(config1));
      t.deepEqual(expectedConfig, config2);
    }
  });
});

test("load input outside of workspace", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    try {
      await configUtils.initConfig(
        undefined,
        undefined,
        undefined,
        "../input",
        undefined,
        undefined,
        false,
        false,
        "",
        "",
        { owner: "github", repo: "example" },
        tmpDir,
        getCachedCodeQL(),
        tmpDir,
        gitHubVersion,
        sampleApiDetails,
        getRunnerLogger(true),
      );
      throw new Error("initConfig did not throw error");
    } catch (err) {
      t.deepEqual(
        err,
        new UserError(
          configUtils.getConfigFileOutsideWorkspaceErrorMessage(
            path.join(tmpDir, "../input"),
          ),
        ),
      );
    }
  });
});

test("load non-local input with invalid repo syntax", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    // no filename given, just a repo
    const configFile = "octo-org/codeql-config@main";

    try {
      await configUtils.initConfig(
        undefined,
        undefined,
        undefined,
        configFile,
        undefined,
        undefined,
        false,
        false,
        "",
        "",
        { owner: "github", repo: "example" },
        tmpDir,
        getCachedCodeQL(),
        tmpDir,
        gitHubVersion,
        sampleApiDetails,
        getRunnerLogger(true),
      );
      throw new Error("initConfig did not throw error");
    } catch (err) {
      t.deepEqual(
        err,
        new UserError(
          configUtils.getConfigFileRepoFormatInvalidMessage(
            "octo-org/codeql-config@main",
          ),
        ),
      );
    }
  });
});

test("load non-existent input", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    const languages = "javascript";
    const configFile = "input";
    t.false(fs.existsSync(path.join(tmpDir, configFile)));

    try {
      await configUtils.initConfig(
        languages,
        undefined,
        undefined,
        configFile,
        undefined,
        undefined,
        false,
        false,
        "",
        "",
        { owner: "github", repo: "example" },
        tmpDir,
        getCachedCodeQL(),
        tmpDir,
        gitHubVersion,
        sampleApiDetails,
        getRunnerLogger(true),
      );
      throw new Error("initConfig did not throw error");
    } catch (err) {
      t.deepEqual(
        err,
        new UserError(
          configUtils.getConfigFileDoesNotExistErrorMessage(
            path.join(tmpDir, "input"),
          ),
        ),
      );
    }
  });
});

test("load non-empty input", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    const codeQL = setCodeQL({
      async resolveQueries() {
        return {
          byLanguage: {
            javascript: {
              "/foo/a.ql": {},
              "/bar/b.ql": {},
            },
          },
          noDeclaredLanguage: {},
          multipleDeclaredLanguages: {},
        };
      },
      async packDownload(): Promise<PackDownloadOutput> {
        return { packs: [] };
      },
    });

    // Just create a generic config object with non-default values for all fields
    const inputFileContents = `
      name: my config
      disable-default-queries: true
      queries:
        - uses: ./foo
      paths-ignore:
        - a
        - b
      paths:
        - c/d`;

    fs.mkdirSync(path.join(tmpDir, "foo"));

    // And the config we expect it to parse to
    const expectedConfig: configUtils.Config = {
      languages: [Language.javascript],
      originalUserInput: {
        name: "my config",
        "disable-default-queries": true,
        queries: [{ uses: "./foo" }],
        "paths-ignore": ["a", "b"],
        paths: ["c/d"],
      },
      tempDir: tmpDir,
      codeQLCmd: codeQL.getPath(),
      gitHubVersion,
      dbLocation: path.resolve(tmpDir, "codeql_databases"),
      debugMode: false,
      debugArtifactName: "my-artifact",
      debugDatabaseName: "my-db",
      augmentationProperties: configUtils.defaultAugmentationProperties,
      trapCaches: {},
      trapCacheDownloadTime: 0,
    };

    const languages = "javascript";
    const configFilePath = createConfigFile(inputFileContents, tmpDir);

    const actualConfig = await configUtils.initConfig(
      languages,
      undefined,
      undefined,
      configFilePath,
      undefined,
      undefined,
      false,
      false,
      "my-artifact",
      "my-db",
      { owner: "github", repo: "example" },
      tmpDir,
      codeQL,
      tmpDir,
      gitHubVersion,
      sampleApiDetails,
      getRunnerLogger(true),
    );

    // Should exactly equal the object we constructed earlier
    t.deepEqual(actualConfig, expectedConfig);
  });
});

/**
 * Returns the provided queries, just in the right format for a resolved query
 * This way we can test by seeing which returned items are in the final
 * configuration.
 */
function queriesToResolvedQueryForm(queries: string[]) {
  const dummyResolvedQueries = {};
  for (const q of queries) {
    dummyResolvedQueries[q] = {};
  }
  return {
    byLanguage: {
      javascript: dummyResolvedQueries,
    },
    noDeclaredLanguage: {},
    multipleDeclaredLanguages: {},
  };
}

test("Using config input and file together, config input should be used.", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    process.env["RUNNER_TEMP"] = tmpDir;
    process.env["GITHUB_WORKSPACE"] = tmpDir;

    const inputFileContents = `
      name: my config
      queries:
        - uses: ./foo_file`;
    const configFilePath = createConfigFile(inputFileContents, tmpDir);

    const configInput = `
      name: my config
      queries:
        - uses: ./foo
      packs:
        javascript:
          - a/b@1.2.3
        python:
          - c/d@1.2.3
    `;

    fs.mkdirSync(path.join(tmpDir, "foo"));

    const resolveQueriesArgs: Array<{
      queries: string[];
      extraSearchPath: string | undefined;
    }> = [];
    const codeQL = setCodeQL({
      async resolveQueries(
        queries: string[],
        extraSearchPath: string | undefined,
      ) {
        resolveQueriesArgs.push({ queries, extraSearchPath });
        return queriesToResolvedQueryForm(queries);
      },
      async packDownload(): Promise<PackDownloadOutput> {
        return { packs: [] };
      },
    });

    // Only JS, python packs will be ignored
    const languages = "javascript";

    const config = await configUtils.initConfig(
      languages,
      undefined,
      undefined,
      undefined,
      configFilePath,
      configInput,
      false,
      false,
      "",
      "",
      { owner: "github", repo: "example" },
      tmpDir,
      codeQL,
      tmpDir,
      gitHubVersion,
      sampleApiDetails,
      getRunnerLogger(true),
    );

    t.deepEqual(config.originalUserInput, yaml.load(configInput));
  });
});

test("API client used when reading remote config", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    const codeQL = setCodeQL({
      async resolveQueries() {
        return {
          byLanguage: {
            javascript: {
              "foo.ql": {},
            },
          },
          noDeclaredLanguage: {},
          multipleDeclaredLanguages: {},
        };
      },
      async packDownload(): Promise<PackDownloadOutput> {
        return { packs: [] };
      },
    });

    const inputFileContents = `
      name: my config
      disable-default-queries: true
      queries:
        - uses: ./
        - uses: ./foo
        - uses: foo/bar@dev
      paths-ignore:
        - a
        - b
      paths:
        - c/d`;
    const dummyResponse = {
      content: Buffer.from(inputFileContents).toString("base64"),
    };
    const spyGetContents = mockGetContents(dummyResponse);

    // Create checkout directory for remote queries repository
    fs.mkdirSync(path.join(tmpDir, "foo/bar/dev"), { recursive: true });

    const configFile = "octo-org/codeql-config/config.yaml@main";
    const languages = "javascript";

    await configUtils.initConfig(
      languages,
      undefined,
      undefined,
      configFile,
      undefined,
      undefined,
      false,
      false,
      "",
      "",
      { owner: "github", repo: "example" },
      tmpDir,
      codeQL,
      tmpDir,
      gitHubVersion,
      sampleApiDetails,
      getRunnerLogger(true),
    );
    t.assert(spyGetContents.called);
  });
});

test("Remote config handles the case where a directory is provided", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    const dummyResponse = []; // directories are returned as arrays
    mockGetContents(dummyResponse);

    const repoReference = "octo-org/codeql-config/config.yaml@main";
    try {
      await configUtils.initConfig(
        undefined,
        undefined,
        undefined,
        repoReference,
        undefined,
        undefined,
        false,
        false,
        "",
        "",
        { owner: "github", repo: "example" },
        tmpDir,
        getCachedCodeQL(),
        tmpDir,
        gitHubVersion,
        sampleApiDetails,
        getRunnerLogger(true),
      );
      throw new Error("initConfig did not throw error");
    } catch (err) {
      t.deepEqual(
        err,
        new UserError(
          configUtils.getConfigFileDirectoryGivenMessage(repoReference),
        ),
      );
    }
  });
});

test("Invalid format of remote config handled correctly", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    const dummyResponse = {
      // note no "content" property here
    };
    mockGetContents(dummyResponse);

    const repoReference = "octo-org/codeql-config/config.yaml@main";
    try {
      await configUtils.initConfig(
        undefined,
        undefined,
        undefined,
        repoReference,
        undefined,
        undefined,
        false,
        false,
        "",
        "",
        { owner: "github", repo: "example" },
        tmpDir,
        getCachedCodeQL(),
        tmpDir,
        gitHubVersion,
        sampleApiDetails,
        getRunnerLogger(true),
      );
      throw new Error("initConfig did not throw error");
    } catch (err) {
      t.deepEqual(
        err,
        new UserError(
          configUtils.getConfigFileFormatInvalidMessage(repoReference),
        ),
      );
    }
  });
});

test("No detected languages", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    mockListLanguages([]);
    const codeQL = setCodeQL({
      async resolveLanguages() {
        return {};
      },
      async packDownload(): Promise<PackDownloadOutput> {
        return { packs: [] };
      },
    });

    try {
      await configUtils.initConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        false,
        "",
        "",
        { owner: "github", repo: "example" },
        tmpDir,
        codeQL,
        tmpDir,
        gitHubVersion,
        sampleApiDetails,
        getRunnerLogger(true),
      );
      throw new Error("initConfig did not throw error");
    } catch (err) {
      t.deepEqual(err, new UserError(configUtils.getNoLanguagesError()));
    }
  });
});

test("Unknown languages", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    const languages = "rubbish,english";

    try {
      await configUtils.initConfig(
        languages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        false,
        "",
        "",
        { owner: "github", repo: "example" },
        tmpDir,
        getCachedCodeQL(),
        tmpDir,
        gitHubVersion,
        sampleApiDetails,
        getRunnerLogger(true),
      );
      throw new Error("initConfig did not throw error");
    } catch (err) {
      t.deepEqual(
        err,
        new UserError(
          configUtils.getUnknownLanguagesError(["rubbish", "english"]),
        ),
      );
    }
  });
});

/**
 * Test macro for ensuring the packs block is valid
 */
const parsePacksMacro = test.macro({
  exec: (
    t: ExecutionContext<unknown>,
    packsInput: string,
    languages: Language[],
    expected: configUtils.Packs | undefined,
  ) =>
    t.deepEqual(
      configUtils.parsePacksFromInput(packsInput, languages, false),
      expected,
    ),

  title: (providedTitle = "") => `Parse Packs: ${providedTitle}`,
});

/**
 * Test macro for testing when the packs block is invalid
 */
const parsePacksErrorMacro = test.macro({
  exec: (
    t: ExecutionContext<unknown>,
    packsInput: string,
    languages: Language[],
    expected: RegExp,
  ) =>
    t.throws(
      () => configUtils.parsePacksFromInput(packsInput, languages, false),
      {
        message: expected,
      },
    ),
  title: (providedTitle = "") => `Parse Packs Error: ${providedTitle}`,
});

/**
 * Test macro for testing when the packs block is invalid
 */
const invalidPackNameMacro = test.macro({
  exec: (t: ExecutionContext, name: string) =>
    parsePacksErrorMacro.exec(
      t,
      name,
      [Language.cpp],
      new RegExp(`^"${name}" is not a valid pack$`),
    ),
  title: (_providedTitle: string | undefined, arg: string | undefined) =>
    `Invalid pack string: ${arg}`,
});

test("no packs", parsePacksMacro, "", [], undefined);
test("two packs", parsePacksMacro, "a/b,c/d@1.2.3", [Language.cpp], {
  [Language.cpp]: ["a/b", "c/d@1.2.3"],
});
test(
  "two packs with spaces",
  parsePacksMacro,
  " a/b , c/d@1.2.3 ",
  [Language.cpp],
  {
    [Language.cpp]: ["a/b", "c/d@1.2.3"],
  },
);
test(
  "two packs with language",
  parsePacksErrorMacro,
  "a/b,c/d@1.2.3",
  [Language.cpp, Language.java],
  new RegExp(
    "Cannot specify a 'packs' input in a multi-language analysis. " +
      "Use a codeql-config.yml file instead and specify packs by language.",
  ),
);

test(
  "packs with other valid names",
  parsePacksMacro,
  [
    // ranges are ok
    "c/d@1.0",
    "c/d@~1.0.0",
    "c/d@~1.0.0:a/b",
    "c/d@~1.0.0+abc:a/b",
    "c/d@~1.0.0-abc:a/b",
    "c/d:a/b",
    // whitespace is removed
    " c/d      @     ~1.0.0    :    b.qls   ",
    // and it is retained within a path
    " c/d      @     ~1.0.0    :    b/a path with/spaces.qls   ",
    // this is valid. the path is '@'. It will probably fail when passed to the CLI
    "c/d@1.2.3:@",
    // this is valid, too. It will fail if it doesn't match a path
    // (globbing is not done)
    "c/d@1.2.3:+*)_(",
  ].join(","),
  [Language.cpp],
  {
    [Language.cpp]: [
      "c/d@1.0",
      "c/d@~1.0.0",
      "c/d@~1.0.0:a/b",
      "c/d@~1.0.0+abc:a/b",
      "c/d@~1.0.0-abc:a/b",
      "c/d:a/b",
      "c/d@~1.0.0:b.qls",
      "c/d@~1.0.0:b/a path with/spaces.qls",
      "c/d@1.2.3:@",
      "c/d@1.2.3:+*)_(",
    ],
  },
);

test(invalidPackNameMacro, "c"); // all packs require at least a scope and a name
test(invalidPackNameMacro, "c-/d");
test(invalidPackNameMacro, "-c/d");
test(invalidPackNameMacro, "c/d_d");
test(invalidPackNameMacro, "c/d@@");
test(invalidPackNameMacro, "c/d@1.0.0:");
test(invalidPackNameMacro, "c/d:");
test(invalidPackNameMacro, "c/d:/a");
test(invalidPackNameMacro, "@1.0.0:a");
test(invalidPackNameMacro, "c/d@../a");
test(invalidPackNameMacro, "c/d@b/../a");
test(invalidPackNameMacro, "c/d:z@1");

/**
 * Test macro for pretty printing pack specs
 */
const packSpecPrettyPrintingMacro = test.macro({
  exec: (t: ExecutionContext, packStr: string, packObj: configUtils.Pack) => {
    const parsed = configUtils.parsePacksSpecification(packStr);
    t.deepEqual(parsed, packObj, "parsed pack spec is correct");
    const stringified = prettyPrintPack(packObj);
    t.deepEqual(
      stringified,
      packStr.trim(),
      "pretty-printed pack spec is correct",
    );

    t.deepEqual(
      configUtils.validatePackSpecification(packStr),
      packStr.trim(),
      "pack spec is valid",
    );
  },
  title: (
    _providedTitle: string | undefined,
    packStr: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _packObj: configUtils.Pack,
  ) => `Prettyprint pack spec: '${packStr}'`,
});

test(packSpecPrettyPrintingMacro, "a/b", {
  name: "a/b",
  version: undefined,
  path: undefined,
});
test(packSpecPrettyPrintingMacro, "a/b@~1.2.3", {
  name: "a/b",
  version: "~1.2.3",
  path: undefined,
});
test(packSpecPrettyPrintingMacro, "a/b@~1.2.3:abc/def", {
  name: "a/b",
  version: "~1.2.3",
  path: "abc/def",
});
test(packSpecPrettyPrintingMacro, "a/b:abc/def", {
  name: "a/b",
  version: undefined,
  path: "abc/def",
});
test(packSpecPrettyPrintingMacro, "    a/b:abc/def    ", {
  name: "a/b",
  version: undefined,
  path: "abc/def",
});

const mockLogger = getRunnerLogger(true);

const calculateAugmentationMacro = test.macro({
  exec: async (
    t: ExecutionContext,
    _title: string,
    rawPacksInput: string | undefined,
    rawQueriesInput: string | undefined,
    languages: Language[],
    expectedAugmentationProperties: configUtils.AugmentationProperties,
  ) => {
    const actualAugmentationProperties = configUtils.calculateAugmentation(
      rawPacksInput,
      rawQueriesInput,
      languages,
    );
    t.deepEqual(actualAugmentationProperties, expectedAugmentationProperties);
  },
  title: (_, title) => `Calculate Augmentation: ${title}`,
});

test(
  calculateAugmentationMacro,
  "All empty",
  undefined,
  undefined,
  [Language.javascript],
  {
    queriesInputCombines: false,
    queriesInput: undefined,
    packsInputCombines: false,
    packsInput: undefined,
  } as configUtils.AugmentationProperties,
);

test(
  calculateAugmentationMacro,
  "With queries",
  undefined,
  " a, b , c, d",
  [Language.javascript],
  {
    queriesInputCombines: false,
    queriesInput: [{ uses: "a" }, { uses: "b" }, { uses: "c" }, { uses: "d" }],
    packsInputCombines: false,
    packsInput: undefined,
  } as configUtils.AugmentationProperties,
);

test(
  calculateAugmentationMacro,
  "With queries combining",
  undefined,
  "   +   a, b , c, d ",
  [Language.javascript],
  {
    queriesInputCombines: true,
    queriesInput: [{ uses: "a" }, { uses: "b" }, { uses: "c" }, { uses: "d" }],
    packsInputCombines: false,
    packsInput: undefined,
  } as configUtils.AugmentationProperties,
);

test(
  calculateAugmentationMacro,
  "With packs",
  "   codeql/a , codeql/b   , codeql/c  , codeql/d  ",
  undefined,
  [Language.javascript],
  {
    queriesInputCombines: false,
    queriesInput: undefined,
    packsInputCombines: false,
    packsInput: ["codeql/a", "codeql/b", "codeql/c", "codeql/d"],
  } as configUtils.AugmentationProperties,
);

test(
  calculateAugmentationMacro,
  "With packs combining",
  "   +   codeql/a, codeql/b, codeql/c, codeql/d",
  undefined,
  [Language.javascript],
  {
    queriesInputCombines: false,
    queriesInput: undefined,
    packsInputCombines: true,
    packsInput: ["codeql/a", "codeql/b", "codeql/c", "codeql/d"],
  } as configUtils.AugmentationProperties,
);

const calculateAugmentationErrorMacro = test.macro({
  exec: async (
    t: ExecutionContext,
    _title: string,
    rawPacksInput: string | undefined,
    rawQueriesInput: string | undefined,
    languages: Language[],
    expectedError: RegExp | string,
  ) => {
    t.throws(
      () =>
        configUtils.calculateAugmentation(
          rawPacksInput,
          rawQueriesInput,
          languages,
        ),
      { message: expectedError },
    );
  },
  title: (_, title) => `Calculate Augmentation Error: ${title}`,
});

test(
  calculateAugmentationErrorMacro,
  "Plus (+) with nothing else (queries)",
  undefined,
  "   +   ",
  [Language.javascript],
  /The workflow property "queries" is invalid/,
);

test(
  calculateAugmentationErrorMacro,
  "Plus (+) with nothing else (packs)",
  "   +   ",
  undefined,
  [Language.javascript],
  /The workflow property "packs" is invalid/,
);

test(
  calculateAugmentationErrorMacro,
  "Packs input with multiple languages",
  "   +  a/b, c/d ",
  undefined,
  [Language.javascript, Language.java],
  /Cannot specify a 'packs' input in a multi-language analysis/,
);

test(
  calculateAugmentationErrorMacro,
  "Packs input with no languages",
  "   +  a/b, c/d ",
  undefined,
  [],
  /No languages specified/,
);

test(
  calculateAugmentationErrorMacro,
  "Invalid packs",
  " a-pack-without-a-scope ",
  undefined,
  [Language.javascript],
  /"a-pack-without-a-scope" is not a valid pack/,
);

test("downloadPacks-no-registries", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    const packDownloadStub = sinon.stub();
    packDownloadStub.callsFake((packs) => ({
      packs,
    }));
    const codeQL = setCodeQL({
      packDownload: packDownloadStub,
    });
    const logger = getRunnerLogger(true);

    // packs are supplied for go, java, and python
    // analyzed languages are java, javascript, and python
    await configUtils.downloadPacks(
      codeQL,
      [Language.javascript, Language.java, Language.python],
      {
        java: ["a", "b"],
        go: ["c", "d"],
        python: ["e", "f"],
      },
      sampleApiDetails,
      undefined, // registriesAuthTokens
      tmpDir,
      logger,
    );

    // Expecting packs to be downloaded once for java and once for python
    t.deepEqual(packDownloadStub.callCount, 2);
    // no config file was created, so pass `undefined` as the config file path
    t.deepEqual(packDownloadStub.firstCall.args, [["a", "b"], undefined]);
    t.deepEqual(packDownloadStub.secondCall.args, [["e", "f"], undefined]);
  });
});

test("downloadPacks-with-registries", async (t) => {
  // same thing, but this time include a registries block and
  // associated env vars
  return await withTmpDir(async (tmpDir) => {
    process.env.GITHUB_TOKEN = "not-a-token";
    process.env.CODEQL_REGISTRIES_AUTH = undefined;
    const logger = getRunnerLogger(true);

    const registriesInput = yaml.dump([
      {
        // no slash
        url: "http://ghcr.io",
        packages: ["codeql/*", "codeql-testing/*"],
        token: "not-a-token",
      },
      {
        // with slash
        url: "https://containers.GHEHOSTNAME1/v2/",
        packages: "semmle/*",
        token: "still-not-a-token",
      },
    ]);

    // append a slash to the first url
    const registries = yaml.load(
      registriesInput,
    ) as configUtils.RegistryConfigWithCredentials[];
    const expectedRegistries = registries.map((r, i) => ({
      packages: r.packages,
      url: i === 0 ? `${r.url}/` : r.url,
    }));

    const expectedConfigFile = path.join(tmpDir, "qlconfig.yml");
    const packDownloadStub = sinon.stub();
    packDownloadStub.callsFake((packs, configFile: string) => {
      t.deepEqual(configFile, expectedConfigFile);
      // verify the env vars were set correctly
      t.deepEqual(process.env.GITHUB_TOKEN, sampleApiDetails.auth);
      t.deepEqual(
        process.env.CODEQL_REGISTRIES_AUTH,
        "http://ghcr.io=not-a-token,https://containers.GHEHOSTNAME1/v2/=still-not-a-token",
      );

      // verify the config file contents were set correctly
      const config = yaml.load(fs.readFileSync(configFile, "utf8")) as {
        registries: configUtils.RegistryConfigNoCredentials[];
      };
      t.deepEqual(config.registries, expectedRegistries);
      return {
        packs,
      };
    });

    const codeQL = setCodeQL({
      packDownload: packDownloadStub,
      getVersion: () => Promise.resolve(makeVersionInfo("2.10.5")),
    });

    // packs are supplied for go, java, and python
    // analyzed languages are java, javascript, and python
    await configUtils.downloadPacks(
      codeQL,
      [Language.javascript, Language.java, Language.python],
      {
        java: ["a", "b"],
        go: ["c", "d"],
        python: ["e", "f"],
      },
      sampleApiDetails,
      registriesInput,
      tmpDir,
      logger,
    );

    // Same packs are downloaded as in previous test
    t.deepEqual(packDownloadStub.callCount, 2);
    t.deepEqual(packDownloadStub.firstCall.args, [
      ["a", "b"],
      expectedConfigFile,
    ]);
    t.deepEqual(packDownloadStub.secondCall.args, [
      ["e", "f"],
      expectedConfigFile,
    ]);

    // Verify that the env vars were unset.
    t.deepEqual(process.env.GITHUB_TOKEN, "not-a-token");
    t.deepEqual(process.env.CODEQL_REGISTRIES_AUTH, undefined);
  });
});

test("downloadPacks-with-registries fails with invalid registries block", async (t) => {
  // same thing, but this time include a registries block and
  // associated env vars
  return await withTmpDir(async (tmpDir) => {
    process.env.GITHUB_TOKEN = "not-a-token";
    process.env.CODEQL_REGISTRIES_AUTH = "not-a-registries-auth";
    const logger = getRunnerLogger(true);

    const registriesInput = yaml.dump([
      {
        // missing url property
        packages: ["codeql/*", "codeql-testing/*"],
        token: "not-a-token",
      },
      {
        url: "https://containers.GHEHOSTNAME1/v2/",
        packages: "semmle/*",
        token: "still-not-a-token",
      },
    ]);

    const codeQL = setCodeQL({
      getVersion: () => Promise.resolve(makeVersionInfo("2.10.4")),
    });
    await t.throwsAsync(
      async () => {
        return await configUtils.downloadPacks(
          codeQL,
          [Language.javascript, Language.java, Language.python],
          {},
          sampleApiDetails,
          registriesInput,
          tmpDir,
          logger,
        );
      },
      { instanceOf: Error },
      "Invalid 'registries' input. Must be an array of objects with 'url' and 'packages' properties.",
    );
  });
});

test("no generateRegistries when registries is undefined", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    const registriesInput = undefined;
    const logger = getRunnerLogger(true);
    const { registriesAuthTokens, qlconfigFile } =
      await configUtils.generateRegistries(registriesInput, tmpDir, logger);

    t.is(registriesAuthTokens, undefined);
    t.is(qlconfigFile, undefined);
  });
});

test("generateRegistries prefers original CODEQL_REGISTRIES_AUTH", async (t) => {
  return await withTmpDir(async (tmpDir) => {
    process.env.CODEQL_REGISTRIES_AUTH = "original";
    const registriesInput = yaml.dump([
      {
        url: "http://ghcr.io",
        packages: ["codeql/*", "codeql-testing/*"],
        token: "not-a-token",
      },
    ]);
    const logger = getRunnerLogger(true);
    const { registriesAuthTokens, qlconfigFile } =
      await configUtils.generateRegistries(registriesInput, tmpDir, logger);

    t.is(registriesAuthTokens, "original");
    t.is(qlconfigFile, path.join(tmpDir, "qlconfig.yml"));
  });
});

// getLanguages

const mockRepositoryNwo = parseRepositoryNwo("owner/repo");
// eslint-disable-next-line github/array-foreach
[
  {
    name: "languages from input",
    codeqlResolvedLanguages: ["javascript", "java", "python"],
    languagesInput: "jAvAscript, \n jaVa",
    languagesInRepository: ["SwiFt", "other"],
    expectedLanguages: ["javascript", "java"],
    expectedApiCall: false,
  },
  {
    name: "languages from github api",
    codeqlResolvedLanguages: ["javascript", "java", "python"],
    languagesInput: "",
    languagesInRepository: ["  jAvAscript\n \t", " jaVa", "SwiFt", "other"],
    expectedLanguages: ["javascript", "java"],
    expectedApiCall: true,
  },
  {
    name: "aliases from input",
    codeqlResolvedLanguages: ["javascript", "csharp", "cpp", "java", "python"],
    languagesInput: "  typEscript\n \t, C#, c , KoTlin",
    languagesInRepository: ["SwiFt", "other"],
    expectedLanguages: ["javascript", "csharp", "cpp", "java"],
    expectedApiCall: false,
  },
  {
    name: "duplicate languages from input",
    codeqlResolvedLanguages: ["javascript", "java", "python"],
    languagesInput: "jAvAscript, \n jaVa, kotlin, typescript",
    languagesInRepository: ["SwiFt", "other"],
    expectedLanguages: ["javascript", "java"],
    expectedApiCall: false,
  },
  {
    name: "aliases from github api",
    codeqlResolvedLanguages: ["javascript", "csharp", "cpp", "java", "python"],
    languagesInput: "",
    languagesInRepository: ["  typEscript\n \t", " C#", "c", "other"],
    expectedLanguages: ["javascript", "csharp", "cpp"],
    expectedApiCall: true,
  },
  {
    name: "no languages",
    codeqlResolvedLanguages: ["javascript", "java", "python"],
    languagesInput: "",
    languagesInRepository: [],
    expectedApiCall: true,
    expectedError: configUtils.getNoLanguagesError(),
  },
  {
    name: "unrecognized languages from input",
    codeqlResolvedLanguages: ["javascript", "java", "python"],
    languagesInput: "a, b, c, javascript",
    languagesInRepository: [],
    expectedApiCall: false,
    expectedError: configUtils.getUnknownLanguagesError(["a", "b"]),
  },
].forEach((args) => {
  test(`getLanguages: ${args.name}`, async (t) => {
    const mockRequest = mockLanguagesInRepo(args.languagesInRepository);
    const languages = args.codeqlResolvedLanguages.reduce(
      (acc, lang) => ({
        ...acc,
        [lang]: true,
      }),
      {},
    );
    const codeQL = setCodeQL({
      resolveLanguages: () => Promise.resolve(languages),
    });

    if (args.expectedLanguages) {
      // happy path
      const actualLanguages = await configUtils.getLanguages(
        codeQL,
        args.languagesInput,
        mockRepositoryNwo,
        mockLogger,
      );

      t.deepEqual(actualLanguages.sort(), args.expectedLanguages.sort());
    } else {
      // there is an error
      await t.throwsAsync(
        async () =>
          await configUtils.getLanguages(
            codeQL,
            args.languagesInput,
            mockRepositoryNwo,
            mockLogger,
          ),
        { message: args.expectedError },
      );
    }
    t.deepEqual(mockRequest.called, args.expectedApiCall);
  });
});
