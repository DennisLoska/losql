import { Database } from "bun:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import { osc52 } from "../../../core/clipboard";
import type { ExecRequest, ExecResult } from "../../../core/exec";
import { readHistory } from "../../../core/state";
import { fakeClaude, mount, type FakeReply, type MountOptions, type TestApp } from "../../testing";
import { AgentPane } from "./AgentPane";

let app: TestApp;
let fake: ReturnType<typeof fakeClaude>;
afterEach(async () => { await app?.dispose(); });

async function start(replies: FakeReply[], options: MountOptions = {}) {
  fake = fakeClaude(replies);
  app = await mount({
    ...options,
    config: { agent: { provider: "claude" }, ...options.config },
    deps: { which: fake.which, exec: fake.exec, ...options.deps },
  });
  await app.waitFor(() => app.api.session.status() === "connected" && app.api.agent.providers().length === 4);
}
const turn = (index = 0) => app.api.agent.turns()[index]!;
const finished = (index = 0) => app.waitFor(() => app.api.agent.turns().length > index && turn(index).status !== "running");
const orderCount = async () => {
  const [outcome] = await app.api.session.run({ statements: ["select count(*) from orders"], record: false, show: false });
  return outcome!.ok ? outcome!.result.rows[0]![0] : null;
};

const countQuery = '{"action":"query","sql":"select count(*) as n from orders","why":"count them"}';
const countAnswer = '{"action":"answer","message":"There are 12 orders.","sql":"select count(*) as orders from orders"}';

describe("setup states", () => {
  test("without a Provider the Pane explains what to do", async () => {
    app = await mount();
    await app.waitFor(() => app.api.session.status() === "connected");
    await app.press("<Space>aa");
    expect(app.api.focus.pane()).toBe("agent");
    expect(app.frame()).toContain("No agent is set up");
    expect(app.api.agent.provider()).toBeNull();
    await app.api.agent.ask({ intent: "ask", text: "hello" });
    expect(app.api.agent.turns()).toEqual([]);
  });

  test("a configured Provider that is not installed is reported", async () => {
    app = await mount({ config: { agent: { provider: "codex" } } });
    await app.waitFor(() => app.api.agent.providers().length === 4);
    await app.press("<Space>aa");
    expect(app.api.agent.provider()).toMatchObject({ id: "codex", installed: false });
    expect(app.frame()).toContain("Codex is not installed");
    expect(app.frame()).toContain("npm install -g @openai/codex");
  });

  test("the Provider and Model are shown", async () => {
    await start([countAnswer], { config: { agent: { provider: "claude", model: "sonnet" } } });
    expect(app.api.agent.provider()).toMatchObject({ id: "claude", installed: true, version: "9.9.9" });
    expect(app.api.agent.model()).toBe("sonnet");
    expect(app.frame()).toContain("claude · sonnet");
  });

  test("without a Session the Agent cannot be asked", async () => {
    fake = fakeClaude([countAnswer]);
    app = await mount({ connection: null, config: { agent: { provider: "claude" } }, deps: { which: fake.which, exec: fake.exec } });
    await app.waitFor(() => app.api.agent.providers().length === 4);
    await app.press("<Esc>"); // the Connections dialog that opens without a Connection
    await app.api.agent.ask({ intent: "ask", text: "hello" });
    expect(app.api.agent.turns()).toEqual([]);
    expect(app.api.status.message()).toEqual({ text: "Not connected (use :connect)", kind: "error" });
  });
});

describe("a Turn", () => {
  test("typing a question runs Steps and ends with a Proposal", async () => {
    await start([countQuery, countAnswer]);
    await app.press("<Space>ai");
    expect(app.api.focus.pane()).toBe("agent");
    expect(app.api.status.current().mode).toBe("INSERT");
    await app.press("how many orders are there<CR>");
    await finished();
    expect(turn()).toMatchObject({ intent: "ask", text: "how many orders are there", status: "done", message: "There are 12 orders." });
    expect(turn().steps.length).toBe(1);
    expect(turn().proposal).toMatchObject({ sql: "select count(*) as orders from orders", kind: "read" });
    for (const text of ["you", "how many orders are there", "agent", "▸ query", "→ 1 row", "There are 12 orders.", "select count(*) as orders", "enter accept"]) {
      expect(app.frame()).toContain(text);
    }
    expect(fake.prompts.length).toBe(2);
    expect(fake.prompts[0]).toContain("how many orders are there");
    expect(fake.prompts[0]).toContain("orders(id integer pk");
    expect(fake.prompts[1]).toContain('"rows":[[12]]');
    expect(fake.requests[0]!.cmd).toContain("--safe-mode");
    expect(await readHistory(app.deps.paths)).toEqual([]);
  });

  test("the input is cleared after sending and Escape returns to normal mode", async () => {
    await start([countAnswer]);
    await app.press("<Space>ai");
    await app.press("hi<CR>");
    await finished();
    expect(app.frame()).not.toMatch(/> hi/);
    await app.press("<Esc>");
    expect(app.api.status.current().mode).toBe("NORMAL");
    await app.press("i");
    expect(app.api.status.current().mode).toBe("INSERT");
  });

  test("ctrl+j adds a line and an empty question is not sent", async () => {
    await start([countAnswer]);
    await app.press("<Space>ai");
    await app.press("<CR>");
    expect(app.api.agent.turns()).toEqual([]);
    await app.press("one<C-j>two<CR>");
    await finished();
    expect(turn().text).toBe("one\ntwo");
  });

  test(":ask sends at once", async () => {
    await start([countAnswer]);
    await app.press(":ask how many orders<CR>");
    await finished();
    expect(turn().text).toBe("how many orders");
    expect(app.api.focus.visible("agent")).toBe(true);
  });

  test("the Conversation is sent with the next Turn, and can be reset", async () => {
    await start([countAnswer, '{"action":"answer","message":"Second answer."}']);
    await app.api.agent.ask({ intent: "ask", text: "first question" });
    await app.api.agent.ask({ intent: "ask", text: "second question" });
    expect(app.api.agent.turns().length).toBe(2);
    expect(fake.prompts[1]).toContain("first question");
    expect(fake.prompts[1]).toContain("There are 12 orders.");
    await app.press("<Space>an");
    expect(app.api.agent.turns()).toEqual([]);
    await app.api.agent.ask({ intent: "ask", text: "third question" });
    expect(fake.prompts[2]).not.toContain("first question");
  });

  test("schema-only data access is passed on", async () => {
    await start([countAnswer], { config: { agent: { provider: "claude", dataAccess: "schema" } } });
    await app.api.agent.ask({ intent: "ask", text: "x" });
    expect(fake.prompts[0]).toContain("You cannot run queries in this session");
  });

  test("a write in a query Step fails at the database and changes nothing", async () => {
    await start(['{"action":"query","sql":"delete from orders"}', '{"action":"answer","message":"I could not."}']);
    await app.api.agent.ask({ intent: "ask", text: "wipe the orders" });
    expect(turn().steps[0]!.result).toContain("error");
    await app.settle();
    expect(app.frame()).toContain("→ error");
    expect(await orderCount()).toBe(12);
  });
});

describe("Proposals", () => {
  test("Enter accepts into a new Buffer without running, and the Buffer then runs", async () => {
    await start([countQuery, countAnswer]);
    await app.api.agent.ask({ intent: "ask", text: "how many orders" });
    app.api.focus.focus("agent");
    await app.press("<CR>");
    expect(app.api.focus.pane()).toBe("editor");
    expect(app.api.editor.buffers().map((b) => b.name)).toEqual(["scratch", "agent"]);
    expect(app.api.editor.text()).toBe("select count(*) as orders from orders");
    expect(app.api.session.shown()).toBeNull();
    await app.press("<CR>");
    await app.waitFor(() => app.api.session.shown() !== null);
    const shown = app.api.session.shown()!;
    expect(shown.ok && shown.result.rows).toEqual([[12]]);
  });

  test("r runs a read Proposal at once", async () => {
    await start([countAnswer]);
    await app.api.agent.ask({ intent: "ask", text: "how many orders" });
    app.api.focus.focus("agent");
    await app.press("r");
    await app.waitFor(() => app.api.session.shown() !== null);
    expect(app.api.dialog.depth()).toBe(0);
    expect(app.api.editor.text()).toBe("select count(*) as orders from orders");
  });

  test("r on a Proposal that is not a read asks first", async () => {
    await start(['{"action":"answer","message":"This deletes every order.","sql":"delete from orders"}']);
    await app.api.agent.ask({ intent: "ask", text: "wipe the orders" });
    expect(turn().proposal!.kind).toBe("write");
    app.api.focus.focus("agent");
    await app.press("r");
    expect(app.api.dialog.depth()).toBe(1);
    expect(app.frame()).toContain("Run this statement?");
    expect(app.frame()).toContain("delete from orders");
    await app.press("<CR>");
    expect(app.api.dialog.depth()).toBe(0);
    expect(await orderCount()).toBe(12);
    await app.press("r");
    await app.press("y");
    await app.waitFor(() => app.api.session.shown() !== null);
    expect(await orderCount()).toBe(0);
  });

  test("y yanks the selected Proposal, and { and } move between Proposals", async () => {
    await start([countAnswer, '{"action":"answer","message":"Another.","sql":"select 2"}']);
    await app.api.agent.ask({ intent: "ask", text: "one" });
    await app.api.agent.ask({ intent: "ask", text: "two" });
    app.api.focus.focus("agent");
    expect(app.api.agent.selected()!.sql).toBe("select 2");
    await app.press("{");
    expect(app.api.agent.selected()!.sql).toBe("select count(*) as orders from orders");
    await app.press("{y");
    expect(app.deps.written).toEqual([osc52("select count(*) as orders from orders")]);
    await app.press("}");
    expect(app.api.agent.selected()!.sql).toBe("select 2");
  });

  test("Enter without a Proposal does nothing", async () => {
    await start(['{"action":"answer","message":"Just words."}']);
    await app.api.agent.ask({ intent: "ask", text: "hello" });
    app.api.focus.focus("agent");
    await app.press("<CR>r");
    expect(app.api.editor.buffers().length).toBe(1);
    expect(app.api.focus.pane()).toBe("agent");
  });
});

