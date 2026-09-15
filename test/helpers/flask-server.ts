import { type ChildProcess, spawn } from "node:child_process";

export interface FlaskServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

const OPERATOR_USER = "operator";
const OPERATOR_PASS = "changeme123";

export { OPERATOR_USER, OPERATOR_PASS };

export async function startFlaskServer(port: number): Promise<FlaskServer> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn("python3", ["app.py"], {
    env: {
      ...process.env,
      TENANT: "first_credit_union",
      PORT: String(port),
      OPERATOR_USER,
      OPERATOR_PASS,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });

  await waitForReady(baseUrl);

  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

async function waitForReady(baseUrl: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/login`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // server not accepting connections yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`flask server at ${baseUrl} did not become ready within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
