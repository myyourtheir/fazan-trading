export const brokerIdLimit = 128;

export function isPrintableAscii(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[^\x21-\x7e]/.test(value);
}
