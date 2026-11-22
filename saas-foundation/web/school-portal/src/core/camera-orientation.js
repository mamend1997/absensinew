export function cameraRotationFromOrientation(beta, gamma, currentRotation = 0) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return currentRotation;

  const measuredAngle = Math.atan2(gamma, beta) * (180 / Math.PI);
  const snappedAngle = Math.round(measuredAngle / 90) * 90;
  const distanceFromSnap = Math.abs(((measuredAngle - snappedAngle + 540) % 360) - 180);
  if (distanceFromSnap > 35) return currentRotation;

  return ((snappedAngle + 540) % 360) - 180;
}

export function normalizeCameraRotation(angle) {
  if (!Number.isFinite(angle)) return 0;
  const snappedAngle = Math.round(angle / 90) * 90;
  return ((snappedAngle + 540) % 360) - 180;
}

export function rotateCameraByQuarterTurn(rotation) {
  return normalizeCameraRotation(rotation + 90);
}

export function cameraRotationForScreen(
  beta,
  gamma,
  screenAngle,
  currentRotation = 0,
  previousScreenAngle = screenAngle,
) {
  const normalizedScreenAngle = normalizeCameraRotation(screenAngle);
  const previousDisplayAngle = normalizeCameraRotation(previousScreenAngle);
  const currentPhysicalRotation = normalizeCameraRotation(currentRotation + previousDisplayAngle);
  const physicalRotation = cameraRotationFromOrientation(
    beta,
    gamma,
    currentPhysicalRotation,
  );
  return normalizeCameraRotation(physicalRotation - normalizedScreenAngle);
}
