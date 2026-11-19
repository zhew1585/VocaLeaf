// The Voices a Book can be narrated with (PRD 4.2.4), in the order the design lists them.
import type { Voice } from "./api";

export const VOICES: { id: Voice; name: string }[] = [
  { id: "us_female", name: "美音女声" },
  { id: "us_male", name: "美音男声" },
  { id: "uk_female", name: "英音女声" },
  { id: "uk_male", name: "英音男声" },
];

/** The upload's Voice until the user picks another; the API's DEFAULT_VOICE (contract.ts). */
export const DEFAULT_VOICE: Voice = "us_female";

export function voiceName(voice: Voice): string {
  return VOICES.find((v) => v.id === voice)?.name ?? voice;
}

/**
 * The 5-second preview of a Voice: a static clip in web/public/voices, cut from a Kokoro sample by
 * worker/scripts/voice_samples.py, so trying a Voice never waits on the TTS service.
 */
export function previewUrl(voice: Voice): string {
  return `/voices/${voice}.m4a`;
}
