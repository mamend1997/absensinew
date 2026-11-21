export function cameraRotationFromOrientation(beta, gamma, currentRotation = 0) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return currentRotation;

  const measuredAngle = Math.atan2(gamma, beta) * (180 / Math.PI);
  const snappedAngle = Math.round(measuredAngle / 90) * 90;
  const distanceFromSnap = Math.abs(((measuredAngle - snappedAngle + 540) % 360) - 180);
  if (distanceFromSnap > 35) return currentRotation;

  return ((snappedAngle + 540) % 360) - 180;
}
