// Never log error messages, queries, parameters, or connection details: drivers and
// ORM wrappers can include credentials and application data in any of them.
const diagnostics: Record<string, string> = {
  '42P01': 'PostgreSQL relation does not exist',
  '42703': 'PostgreSQL column does not exist',
  '42501': 'PostgreSQL permission denied',
  '3D000': 'PostgreSQL database does not exist',
  '28P01': 'PostgreSQL authentication failed',
  '28000': 'PostgreSQL authorization failed',
  ECONNREFUSED: 'database connection refused',
  ENOTFOUND: 'database host not found',
  ETIMEDOUT: 'database connection timed out',
};

const configurationErrors = new Set([
  'DATABASE_URL or PostgreSQL connection variables are required.',
  'OWNER_PASSWORD must contain 12–256 characters.',
  'COOKIE_SECURE must be true or false.',
  'PORT must be a valid port number.',
  'SANDBOX_TOKEN_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hexadecimal characters.',
]);

export function startupErrorMessage(error: unknown, stage: string): string {
  if (error instanceof Error && configurationErrors.has(error.message)) return error.message;
  const seen = new Set<object>();
  let current = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') {
      const description = Object.hasOwn(diagnostics, current.code)
        ? diagnostics[current.code]
        : undefined;
      if (description)
        return `Backend startup failed during ${stage}: ${description} (${current.code}).`;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return `Backend startup failed during ${stage}. Check configuration, database, and listening address.`;
}
