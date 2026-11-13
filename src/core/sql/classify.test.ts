import { describe, expect, test } from "bun:test";
import { classify, commandTag } from "./classify";

test.each([
  ["select 1", "read"],
  ["  -- note\n SELECT * from t", "read"],
  ["with x as (select 1) select * from x", "read"],
  ["values (1), (2)", "read"],
  ["table users", "read"],
  ["show search_path", "read"],
  ["explain select 1", "read"],
  ["explain query plan select 1", "read"],
  ["pragma table_info('t')", "read"],
  ["with d as (delete from t returning *) select * from d", "write"],
  ["insert into t values (1)", "write"],
  ["update t set a = 1", "write"],
  ["delete from t", "write"],
  ["merge into t using s on true when matched then delete", "write"],
  ["truncate t", "write"],
  ["copy t from stdin", "write"],
  ["explain analyze delete from t", "write"],
  ["explain (analyze, buffers) update t set a = 1", "write"],
  ["explain analyze select 1", "read"],
  ["pragma journal_mode = wal", "write"],
  ["select * into backup from t", "write"],
  ["create table t (a int)", "ddl"],
  ["alter table t add b int", "ddl"],
  ["drop table t", "ddl"],
  ["grant select on t to u", "ddl"],
  ["begin", "transaction"],
  ["start transaction", "transaction"],
  ["commit", "transaction"],
  ["rollback", "transaction"],
  ["savepoint a", "transaction"],
  ["set search_path = public", "other"],
  ["vacuum", "other"],
  ["", "other"],
] as const)("classify(%p) is %p", (sql, expected) => {
  expect(classify(sql)).toBe(expected);
});

test("a keyword inside a string or comment does not count", () => {
  expect(classify("select 'delete from t' /* update */")).toBe("read");
});

test("commandTag", () => {
  expect(commandTag("  select 1")).toBe("SELECT");
  expect(commandTag("-- x\ninsert into t values (1)")).toBe("INSERT");
  expect(commandTag("")).toBe("");
});

describe("classify: read-only gate corner cases", () => {
  test("explain analyse is the same as explain analyze", () => {
    expect(classify("explain analyse delete from t")).toBe("write");
    expect(classify("EXPLAIN ANALYSE select 1")).toBe("read");
  });

  test("explain analyze is judged by the statement it runs", () => {
    expect(classify("explain (analyze) create table x as select 1")).toBe("ddl");
    expect(classify("explain (analyze, buffers) select * from t")).toBe("read");
    expect(classify("explain analyze verbose update t set a = 1")).toBe("write");
    expect(classify("explain analyze execute stmt")).toBe("other");
    expect(classify("explain analyze")).toBe("other");
  });

  test("explain without analyze only plans", () => {
    expect(classify("explain (costs off) delete from t")).toBe("read");
    expect(classify("explain query plan select 1")).toBe("read");
    expect(classify("explain verbose insert into t values (1)")).toBe("read");
  });

  test("a pragma with an argument is a write unless it only inspects", () => {
    expect(classify("pragma journal_mode(wal)")).toBe("write");
    expect(classify("pragma main.user_version(5)")).toBe("write");
    expect(classify("pragma table_info(users)")).toBe("read");
    expect(classify("PRAGMA main.index_list('orders')")).toBe("read");
    expect(classify("pragma foreign_keys")).toBe("read");
    expect(classify("pragma foreign_keys = on")).toBe("write");
    expect(classify("pragma user_version == 5")).toBe("write");
    expect(classify("pragma query_only==0")).toBe("write");
    expect(classify("PRAGMA foreign_keys == off")).toBe("write");
  });
});

