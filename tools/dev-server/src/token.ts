/**
 * Length-independent compare, so a wrong token leaks nothing through timing.
 *
 * Shared by the HTTP routes and the WebSocket handshake: one comparison, so the
 * two authentication paths cannot come to differ in strictness.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index % b.length);
  }
  return diff === 0;
}
