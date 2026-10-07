/** Only locally authored, credential-free application messages may cross an API boundary.
 * Never wrap an SDK/transport Error.message in this class.
 */
export class PublicError extends Error {}

export const API_ERROR_FALLBACK = "Request failed. Check your login, wallet permission and service configuration.";

export function publicErrorMessage(error: unknown, fallback = API_ERROR_FALLBACK): string {
  return error instanceof PublicError ? error.message : fallback;
}