describe("classify: into and acting pragmas", () => {
  test("select into is a write wherever the into appears", () => {
    expect(classify("select extract(year from now()) into t")).toBe("write");
    expect(classify("select (select 1 from x) as a into t")).toBe("write");
    expect(classify("with x as (select 1) select * into t from x")).toBe("write");
    expect(classify("with x as (select 1) replace into t select * from x")).toBe("write");
  });

  test("a query that only mentions into as data stays a read", () => {
    expect(classify("select replace(a, 'x', 'y') from t")).toBe("read");
    expect(classify("select 'into' as word, \"into\" from t")).toBe("read");
    expect(classify("select extract(year from now()) from t")).toBe("read");
  });

  test("pragmas that act without an argument are writes", () => {
    for (const name of ["wal_checkpoint", "optimize", "incremental_vacuum", "shrink_memory"]) {
      expect(classify(`pragma ${name}`)).toBe("write");
      expect(classify(`PRAGMA main.${name}`)).toBe("write");
      expect(classify(`pragma ${name}(1)`)).toBe("write");
    }
    expect(classify("pragma journal_mode")).toBe("read");
    expect(classify("pragma integrity_check")).toBe("read");
  });

  test("text with more than one statement is classified by its most severe statement", () => {
    expect(classify("select 1; drop table t")).toBe("ddl");
    expect(classify("select 1; delete from t")).toBe("write");
    expect(classify("begin; delete from t")).toBe("write");
    expect(classify("select 1; select 2")).toBe("read");
    expect(classify("select 1;")).toBe("read");
    expect(classify("select 1; -- done")).toBe("read");
    expect(classify("explain select 1; delete from t")).toBe("write");
    expect(classify("pragma table_info(t); delete from t")).toBe("write");
    expect(classify("select ';'; select 2")).toBe("read");
    expect(classify("select 1; commit")).toBe("transaction");
  });

  test("deeply nested explain prefixes are consumed without recursion", () => {
    const analyzePrefix = "explain analyze ".repeat(5000);
    expect(classify(`${analyzePrefix}select 1`)).toBe("read");
    expect(classify(`${analyzePrefix}delete from t`)).toBe("write");
    const explainPrefix = "explain ".repeat(5000);
    expect(classify(`${explainPrefix}delete from t`)).toBe("read");
  });

  test("pinned classification decisions", () => {
    expect(classify("select * from t for update")).toBe("write");
    expect(classify("with x as (delete from t returning *) select * from x")).toBe("write");
    expect(classify("select 1 into t2 from t")).toBe("write");
    expect(classify("values (1)")).toBe("read");
    expect(classify("table t")).toBe("read");
    expect(classify("show search_path")).toBe("read");
    expect(classify("describe t")).toBe("read");
    expect(classify("desc t")).toBe("read");
    expect(classify("explain analyze")).toBe("other");
    expect(classify("explain (analyze, verbose) delete from t")).toBe("write");
    expect(classify("explain (verbose) delete from t")).toBe("read");
    expect(classify("pragma wal_checkpoint")).toBe("write");
    expect(classify("pragma optimize")).toBe("write");
    expect(classify("pragma foo(1)")).toBe("write");
    expect(classify("pragma table_info(t)")).toBe("read");
    expect(classify("pragma user_version")).toBe("read");
  });

  test("compound statements (triggers and begin atomic routines) are classified as a whole", () => {
    expect(classify("create trigger t after insert on a begin update a set n = n + 1; end")).toBe("ddl");
    expect(
      classify(
        "create temp trigger t after insert on a begin update a set n = n + 1; delete from b; end",
      ),
    ).toBe("ddl");
    expect(classify("create function f() returns int language sql begin atomic select 1; end")).toBe(
      "ddl",
    );
    expect(
      classify(
        "create procedure p() language sql begin atomic insert into t values (1); end",
      ),
    ).toBe("ddl");
    expect(classify("select 1; update t set a = 1")).toBe("write");
    expect(classify("begin; select 1; commit")).toBe("transaction");
  });
});



