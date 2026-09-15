import type { Locator, Page } from "playwright";
import type { Checkpoint } from "../schema/capability.js";
import type { AriaRole } from "./locate.js";

type DetectScope = Page | Locator;

/**
 * Evaluates a single declared checkpoint against the current page. Used for
 * a step's own checkpoint, and identically for every declared outcome and
 * recoverable detector — detection is one code path regardless of who
 * declared the checkpoint.
 */
export async function checkpointMatches(page: Page, checkpoint: Checkpoint): Promise<boolean> {
  switch (checkpoint.kind) {
    case "url_matches":
      return new RegExp(checkpoint.pattern).test(page.url());

    case "text_present": {
      const scope: DetectScope = checkpoint.within ? page.locator(checkpoint.within) : page.locator("body");
      if ((await scope.count()) === 0) {
        return false;
      }
      const text = await scope.first().innerText();
      return new RegExp(checkpoint.pattern).test(text);
    }

    case "element_present": {
      const root: DetectScope = checkpoint.within ? page.locator(checkpoint.within) : page;
      const locator = buildElementPresentLocator(root, checkpoint);
      return (await locator.count()) > 0;
    }
  }
}

function buildElementPresentLocator(
  root: DetectScope,
  checkpoint: Extract<Checkpoint, { kind: "element_present" }>,
): Locator {
  const { role, name, name_pattern: namePattern } = checkpoint;

  if (role && namePattern) {
    return root.getByRole(role as AriaRole, { name: new RegExp(namePattern) });
  }
  if (role && name) {
    return root.getByRole(role as AriaRole, { name });
  }
  if (role) {
    return root.getByRole(role as AriaRole);
  }
  if (namePattern) {
    return root.getByText(new RegExp(namePattern));
  }
  if (name) {
    return root.getByText(name, { exact: true });
  }
  // A checkpoint with none of role/name/name_pattern declared is only
  // meaningful when it has a `within` container to check for presence of.
  if (typeof root === "object" && "first" in root) {
    return root;
  }
  return root.locator("body");
}

/** A trimmed, human-useful description of the current page for a hard-failure result — never a stack trace. */
export async function describeObserved(page: Page): Promise<string> {
  const text = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  const trimmed = text.replace(/\s+/g, " ").trim().slice(0, 500);
  return `url=${page.url()}; visible_text="${trimmed}"`;
}