describe("quick actions", () => {
  test("explain sends the Statement under the cursor", async () => {
    await start(['{"action":"answer","message":"It counts orders."}']);
    app.api.editor.setText("select 1;\nselect count(*) from orders;");
    await app.press("j<Space>ae");
    await finished();
    expect(turn()).toMatchObject({ intent: "explain", text: "Explain this statement", message: "It counts orders." });
    expect(fake.prompts[0]).toContain("Explain what this statement does.");
    expect(fake.prompts[0]).toContain("select count(*) from orders");
    expect(fake.prompts[0]).not.toContain("Statement:\nselect 1");
    expect(app.api.focus.visible("agent")).toBe(true);
  });

  test("fix sends the failed Statement with its error and replaces it on accept", async () => {
    await start(['{"action":"answer","message":"A typo in FROM.","sql":"select count(*) from orders"}']);
    app.api.editor.setText("select 1;\nselect count(*) frm orders;");
    await app.press("j<CR>");
    await app.waitFor(() => app.api.session.lastError() !== null);
    await app.press("<Space>af");
    await finished();
    expect(fake.prompts[0]).toContain("This statement failed. Fix it.");
    expect(fake.prompts[0]).toContain("select count(*) frm orders");
    expect(fake.prompts[0]).toContain("syntax error");
    app.api.focus.focus("agent");
    await app.press("<CR>");
    expect(app.api.editor.buffers().length).toBe(1);
    expect(app.api.editor.text()).toBe("select 1;\nselect count(*) from orders;");
    expect(app.api.focus.pane()).toBe("editor");
  });

  test("fix is offered only after a failed Run", async () => {
    await start([countAnswer]);
    const fix = app.api.commands.registry.byId("agent.fix")!;
    expect(fix.when!(app.api)).toBe(false);
    await app.api.session.run({ statements: ["select * from nope"] });
    expect(fix.when!(app.api)).toBe(true);
  });

  test("optimize sends the plan", async () => {
    await start(['{"action":"answer","message":"Add an index.","sql":"create index orders_status on orders(status)"}']);
    app.api.editor.setText("select * from orders where status = 'paid'");
    await app.press("<Space>ao");
    await finished();
    expect(fake.prompts[0]).toContain("Suggest how to make this statement faster.");
    expect(fake.prompts[0]).toContain("Plan:");
    expect(fake.prompts[0]).toContain("SCAN");
    expect(turn().proposal!.kind).toBe("ddl");
    expect(app.api.session.shown()).toBeNull();
  });

  test("a quick action without a Statement says so", async () => {
    await start([countAnswer]);
    app.api.editor.setText("");
    await app.press("<Space>ae");
    expect(app.api.status.message()).toEqual({ text: "No statement under the cursor", kind: "error" });
    expect(app.api.agent.turns()).toEqual([]);
  });
});

describe("failures", () => {
  test("a Provider error ends the Turn with advice and keeps the Conversation", async () => {
    await start([{ error: "You've hit your usage limit. Try again on Nov 16." }, countAnswer]);
    await app.api.agent.ask({ intent: "ask", text: "first" });
    expect(turn()).toMatchObject({ status: "error", errorKind: "quota" });
    app.api.focus.focus("agent");
    await app.settle();
    expect(app.frame()).toContain("usage limit");
    expect(app.frame()).toContain("switch");
    await app.api.agent.ask({ intent: "ask", text: "second" });
    expect(app.api.agent.turns().map((t) => t.status)).toEqual(["error", "done"]);
  });

  test("a reply that cannot be understood is a protocol error", async () => {
    await start(['{"action":"dance"}']);
    await app.api.agent.ask({ intent: "ask", text: "x" });
    expect(turn()).toMatchObject({ status: "error", errorKind: "protocol" });
  });

  test("ctrl+c cancels a running Turn", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    await start([{ hold, reply: countAnswer }]);
    const asking = app.api.agent.ask({ intent: "ask", text: "slow question" });
    app.api.focus.focus("agent");
    await app.waitFor(() => app.api.agent.running());
    expect(app.frame()).toContain("thinking");
    await app.press("<C-c>");
    await asking;
    await app.settle();
    expect(turn().status).toBe("cancelled");
    expect(app.api.agent.running()).toBe(false);
    expect(app.deps.exits).toEqual([]);
    expect(app.frame()).toContain("Cancelled.");
    release();
  });

  test("a second question while a Turn is running is refused", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    await start([{ hold, reply: countAnswer }]);
    const asking = app.api.agent.ask({ intent: "ask", text: "slow question" });
    await app.waitFor(() => app.api.agent.running());
    await app.api.agent.ask({ intent: "ask", text: "impatient" });
    expect(app.api.agent.turns().length).toBe(1);
    release();
    await asking;
    expect(turn().status).toBe("done");
  });
});

