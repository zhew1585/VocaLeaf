precision mediump float;
/** @resolution */
uniform vec2 u_resolution;
/** @label Reading content */
uniform sampler2D u_content;
/**
 * @label Scrolled state
 * @default 0
 * @range 0, 1
 */
uniform float u_scrolled;

vec4 readPixel(vec2 pixel) {
  vec2 uv = pixel / u_resolution;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(u_content, uv);
}

void main() {
  vec2 p = gl_FragCoord.xy;
  float topDistance = u_resolution.y - p.y;
  float strength = (1.0 - smoothstep(0.0, 48.0, topDistance)) * u_scrolled;
  float radius = 3.5 * strength;
  vec4 color = readPixel(p) * 0.28;
  color += readPixel(p + vec2(radius, 0.0)) * 0.12;
  color += readPixel(p - vec2(radius, 0.0)) * 0.12;
  color += readPixel(p + vec2(0.0, radius)) * 0.12;
  color += readPixel(p - vec2(0.0, radius)) * 0.12;
  color += readPixel(p + vec2(radius, radius)) * 0.06;
  color += readPixel(p - vec2(radius, radius)) * 0.06;
  color += readPixel(p + vec2(radius, -radius)) * 0.06;
  color += readPixel(p + vec2(-radius, radius)) * 0.06;
  float opacity = mix(1.0, smoothstep(0.0, 40.0, topDistance), u_scrolled);
  gl_FragColor = color * opacity;
}
