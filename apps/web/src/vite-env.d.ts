/// <reference types="vite/client" />

import type { DetailedHTMLProps, HTMLAttributes } from "react";

interface ImportMetaEnv {
  /** `"1"` forces the offline fixtures instead of the Worker API. */
  readonly VITE_USE_MOCK?: string;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "elevenlabs-convai": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        "agent-id"?: string;
        "signed-url"?: string;
        variant?: string;
        "action-text"?: string;
        "start-call-text"?: string;
        "end-call-text"?: string;
        "listening-text"?: string;
        "speaking-text"?: string;
        "avatar-orb-color-1"?: string;
        "avatar-orb-color-2"?: string;
      };
    }
  }
}

export {};
