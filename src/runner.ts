import * as assert from "assert";
import { Pool } from "pg";
import getTasks from "./getTasks";
import { Runner, RunnerOptions, TaskList } from "./interfaces";
import { runTaskList, runTaskListOnce } from "./main";
import { makeWithPgClientFromPool, makeAddJob } from "./helpers";
import { migrate } from "./migrate";

const createPgPoolFromOptions = (
  options: RunnerOptions,
  releasers: Array<() => void | Promise<void>>
) => {
  let pgPool: Pool;
  if (options.pgPool) {
    pgPool = options.pgPool;
  } else if (options.connectionString) {
    pgPool = new Pool({ connectionString: options.connectionString });
    releasers.push(() => pgPool.end());
  } else if (process.env.DATABASE_URL) {
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
    releasers.push(() => pgPool.end());
  } else {
    throw new Error(
      "You must either specify `pgPool` or `connectionString`, or you must make the `DATABASE_URL` environmental variable available."
    );
  }
  return pgPool;
};

const processOptions = async (options: RunnerOptions) => {
  const releasers: Array<() => void | Promise<void>> = [];
  const release = () => Promise.all(releasers.map(fn => fn()));

  try {
    assert(
      !options.taskDirectory || !options.taskList,
      "Exactly one of either `taskDirectory` or `taskList` should be set"
    );
    let taskList: TaskList;
    if (options.taskList) {
      taskList = options.taskList;
    } else if (options.taskDirectory) {
      const watchedTasks = await getTasks(options.taskDirectory, false);
      releasers.push(() => watchedTasks.release());
      taskList = watchedTasks.tasks;
    } else {
      throw new Error(
        "You must specify either `options.taskList` or `options.taskDirectory`"
      );
    }

    assert(
      !options.pgPool || !options.connectionString,
      "Both `pgPool` and `connectionString` are set, at most one of these options should be provided"
    );

    const pgPool: Pool = createPgPoolFromOptions(options, releasers);

    pgPool.on("error", err => {
      /*
       * This handler is required so that client connection errors don't bring
       * the server down (via `unhandledError`).
       *
       * `pg` will automatically terminate the client and remove it from the
       * pool, so we don't actually need to take any action here, just ensure
       * that the event listener is registered.
       */
      // eslint-disable-next-line no-console
      console.error("PostgreSQL client generated error: ", err.message);
    });

    const withPgClient = makeWithPgClientFromPool(pgPool);

    // Migrate
    await withPgClient(client => migrate(client));

    return { taskList, pgPool, withPgClient, release };
  } catch (e) {
    release();
    throw e;
  }
};

export const schemaOnly = async (options: RunnerOptions) => {
  const releasers: Array<() => void | Promise<void>> = [];
  const pgPool: Pool = createPgPoolFromOptions(options, releasers);
  const withPgClient = makeWithPgClientFromPool(pgPool);
  try {
    await withPgClient(client => migrate(client));
  } catch (e) {
    throw e;
  } finally {
    await Promise.all(releasers.map(fn => fn()));
  }
};

export const runOnce = async (options: RunnerOptions): Promise<void> => {
  const { taskList, withPgClient, release } = await processOptions(options);
  await withPgClient(client => runTaskListOnce(taskList, client, options));
  await release();
};

export const run = async (options: RunnerOptions): Promise<Runner> => {
  const { taskList, pgPool, withPgClient, release } = await processOptions(
    options
  );

  const workerPool = runTaskList(taskList, pgPool, options);
  let running = true;
  return {
    async stop() {
      if (running) {
        throw new Error("Runner is already stopped");
      } else {
        running = false;
        await workerPool.release();
        await release();
      }
    },
    addJob: makeAddJob(withPgClient),
    promise: workerPool.promise,
  };
};
