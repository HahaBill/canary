/** Deep links. Paths come from shared `buildAppPath`; only the origin is ours. */
import { buildAppPath } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { createAppLink, incidentLink } from "./links.ts";

const BASE = "https://canary.test";

describe("createAppLink", () => {
  it("builds the dashboard link", () => {
    expect(createAppLink({ destination: "dashboard" }, BASE)).toEqual({ url: `${BASE}/`, path: "/" });
  });

  it("builds incident links, with and without a tab", () => {
    expect(createAppLink({ destination: "incident", id: "inc_1" }, BASE)).toEqual({ url: `${BASE}/incidents/inc_1`, path: "/incidents/inc_1" });
    for (const tab of ["drivers", "evidence", "whatif"] as const) {
      expect(createAppLink({ destination: "incident", id: "inc_1", tab }, BASE).url).toBe(`${BASE}/incidents/inc_1?tab=${tab}`);
    }
  });

  it("omits the default overview tab, matching buildAppPath", () => {
    const req = { destination: "incident", id: "inc_1", tab: "overview" } as const;
    expect(createAppLink(req, BASE).path).toBe(buildAppPath(req));
    expect(createAppLink(req, BASE).path).toBe("/incidents/inc_1");
  });

  it("normalises a base URL with a trailing slash", () => {
    expect(createAppLink({ destination: "incident", id: "inc_1" }, `${BASE}/`).url).toBe(`${BASE}/incidents/inc_1`);
    expect(createAppLink({ destination: "dashboard" }, `${BASE}///`).url).toBe(`${BASE}/`);
  });

  it("escapes ids", () => {
    expect(incidentLink("inc/../secret", BASE).path).toBe("/incidents/inc%2F..%2Fsecret");
  });
});