test("the transcript scrolls and follows new Turns", async () => {
  const long = JSON.stringify({ action: "answer", message: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") });
  await start([long, '{"action":"answer","message":"the very last answer"}']);
  await app.api.agent.ask({ intent: "ask", text: "first" });
  app.api.focus.focus("agent");
  await app.settle();
  expect(app.frame()).toContain("line 59");
  expect(app.frame()).not.toMatch(/line 0 /);
  await app.press("gg");
  expect(app.frame()).toMatch(/line 0 /);
  expect(app.frame()).not.toContain("line 59");
  await app.press("G");
  expect(app.frame()).toContain("line 59");
  await app.api.agent.ask({ intent: "ask", text: "second" });
  await app.settle();
  expect(app.frame()).toContain("the very last answer");
});

describe("long Proposal SQL wrapping in the Agent Pane", () => {
  const deleteCancelledSql = [
    "BEGIN;",
    "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'cancelled');",
    "DELETE FROM orders WHERE status = 'cancelled';",
    "COMMIT;",
  ].join("\n");

  const deleteReply = JSON.stringify({
    action: "answer",
    message: "Remove cancelled orders and their items.",
    sql: deleteCancelledSql,
  });

  function unwrapFrameSql(frame: string): string {
    const cardRows: string[] = [];
    for (const rawLine of frame.split("\n")) {
      const idx = rawLine.lastIndexOf("┃ ");
      if (idx === -1) continue;
      const cell = rawLine.slice(idx + 2).trimEnd();
      if (cell.startsWith("↪ ")) {
        if (cardRows.length > 0) {
          cardRows[cardRows.length - 1] += ` ${cell.slice(2).trimStart()}`;
        }
      } else {
        cardRows.push(cell);
      }
    }
    return cardRows.join("\n");
  }

  test("at 140x40 and 80x24 both DELETE lines show status = 'cancelled', accepting inserts the exact SQL, and resizing updates the frame", async () => {
    await start([deleteReply], { width: 140, height: 40 });
    await app.api.agent.ask({ intent: "ask", text: "delete cancelled orders" });
    app.api.focus.focus("agent");
    await app.settle();

    // At 140x40 both DELETE lines show their WHERE status = 'cancelled' clause via ↪ continuation rows
    expect(app.frame()).toContain("↪");
    expect(app.frame()).toContain("status = 'cancelled');");
    expect(app.frame()).toContain("↪ 'cancelled';");
    const unwrapped140 = unwrapFrameSql(app.frame());
    expect(unwrapped140).toContain(
      "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'cancelled');",
    );
    expect(unwrapped140).toContain("DELETE FROM orders WHERE status = 'cancelled';");

    // Confirmation before running a write Proposal shows the whole Statement
    await app.press("r");
    expect(app.api.dialog.depth()).toBe(1);
    expect(app.frame()).toContain("Run this statement?");
    expect(app.frame()).toContain("'cancelled');");
    expect(app.frame()).toContain("'cancelled';");
    await app.press("<Esc>");
    expect(app.api.dialog.depth()).toBe(0);

    // Resize to 80x24 and verify the frame is right for the new dimensions
    await app.resize(80, 24);
    expect(app.frame()).toContain("↪");
    expect(app.frame()).toContain("status = 'cancelled');");
    expect(app.frame()).toContain("↪ 'cancelled';");
    const unwrapped80 = unwrapFrameSql(app.frame());
    expect(unwrapped80).toContain(
      "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'cancelled');",
    );
    expect(unwrapped80).toContain("DELETE FROM orders WHERE status = 'cancelled';");

    // Accepting inserts the exact original SQL into the Buffer
    await app.press("<CR>");
    expect(app.api.focus.pane()).toBe("editor");
    expect(app.api.editor.text()).toBe(deleteCancelledSql);
  });

  test("mounted at 80x24 and resized to 140x40 keeps full SQL visible and preserves syntax colours on continuation rows", async () => {
    const longStringAndCommentSql = [
      deleteCancelledSql,
      "SELECT 'a_very_long_string_literal_that_continues_onto_the_next_row_in_the_card';",
      "SELECT 1 -- a_very_long_comment_that_continues_onto_the_next_row_in_the_card",
    ].join("\n");
    await start(
      [JSON.stringify({ action: "answer", message: "Here.", sql: longStringAndCommentSql })],
      { width: 80, height: 24 },
    );
    await app.api.agent.ask({ intent: "ask", text: "delete cancelled orders" });
    app.api.focus.focus("agent");
    await app.settle();

    const unwrapped80 = unwrapFrameSql(app.frame());
    expect(unwrapped80).toContain(
      "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'cancelled');",
    );
    expect(unwrapped80).toContain("DELETE FROM orders WHERE status = 'cancelled';");

    // Check continuation marker and syntax colours on continuation rows
    const spans = app.spans();
    const mutedColor = app.api.theme.color("textMuted");
    const stringColor = app.api.theme.color("syntaxString");
    const commentColor = app.api.theme.color("syntaxComment");

    let foundMarker = false;
    let foundContinuedString = false;
    let foundContinuedComment = false;
    for (const line of spans.lines) {
      for (const span of line.spans) {
        if (span.text.includes("↪")) {
          foundMarker = true;
          expect(span.fg).toEqual(mutedColor);
        }
        if (span.text.includes("_continues_onto_the_next_row_in_the")) {
          foundContinuedString = true;
          expect(span.fg).toEqual(stringColor);
        }
        if (span.text.includes("ntinues_onto_the_next_row_in_the_card")) {
          foundContinuedComment = true;
          expect(span.fg).toEqual(commentColor);
        }
      }
    }
    expect(foundMarker).toBe(true);
    expect(foundContinuedString).toBe(true);
    expect(foundContinuedComment).toBe(true);

    await app.resize(140, 40);
    const unwrapped140 = unwrapFrameSql(app.frame());
    expect(unwrapped140).toContain(
      "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'cancelled');",
    );
    expect(unwrapped140).toContain("DELETE FROM orders WHERE status = 'cancelled';");
  });

  test("recomputes SQL rows when the Pane width changes and stays fast with 200 earlier Turns", async () => {
    const { AgentPane } = await import("./AgentPane");
    fake = fakeClaude([deleteReply]);
    app = await mount({
      width: 50,
      height: 24,
      config: { agent: { provider: "claude" } },
      deps: { which: fake.which, exec: fake.exec },
      ui: () => <AgentPane />,
    });
    await app.waitFor(() => app.api.session.status() === "connected" && app.api.agent.providers().length === 4);
    await app.api.agent.ask({ intent: "ask", text: "delete cancelled orders" });
    app.api.focus.focus("agent");
    await app.settle();

    // At width 50 (inner width 45), the 93-cell and 46-cell DELETE lines wrap with ↪
    expect(app.frame()).toContain("↪");
    expect(unwrapFrameSql(app.frame())).toContain(
      "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'cancelled');",
    );

    // Resize to width 110 (inner width 105): both DELETE lines fit on single rows without ↪
    await app.resize(110, 24);
    expect(app.frame()).not.toContain("↪");
    expect(app.frame()).toContain(
      "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'cancelled');",
    );
    expect(app.frame()).toContain("DELETE FROM orders WHERE status = 'cancelled';");

    // Resize back to width 46 (inner width 41, matching 42-cell card width): wraps again with ↪
    await app.resize(46, 24);
    expect(app.frame()).toContain("↪");
    expect(unwrapFrameSql(app.frame())).toContain(
      "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'cancelled');",
    );
    await app.dispose();

    // Measure 1 streamed chunk and 1 scroll key with 200 earlier Turns
    const { createSignal } = await import("solid-js");
    const { Transcript } = await import("./Transcript");
    type TurnView = import("../../context/agent").TurnView;
    type TranscriptHandle = import("./Transcript").TranscriptHandle;

    const earlierTurns: TurnView[] = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      intent: "ask",
      text: `question ${i + 1}`,
      steps: [
        {
          action: { action: "query", sql: "select count(*) from orders" },
          result: '{"columns":["n"],"rows":[[12]],"truncated":false}',
        },
      ],
      status: "done",
      activity: null,
      message: `Answer ${i + 1}`,
      errorKind: null,
      proposal: {
        id: i + 1,
        turnId: i + 1,
        sql: deleteCancelledSql,
        kind: "write",
      },
      source: null,
    }));

    const activeBase: TurnView = {
      id: 201,
      intent: "ask",
      text: "streamed question",
      steps: [],
      status: "running",
      activity: "thinking",
      message: null,
      errorKind: null,
      proposal: null,
      source: null,
    };

    const [turnsSig, setTurnsSig] = createSignal<TurnView[]>([...earlierTurns, activeBase]);
    let handle!: TranscriptHandle;

    app = await mount({
      width: 44,
      height: 40,
      connection: null,
      ui: () => (
        <Transcript
          turns={turnsSig()}
          provider={{ label: "Claude Code", binary: "claude", installHint: "install claude" }}
          selectedProposalId={200}
          onReady={(h) => {
            handle = h;
          }}
        />
      ),
    });

    const tChunk0 = performance.now();
    setTurnsSig([
      ...earlierTurns,
      {
        ...activeBase,
        steps: [
          {
            action: { action: "query", sql: "select id from orders where status = 'cancelled'" },
            result: '{"columns":["id"],"rows":[[1]],"truncated":false}',
          },
        ],
        activity: "querying",
      },
    ]);
    await app.setup.renderOnce();
    const chunkMs = performance.now() - tChunk0;

    const tScroll0 = performance.now();
    handle.scrollBy(-1);
    await app.setup.renderOnce();
    const scrollMs = performance.now() - tScroll0;

    expect(chunkMs).toBeLessThan(25);
    expect(scrollMs).toBeLessThan(25);
  });
});

