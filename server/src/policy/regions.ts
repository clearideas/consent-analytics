// Built-in country groups for data policies (`@EU`, `@EEA`).

/** EU member states. */
export const EU_COUNTRIES: readonly string[] = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
]

/** European Economic Area: the EU plus Iceland, Liechtenstein and Norway. */
export const EEA_COUNTRIES: readonly string[] = [...EU_COUNTRIES, 'IS', 'LI', 'NO']

export const BUILT_IN_REGION_SETS: Readonly<Record<string, readonly string[]>> = {
  EU: EU_COUNTRIES,
  EEA: EEA_COUNTRIES,
}
