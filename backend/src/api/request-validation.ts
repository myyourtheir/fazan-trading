export const brokerIdLimit = 128;

export function isPositiveInt32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

export function isPrintableAscii(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[^\x21-\x7e]/.test(value);
}
