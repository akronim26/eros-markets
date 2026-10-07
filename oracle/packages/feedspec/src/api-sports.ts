/** Public provider catalog. Credentials remain in the server/CRE environment. */
export const API_SPORTS_AUTH = {
  secretId: 'SPORTSDATA_API_KEY',
  env: 'SPORTSDATA_API_KEY_VALUE',
  header: 'x-apisports-key',
  prefix: '',
} as const

export const SPORTS_RULE_SCHEMA = 'sports-v1' as const

export const API_SPORTS_PROVIDERS = [
  { id: 'football', name: 'Football', host: 'v3.football.api-sports.io', authRefLabel: 'EROS_API_FOOTBALL_V1', resolutionAdapter: SPORTS_RULE_SCHEMA },
  { id: 'baseball', name: 'Baseball', host: 'v1.baseball.api-sports.io', authRefLabel: 'EROS_API_BASEBALL_V1', resolutionAdapter: SPORTS_RULE_SCHEMA },
  { id: 'formula-1', name: 'Formula 1', host: 'v1.formula-1.api-sports.io', authRefLabel: 'EROS_API_FORMULA_1_V1', resolutionAdapter: SPORTS_RULE_SCHEMA },
  { id: 'handball', name: 'Handball', host: 'v1.handball.api-sports.io', authRefLabel: 'EROS_API_HANDBALL_V1', resolutionAdapter: SPORTS_RULE_SCHEMA },
  { id: 'hockey', name: 'Hockey', host: 'v1.hockey.api-sports.io', authRefLabel: 'EROS_API_HOCKEY_V1', resolutionAdapter: SPORTS_RULE_SCHEMA },
  { id: 'mma', name: 'MMA', host: 'v1.mma.api-sports.io', authRefLabel: 'EROS_API_MMA_V1', resolutionAdapter: SPORTS_RULE_SCHEMA },
  { id: 'nba', name: 'NBA', host: 'v2.nba.api-sports.io', authRefLabel: 'EROS_API_NBA_V2', resolutionAdapter: SPORTS_RULE_SCHEMA },
  { id: 'american-football', name: 'American football', host: 'v1.american-football.api-sports.io', authRefLabel: 'EROS_API_AMERICAN_FOOTBALL_V1', resolutionAdapter: SPORTS_RULE_SCHEMA },
  { id: 'rugby', name: 'Rugby', host: 'v1.rugby.api-sports.io', authRefLabel: 'EROS_API_RUGBY_V1', resolutionAdapter: SPORTS_RULE_SCHEMA },
  { id: 'volleyball', name: 'Volleyball', host: 'v1.volleyball.api-sports.io', authRefLabel: 'EROS_API_VOLLEYBALL_V1', resolutionAdapter: SPORTS_RULE_SCHEMA },
] as const
