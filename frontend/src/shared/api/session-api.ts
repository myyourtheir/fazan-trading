import { mutationHeaders, rootApi } from './root-api';

type Authenticated = { authenticated: true };
type Session = Authenticated & { remainingMs: number };
const changedSessionTags = (_data: unknown, error: unknown) =>
  error
    ? []
    : ([
        'Session',
        'Dashboard',
        'Sandbox',
        'SandboxBalance',
        'Strategy',
        'Journal',
        'DisplaySettings',
      ] as const);

export const sessionApi = rootApi.injectEndpoints({
  endpoints: (builder) => ({
    session: builder.query<Session, void>({
      query: () => 'auth/session',
      providesTags: ['Session'],
    }),
    login: builder.mutation<Authenticated, string>({
      query: (password) => ({
        url: 'auth/login',
        method: 'POST',
        headers: mutationHeaders,
        body: { password },
      }),
      invalidatesTags: changedSessionTags,
    }),
    logout: builder.mutation<null, void>({
      query: () => ({ url: 'auth/logout', method: 'POST', headers: mutationHeaders }),
      invalidatesTags: changedSessionTags,
    }),
  }),
});
