import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { cac } from 'cac';

import type { CommandOptions, RunOptions } from './types';
import {
  bisectRstest,
  buildRstest,
  ignorePrecoded,
  parseMajorVersion,
  parseRstestMajor,
  setupEnvironment,
  setupRstestRepo,
} from './utils';

const cli = cac();
cli
  .command('[...suites]', 'build rstest and run selected suites')
  .option('--verify', 'verify checkouts by running tests', { default: false })
  .option('--repo <repo>', 'rstest repository to use', {
    default: 'web-infra-dev/rstest',
  })
  .option('--branch <branch>', 'rstest branch to use', { default: 'main' })
  .option('--tag <tag>', 'rstest tag to use')
  .option('--commit <commit>', 'rstest commit sha to use')
  .option('--release <version>', 'rstest release to use from npm registry')
  .option('--suite-precoded', 'use precoded suite options under tests dir')
  .option('--suite-branch <branch>', 'suite branch to use')
  .option('--suite-tag <tag>', 'suite tag to use')
  .option('--suite-commit <commit>', 'suite commit sha to use')
  .action(async (suites, options: CommandOptions) => {
    const { root, rstestPath, workspace } = await setupEnvironment();
    const suitesToRun = getSuitesToRun(suites, root);
    let rstestMajor: number;
    if (!options.release) {
      await setupRstestRepo(options);
      await buildRstest({ verify: options.verify });
      rstestMajor = parseRstestMajor(rstestPath);
    } else {
      rstestMajor = parseMajorVersion(options.release);
    }
    const runOptions: RunOptions = {
      root,
      rstestPath,
      rstestMajor,
      workspace,
      release: options.release,
      verify: options.verify,
      skipGit: false,
      suiteBranch: ignorePrecoded(options.suiteBranch),
      suiteTag: ignorePrecoded(options.suiteTag),
      suiteCommit: ignorePrecoded(options.suiteCommit),
    };
    for (const suite of suitesToRun) {
      await run(suite, runOptions);
    }
  });

cli
  .command('build-rstest', 'build rstest only')
  .option('--verify', 'verify rstest checkout by running tests', {
    default: false,
  })
  .option('--repo <repo>', 'rstest repository to use', {
    default: 'web-infra-dev/rstest',
  })
  .option('--branch <branch>', 'rstest branch to use', { default: 'main' })
  .option('--tag <tag>', 'rstest tag to use')
  .option('--commit <commit>', 'rstest commit sha to use')
  .action(async (options: CommandOptions) => {
    await setupEnvironment();
    await setupRstestRepo(options);
    await buildRstest({ verify: options.verify });
  });

cli
  .command('run-suites [...suites]', 'run single suite with pre-built rstest')
  .option(
    '--verify',
    'verify checkout by running tests before using local rstest',
    { default: false },
  )
  .option('--repo <repo>', 'rstest repository to use', {
    default: 'web-infra-dev/rstest',
  })
  .option('--release <version>', 'rstest release to use from npm registry')
  .option('--suite-precoded', 'use precoded suite options under tests dir')
  .option('--suite-branch <branch>', 'suite branch to use')
  .option('--suite-tag <tag>', 'suite tag to use')
  .option('--suite-commit <commit>', 'suite commit sha to use')
  .action(async (suites, options: CommandOptions) => {
    const { root, rstestPath, workspace } = await setupEnvironment();
    const suitesToRun = getSuitesToRun(suites, root);
    const runOptions: RunOptions = {
      ...options,
      root,
      rstestPath,
      rstestMajor: parseRstestMajor(rstestPath),
      workspace,
      suiteBranch: ignorePrecoded(options.suiteBranch),
      suiteTag: ignorePrecoded(options.suiteTag),
      suiteCommit: ignorePrecoded(options.suiteCommit),
    };
    for (const suite of suitesToRun) {
      await run(suite, runOptions);
    }
  });

cli
  .command(
    'bisect [...suites]',
    'use git bisect to find a commit in rstest that broke suites',
  )
  .option('--good <ref>', 'last known good ref, e.g. a previous tag. REQUIRED!')
  .option('--verify', 'verify checkouts by running tests', { default: false })
  .option('--repo <repo>', 'rstest repository to use', {
    default: 'web-infra-dev/rstest',
  })
  .option('--branch <branch>', 'rstest branch to use', { default: 'main' })
  .option('--tag <tag>', 'rstest tag to use')
  .option('--commit <commit>', 'rstest commit sha to use')
  .option('--suite-precoded', 'use precoded suite options under tests dir')
  .option('--suite-branch <branch>', 'suite branch to use')
  .option('--suite-tag <tag>', 'suite tag to use')
  .option('--suite-commit <commit>', 'suite commit sha to use')
  .action(async (suites, options: CommandOptions & { good: string }) => {
    if (!options.good) {
      console.log(
        'you have to specify a known good version with `--good <commit|tag>`',
      );
      process.exit(1);
    }
    const { root, rstestPath, workspace } = await setupEnvironment();
    const suitesToRun = getSuitesToRun(suites, root);
    let isFirstRun = true;
    const { verify } = options;
    const runSuite = async () => {
      try {
        await buildRstest({ verify: isFirstRun && verify });
        for (const suite of suitesToRun) {
          await run(suite, {
            verify: !!(isFirstRun && verify),
            skipGit: !isFirstRun,
            root,
            rstestPath,
            rstestMajor: parseRstestMajor(rstestPath),
            workspace,
            suiteBranch: ignorePrecoded(options.suiteBranch),
            suiteTag: ignorePrecoded(options.suiteTag),
            suiteCommit: ignorePrecoded(options.suiteCommit),
          });
        }
        isFirstRun = false;
        return null;
      } catch (e) {
        return e;
      }
    };
    await setupRstestRepo({ ...options, shallow: false });
    const initialError = await runSuite();
    if (initialError) {
      await bisectRstest(options.good, runSuite);
    } else {
      console.log('no errors for starting commit, cannot bisect');
    }
  });
cli.help();
cli.parse();

async function run(suite: string, options: RunOptions) {
  const { test } = await import(`./tests/${suite}.ts`);
  await test({
    ...options,
    workspace: path.resolve(options.workspace, suite),
  });
}

function getSuitesToRun(suites: string[], root: string) {
  let suitesToRun: string[] = suites;
  const availableSuites: string[] = fs
    .readdirSync(path.join(root, 'tests'))
    .filter((f: string) => !f.startsWith('_') && f.endsWith('.ts'))
    .map((f: string) => f.slice(0, -3));
  availableSuites.sort();
  if (suitesToRun.length === 0) {
    suitesToRun = availableSuites;
  } else {
    const invalidSuites = suitesToRun.filter(
      (x) => !x.startsWith('_') && !availableSuites.includes(x),
    );
    if (invalidSuites.length) {
      console.log(`invalid suite(s): ${invalidSuites.join(', ')}`);
      console.log(`available suites: ${availableSuites.join(', ')}`);
      process.exit(1);
    }
  }
  return suitesToRun;
}
