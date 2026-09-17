/**
 * The operator surface: a minimal local HTTP server mocking the UI a human
 * uses to service an escalation, not the mechanism (that lives in
 * ./escalation.ts and Session's state machine). Deliberately built on plain
 * node:http rather than a framework — this is four routes and a couple of
 * server-rendered HTML pages, not an application.
 *
 * The browser the human acts in is the SAME headed Playwright window the
 * escalated run was using — this server only flips the session's control
 * state and signals its condition variables; it never drives the page
 * itself.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import {
  abandonIntervention,
  claimIntervention,
  escalationRegistry,
  resumeIntervention,
  type EscalationHandle,
} from "../engine/escalation.js";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function sendRedirect(res: ServerResponse, location: string): void {
  // 303, not 302: turns the POST into a GET on the redirect target, which
  // is what lets the browser land on a normal page instead of re-POSTing
  // (and showing a "resubmit form?" prompt) on refresh.
  res.writeHead(303, { location });
  res.end();
}

/**
 * True for an actual browser navigating via the plain <form> buttons on the
 * detail page (Accept: text/html, ...) — those should land back on a real
 * page, not a JSON blob. False for a programmatic caller (curl, fetch,
 * a script) that didn't ask for HTML, which gets the JSON body instead.
 */
function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? "").includes("text/html");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  code, pre { background: #f4f4f4; padding: 0.15rem 0.3rem; border-radius: 3px; }
  pre { padding: 0.75rem; overflow-x: auto; }
  form { display: inline; }
  button { padding: 0.4rem 0.8rem; margin-right: 0.5rem; cursor: pointer; }
  .status { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 3px; background: #eee; }
  img.screenshot { max-width: 100%; border: 1px solid #ccc; margin-top: 1rem; }
</style>
</head>
<body>${body}</body>
</html>`;
}

function renderList(handles: EscalationHandle[]): string {
  if (handles.length === 0) {
    return "<p>No pending interventions.</p>";
  }
  const rows = handles
    .map((handle) => {
      const r = handle.record;
      return `<tr>
        <td><a href="/interventions/${escapeHtml(r.intervention_id)}">${escapeHtml(r.intervention_id)}</a></td>
        <td>${escapeHtml(r.context.capability)}</td>
        <td>${escapeHtml(r.reason.trigger)}</td>
        <td>${escapeHtml(r.context.current_step)}</td>
        <td><span class="status">${escapeHtml(r.status)}</span></td>
      </tr>`;
    })
    .join("\n");
  return `<table>
    <thead><tr><th>Intervention</th><th>Capability</th><th>Trigger</th><th>Stuck step</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderDetail(handle: EscalationHandle): string {
  const r = handle.record;
  const canClaim = r.status === "pending";
  const canResume = r.status === "claimed";
  const canAbandon = r.status === "pending" || r.status === "claimed";
  return `
  <p><a href="/interventions">&larr; back to pending list</a></p>
  <h1>Intervention ${escapeHtml(r.intervention_id)}</h1>
  <p>Status: <span class="status">${escapeHtml(r.status)}</span></p>
  <h2>Reason</h2>
  <p><strong>${escapeHtml(r.reason.trigger)}</strong>: ${escapeHtml(r.reason.detail)}</p>
  <h2>Context</h2>
  <table>
    <tr><th>Capability</th><td>${escapeHtml(r.context.capability)}</td></tr>
    <tr><th>Goal</th><td>${escapeHtml(r.context.goal)}</td></tr>
    <tr><th>Current step</th><td>${escapeHtml(r.context.current_step)}</td></tr>
    <tr><th>Steps completed</th><td>${escapeHtml(r.context.steps_completed.join(", ") || "(none)")}</td></tr>
    <tr><th>Current URL</th><td>${escapeHtml(r.context.current_url)}</td></tr>
  </table>
  <h2>Resume contract</h2>
  <p>What "done" looks like — once this holds, the run continues from step <code>${escapeHtml(r.resume_contract.next_step)}</code>:</p>
  <pre>${escapeHtml(r.resume_contract.expected_state)}</pre>
  <img class="screenshot" src="/interventions/${escapeHtml(r.intervention_id)}/screenshot" alt="page state at escalation" />
  <h2>Actions</h2>
  <form method="POST" action="/interventions/${escapeHtml(r.intervention_id)}/claim">
    <button type="submit" ${canClaim ? "" : "disabled"}>Claim (take over the browser)</button>
  </form>
  <form method="POST" action="/interventions/${escapeHtml(r.intervention_id)}/resume">
    <button type="submit" ${canResume ? "" : "disabled"}>Resume (hand back to automation)</button>
  </form>
  <form method="POST" action="/interventions/${escapeHtml(r.intervention_id)}/abandon">
    <button type="submit" ${canAbandon ? "" : "disabled"}>Abandon (terminate the run)</button>
  </form>
  `;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && parts.length === 1 && parts[0] === "interventions") {
    sendHtml(res, 200, page("Pending interventions", `<h1>Pending interventions</h1>${renderList(escalationRegistry.listPending())}`));
    return;
  }

  if (req.method === "GET" && parts.length === 2 && parts[0] === "interventions") {
    const handle = escalationRegistry.get(parts[1] ?? "");
    if (!handle) {
      sendHtml(res, 404, page("Not found", "<p>No such intervention (it may have already been resolved).</p>"));
      return;
    }
    sendHtml(res, 200, page(`Intervention ${handle.record.intervention_id}`, renderDetail(handle)));
    return;
  }

  if (req.method === "GET" && parts.length === 3 && parts[0] === "interventions" && parts[2] === "screenshot") {
    const handle = escalationRegistry.get(parts[1] ?? "");
    if (!handle?.record.context.screenshot_path) {
      res.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(handle.record.context.screenshot_path);
      res.writeHead(200, { "content-type": "image/png" });
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
    return;
  }

  if (req.method === "POST" && parts.length === 3 && parts[0] === "interventions") {
    const interventionId = parts[1] ?? "";
    const handle = escalationRegistry.get(interventionId);
    const action = parts[2];
    const html = wantsHtml(req);

    if (!handle) {
      if (html) {
        sendRedirect(res, "/interventions");
        return;
      }
      sendJson(res, 404, { error: "no such intervention (it may have already been resolved)" });
      return;
    }

    // After claim/resume the intervention still exists (detail page shows
    // its updated status); after abandon it's gone from the registry, so a
    // browser lands on the list instead of a 404 for the id it just removed.
    const redirectTarget = `/interventions/${interventionId}`;

    try {
      if (action === "claim") {
        await claimIntervention(handle);
      } else if (action === "resume") {
        await resumeIntervention(handle);
      } else if (action === "abandon") {
        await abandonIntervention(handle);
        escalationRegistry.remove(handle.record.intervention_id);
      } else {
        if (html) {
          sendRedirect(res, redirectTarget);
          return;
        }
        sendJson(res, 404, { error: `unknown action "${action ?? ""}"` });
        return;
      }
      if (html) {
        sendRedirect(res, action === "abandon" ? "/interventions" : redirectTarget);
        return;
      }
      sendJson(res, 200, { status: handle.record.status });
    } catch (err) {
      if (html) {
        sendRedirect(res, redirectTarget);
        return;
      }
      sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  res.writeHead(404).end();
}

export function startOperatorServer(port: number): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      console.error("operator server request failed:", err);
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    });
  });
  server.listen(port);
  return server;
}
