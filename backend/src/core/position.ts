export function positionDelta(position: number, target: number) {
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(target) ||
    !Number.isSafeInteger(target - position)
  )
    throw new Error('Invalid or unpersistable position delta');
  const delta = target - position;
  if (delta === 0) return null;
  return { direction: delta > 0 ? ('buy' as const) : ('sell' as const), lots: Math.abs(delta) };
}

// The live journal stores positions and order quantities as PostgreSQL integers.
export function journalPositionDelta(position: number, target: number) {
  const result = positionDelta(position, target);
  const max = 2_147_483_647;
  if (Math.abs(position) > max || Math.abs(target) > max || (result && result.lots > max))
    throw new Error('Invalid or unpersistable position delta');
  return result;
}
