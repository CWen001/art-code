precision mediump float;

varying vec2 vTexCoord;

uniform sampler2D u_baseTex;
uniform sampler2D u_flowStateTex;
uniform sampler2D u_regionTex;
uniform sampler2D u_edgeTex;
uniform sampler2D u_confidenceTex;
uniform sampler2D u_flowHintTex;
uniform sampler2D u_flowMagTex;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_grainAmount;
uniform float u_chromaAberration;
uniform float u_maskFeather;
uniform float u_activeRegion;
uniform float u_regionCount;
uniform float u_debugMode;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(41.13, 289.97))) * 47234.833);
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
  float encoded = texture2D(u_regionTex, uv).r;
  float regionCount = max(1.0, u_regionCount - 1.0);
  float rid = floor(encoded * regionCount + 0.5);
  float matchValue = 1.0 - smoothstep(0.0, 0.5, abs(rid - u_activeRegion));
  float confBoost = smoothstep(0.15 - u_maskFeather * 0.1, 0.8, confidence);
  return matchValue * confBoost;
}

vec3 hueBand(float t) {
  return 0.55 + 0.45 * cos(6.28318 * (vec3(0.12, 0.42, 0.72) + t));
}

void main() {
  vec2 uv = vTexCoord;
  uv.y = 1.0 - uv.y;

  float edge = texture2D(u_edgeTex, uv).r;
  float confidence = texture2D(u_confidenceTex, uv).r;
  float activeMask = regionMask(uv, confidence);
  vec4 flowState = texture2D(u_flowStateTex, uv);

  float energy = flowState.r;
  float dynamicMask = flowState.g * activeMask;

  vec2 flowDir = texture2D(u_flowHintTex, uv).rg * 2.0 - 1.0;
  float flowMag = texture2D(u_flowMagTex, uv).r;

  // Debug: region ids
  if (u_debugMode > 0.5 && u_debugMode < 1.5) {
    float rid = texture2D(u_regionTex, uv).r;
    gl_FragColor = vec4(hueBand(rid), 1.0);
    return;
  }

  // Debug: edge mask
  if (u_debugMode > 1.5 && u_debugMode < 2.5) {
    gl_FragColor = vec4(vec3(edge), 1.0);
    return;
  }

  // Debug: flow field
  if (u_debugMode > 2.5 && u_debugMode < 3.5) {
    vec3 flowColor = vec3(0.5 + 0.5 * flowDir.x, 0.5 + 0.5 * flowDir.y, flowMag);
    gl_FragColor = vec4(flowColor, 1.0);
    return;
  }

  // Debug: confidence
  if (u_debugMode > 3.5 && u_debugMode < 4.5) {
    gl_FragColor = vec4(vec3(confidence), 1.0);
    return;
  }

  // Debug: leakage overlay
  if (u_debugMode > 4.5) {
    vec3 baseDebug = texture2D(u_baseTex, uv).rgb;
    float leakage = energy * (1.0 - dynamicMask);
    vec3 mixDebug = mix(baseDebug, vec3(1.0, 0.08, 0.02), smoothstep(0.03, 0.3, leakage));
    gl_FragColor = vec4(mixDebug, 1.0);
    return;
  }

  float warp = (energy - 0.5) * 0.004;
  vec2 warpUv = uv + flowDir * warp;

  float aberration = u_chromaAberration * 0.003;
  float r = texture2D(u_baseTex, warpUv + vec2(aberration, 0.0)).r;
  float g = texture2D(u_baseTex, warpUv).g;
  float b = texture2D(u_baseTex, warpUv - vec2(aberration, 0.0)).b;
  vec3 baseColor = vec3(r, g, b);

  float pulse = noise(uv * 380.0 + vec2(u_time * 0.2, -u_time * 0.15));
  vec3 inkColor = mix(vec3(0.09, 0.08, 0.07), vec3(0.93, 0.77, 0.53), pulse * 0.7 + flowMag * 0.3);

  float blendAmount = smoothstep(0.05, 0.85, energy) * dynamicMask * (1.0 - edge * 0.65);
  vec3 mixed = mix(baseColor, mix(baseColor * 0.62, inkColor, 0.65), blendAmount);

  // Subtle paper-like grain.
  float grain = (hash(uv * u_resolution.xy + u_time) - 0.5) * u_grainAmount * 0.12;
  mixed += grain;

  gl_FragColor = vec4(clamp(mixed, 0.0, 1.0), 1.0);
}
