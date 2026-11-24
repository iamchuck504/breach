// Proporción entre las placas de los nudillos y la cara distal del brazal.
export function brazal(lado, escala, ajuste = {}) {
  const izquierdo = lado === 'L';
  return {
    scale: escala, sleeveScale: escala * (izquierdo ? .70 : .68),
    boca: izquierdo ? [-.0013, -.30995, .0009] : [.00029, -.30999, .00051], asiento: [0, -.001, .007],
    twist: izquierdo ? 1.38473 : -1.38473,
    elbowDirection: [izquierdo ? -.62 : .48, -.65, .38],
    ...ajuste,
    elbowDirectionADS: [izquierdo ? -.65 : .53, -.65, .34],
  };
}
