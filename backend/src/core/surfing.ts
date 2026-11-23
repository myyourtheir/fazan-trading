import type { Side } from './crossing.js';

export type SurfingState = { side: Side | null };
export type SurfingObservation = { close: number; ema: number };
export type SurfingParameters = { lots: number };

// Equality retains the last strict side, including an unknown initial side.
export function decideSurfing(
  state: SurfingState,
  observation: SurfingObservation,
  parameters: SurfingParameters,
) {
  const { close, ema } = observation;
  if (!Number.isFinite(close) || !Number.isFinite(ema)) return { state, signal: null };
  const side = close === ema ? state.side : close > ema ? 1 : -1;
  const crossed = state.side !== null && side !== state.side;
  return {
    state: { side },
    signal:
      crossed && side !== null
        ? { targetPosition: side * parameters.lots, explanation: { close, ema } }
        : null,
  };
}