describe("abandoning a running Turn when the Connection changes or is lost", () => {
  test("connecting to another database cancels the running Turn, accepts a new request, ignores late replies, and reset() works", async () => {
    let releaseFirst = () => {};
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const baseFake = fakeClaude([countAnswer, countAnswer]);
    let callIdx = 0;
    const customExec: typeof baseFake.exec = async (req) => {
      if (req.cmd.includes("--version")) return baseFake.exec(req);
      const myCall = ++callIdx;
      if (myCall === 1) {
        // Ignore abort so that releasing holdFirst later still produces stdout & resolves
        await holdFirst;
        const text = '{"action":"answer","message":"Abandoned answer","sql":"select 999"}';
        req.onStdoutLine?.(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
        req.onStdoutLine?.(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }));
        return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
      }
      return baseFake.exec(req);
    };

    app = await mount({
      config: { agent: { provider: "claude" } },
      deps: { which: baseFake.which, exec: customExec },
    });
    await app.waitFor(() => app.api.session.status() === "connected" && app.api.agent.providers().length === 4);

    const firstAsk = app.api.agent.ask({ intent: "ask", text: "first slow question" });
    app.api.focus.focus("agent");
    await app.waitFor(() => app.api.agent.running());
    expect(app.frame()).toContain("thinking");

    // Connect to another database while Turn 1 is running
    const connRes = await app.api.session.connect(":memory:");
    expect(connRes.ok).toBe(true);
    await app.settle();

    // Another Connection: the Conversation is emptied with the abandoned Turn.
    expect(app.api.agent.turns()).toEqual([]);
    expect(app.api.agent.running()).toBe(false);
    expect(app.frame()).not.toContain("thinking");
    expect(app.frame()).not.toContain("first slow question");

    // A new ask is accepted at once and its answer lands in the new Turn only
    await app.api.agent.ask({ intent: "ask", text: "second question" });
    await finished(0);
    expect(app.api.agent.turns().length).toBe(1);
    expect(turn(0)).toMatchObject({ text: "second question", status: "done", message: "There are 12 orders." });

    // Releasing the held exec afterwards changes nothing
    releaseFirst();
    await firstAsk;
    await app.settle();
    expect(app.api.agent.turns().length).toBe(1);
    expect(turn(0)).toMatchObject({ text: "second question", status: "done", message: "There are 12 orders." });

    // reset() works
    app.api.agent.reset();
    expect(app.api.agent.turns()).toEqual([]);
  });

  test("losing the Connection (disconnect) cancels the running Turn, accepts a new request after reconnecting, and quitting during a Turn logs no error", async () => {
    const { QueryError } = await import("../../../core/db/types");
    const { openSession } = await import("../../../core/db/connection");
    let releaseFirst = () => {};
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callIdx = 0;
    const baseFake = fakeClaude([countAnswer, countAnswer]);
    const customExec: typeof baseFake.exec = async (req) => {
      if (req.cmd.includes("--version")) return baseFake.exec(req);
      const myCall = ++callIdx;
      if (myCall === 1) {
        await holdFirst;
        const text = '{"action":"answer","message":"Late after disconnect"}';
        req.onStdoutLine?.(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
        req.onStdoutLine?.(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }));
        return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
      }
      return baseFake.exec(req);
    };

    let openCalls = 0;
    app = await mount({
      connection: "postgres://localhost/dev",
      config: { agent: { provider: "claude" } },
      deps: {
        which: baseFake.which,
        exec: customExec,
        openSession: async (connection) => {
          if (connection.dialect === "sqlite") {
            return openSession(connection);
          }
          openCalls++;
          if (openCalls > 1) throw new QueryError("connect ECONNREFUSED");
          return {
            connection,
            run: async () => {
              throw new QueryError("read ECONNRESET", { code: "ECONNRESET" });
            },
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {},
          };
        },
      },
    });
    await app.waitFor(() => app.api.session.status() === "connected" && app.api.agent.providers().length === 4);

    const firstAsk = app.api.agent.ask({ intent: "ask", text: "question before disconnect" });
    app.api.focus.focus("agent");
    await app.waitFor(() => app.api.agent.running());

    // Trigger a disconnect via a failed Run that cannot reopen
    await app.api.session.run({ statements: ["select 1"] });
    expect(app.api.session.status()).toBe("disconnected");
    await app.settle();

    expect(turn(0)).toMatchObject({ status: "cancelled", activity: null });
    expect(app.api.agent.running()).toBe(false);
    expect(app.frame()).not.toContain("thinking");

    // Connect to demo, another Connection: the Conversation is emptied; then ask a new question
    await app.api.session.connect("demo");
    expect(app.api.agent.turns()).toEqual([]);
    await app.api.agent.ask({ intent: "ask", text: "after reconnect" });
    await finished(0);
    expect(app.api.agent.turns().length).toBe(1);
    expect(turn(0)).toMatchObject({ text: "after reconnect", status: "done", message: "There are 12 orders." });

    // Releasing the first held exec changes nothing
    releaseFirst();
    await firstAsk;
    await app.settle();
    expect(app.api.agent.turns().length).toBe(1);
    expect(turn(0)).toMatchObject({ text: "after reconnect", status: "done", message: "There are 12 orders." });

    // Quitting during a running Turn logs no error
    let releaseQuitTurn = () => {};
    const holdQuitTurn = new Promise<void>((resolve) => {
      releaseQuitTurn = resolve;
    });
    callIdx = 0; // next call will hold on holdFirst if we don't adjust, let's use another ask via hold
    await app.dispose();

    const quitFake = fakeClaude([{ hold: holdQuitTurn, reply: countAnswer }]);
    app = await mount({
      config: { agent: { provider: "claude" } },
      deps: { which: quitFake.which, exec: quitFake.exec },
    });
    await app.waitFor(() => app.api.session.status() === "connected" && app.api.agent.providers().length === 4);
    const quitAsking = app.api.agent.ask({ intent: "ask", text: "quit while running" });
    await app.waitFor(() => app.api.agent.running());
    await app.api.quit();
    releaseQuitTurn();
    await quitAsking;
    expect(app.deps.exits).toEqual([0]);
  });
});

describe("confirmation before running a Proposal that is not a read", () => {
  test("sixty selects and one delete at 80x24 and 140x40 shows title, summary line, delete from orders, and both buttons; confirming runs whole Proposal and cancelling leaves Buffer untouched", async () => {
    const sixtySelects = Array.from({ length: 60 }, (_, i) => `select ${i + 1};`).join("\n");
    const fullSql = `${sixtySelects}\ndelete from orders;`;
    const reply = JSON.stringify({
      action: "answer",
      message: "Run checks then delete.",
      sql: fullSql,
    });
    await start([reply], { width: 80, height: 24 });
    app.api.editor.setText("-- initial buffer");
    await app.api.agent.ask({ intent: "ask", text: "sixty selects and one delete" });
    app.api.focus.focus("agent");
    await app.settle();

    await app.press("r");
    expect(app.api.dialog.depth()).toBe(1);
    const frame80 = app.frame();
    expect(frame80).toContain("Run this statement?");
    expect(frame80).toContain("61 statements, 1 change data or structure:");
    expect(frame80).toContain("delete from orders");
    expect(frame80).not.toContain("select 1;");
    expect(frame80).toContain("Cancel");
    expect(frame80).toContain("Run");

    await app.resize(140, 40);
    const frame140 = app.frame();
    expect(frame140).toContain("Run this statement?");
    expect(frame140).toContain("61 statements, 1 change data or structure:");
    expect(frame140).toContain("delete from orders");
    expect(frame140).toContain("Cancel");
    expect(frame140).toContain("Run");

    // Cancel leaves the Buffer untouched and runs nothing
    await app.press("n");
    expect(app.api.dialog.depth()).toBe(0);
    expect(app.api.editor.text()).toBe("-- initial buffer");
    expect(await orderCount()).toBe(12);

    // Confirming runs the whole Proposal (all 61 statements)
    await app.press("r");
    expect(app.api.dialog.depth()).toBe(1);
    await app.press("y");
    await app.waitFor(() => app.api.session.shown() !== null);
    expect(app.api.editor.text()).toBe(fullSql);
    expect(await orderCount()).toBe(0);
    // The shown result is the last result that had columns (select 60 -> [[60]])
    const shown = app.api.session.shown()!;
    expect(shown.ok && shown.result.rows).toEqual([[60]]);
  });

  test("one 5,000-character DELETE line shows buttons and the … K more rows marker with the right K", async () => {
    const longLiteral = "x".repeat(4960);
    const singleDelete = `DELETE FROM orders WHERE notes = '${longLiteral}'`;
    expect(singleDelete.length).toBeGreaterThanOrEqual(4990);
    await start([JSON.stringify({ action: "answer", message: "Long delete.", sql: singleDelete })], {
      width: 80,
      height: 24,
    });
    await app.api.agent.ask({ intent: "ask", text: "long delete" });
    app.api.focus.focus("agent");
    await app.settle();

    await app.press("r");
    expect(app.api.dialog.depth()).toBe(1);
    const f = app.frame();
    expect(f).toContain("Run this statement?");
    expect(f).not.toContain("change data or structure:");
    expect(f).toContain("Cancel");
    expect(f).toContain("Run");

    const { wrapSqlLine } = await import("./transcript-model");
    const wrappedRows = wrapSqlLine(singleDelete, 56);
    const maxBodyRows = 24 - 10; // at 80x24: 14 rows for body
    const shownSqlRows = maxBodyRows - 1;
    const expectedK = wrappedRows.length - shownSqlRows;
    expect(f).toContain(`… ${expectedK} more rows · cancel, then open it in the editor`);
    await app.press("<Esc>");
  });

  test("200 Statements that are not reads shows the marker row, and sizes from 40x12 to 200x60 keep title and buttons visible on resize", async () => {
    const twoHundredDeletes = Array.from({ length: 200 }, (_, i) => `DELETE FROM orders WHERE id = ${i + 1};`).join("\n");
    await start([JSON.stringify({ action: "answer", message: "Many deletes.", sql: twoHundredDeletes })], {
      width: 80,
      height: 24,
    });
    await app.api.agent.ask({ intent: "ask", text: "200 deletes" });
    app.api.focus.focus("agent");
    await app.settle();

    await app.press("r");
    expect(app.api.dialog.depth()).toBe(1);
    expect(app.frame()).toContain("200 statements, 200 change data or structure:");
    expect(app.frame()).toMatch(/… \d+ more rows · cancel, then open it in the editor/);

    for (const [w, h] of [
      [40, 12],
      [60, 18],
      [80, 24],
      [120, 36],
      [140, 40],
      [200, 60],
    ] as const) {
      await app.resize(w, h);
      const frame = app.frame();
      expect(frame).toContain("Run this statement?");
      expect(frame).toContain("Cancel");
      expect(frame).toContain("Run");
      expect(frame).toContain("more rows");
      for (const line of frame.split("\n")) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(w);
      }
    }
    await app.press("<Esc>");
  });
});

