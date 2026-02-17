export const CHAMPION_NAME_TO_ID: Record<string, number> = {
  Aatrox: 266,
  Camille: 164,
  Darius: 122,
  Fiora: 114,
  Garen: 86,
  Gnar: 150,
  Irelia: 39,
  Jax: 24,
  "K'Sante": 897,
  Malphite: 54,
  Mordekaiser: 82,
  Nasus: 75,
  Ornn: 516,
  Renekton: 58,
  Riven: 92,
  Sett: 875,
  Shen: 98,
  Teemo: 17,
  Tryndamere: 23,
  Yorick: 83
};

export const CHAMPION_ID_TO_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(CHAMPION_NAME_TO_ID).map(([name, id]) => [id, name])
);
