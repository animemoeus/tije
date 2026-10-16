/** Base URL of tije-api; see CLAUDE.md for what it serves. */
export const API =
  import.meta.env.VITE_API_URL ?? 'https://api.tije.info'

// Route types shown until the user picks others, in /route-types order.
// Kept out of RouteMap.tsx so that file exports only components and Vite
// can Fast Refresh it.
export const DEFAULT_TYPES = ['BRT', 'Angkutan Umum Integrasi']
