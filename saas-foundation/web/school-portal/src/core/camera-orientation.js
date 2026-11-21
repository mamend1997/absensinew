export function cameraRotationFromOrientation(beta, gamma, currentRotation = 0) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return currentRotation;

  const measuredAngle = Math.atan2(gamma, beta) * (180 / Math.PI);
  const snappedAngle = Math.round(measuredAngle / 90) * 90;
  const distanceFromSnap = Math.abs(((measuredAngle - snappedAngle + 540) % 360) - 180);
  if (distanceFromSnap > 35) return currentRotation;

  return ((snappedAngle + 540) % 360) - 180;
}

function normalizeRightAngle(angle) {
  const snappedAngle = Math.round(angle / 90) * 90;
  return ((snappedAngle + 540) % 360) - 180;
}

export function cameraRotationForScreen(
  beta,
  gamma,
  screenAngle,
  currentRotation = 0,
  previousScreenAngle = screenAngle,
) {
  const normalizedScreenAngle = normalizeRightAngle(screenAngle);
  const previousDisplayAngle = normalizeRightAngle(previousScreenAngle);
  const currentPhysicalRotation = normalizeRightAngle(currentRotation + previousDisplayAngle);
  const physicalRotation = cameraRotationFromOrientation(
    beta,
    gamma,
    currentPhysicalRotation,
  );
  return normalizeRightAngle(physicalRotation - normalizedScreenAngle);
}
