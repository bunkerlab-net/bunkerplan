/**
 * Everything a page needs that only the server knows. Serialised into the
 * document and read back on hydration, so both renders start from the same
 * inputs - which is what keeps the markup identical.
 *
 * A union rather than one widened shape: the gate carries a plan id and
 * whether that plan has a share code, and neither is meaningful anywhere
 * else. `Page` narrows on `name`, so a page cannot read a field its own
 * renderer was never handed.
 *
 * Their own module, apart from the components that render them, because
 * `pages.tsx` renders `PlanGate` and `PlanGate` needs the shape it is handed:
 * declared there, the two import each other. A type-only import compiles fine
 * and still reads as a cycle to every tool that walks the import graph, and the
 * next thing anyone adds across that edge is a value. Nothing is imported here,
 * so there is no edge to add.
 */
interface BasePageProps {
  path: string;
  origin: string;
}

export interface LandingProps extends BasePageProps {
  name: "landing";
}

export interface DashboardProps extends BasePageProps {
  name: "dashboard";
}

export interface GateProps extends BasePageProps {
  name: "gate";
  planId: string;
  hasCode: boolean;
  /**
   * True on `/s/{id}`, the trusted page a share link points at.
   *
   * The share code travels in the fragment, and `/p/{id}` serves the uploaded
   * document itself - untrusted HTML, which can read its own `location.hash`.
   * So the link lands here instead: this page is the app's own, spends the code,
   * and only then sends the reader to the plan. A reader who arrives with no
   * code in the fragment is forwarded straight there, because there is nothing
   * for this page to do and `/p/{id}` is what decides whether they may read it.
   *
   * False on `/p/{id}`, where the same component is the refusal page: there,
   * forwarding on an empty fragment would reload the page it is already on.
   */
  relay: boolean;
}

export type PageProps = LandingProps | DashboardProps | GateProps;
