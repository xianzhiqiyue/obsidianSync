import { copyFile, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} 执行失败，退出码 ${code}`));
    });
  });
}

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await run("tsc", ["-p", "tsconfig.json"]);
await Promise.all([copyFile("index.html", "dist/index.html"), copyFile("styles.css", "dist/styles.css")]);
