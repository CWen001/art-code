precision mediump float;

varying vec2 vTexCoord;

uniform sampler2D u_prevTex;
uniform sampler2D u_baseTex;
uniform sampler2D u_regionTex;
uniform sampler2D u_edgeTex;
uniform sampler2D u_confidenceTex;
uniform sampler2D u_flowHintTex;
uniform sampler2D u_flowMagTex;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_dt;
uniform float u_motionSpeed;
uniform float u_turbulence;
uniform float u_edgeLock;
uniform float u_maskFeather;
uniform float u_textureScale;
uniform float u_activeRegion;
uniform float u_regionCount;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);

  float a = hash(i + vec2(0.0, 0.0));
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float regionMask(vec2 uv, float confidence) {
  if (u_activeRegion < 0.0) {
    return 1.0;
  }

  float encodedId = texture2D(u_regionTex, uv).r;
  float regionCount = max(1.0, u_regionCount - 1.0);
  float rid = floor(encodedId * regionCount + 0.5);
  float matchValue = 1.0 - smoothstep(0.0, 0.5, abs(rid - u_activeRegion));

  float confBoost = smoothstep(0.15 - u_maskFeather * 0.1, 0.8, confidence);
  return matchValue * confBoost;
}

void main() {
  vec2 uv = vTexCoord;
  uv.y = 1.0 - uv.y;

  float confidence = texture2D(u_confidenceTex, uv).r;
  float edgeMask = texture2D(u_edgeTex, uv).r;
  vec2 flowDir = texture2D(u_flowHintTex, uv).rg * 2.0 - 1.0;
  float flowMag = texture2D(u_flowMagTex, uv).r;

  float selected = regionMask(uv, confidence);

  float n = noise(uv * (120.0 + u_textureScale * 240.0) + vec2(u_time * 0.3, -u_time * 0.2));
  vec2 turbulence = (vec2(noise(uv * 93.1 + u_time), noise(uv * 71.7 - u_time)) - 0.5) * u_turbulence;

  float dt = clamp(u_dt, 0.0, 0.08);
  vec2 advection = (flowDir * (0.15 + flowMag * 0.85) * u_motionSpeed + turbulence) * dt * 0.5;
  advection *= (1.0 - edgeMask * u_edgeLock);

  vec2 advectedUv = clamp(uv - advection, vec2(0.001), vec2(0.999));

  float prevState = texture2D(u_prevTex, advectedUv).r;
  float carried = mix(prevState, texture2D(u_prevTex, uv).r, 0.2) * 0.985;

  vec4 base = texture2D(u_baseTex, uv);
  float luma = dot(base.rgb, vec3(0.2126, 0.7152, 0.0722));
  float stripe = 0.5 + 0.5 * sin((uv.x * 720.0 + uv.y * 420.0) * (0.4 + u_textureScale) + u_time * 1.8);
  float stipple = step(0.55, noise(uv * (48.0 + u_textureScale * 100.0) - u_time * 0.7));
  float fiber = noise(uv * (220.0 + u_textureScale * 300.0) + vec2(u_time * 0.18, u_time * 0.12));

  float pattern = mix(stripe, stipple, 0.45) * 0.55 + fiber * 0.45;
  float injection = pattern * (0.35 + 0.65 * flowMag) * (0.45 + 0.55 * (1.0 - abs(luma - 0.5) * 2.0));
  injection *= selected;

  float edgeBarrier = smoothstep(0.1, 0.9, edgeMask) * u_edgeLock;
  float nextState = max(carried, injection * 0.9 + n * 0.1);
  nextState *= 1.0 - edgeBarrier * 0.88;

  // R: dynamic energy, G: active region mask, B: edge barrier.
  gl_FragColor = vec4(nextState, selected, edgeBarrier, 1.0);
}