describe("input clearing and key isolation in insert mode", () => {
  test("a question is cleared from the input only when it was accepted, and kept when refused", async () => {
    // 1. Refused because a Turn is running
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start([{ hold, reply: countAnswer }, countAnswer]);
    await app.press("<Space>ai");
    await app.press("first running question<CR>");
    await app.waitFor(() => app.api.agent.running());
    expect(app.frame()).not.toContain("> first running question");

    // Type a second question, move cursor left by 2 ("on"), press <CR> while Turn 1 is running
    await app.press("kept question<Left><Left><CR>");
    expect(app.api.status.message()?.text).toBe("The agent is still working");
    expect(app.frame()).toContain("> kept question");
    // Verify cursor was preserved (typing 'X' inserts before 'on')
    await app.press("X");
    expect(app.frame()).toContain("> kept questiXon");

    // Finish first Turn, then press <CR> to submit the kept question -> accepted and cleared
    await app.press("<BS>");
    release();
    await finished(0);
    await app.press("<CR>");
    await finished(1);
    expect(turn(1).text).toBe("kept question");
    expect(app.frame()).not.toContain("> kept question");

    // 2. Refused because no Connection
    await app.dispose();
    fake = fakeClaude([countAnswer]);
    app = await mount({
      connection: null,
      config: { agent: { provider: "claude" } },
      deps: { which: fake.which, exec: fake.exec },
    });
    await app.waitFor(() => app.api.agent.providers().length === 4);
    await app.press("<Esc>"); // dismiss startup Connections dialog
    await app.press("<Space>ai");
    await app.press("while disconnected<CR>");
    expect(app.api.status.message()).toEqual({ text: "Not connected (use :connect)", kind: "error" });
    expect(app.api.agent.turns()).toEqual([]);
    expect(app.frame()).toContain("> while disconnected");

    // 3. Refused because Provider is not set up (config changed while in insert mode)
    await app.api.session.connect("demo");
    await app.api.config.set((cfg) => ({ ...cfg, agent: { ...cfg.agent, provider: null } }));
    const accepted = await app.api.agent.ask({ intent: "ask", text: "no provider" });
    expect(accepted).toBe(false);
    expect(app.api.agent.turns()).toEqual([]);
  });

  test("a question without a Provider, or with one that is not installed, is refused with a status message and kept", async () => {
    await start([countAnswer]);
    await app.press("<Space>ai");
    await app.press("how many orders");

    // No Provider set.
    await app.api.config.set((cfg) => ({ ...cfg, agent: { ...cfg.agent, provider: null } }));
    await app.press("<CR>");
    expect(app.api.status.message()).toEqual({ text: "No agent is set up (use space p)", kind: "error" });
    expect(app.api.agent.turns()).toEqual([]);
    expect(app.api.focus.pane()).toBe("agent");
    expect(app.api.dialog.depth()).toBe(0);
    expect(await app.api.agent.ask({ intent: "ask", text: "how many orders" })).toBe(false);
    expect(app.api.status.message()).toEqual({ text: "No agent is set up (use space p)", kind: "error" });
    // The Pane hides its input while no Provider can be asked; the question is still in it after.
    await app.api.config.set((cfg) => ({ ...cfg, agent: { ...cfg.agent, provider: "claude" } }));
    await app.settle();
    expect(app.frame()).toContain("> how many orders");

    // A Provider that is not installed (the fake finds only claude).
    app.api.status.clear();
    await app.api.config.set((cfg) => ({ ...cfg, agent: { ...cfg.agent, provider: "codex" } }));
    await app.press("<CR>");
    expect(app.api.status.message()).toEqual({ text: "Codex was not found (use space p)", kind: "error" });
    expect(app.api.agent.turns()).toEqual([]);
    expect(app.api.dialog.depth()).toBe(0);
    expect(await app.api.agent.ask({ intent: "ask", text: "how many orders" })).toBe(false);
    expect(app.api.status.message()).toEqual({ text: "Codex was not found (use space p)", kind: "error" });
    await app.api.config.set((cfg) => ({ ...cfg, agent: { ...cfg.agent, provider: "claude" } }));
    await app.settle();
    expect(app.frame()).toContain("> how many orders");

    // With the Provider back, the kept question is asked.
    await app.press("<CR>");
    await finished(0);
    expect(turn(0).text).toBe("how many orders");
  });

  test("in insert mode <C-h> deletes one character before the cursor and <C-k>, <C-l>, <C-p> and <F1> are consumed without leaking", async () => {
    await start([countAnswer]);
    await app.press("<Space>ai");
    expect(app.api.focus.pane()).toBe("agent");
    expect(app.api.status.current().mode).toBe("INSERT");

    await app.press("abcd");
    expect(app.frame()).toContain("> abcd");

    // <C-h> deletes the character before the cursor and keeps focus on the Agent Pane
    await app.press("<C-h>");
    expect(app.api.focus.pane()).toBe("agent");
    expect(app.api.dialog.depth()).toBe(0);
    expect(app.frame()).toContain("> abc");
    expect(app.frame()).not.toContain("> abcd");

    // <C-k>, <C-l>, <C-p>, <F1> are consumed without moving focus or opening any dialog
    for (const key of ["<C-k>", "<C-l>", "<C-p>", "<F1>"]) {
      await app.press(key);
      expect(app.api.focus.pane()).toBe("agent");
      expect(app.api.status.current().mode).toBe("INSERT");
      expect(app.api.dialog.depth()).toBe(0);
      expect(app.frame()).toContain("> abc");
    }
  });
});

describe("clipboard copy failure reporting in the Agent Pane", () => {
  test("a failed copy says Could not copy: <reason> on the status line", async () => {
    const baseFake = fakeClaude([countAnswer]);
    app = await mount({
      config: { agent: { provider: "claude" } },
      deps: {
        write: () => {
          throw new Error("terminal write failed");
        },
        which: (bin) => {
          if (bin === "claude") return "/fake/bin/claude";
          if (bin === "pbcopy") return "/usr/bin/pbcopy";
          return null;
        },
        exec: async (req) => {
          if (req.cmd[0] === "/usr/bin/pbcopy") {
            return {
              code: 1,
              stdout: "",
              stderr: "pbcopy unavailable",
              timedOut: false,
              aborted: false,
            };
          }
          return baseFake.exec(req);
        },
      },
    });
    await app.waitFor(
      () => app.api.session.status() === "connected" && app.api.agent.providers().length === 4,
    );
    await app.api.agent.ask({ intent: "ask", text: "how many" });
    await finished();
    app.api.focus.focus("agent");
    await app.press("y");
    await app.waitFor(() => app.api.status.message() !== null);
    expect(app.api.status.message()).toEqual({
      text: "Could not copy: pbcopy failed: pbcopy unavailable",
      kind: "error",
    });
  });

  test("a successful copy writes to the clipboard and leaves the status line clear", async () => {
    await start([countAnswer]);
    await app.api.agent.ask({ intent: "ask", text: "how many" });
    await finished();
    app.api.focus.focus("agent");
    await app.press("y");
    expect(app.deps.written).toEqual([osc52("select count(*) as orders from orders")]);
    expect(app.api.status.message()).toBeNull();
  });
});






