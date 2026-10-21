export type * from "@team/contracts/runtime";
export class HarnessTransportError extends Error {
  readonly executionUnknown = true;
}
