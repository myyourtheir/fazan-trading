export type Side = -1 | 1;

export function crossing(previous: Side | null, close: number, ema: number) {
  const side = close === ema ? previous : close > ema ? 1 : -1;
  return { side, direction: previous !== null && side !== previous ? side : null };
}

export function positionDelta(position: number, target: number) {
  const delta = target - position;
  return { direction: delta > 0 ? 'buy' as const : 'sell' as const, lots: Math.abs(delta) };
}