describe("a select that calls a function acting outside its transaction", () => {
  const ACTING = [
    "setval", "nextval", "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf",
    "pg_rotate_logfile", "pg_switch_wal", "pg_create_restore_point", "pg_promote", "pg_notify",
    "pg_logical_emit_message", "pg_stat_reset",
    "pg_stat_reset_shared", "pg_stat_statements_reset", "lo_import", "lo_export", "lo_unlink", "lo_create",
    "lowrite", "lo_put", "dblink_exec", "dblink_connect", "dblink", "pg_read_file", "pg_read_binary_file",
    "pg_ls_dir", "pg_file_write", "load_extension",
    // Functions that run SQL given as text.
    "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema", "ts_stat", "ts_rewrite", "crosstab",
    "connectby", "xpath_table",
    "pg_stat_reset_slru", "pg_stat_reset_single_table_counters", "pg_stat_reset_single_function_counters",
    "pg_stat_reset_replication_slot", "pg_stat_reset_subscription_stats", "pg_log_backend_memory_contexts",
    // Replication slots and origins, backups, WAL replay and statistics of the server as a whole.
    "pg_create_physical_replication_slot", "pg_create_logical_replication_slot", "pg_drop_replication_slot",
    "pg_replication_slot_advance", "pg_copy_physical_replication_slot", "pg_copy_logical_replication_slot",
    "pg_sync_replication_slots", "pg_replication_origin_create", "pg_replication_origin_drop",
    "pg_replication_origin_advance", "pg_replication_origin_session_setup", "pg_replication_origin_session_reset",
    "pg_replication_origin_xact_setup", "pg_backup_start", "pg_backup_stop", "pg_log_standby_snapshot",
    "pg_wal_replay_pause", "pg_wal_replay_resume", "pg_stat_reset_backend_stats",
    // They consume the changes of a replication slot.
    "pg_logical_slot_get_changes", "pg_logical_slot_get_binary_changes",
    // Their names up to Postgres 14.
    "pg_start_backup", "pg_stop_backup",
  ];

  // Their effects end with the session, and the Postgres Driver resets session
  // settings and releases advisory locks after every read-only Run.
  const SESSION_SCOPED = [
    "set_config", "pg_advisory_lock", "pg_advisory_lock_shared", "pg_try_advisory_lock",
    "pg_try_advisory_lock_shared", "pg_advisory_unlock", "pg_advisory_unlock_all",
  ];

  test("the list has 65 names", () => {
    expect(ACTING).toHaveLength(65);
  });

  test.each(SESSION_SCOPED)("%s called stays a read", (name) => {
    expect(classify(`select ${name}('orders_id_seq', 1)`)).toBe("read");
    expect(classify(`with x as (select 1 as a) select ${name}(a) from x`)).toBe("read");
    expect(classify(`SELECT ${name.toUpperCase()}(1)`)).toBe("read");
    expect(classify(`select pg_catalog.${name}(1)`)).toBe("read");
    expect(classify(`select PG_CATALOG . ${name} /* note */ (1)`)).toBe("read");
    expect(classify(`explain select ${name}(1)`)).toBe("read");
    expect(classify(`select 1 where ${name}(1) is not null`)).toBe("read");
    expect(classify(`select "${name}"(1)`)).toBe("read");
  });

  test.each(ACTING)("%s called is a write", (name) => {
    expect(classify(`select ${name}('orders_id_seq', 1)`)).toBe("write");
    expect(classify(`with x as (select 1 as a) select ${name}(a) from x`)).toBe("write");
    expect(classify(`SELECT ${name.toUpperCase()}(1)`)).toBe("write");
    expect(classify(`select pg_catalog.${name}(1)`)).toBe("write");
    expect(classify(`select PG_CATALOG . ${name} /* note */ (1)`)).toBe("write");
    expect(classify(`explain select ${name}(1)`)).toBe("write");
    expect(classify(`select 1 where ${name}(1) is not null`)).toBe("write");
  });

  test.each(ACTING)("%s inside a string, a comment or a quoted identifier, or not called, is a read", (name) => {
    expect(classify(`select '${name}(1)'`)).toBe("read");
    expect(classify(`select 1 -- ${name}(1)`)).toBe("read");
    expect(classify(`select 1 /* ${name}(1) */`)).toBe("read");
    expect(classify(`select "${name}(1)" from t`)).toBe("read");
    expect(classify(`select "${name}" from t`)).toBe("read");
    expect(classify(`select ${name} from t`)).toBe("read");
    expect(classify(`select * from ${name}`)).toBe("read");
    expect(classify(`select t.${name}, ${name} as x from ${name} t`)).toBe("read");
  });

  test("the call raises a Statement to write, and a text by its most severe Statement", () => {
    expect(classify("select pg_terminate_backend(1)")).toBe("write");
    expect(classify("select setval('orders_id_seq', 1)")).toBe("write");
    expect(classify("select 1; select pg_cancel_backend(2)")).toBe("write");
    expect(classify("select count(*) from t")).toBe("read");
    expect(classify("select now(), lower(name) from t")).toBe("read");
    expect(classify(`select "setval"('orders_id_seq', 1)`)).toBe("write");
    // A ddl is no read either and stays ddl (the schema is refreshed after one).
    expect(classify("create table t as select nextval('s') as n")).toBe("ddl");
  });
});

describe("a call written as a U& quoted identifier", () => {
  test("a U&\"…\" identifier directly followed by ( makes the Statement a write, whatever it spells", () => {
    expect(classify(String.raw`select U&"pg_terminate_\0062ackend"(1)`)).toBe("write");
    expect(classify(String.raw`select u&"pg_terminate_\0062ackend" (1)`)).toBe("write");
    expect(classify(String.raw`select pg_catalog.U&"pg_terminate_\0062ackend"(1)`)).toBe("write");
    expect(classify(String.raw`select PG_CATALOG . U&"pg_terminate_\0062ackend" /* note */ (1)`)).toBe("write");
    expect(classify(String.raw`select U&"\0073etval"('s', 1) from t`)).toBe("write");
    expect(classify(`select U&"lower"('A')`)).toBe("write");
    expect(classify(String.raw`select U&"pg_terminate_!0062ackend" UESCAPE '!'(1)`)).toBe("write");
    expect(classify(String.raw`select 1; select U&"pg_cancel_\0062ackend"(2)`)).toBe("write");
  });

  test("a U&\"…\" identifier not followed by ( stays a read", () => {
    expect(classify(String.raw`select U&"pg_terminate_\0062ackend" from t`)).toBe("read");
    expect(classify(String.raw`select U&"d\0061ta" from t where U&"d\0061ta" > 1`)).toBe("read");
    expect(classify(String.raw`select * from U&"t\0061ble"`)).toBe("read");
    expect(classify(String.raw`select pg_catalog.U&"x" as y from t`)).toBe("read");
    expect(classify(String.raw`select U&"x" UESCAPE '!' from t`)).toBe("read");
    expect(classify(String.raw`select 'U&"pg_terminate_\0062ackend"(1)'`)).toBe("read");
    expect(classify(String.raw`select 1 -- U&"pg_terminate_\0062ackend"(1)`)).toBe("read");
    // Not a U& identifier: a column u and the operator & with a quoted call.
    expect(classify(`select u & "abs"(1) from t`)).toBe("read");
  });
});
