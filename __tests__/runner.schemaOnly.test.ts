import { schemaOnly } from "../src/runner";
import { RunnerOptions } from "../src/interfaces";
import { reset, withPgPool, TEST_CONNECTION_STRING } from "./helpers";

afterAll(async function() {
  await withPgPool(async pgPool => {
    await reset(pgPool);
  });
});

test("schemaOnly runs without errors and only needs a connection", async () => {
  const options: RunnerOptions = {
    connectionString: TEST_CONNECTION_STRING,
  };
  expect.assertions(1);
  await withPgPool(async pgPool => {
    return await pgPool.query("drop schema if exists graphile_worker cascade;");
  });
  await schemaOnly(options);
  await withPgPool(async pgPool => {
    const {
      rows: [graphileWorkerNamespaceBeforeMigration],
    } = await pgPool.query(
      `select * from pg_catalog.pg_namespace where nspname = $1`,
      ["graphile_worker"]
    );
    expect(graphileWorkerNamespaceBeforeMigration).toBeTruthy();
  });
});
