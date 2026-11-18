precision mediump float;

/** @resolution */
uniform vec2 u_resolution;
/** @time */
uniform float u_time;
/** @label Playing @default 1 @range 0, 1 */
uniform float u_playing;

float capsule(vec2 p, vec2 center, float halfHeight) {
  vec2 q = abs(p - center) - vec2(0.65, halfHeight - 0.65);
  float distanceToEdge = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.65;
  return 1.0 - smoothstep(-0.35, 0.35, distanceToEdge);
}

void main() {
  vec2 p = gl_FragCoord.xy / u_resolution * 16.0;
  float alpha = 0.0;
  for (int i = 0; i < 4; i++) {
    float index = float(i);
    float pulse = 0.5 + 0.5 * sin(u_time * (3.8 + index * 0.32) + index * 1.7);
    float height = mix(3.0, 4.0 + 8.0 * pulse, u_playing);
    alpha = max(alpha, capsule(p, vec2(3.0 + index * 3.3, 8.0), height * 0.5));
  }
  vec3 ink = vec3(28.0, 33.0, 29.0) / 255.0;
  gl_FragColor = vec4(ink * alpha, alpha);
}
