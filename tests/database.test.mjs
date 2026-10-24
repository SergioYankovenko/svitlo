import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
test("real PostgreSQL migrations: atomic registry activation, rollback, RLS and backoff scheduling", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);",
    );
    for (const name of [
      "20261023225141_svitlo_pwa.sql",
      "20261024144933_queue_registry.sql",
    ])
      await db.exec(
        await readFile(
          new URL("../supabase/migrations/" + name, import.meta.url),
          "utf8",
        ),
      );
    const version = {
      id: "v1",
      validFrom: "2026-10-01",
      validUntil: "2027-04-01",
      checkedAt: 1,
      documents: Array.from({ length: 12 }, (_, i) => ({
        queue: Math.floor(i / 2) + 1 + "." + ((i % 2) + 1),
      })),
      rules: [
        {
          city: "м.Христинівка",
          street: "вул.Флорештська",
          scope: "street_all",
          queue: "3.2",
        },
      ],
    };
    await db.query("select public.svitlo_activate_registry($1::jsonb)", [
      JSON.stringify(version),
    ]);
    assert.equal(
      (await db.query("select queue from public.svitlo_queue_rules")).rows[0]
        .queue,
      "3.2",
    );
    await assert.rejects(() =>
      db.query("select public.svitlo_activate_registry($1::jsonb)", [
        JSON.stringify({
          ...version,
          id: "bad",
          rules: [{ ...version.rules[0], queue: "9.9" }],
        }),
      ]),
    );
    assert.equal(
      (
        await db.query(
          "select id from public.svitlo_queue_versions where active",
        )
      ).rows[0].id,
      "v1",
    );
    await db.exec("set role authenticated");
    await assert.rejects(() =>
      db.query("select * from public.svitlo_queue_rules"),
    );
    await assert.rejects(() =>
      db.query("select public.svitlo_activate_registry($1::jsonb)", [
        JSON.stringify(version),
      ]),
    );
    await db.exec("reset role");
    await db.exec(
      "insert into auth.users values('00000000-0000-0000-0000-000000000001');insert into public.svitlo_profiles(id,owner,address,last_checked,next_check) values('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','{}',9999999,1000)",
    );
    assert.equal(
      (await db.query("select * from public.svitlo_due(999,5)")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("select * from public.svitlo_due(1000,5)")).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});
