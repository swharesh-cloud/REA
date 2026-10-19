/** Slippy-map tile coordinates. The Node domain module re-exports these. */
export const lonToTileX = (longitude, zoom) =>
  ((longitude + 180) / 360) * 2 ** zoom;

export const latToTileY = (latitude, zoom) => {
  const radians = (latitude * Math.PI) / 180;
  const mercator = Math.log(Math.tan(radians) + 1 / Math.cos(radians));
  return ((1 - mercator / Math.PI) / 2) * 2 ** zoom;
};
