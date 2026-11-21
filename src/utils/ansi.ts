const ANSI_REGEX =
  /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x1b\x07]*(?:\x1b\\|\x07)|\([a-zA-Z])/g;

/**
 * Strips all ANSI and OSC escape codes (including OSC 8 hyperlinks) for accurate measurement.
 */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}
