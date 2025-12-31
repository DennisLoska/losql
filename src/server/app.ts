import { sql } from "bun";

namespace Server {
  export async function start() {
    console.log("Losql server started");

    Bun.serve({
      port: 3000,
      routes: {
        "/api/sql": async (req) => {
          // const body = req.body?.json();
          // const { query } = body;

          // Off course we want to inject SQL from the client!
          // It's an SQL editor after all, might add a serializer if needed
          const res = await sql`select * from calls limit 5`;
          const json = JSON.stringify(res);
          return new Response(json);
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
