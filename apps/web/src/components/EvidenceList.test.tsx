import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVIDENCE_KINDS, type EvidenceItem } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { EvidenceList, KIND_META } from "@/components/EvidenceList.tsx";
import { mockIncidentDetail, resetMockSnapshot } from "@/api/mock.ts";
import { formatTimestampMedium } from "@/lib/format.ts";

function evidenceForPrimaryIncident(): EvidenceItem[] {
  const derived = buildMockDerived();
  const detail = mockIncidentDetail(derived.primary_incident!.id);
  return detail!.evidence;
}

describe("EvidenceList", () => {
  beforeEach(resetMockSnapshot);
  afterEach(cleanup);

  it("groups items in evidence-taxonomy order", () => {
    const items = evidenceForPrimaryIncident();
    render(<EvidenceList items={items} />);

    const expected = EVIDENCE_KINDS.filter((kind) => items.some((item) => item.kind === kind)).map(
      (kind) => KIND_META[kind].label,
    );

    expect(expected.length).toBeGreaterThan(1);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(expected);
  });

  it("keeps taxonomy order even when the input is shuffled", () => {
    const items = [...evidenceForPrimaryIncident()].reverse();
    render(<EvidenceList items={items} />);

    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    const positions = headings.map((label) =>
      EVIDENCE_KINDS.findIndex((kind) => KIND_META[kind].label === label),
    );

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("renders external sources as safe links with a cached badge", () => {
    const items = evidenceForPrimaryIncident();
    const external = items.find((item) => item.source_url && item.cached && item.retrieved_at);
    expect(external).toBeDefined();

    render(<EvidenceList items={items} />);

    const link = screen
      .getAllByRole("link")
      .find((anchor) => anchor.getAttribute("href") === external!.source_url);
    expect(link).toBeDefined();
    expect(link).toHaveTextContent(external!.source_title!);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");

    expect(link!.parentElement).toHaveTextContent(
      `retrieved ${formatTimestampMedium(external!.retrieved_at!)}`,
    );
    expect(screen.getAllByText("previously retrieved").length).toBeGreaterThan(0);
  });

  it("handles an incident with no evidence", () => {
    render(<EvidenceList items={[]} />);
    expect(screen.getByText(/No evidence/i)).toBeInTheDocument();
  });
});
