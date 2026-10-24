// Only these exact original starter records are filler. Never remove user plans.
const seeds = [
  ['M-1042', 'Maplewood East', 2.4, 90, 'Today, 9:12 AM'],
  ['M-1041', 'Riverside', 1.8, 75, 'Today, 8:40 AM'],
  ['M-1040', 'Cedar Heights', 3.1, 100, 'Yesterday']
];

export function isDemoMission(mission) {
  return seeds.some(([id, neighborhood, coverage, altitude, createdAt]) =>
    mission.id === id && mission.neighborhood === neighborhood && mission.coverage === coverage && mission.altitude === altitude && mission.createdAt === createdAt
  );
}
