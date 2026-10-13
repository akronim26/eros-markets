// Synthetic API-Football-shaped responses. These are not live match evidence.
import { footballFeed, type FootballBinding } from '../../src/football'
export const binding: FootballBinding = { fixtureId: 999000001, leagueId: 9000, season: 2026,
  homeTeamId: 101, awayTeamId: 202, kickoff: 1791396000, selection: 'HOME' }
export const footballAuth = ('0x' + 'ab'.repeat(32)) as `0x${string}`
export const feed = footballFeed(binding, footballAuth)
export function footballResponse(home = 2, away = 1, status = 'FT') {
  return { get: 'fixtures', parameters: { id: String(binding.fixtureId) }, errors: [], results: 1,
    paging: { current: 1, total: 1 }, response: [{
      fixture: { id: binding.fixtureId, timestamp: binding.kickoff, status: { short: status } },
      league: { id: binding.leagueId, season: binding.season },
      teams: { home: { id: binding.homeTeamId, winner: home === away ? null : home > away },
        away: { id: binding.awayTeamId, winner: home === away ? null : away > home } },
      goals: { home, away }, score: { fulltime: { home, away },
        extratime: { home: null, away: null }, penalty: { home: null, away: null } },
    }] }
}
