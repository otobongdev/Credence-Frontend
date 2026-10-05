import { apiFetch } from './client'
import type { SettingsBlob } from '../lib/settingsSchema'

/** Persist the authenticated user's settings through the typed API boundary. */
export function updateSettings(settings: SettingsBlob, signal?: AbortSignal): Promise<void> {
  return apiFetch<void>('/settings', {
    method: 'PATCH',
    // SettingsBlob is a closed interface; widen it to the JSON-record body the
    // request encoder accepts so the typed blob survives the transport boundary.
    body: settings as Record<string, unknown>,
    signal,
  })
}
