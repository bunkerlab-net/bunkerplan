import { hydrateRoot } from "hono/jsx/dom/client";
import { PAGE_PROPS_ID, ROOT_ID } from "./mount.ts";
import type { PageProps } from "./page-props.ts";
import { Page } from "./pages.tsx";
import "../styles.css";

/**
 * Hydrates the markup the server already rendered.
 *
 * The 404 carries no props element and is left alone: it is static, and it is
 * what `/p/{unknown}` falls through to, where there is no session to resolve.
 */
const element = document.getElementById(PAGE_PROPS_ID);
const root = document.getElementById(ROOT_ID);

if (element !== null && root !== null) {
  const props = JSON.parse(element.textContent ?? "{}") as PageProps;
  hydrateRoot(root, <Page {...props} />);
}
