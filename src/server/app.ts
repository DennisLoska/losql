import { sql } from "bun";

namespace Server {
  export async function start() {
    console.log("Losql server started");

    Bun.serve({
      port: 3000,
      routes: {
        "/api/sql": async (req) => {
          try {
            const body = await req.body?.json();
            // Of course we want to inject SQL from the client!
            // It's an SQL editor after all!
            const res = await sql.unsafe(body.query);
            const report = await sql.unsafe(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON ) ${body.query}`,
            );
            const json = JSON.stringify({ results: res, report, error: null });
            return new Response(json);
          } catch (error) {
            console.log(error);
            return new Response(
              JSON.stringify({ results: null, report: null, error }),
            );
          }
        },

        "/api/lsp": () => {
          return new Response("TODO: add LSP support for SQL editor\n");
        },
      },

      fetch() {
        return new Response("Not Found", { status: 404 });
      },
    });
  }
}

Server.start();
