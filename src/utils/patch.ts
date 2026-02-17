export function toRiotPatchPrefix(patch: string): string {
  const trimmed = patch.trim();
  const match = /^(\d{2})\.(\d{1,2})$/.exec(trimmed);
  if (!match) return trimmed;

  const major = Number(match[1]);
  const minor = Number(match[2]);

  // Riot match-v5 gameVersion currently uses a major that is 10 lower
  // than the season-style patch notation used by many community tools.
  const riotMajor = major >= 20 ? major - 10 : major;
  return `${riotMajor}.${minor}`;
}