test("a failed copy that finishes after the Agent Pane is gone changes nothing", async () => {
  const [shown, setShown] = createSignal(true);
  const base = fakeClaude([countAnswer]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const copies: ExecRequest[] = [];
  app = await mount({
    config: { agent: { provider: "claude" } },
    deps: {
      write: () => {
        throw new Error("terminal write failed");
      },
      which: (bin) => (bin === "pbcopy" ? "/usr/bin/pbcopy" : base.which(bin)),
      exec: async (req): Promise<ExecResult> => {
        if (req.cmd[0] !== "/usr/bin/pbcopy") return base.exec(req);
        copies.push(req);
        await held;
        return { code: 1, stdout: "", stderr: "pbcopy broken", timedOut: false, aborted: false };
      },
    },
    ui: () => (
      <Show when={shown()}>
        <AgentPane />
      </Show>
    ),
  });
  await app.waitFor(() => app.api.session.status() === "connected" && app.api.agent.providers().length === 4);
  await app.api.agent.ask({ intent: "ask", text: "how many" });
  await finished();
  app.api.focus.focus("agent");
  await app.press("y");
  expect(copies).toHaveLength(1);
  setShown(false);
  await app.settle();
  release();
  await app.settle();
  expect(app.api.status.message()).toBeNull();
});

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The rows of the card in the frame: the text after the last "┃ " of each line that has one. */
function cardRows(frame: string): string[] {
  const rows: string[] = [];
  for (const line of frame.split("\n")) {
    const idx = line.lastIndexOf("┃ ");
    if (idx !== -1) rows.push(line.slice(idx + 2).trimEnd());
  }
  return rows;
}

/** The content box of the open confirmation, cut out of the frame by the column of its title. */
function dialogRows(frame: string, width: number): string[] {
  const lines = frame.split("\n");
  const titleIdx = lines.findIndex((l) => l.includes("Run this statement?"));
  expect(titleIdx).toBeGreaterThanOrEqual(0);
  const x0 = lines[titleIdx]!.indexOf("Run this statement?");
  const panelWidth = Math.max(10, Math.min(60, width - 4));
  const cw = Math.max(1, panelWidth - 4);
  const buttonsIdx = lines.findIndex((l, i) => i > titleIdx && l.includes("Cancel"));
  return lines.slice(titleIdx + 1, buttonsIdx).map((l) => [...l].slice(x0, x0 + cw).join("").trimEnd());
}

describe("fix 1: a Proposal is shown, accepted and run as the database reads it", () => {
  for (const [name, sep] of [
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
    ["a lone CR", "\r"],
  ] as const) {
    test(`${name}: two rows on the card, where id = 1 in the confirmation, one row deleted, two lines accepted`, async () => {
      const reply = JSON.stringify({ action: "answer", message: "Remove order 1.", sql: `delete from orders -- cleanup${sep}where id = 1` });
      await start([reply], { width: 120, height: 36 });
      app.api.editor.setText("-- buffer");
      await app.api.agent.ask({ intent: "ask", text: "remove order 1" });
      app.api.focus.focus("agent");
      await app.settle();

      const rows = cardRows(app.frame());
      const first = rows.findIndex((r) => r.startsWith("delete from orders -- cleanup"));
      expect(first).toBeGreaterThanOrEqual(0);
      expect(rows[first]).toBe("delete from orders -- cleanup");
      expect(rows[first + 1]).toBe("where id = 1");

      await app.press("<CR>");
      expect(app.api.focus.pane()).toBe("editor");
      expect(app.api.editor.text().split("\n")).toEqual(["delete from orders -- cleanup", "where id = 1"]);

      app.api.focus.focus("agent");
      await app.press("r");
      expect(app.api.dialog.depth()).toBe(1);
      expect(app.frame()).toContain("where id = 1");
      await app.press("y");
      for (let i = 0; i < 100 && (await orderCount()) === 12; i++) await app.settle();
      expect(await orderCount()).toBe(11);
    });
  }
});

describe("fix 2: a real SQL line starting with ↪ is not taken for a continuation row", () => {
  test("the ↪ is written out muted, the line is coloured as code, and a wrapped comment still continues in the comment's colour", async () => {
    const sql = "select 1 as a -- note\n↪ ; select 2\nselect 3 -- a_very_long_comment_that_continues_onto_the_next_row_of_the_card";
    await start([JSON.stringify({ action: "answer", message: "Two.", sql })], { width: 80, height: 30 });
    await app.api.agent.ask({ intent: "ask", text: "two selects" });
    app.api.focus.focus("agent");
    await app.settle();

    const rows = cardRows(app.frame());
    expect(rows).toContain("\\u21AA ; select 2");

    const theme = app.api.theme;
    const lines = app.spans().lines;
    const escapedLine = lines.find((l) => l.spans.map((s) => s.text).join("").includes("\\u21AA ; select 2"))!;
    expect(escapedLine).toBeDefined();
    const after = escapedLine.spans.slice(escapedLine.spans.findIndex((s) => s.text.includes("\\u21AA")));
    expect(after[0]!.text.trim()).toBe("\\u21AA");
    expect(after[0]!.fg).toEqual(theme.color("textMuted"));
    const selectSpan = after.find((s) => s.text.includes("select"))!;
    expect(selectSpan.fg).toEqual(theme.color("syntaxKeyword"));
    // After the written-out ↪ nothing on the row is in the comment's colour (it equals the muted one here).
    for (const span of after.slice(1)) {
      if (span.text.trim().length > 0) expect(span.fg).not.toEqual(theme.color("syntaxComment"));
    }

    let continuedComment = false;
    for (const line of lines) {
      for (const span of line.spans) {
        if (span.text.includes("next_row_of_the_card")) {
          continuedComment = true;
          expect(span.fg).toEqual(theme.color("syntaxComment"));
        }
      }
    }
    expect(continuedComment).toBe(true);

    await app.press("<CR>");
    expect(app.api.editor.text()).toBe(sql);
  });

  test("highlightSqlCardRows takes continuation from the rows, never from their text", async () => {
    const { highlightSqlCardRows } = await import("./ProposalCard");
    const pieces = highlightSqlCardRows([
      { text: "select 1 as a -- note" },
      { text: "↪ ; select 2" },
      { text: "↪ more", continuation: true },
    ]);
    expect(pieces[1]![0]).toEqual({ text: "\\u21AA", token: "textMuted" });
    expect(pieces[1]!.map((p) => p.text).join("")).toBe("\\u21AA ; select 2");
    expect(pieces[1]!.find((p) => p.text === "select")?.token).toBe("syntaxKeyword");
    expect(pieces[1]!.some((p) => p.token === "syntaxComment")).toBe(false);
    expect(pieces[2]![0]).toEqual({ text: "↪ ", token: "textMuted" });
  });
});

describe("fix 4: the confirmation shows every character of a Statement it lists", () => {
  const cases: [string, string][] = [
    ["30 tabs", "\t".repeat(30)],
    ["80 tabs", "\t".repeat(80)],
    ["5,000 tabs", "\t".repeat(5000)],
    ["80 U+000B", "\u000b".repeat(80)],
  ];
  for (const [w, h] of [[80, 24], [140, 40]] as const) {
    for (const [name, filler] of cases) {
      test(`${name} at ${w}x${h}: or true or the marker row is in the frame, and no body row is wider than the content box`, async () => {
        const sql = `delete from orders where id = 1${filler} or true`;
        await start([JSON.stringify({ action: "answer", message: "Delete one.", sql })], { width: w, height: h });
        await app.api.agent.ask({ intent: "ask", text: "delete" });
        app.api.focus.focus("agent");
        await app.settle();
        await app.press("r");
        expect(app.api.dialog.depth()).toBe(1);
        const body = dialogRows(app.frame(), w);
        expect(body.some((r) => r.includes("or true") || /… \d+ more rows/.test(r))).toBe(true);
        const { confirmBodyRows } = await import("../../context/agent");
        const cw = Math.min(60, w - 4) - 4;
        for (const row of confirmBodyRows(sql, cw)) {
          if (row.kind === "sql") expect(Bun.stringWidth(row.shown)).toBeLessThanOrEqual(cw);
        }
        await app.press("<Esc>");
        expect(await orderCount()).toBe(12);
      });
    }
  }

  test("property: over 500 seeded Statements the body rows of each Statement join to its cleaned text", async () => {
    const { confirmBodyRows } = await import("../../context/agent");
    const { printable } = await import("../../ui/printable");
    const { splitStatements } = await import("../../../core/sql/statements");
    const { classify } = await import("../../../core/sql/classify");
    const alphabet = ["\t", "\t", "\u000b", "\u0000", "\u001b", "\u0085", "\u009b", "\u007f", "漢", "字", "🚀", "👍🏽", "é", "↪", "a", "x", "1", " ", " ", "'", "\n"];
    const rand = seededRandom(500);
    for (let n = 0; n < 500; n++) {
      let tail = "";
      const len = Math.floor(rand() * 120);
      for (let i = 0; i < len; i++) tail += alphabet[Math.floor(rand() * alphabet.length)]!;
      const sql = `delete from orders where id = ${n} ${tail.replace(/'/g, "")} or true`;
      const cw = 6 + Math.floor(rand() * 51);
      const rows = confirmBodyRows(sql, cw);
      const statements = splitStatements(sql).map((s) => s.text).filter((s) => classify(s) !== "read");
      const joined: string[][] = [];
      for (const row of rows) {
        if (row.kind !== "sql") continue;
        expect(Bun.stringWidth(row.shown) <= cw || [...new Intl.Segmenter().segment(row.text)].length <= 3).toBe(true);
        const lines = (joined[row.statement] ??= []);
        if (row.continuation) {
          expect(row.text.startsWith("↪ ")).toBe(true);
          lines[lines.length - 1] += row.text.slice(2);
        } else {
          lines.push(row.text);
        }
      }
      expect(joined.map((lines) => lines.join("\n"))).toEqual(
        statements.map((s) => s.split("\n").map((l) => printable(l)).join("\n")),
      );
    }
  });
});

describe("fix 5: only the Agent decides whether a request is accepted", () => {
  test("while an optimize request waits for its explain, a typed question stays in the input", async () => {
    const { openSession } = await import("../../../core/db/connection");
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await start([countAnswer, countAnswer], {
      deps: {
        openSession: async (connection) => {
          const driver = await openSession(connection);
          const run = driver.run.bind(driver);
          driver.run = async (sql, opts) => {
            if (/^\s*explain/i.test(sql)) await held;
            return run(sql, opts);
          };
          return driver;
        },
      },
    });
    app.api.editor.setText("select * from orders");
    const optimizing = app.api.agent.ask({ intent: "optimize" });
    expect(optimizing.accepted).toBe(true);
    app.api.focus.focus("agent");
    await app.press("i");
    await app.press("next question<CR>");
    expect(app.frame()).toContain("> next question");
    expect(app.api.status.message()?.text).toBe("The agent is still working");

    release();
    expect(await optimizing).toBe(true);
    await finished(0);
    expect(app.api.agent.turns().length).toBe(1);
    await app.press("<CR>");
    await finished(1);
    expect(turn(1).text).toBe("next question");
    expect(app.frame()).not.toContain("> next question");
  });

  test("ask says at once whether it accepted the request", async () => {
    await start([countAnswer]);
    const empty = app.api.agent.ask({ intent: "ask", text: "   " });
    expect(empty.accepted).toBe(false);
    expect(await empty).toBe(false);
    const asked = app.api.agent.ask({ intent: "ask", text: "how many" });
    expect(asked.accepted).toBe(true);
    const refused = app.api.agent.ask({ intent: "ask", text: "again" });
    expect(refused.accepted).toBe(false);
    expect(await refused).toBe(false);
    expect(await asked).toBe(true);
  });
});

describe("fix 6: the summary and the marker of the confirmation are readable", () => {
  const sizes = [
    { digits: 1, statements: 5 },
    { digits: 3, statements: 150 },
    { digits: 5, statements: 10500 },
  ];
  for (const { digits, statements } of sizes) {
    test(`counts of ${digits} digit(s) at dialog widths 30 to 60: both texts are in the frame whole`, async () => {
      // Short Statements keep the reply under the 200,000-character limit of a reply.
      const sql = Array.from({ length: statements }, () => "delete from x;").join("\n");
      const height = digits === 1 ? 18 : 24;
      await start([JSON.stringify({ action: "answer", message: "Delete.", sql })], { width: 64, height });
      await app.api.agent.ask({ intent: "ask", text: "delete" });
      app.api.focus.focus("agent");
      await app.settle();
      await app.press("r");
      expect(app.api.dialog.depth()).toBe(1);
      for (const dialogWidth of [30, 36, 42, 48, 54, 60]) {
        const w = dialogWidth + 4;
        await app.resize(w, height);
        const body = dialogRows(app.frame(), w);
        const text = body.filter((r) => r.length > 0).join(" ");
        expect(text).toContain(`${statements} statements, ${statements} change data or structure:`);
        const k = /… (\d+) more rows/.exec(text);
        expect(k).not.toBeNull();
        expect(text).toContain(`… ${k![1]} more rows · cancel, then open it in the editor`);
        if (digits === 5) expect(k![1]!.length).toBe(5);
        if (digits === 3) expect(k![1]!.length).toBe(3);
      }
      await app.press("<Esc>");
    });
  }
});

describe("final fix 1: the Conversation belongs to the Connection it was held on", () => {
  const deleteAnswer = '{"action":"answer","message":"This deletes every order.","sql":"delete from orders"}';
  const otherPath = () => join(app.deps.cwd, "other.db");
  const seedOther = (setup: string) => async (deps: { cwd: string }) => {
    const db = new Database(join(deps.cwd, "other.db"));
    db.run(setup);
    db.close();
  };
  const withOrders = seedOther("create table orders (id integer primary key); insert into orders (id) values (1), (2), (3);");
  const otherOrders = () => {
    const db = new Database(otherPath(), { readonly: true });
    try {
      return (db.query("select count(*) as n from orders").get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  test("a write Proposal made on demo is gone after connecting to another database, and r then y changes nothing there", async () => {
    await start([deleteAnswer], { seed: withOrders });
    await app.api.agent.ask({ intent: "ask", text: "wipe the orders" });
    expect(turn().proposal).toMatchObject({ sql: "delete from orders", kind: "write" });
    app.api.focus.focus("agent");
    await app.settle();
    expect(app.frame()).toContain("delete from orders");

    expect(await app.api.session.connect(otherPath())).toEqual({ ok: true });
    await app.settle();
    expect(app.api.agent.turns()).toEqual([]);
    expect(app.api.agent.proposals()).toEqual([]);
    expect(app.api.agent.selected()).toBeNull();
    expect(app.frame()).not.toContain("delete from orders");
    expect(app.frame()).not.toContain("wipe the orders");

    app.api.focus.focus("agent");
    await app.press("r");
    expect(app.api.dialog.depth()).toBe(0);
    await app.press("y");
    await app.settle();
    expect(otherOrders()).toBe(3);
  });

  test("rows of the first database are not sent with a question on the second", async () => {
    await start([countQuery, countAnswer, '{"action":"answer","message":"One table."}'], {
      seed: seedOther("create table t (x integer)"),
    });
    await app.api.agent.ask({ intent: "ask", text: "how many orders are there" });
    expect(fake.prompts[1]).toContain('"rows":[[12]]');

    expect(await app.api.session.connect(otherPath())).toEqual({ ok: true });
    await app.waitFor(() => app.api.session.schema() !== null);
    expect(app.api.agent.turns()).toEqual([]);

    await app.api.agent.ask({ intent: "ask", text: "which tables are there" });
    const prompt = fake.prompts[2]!;
    expect(prompt).toContain("which tables are there");
    expect(prompt).toContain("t(x integer");
    for (const old of ["how many orders are there", "select count(*) as n from orders", '"rows":[[12]]', "There are 12 orders.", "select count(*) as orders from orders"]) {
      expect(prompt).not.toContain(old);
    }
    expect(app.api.agent.turns().length).toBe(1);
  });

  test("connecting to the same Connection again keeps the Conversation, and its Proposal still runs", async () => {
    await start([countAnswer, '{"action":"answer","message":"Second."}']);
    await app.api.agent.ask({ intent: "ask", text: "how many orders" });
    const before = app.api.session.driver();
    expect(await app.api.session.connect("demo")).toEqual({ ok: true });
    expect(app.api.session.driver()).not.toBe(before);
    await app.settle();
    expect(app.api.agent.turns().length).toBe(1);
    expect(app.api.agent.selected()).toMatchObject({ sql: "select count(*) as orders from orders" });

    app.api.focus.focus("agent");
    await app.press("r");
    await app.waitFor(() => app.api.session.shown() !== null);
    const shown = app.api.session.shown()!;
    expect(shown.ok && shown.result.rows).toEqual([[12]]);

    await app.api.agent.ask({ intent: "ask", text: "and again" });
    expect(fake.prompts[1]).toContain("how many orders");
  });

  test("a lost connection that is opened again keeps the Conversation, and its Proposal still runs", async () => {
    const { QueryError } = await import("../../../core/db/types");
    let runs = 0;
    const result = { columns: [{ name: "x", type: "integer" }], rows: [[1]], truncated: false, affected: null, command: "SELECT", durationMs: 1 };
    await start(['{"action":"answer","message":"One.","sql":"select 1 as x"}'], {
      connection: "postgres://localhost/dev",
      deps: {
        openSession: async (connection) => ({
          connection,
          run: async () => {
            runs++;
            if (runs === 1) throw new QueryError("write CONNECTION_CLOSED localhost:5432", { code: "CONNECTION_CLOSED" });
            return result;
          },
          schema: async () => ({ dialect: "postgres", namespaces: [] }),
          close: async () => {},
        }),
      },
    });
    await app.api.agent.ask({ intent: "ask", text: "give me one" });
    const before = app.api.session.driver();
    const [outcome] = await app.api.session.run({ statements: ["select 1"] });
    expect(outcome!.ok).toBe(true);
    expect(app.api.session.driver()).not.toBe(before);
    await app.settle();
    expect(app.api.agent.turns().length).toBe(1);

    app.api.session.show(null);
    app.api.focus.focus("agent");
    await app.press("r");
    await app.waitFor(() => app.api.session.shown() !== null);
    const shown = app.api.session.shown()!;
    expect(shown.ok && shown.statement).toBe("select 1 as x");
  });

  test("a Connection change while a Turn runs abandons it: nothing of it appears afterwards, and its late reply changes nothing", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const baseFake = fakeClaude([countAnswer]);
    let calls = 0;
    const exec: typeof baseFake.exec = async (req) => {
      if (req.cmd.includes("--version")) return baseFake.exec(req);
      if (++calls === 1) {
        // Ignores the abort, so that its reply arrives late.
        await hold;
        const text = deleteAnswer;
        req.onStdoutLine?.(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
        req.onStdoutLine?.(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }));
        return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
      }
      return baseFake.exec(req);
    };
    fake = baseFake;
    app = await mount({ config: { agent: { provider: "claude" } }, deps: { which: baseFake.which, exec }, seed: withOrders });
    await app.waitFor(() => app.api.session.status() === "connected" && app.api.agent.providers().length === 4);

    const first = app.api.agent.ask({ intent: "ask", text: "first slow question" });
    await app.waitFor(() => app.api.agent.running());
    expect(await app.api.session.connect(otherPath())).toEqual({ ok: true });
    await app.settle();
    expect(app.api.agent.turns()).toEqual([]);
    expect(app.api.agent.running()).toBe(false);

    release();
    await first;
    await app.settle();
    expect(app.api.agent.turns()).toEqual([]);
    expect(app.api.agent.proposals()).toEqual([]);
    expect(app.frame()).not.toContain("first slow question");

    await app.api.agent.ask({ intent: "ask", text: "second question" });
    expect(app.api.agent.turns().map((t) => t.text)).toEqual(["second question"]);
    expect(baseFake.prompts[baseFake.prompts.length - 1]).not.toContain("first slow question");
    expect(otherOrders()).toBe(3);
  });

  // The reset after a Connection change empties the Conversation, so a stale Proposal can only be
  // reached through a reference held from before the change (as the Agent Pane holds one while its
  // confirmation is open): the tests keep the object and pass it to the Agent afterwards.
  test("a Proposal held from before a Connection change is refused by run and by accept", async () => {
    await start([deleteAnswer], { seed: withOrders });
    await app.api.agent.ask({ intent: "ask", text: "wipe the orders" });
    const stale = app.api.agent.selected()!;
    expect(await app.api.session.connect(otherPath())).toEqual({ ok: true });
    await app.settle();

    await app.api.agent.run(stale);
    expect(app.api.dialog.depth()).toBe(0);
    expect(app.api.status.message()).toEqual({ text: "This proposal was made for another connection", kind: "error" });
    expect(otherOrders()).toBe(3);

    app.api.status.clear();
    app.api.agent.accept(stale);
    expect(app.api.status.message()).toEqual({ text: "This proposal was made for another connection", kind: "error" });
    expect(app.api.editor.buffers().map((b) => b.name)).toEqual(["scratch"]);
    expect(app.api.editor.text()).not.toContain("delete from orders");
  });

  test("a confirmation that was open while the Connection changed runs nothing when confirmed", async () => {
    await start([deleteAnswer], { seed: withOrders });
    await app.api.agent.ask({ intent: "ask", text: "wipe the orders" });
    app.api.focus.focus("agent");
    await app.press("r");
    expect(app.api.dialog.depth()).toBe(1);

    expect(await app.api.session.connect(otherPath())).toEqual({ ok: true });
    await app.settle();
    expect(app.api.dialog.depth()).toBe(1);
    await app.press("y");
    await app.settle();
    expect(app.api.dialog.depth()).toBe(0);
    expect(app.api.status.message()).toEqual({ text: "This proposal was made for another connection", kind: "error" });
    expect(otherOrders()).toBe(3);
    expect(app.api.session.shown()).toBeNull();
    expect(app.api.editor.buffers().map((b) => b.name)).toEqual(["scratch"]);
  });
});

describe("final-c2 fix 1: in schema mode no value of a row leaves the machine through an error", () => {
  const SECRET = "SECRET-VALUE@example.com";
  const fixAnswer = '{"action":"answer","message":"Cast it differently.","sql":"select email from t"}';
  const laterAnswer = '{"action":"answer","message":"Later."}';

  /** A Postgres Driver that fails the two reproductions of the review as the server does. */
  const fakePostgres = async (connection: import("../../../core/db/types").Connection) => {
    const { QueryError } = await import("../../../core/db/types");
    return {
      connection,
      run: async (statement: string) => {
        if (statement.startsWith("select email::int")) {
          throw new QueryError(`invalid input syntax for type integer: "${SECRET}"`, { code: "22P02", position: 8 });
        }
        if (statement.startsWith("insert into t2")) {
          throw new QueryError('duplicate key value violates unique constraint "t2_email_key"', {
            code: "23505",
            detail: `Key (email)=(${SECRET}) already exists.`,
          });
        }
        return { columns: [], rows: [], truncated: false, affected: 0, command: "SELECT", durationMs: 1 };
      },
      schema: async () => ({
        dialect: "postgres" as const,
        namespaces: [{ name: "public", relations: [{ name: "t", kind: "table" as const, columns: [{ name: "email", type: "text", nullable: false, primaryKey: false }] }] }],
      }),
      close: async () => {},
    };
  };

  const reproductions = ["select email::int from t", "insert into t2 (email) select email from t"];

  for (const statement of reproductions) {
    test(`schema mode: the fix request after "${statement}" and a later Turn do not carry the value`, async () => {
      await start([fixAnswer, laterAnswer], {
        connection: "postgres://127.0.0.1:1/fake",
        config: { agent: { provider: "claude", dataAccess: "schema" } },
        deps: { openSession: fakePostgres },
      });
      const [outcome] = await app.api.session.run({ statements: [statement] });
      expect(outcome!.ok).toBe(false);
      await app.press("<Space>af");
      await finished();
      expect(fake.prompts.length).toBe(1);
      expect(fake.prompts[0]).toContain("This statement failed. Fix it.");
      expect(fake.prompts[0]).toContain(statement);
      expect(fake.prompts[0]).not.toContain(SECRET);
      expect(fake.prompts[0]).not.toContain("SECRET");
      expect(fake.prompts[0]).toMatch(/22P02: invalid input syntax for type integer: …|23505: duplicate key value violates unique constraint …/);

      await app.api.agent.ask({ intent: "ask", text: "and now?" });
      expect(fake.prompts.length).toBe(2);
      expect(fake.prompts[1]).toContain("and now?");
      expect(fake.prompts[1]).not.toContain("SECRET");
    });

    test(`rows mode: the fix request after "${statement}" carries the error as before`, async () => {
      await start([fixAnswer], {
        connection: "postgres://127.0.0.1:1/fake",
        config: { agent: { provider: "claude", dataAccess: "rows" } },
        deps: { openSession: fakePostgres },
      });
      await app.api.session.run({ statements: [statement] });
      await app.press("<Space>af");
      await finished();
      expect(fake.prompts[0]).toContain(SECRET);
    });
  }

  test("schema mode on SQLite: an unknown column is sent whole", async () => {
    await start([fixAnswer], { config: { agent: { provider: "claude", dataAccess: "schema" } } });
    await app.api.session.run({ statements: ["select emial from orders"] });
    await app.press("<Space>af");
    await finished();
    expect(fake.prompts[0]).toContain("no such column: emial");
  });

  const pgUrl = process.env.LOSQL_TEST_PG_URL;
  test.skipIf(!pgUrl)("on the throwaway server: neither reproduction sends the value in schema mode", async () => {
    const { openPostgres } = await import("../../../core/db/postgres");
    const schemaName = `losql_c2_fix1_${process.pid}_${Date.now()}`;
    const admin = await openPostgres({ id: "admin", name: "admin", dialect: "postgres", url: pgUrl!, display: "admin" });
    try {
      await admin.run(`create schema ${schemaName}`);
      await admin.run(`create table ${schemaName}.t (email text not null)`);
      await admin.run(`create table ${schemaName}.t2 (email text unique)`);
      await admin.run(`insert into ${schemaName}.t values ('${SECRET}')`);
      await admin.run(`insert into ${schemaName}.t2 values ('${SECRET}')`);

      for (const [index, mode] of (["schema", "rows"] as const).entries()) {
        await start([fixAnswer, fixAnswer, laterAnswer], {
          connection: pgUrl!,
          config: { agent: { provider: "claude", dataAccess: mode } },
        });
        const statements = [`select email::int from ${schemaName}.t`, `insert into ${schemaName}.t2 (email) select email from ${schemaName}.t`];
        for (const [i, statement] of statements.entries()) {
          const [outcome] = await app.api.session.run({ statements: [statement] });
          expect(outcome!.ok).toBe(false);
          await app.api.agent.ask({ intent: "fix" });
          expect(fake.prompts.length).toBe(i + 1);
          if (mode === "schema") {
            expect(fake.prompts[i]).not.toContain("SECRET");
          } else {
            expect(fake.prompts[i]).toContain(SECRET);
          }
        }
        if (mode === "schema") {
          await app.api.agent.ask({ intent: "ask", text: "and now?" });
          expect(fake.prompts[2]).not.toContain("SECRET");
        }
        if (index === 0) await app.dispose();
      }
    } finally {
      await admin.run(`drop schema ${schemaName} cascade`).catch(() => {});
      await admin.close();
    }
  });
});

describe("Provider processes do not inherit the variables a saved Connection reads its password from", () => {
  const savedUrl = "postgres://u:${DBPW}@127.0.0.1:54329/x";

  test("the detection and a Turn get an environment without DBPW, and a Connection saved later counts", async () => {
    const envs: { cmd: string[]; env: Record<string, string | undefined> | undefined }[] = [];
    const base = fakeClaude([countAnswer]);
    const exec: typeof base.exec = async (req) => {
      envs.push({ cmd: req.cmd, env: req.env });
      return base.exec(req);
    };
    await start([countAnswer], {
      config: { agent: { provider: "claude" }, connections: [{ name: "saved", url: savedUrl }] },
      deps: { which: base.which, exec, env: { DBPW: "hunter2", PATH: "/usr/bin:/bin", OTHERPW: "later" } },
    });
    fake = base;
    const detection = envs.filter((e) => e.cmd.includes("--version"));
    expect(detection.length).toBeGreaterThan(0);
    for (const e of detection) {
      expect(e.env).toBeDefined();
      expect(e.env!.DBPW).toBeUndefined();
      expect(e.env!.PATH).toBe("/usr/bin:/bin");
    }

    await app.api.config.set((c) => ({ ...c, connections: [...c.connections, { name: "new", url: "postgres://u:${OTHERPW}@127.0.0.1:54329/y" }] }));
    envs.length = 0;
    await app.api.agent.ask({ intent: "ask", text: "x" });
    await finished();
    const turnCalls = envs.filter((e) => !e.cmd.includes("--version"));
    expect(turnCalls.length).toBeGreaterThan(0);
    for (const e of turnCalls) {
      expect(e.env).toBeDefined();
      expect(e.env!.DBPW).toBeUndefined();
      expect(e.env!.OTHERPW).toBeUndefined();
      expect(e.env!.PATH).toBe("/usr/bin:/bin");
    }

    envs.length = 0;
    await app.api.agent.detect();
    expect(envs.length).toBeGreaterThan(0);
    for (const e of envs) {
      expect(e.env!.DBPW).toBeUndefined();
      expect(e.env!.OTHERPW).toBeUndefined();
      expect(e.env!.PATH).toBe("/usr/bin:/bin");
    }
  });
});
