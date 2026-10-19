const EARTH_MILES = 3958.7613;
const MILES_PER_LAT_DEGREE = 69;

/** Great-circle distance in miles. */
export const distanceMiles = (lat1, lng1, lat2, lng2) => {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * Axis-aligned box that contains the circle. The circle test in comp
 * selection is the inclusion rule; this box only limits remote reads.
 */
export const boundingBox = (latitude, longitude, radiusMiles) => {
  const padded = radiusMiles * 1.15;
  const latDelta = padded / MILES_PER_LAT_DEGREE;
  const cosine = Math.cos((latitude * Math.PI) / 180);
  const milesPerLng = Math.max(1, MILES_PER_LAT_DEGREE * Math.abs(cosine));
  const lngDelta = padded / milesPerLng;
  return {
    minLat: latitude - latDelta,
    maxLat: latitude + latDelta,
    minLng: longitude - lngDelta,
    maxLng: longitude + lngDelta,
  };
};

export const lonToTileX = (longitude, zoom) =>
  ((longitude + 180) / 360) * 2 ** zoom;

export const latToTileY = (latitude, zoom) => {
  const radians = (latitude * Math.PI) / 180;
  const mercator = Math.log(Math.tan(radians) + 1 / Math.cos(radians));
  return ((1 - mercator / Math.PI) / 2) * 2 ** zoom;
};
