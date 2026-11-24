// Acabados del kit. Los nombres mantienen la clasificación por superficie
// del material de Breach, incluidos el tinte de equipo y el desgaste.
export const SURF = {
  metal: 'slate metal / acero pavonado',
  metalDark: 'slate metal / fosfatado',
  steel: 'machined / acero satinado',
  light: 'machined / cantos',
  ceramic: 'graphite / placa protectora',
  polymer: 'graphite / polímero moldeado',
  rubber: 'rubber / inserto',
  black: 'graphite / rebaje',
  mark: 'unit markings / serigrafía',
  team: 'painted red / identificación',
  dot: 'recessed red LED / punto',
  brass: 'copper / casquillo',
  optic: 'optic / canto pulido',
};

const finishes = [
  [SURF.metal, [0.12, 0.145, 0.17], 0.42, 0.79],
  [SURF.metalDark, [0.068, 0.079, 0.095], 0.56, 0.68],
  [SURF.steel, [0.27, 0.30, 0.32], 0.30, 0.83],
  [SURF.light, [0.35, 0.37, 0.38], 0.35, 0.79],
  [SURF.ceramic, [0.17, 0.18, 0.19], 0.58, 0.13],
  [SURF.polymer, [0.075, 0.083, 0.095], 0.75, 0.05],
  [SURF.rubber, [0.032, 0.038, 0.043], 0.90, 0.00],
  [SURF.black, [0.024, 0.028, 0.033], 0.61, 0.18],
  [SURF.mark, [0.57, 0.56, 0.49], 0.68, 0.03],
  [SURF.team, [0.32, 0.052, 0.037], 0.50, 0.21],
  [SURF.dot, [0.88, 0.14, 0.09], 0.33, 0.1],
  [SURF.brass, [0.49, 0.255, 0.115], 0.38, 0.76],
  [SURF.optic, [0.12, 0.23, 0.27], 0.16, 0.63],
];

export const kitMaterials = finishes.map(([name, color, roughnessFactor, metallicFactor]) => ({
  name, pbrMetallicRoughness: { baseColorFactor: [...color, 1], roughnessFactor, metallicFactor },
  ...(name === SURF.dot && { emissiveFactor: color, extensions: { KHR_materials_emissive_strength: { emissiveStrength: 1.5 } } }),
}));
