precision mediump float;
/** @resolution */
uniform vec2 u_resolution;
/** @time */
uniform float u_time;
/** @label Title content */
uniform sampler2D u_content;
/**
 * @label Visible title width
 * @default 152
 */
uniform float u_viewport;

void main() {
  float distance = max(u_resolution.x - u_viewport, 0.0);
  float duration = distance / 18.0;
  float cycle = 2.0 + duration + 1.5;
  float elapsed = mod(u_time, max(cycle, 0.01));
  float shift = min(max(elapsed - 2.0, 0.0) * 18.0, distance);
  vec2 uv = (gl_FragCoord.xy + vec2(shift, 0.0)) / u_resolution;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0);
  } else {
    gl_FragColor = texture2D(u_content, uv);
  }
}
