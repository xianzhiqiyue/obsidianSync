import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.ADMIN_PORT ?? 5173);
const root = join(process.cwd(), "dist");
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"]
]);

function resolvePath(url) {
  const pathname = new URL(url ?? "/", `http://localhost:${port}`).pathname;
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^\.\.(?:\/|$)/, "");
  return join(root, safePath);
}

const server = createServer(async (request, response) => {
  const filePath = resolvePath(request.url);

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "content-type": contentTypes.get(extname(filePath)) ?? "application/octet-stream" });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

server.listen(port, () => {
  console.log(`管理后台预览服务已启动：http://localhost:${port}`);
});
