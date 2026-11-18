precision mediump float;

/** @resolution */
uniform vec2 u_resolution;
/** @time */
uniform float u_time;
/**
 * @label Playing
 * @default 1
 * @range 0, 1
 */
uniform float u_playing;

float stroke(vec2 p, vec2 center, float height) {
  float radius = 0.6666667;
  vec2 q = p - center;
  q.y -= clamp(q.y, -height * 0.5 + radius, height * 0.5 - radius);
  float distanceToEdge = length(q) - radius;
  return 1.0 - smoothstep(-0.3, 0.3, distanceToEdge);
}

void main() {
  vec2 p = gl_FragCoord.xy / u_resolution * 16.0;
  float alpha = 0.0;
  for (int i = 0; i < 4; i++) {
    float index = float(i);
    float pulse = 0.5 + 0.5 * sin(u_time * (2.4 + index * 0.17) + index * 1.8);
    float height = mix(3.0, 4.0 + 7.0 * pulse, u_playing);
    alpha = max(alpha, stroke(p, vec2(3.2 + index * 3.2, 8.0), height));
  }
  vec3 ink = vec3(28.0, 33.0, 29.0) / 255.0;
  gl_FragColor = vec4(ink * alpha, alpha);
}
