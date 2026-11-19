import { useMemo } from 'react';
import { defaultTimeZone } from '@/shared/lib/display-time';
import { mutationHeaders, rootApi } from './root-api';

type DisplaySettings = { timeZone: string };

export const displaySettingsApi = rootApi.injectEndpoints({
  endpoints: builder => ({
    displaySettings: builder.query<DisplaySettings, void>({
      query: () => 'settings/display',
      providesTags: ['DisplaySettings'],
    }),
    setTimeZone: builder.mutation<DisplaySettings, string>({
      query: timeZone => ({ url: 'settings/display', method: 'PUT', headers: mutationHeaders, body: { timeZone } }),
      async onQueryStarted(_timeZone, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(displaySettingsApi.util.updateQueryData('displaySettings', undefined, () => data));
        } catch {
          // Leave the last saved value in the cache; the settings form shows the error.
        }
      },
    }),
  }),
});

export function useDisplayTimeZoneSettings() {
  const settings = displaySettingsApi.useDisplaySettingsQuery(undefined, { refetchOnFocus: true, refetchOnReconnect: true });
  const saved = settings.data?.timeZone;
  const timeZone = useMemo(() => {
    if (!saved) return undefined;
    try {
      // A browser with older timezone data may not recognize a zone saved on another device.
      new Intl.DateTimeFormat('ru-RU', { timeZone: saved });
      return saved;
    } catch {
      return undefined;
    }
  }, [saved]);
  return { settings, timeZone };
}

export function useDisplayTimeZone() {
  return useDisplayTimeZoneSettings().timeZone ?? defaultTimeZone;
}
