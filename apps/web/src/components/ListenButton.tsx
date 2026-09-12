import { Loader2, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, getIncidentVoice } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { InfoTooltip } from "@/components/ui/tooltip.tsx";

type Status = "idle" | "loading" | "ready" | "unavailable";

/**
 * Plays the ElevenLabs voice note for an incident — the same script the founder
 * received over iMessage, rendered from the same incident object.
 *
 * Voice is optional infrastructure: a 503 means TTS is not configured on this
 * deployment, which is a normal state and is reported quietly rather than as an
 * error. The audio blob is fetched once and reused for later plays.
 */
export function ListenButton({ incidentId }: { incidentId: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  // Reset per incident, and release the blob URL when the header goes away.
  useEffect(() => {
    setStatus("idle");
    setPlaying(false);
    setSeconds(null);
    setReason(null);
    return () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [incidentId]);

  async function toggle() {
    const audio = audioRef.current;
    if (!audio) return;

    if (playing) {
      audio.pause();
      return;
    }

    if (!urlRef.current) {
      setStatus("loading");
      try {
        const blob = await getIncidentVoice(incidentId);
        urlRef.current = URL.createObjectURL(blob);
        audio.src = urlRef.current;
        setStatus("ready");
      } catch (err) {
        setStatus("unavailable");
        setReason(
          err instanceof ApiError && err.status === 503 ? "Voice not configured" : "Voice note unavailable",
        );
        return;
      }
    }

    try {
      await audio.play();
    } catch {
      // Autoplay policies and codec refusals both land here; the note is optional.
      setStatus("unavailable");
      setReason("This browser would not play the note");
    }
  }

  const disabled = status === "unavailable" || status === "loading";

  const button = (
    <Button
      variant="outline"
      size="sm"
      onClick={toggle}
      disabled={disabled}
      aria-label={playing ? "Pause the voice note" : "Play the voice note"}
    >
      {status === "loading" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : playing ? (
        <Pause className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Play className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {status === "loading" ? "Loading…" : playing ? "Pause" : "Listen"}
      {seconds !== null ? <span className="tabular-nums text-neutral-500">{formatClock(seconds)}</span> : null}
    </Button>
  );

  return (
    <>
      {reason ? (
        <InfoTooltip label={reason}>
          {/* A disabled button swallows pointer events, so the tooltip hangs off a wrapper. */}
          <span title={reason} className="inline-flex">
            {button}
          </span>
        </InfoTooltip>
      ) : (
        button
      )}

      <audio
        ref={audioRef}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          const value = e.currentTarget.duration;
          setSeconds(Number.isFinite(value) ? Math.round(value) : null);
        }}
        className="hidden"
      />
    </>
  );
}

/** `0:15` — playback position, not a financial figure. */
export function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = Math.max(0, Math.round(totalSeconds % 60));
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
