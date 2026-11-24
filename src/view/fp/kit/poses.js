// HandPose y POSE de suit.ts. Cada dedo tiene tres ángulos hacia la palma.
// El pulgar tiene guiñada, cabeceo y flexión distal independientes.
export const POSE = {
  grip: { fingers: [[1.15, 1.35, 0.9], [1.35, 1.45, 1.0], [1.4, 1.45, 1.0], [1.45, 1.4, 1.0]], spread: 0.02, thumb: [0.55, 0.65, 0.5] },
  trigger: { fingers: [[0.35, 1.0, 0.7], [1.35, 1.45, 1.0], [1.4, 1.45, 1.0], [1.45, 1.4, 1.0]], spread: 0.04, thumb: [0.55, 0.7, 0.55] },
  cup: { fingers: [[0.75, 0.8, 0.5], [0.8, 0.85, 0.5], [0.85, 0.85, 0.5], [0.9, 0.85, 0.5]], spread: 0.06, thumb: [0.35, 0.3, 0.2] },
  pinch: { fingers: [[0.9, 1.0, 0.7], [1.1, 1.2, 0.8], [1.3, 1.3, 0.9], [1.4, 1.3, 0.9]], spread: 0.03, thumb: [0.8, 0.9, 0.4] },
  flat: { fingers: [[0.15, 0.15, 0.1], [0.15, 0.15, 0.1], [0.2, 0.15, 0.1], [0.25, 0.15, 0.1]], spread: 0.07, thumb: [0.6, 0.2, 0.1] },
};

// Índice a lo largo del armazón y pulgares adelantados en el agarre doble.
POSE.indexed = { ...POSE.trigger, fingers: [[0.12, 0.14, 0.10], ...POSE.trigger.fingers.slice(1)], thumb: [0.16, 0.32, 0.18] };
POSE.wrap = { ...POSE.grip, thumb: [0.14, 0.25, 0.18] };

export function handPose(spec) {
  const base = POSE[spec.pose];
  return { ...base, ...spec.angles };
}
