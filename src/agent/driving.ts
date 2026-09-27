const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
export function drivingControl(
  error: number,
  distance: number,
  speed: number,
  smooth: boolean,
  last: boolean,
) {
  const cruise = smooth ? 8 : 14;
  const wanted = Math.min(
    cruise,
    Math.abs(error) > 0.45 ? cruise * 0.4 : cruise,
    last ? Math.max(0, (distance - 3) * 0.65) : cruise,
  );
  return {
    x: clamp(-error * 1.6, -1, 1),
    y:
      speed < wanted
        ? Math.min(smooth ? 0.4 : 0.85, (wanted - speed) * 0.25 + 0.12)
        : speed > wanted + 0.6
          ? -Math.min(smooth ? 0.3 : 0.8, (speed - wanted) * 0.12)
          : 0,
  };
}
