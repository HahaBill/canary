import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListenButton, formatClock } from "@/components/ListenButton.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";

function renderButton(id = "inc_5b393334") {
  return render(
    <TooltipProvider delayDuration={0}>
      <ListenButton incidentId={id} />
    </TooltipProvider>,
  );
}

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(() => Promise.resolve(response()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The click handler awaits a fetch, so let its microtasks settle inside `act`. */
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

function playButton() {
  return screen.getByRole("button", { name: "Play the voice note" });
}

describe("ListenButton", () => {
  beforeEach(() => {
    // jsdom implements neither media playback nor blob URLs.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("pause"));
    });
    URL.createObjectURL = vi.fn(() => "blob:canary-voice");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetches the note once and toggles between play and pause", async () => {
    const fetchMock = stubFetch(() => new Response(new Blob(["audio"]), { status: 200 }));
    renderButton();

    await click(playButton());

    expect(fetchMock).toHaveBeenCalledWith("/api/incidents/inc_5b393334/voice", expect.anything());
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    const pause = screen.getByRole("button", { name: "Pause the voice note" });
    expect(pause).toHaveTextContent("Pause");

    await click(pause);
    expect(playButton()).toHaveTextContent("Listen");

    // A second play reuses the blob rather than re-fetching.
    await click(playButton());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Pause the voice note" })).toBeInTheDocument();
  });

  it("disables itself and explains when voice is not configured", async () => {
    stubFetch(() => new Response("", { status: 503 }));
    renderButton();

    await click(playButton());

    expect(playButton()).toBeDisabled();
    expect(screen.getByTitle("Voice not configured")).toBeInTheDocument();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("stays quiet but disabled for any other failure", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    renderButton();

    await click(playButton());

    expect(screen.getByTitle("Voice note unavailable")).toBeInTheDocument();
    expect(playButton()).toBeDisabled();
  });

  it("shows the duration once metadata loads", async () => {
    stubFetch(() => new Response(new Blob(["audio"]), { status: 200 }));
    const { container } = renderButton();

    await click(playButton());

    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { value: 15.4, configurable: true });
    await act(async () => {
      fireEvent(audio, new Event("loadedmetadata"));
    });

    expect(screen.getByText("0:15")).toBeInTheDocument();
  });

  it("releases the blob URL on unmount", async () => {
    stubFetch(() => new Response(new Blob(["audio"]), { status: 200 }));
    const { unmount } = renderButton();

    await click(playButton());
    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:canary-voice");
  });

  describe("formatClock", () => {
    it("reads as minutes and seconds", () => {
      expect(formatClock(15)).toBe("0:15");
      expect(formatClock(75)).toBe("1:15");
      expect(formatClock(0)).toBe("0:00");
    });
  });
});
