export const ownerCookie = 'serfing_session';

export function ownerSessionToken(cookie: string | undefined) {
  return cookie?.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${ownerCookie}=`))?.slice(ownerCookie.length + 1);
}
