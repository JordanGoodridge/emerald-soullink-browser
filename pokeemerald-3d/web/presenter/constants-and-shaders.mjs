// WebGPU HD-2D surface constants, camera parameters, and WGSL shaders.
export const HD2D_SURFACE_BITS = 3;
export const HD2D_SURFACE_GROUND = 0;
export const HD2D_SURFACE_WATER = 1;
export const HD2D_SURFACE_DECK = 2;
export const HD2D_SURFACE_TERRAIN = 3;
export const HD2D_SURFACE_OBSTACLE = 4;
export const HD2D_SURFACE_WALL = 5;
export const HD2D_SURFACE_ROOF = 6;
export const HD2D_SURFACE_OPEN_DECK = 7;
export const HD2D_SURFACE_MASK = (1 << HD2D_SURFACE_BITS) - 1;
export const HD2D_COMPONENT_SHIFT = HD2D_SURFACE_BITS;
export const HD2D_RECEIVER_VALID = 0x8000;
export const HD2D_RECEIVER_TERRAIN_FACE = 0x4000;
export const HD2D_RECEIVER_TERRAIN_FACE_SOUTH = 0x20;
export const HD2D_RECEIVER_TERRAIN_FACE_SELF = 0x40;
export const HD2D_RECEIVER_OFFSET_BIAS = 16;
export const HD2D_RECEIVER_OFFSET_MASK = 31;
export const HD2D_RECEIVER_DX_SHIFT = HD2D_SURFACE_BITS;
export const HD2D_RECEIVER_DY_SHIFT = 8;
export const HD2D_FACADE_ROOF_OVERHANG = 0x80000000;
export const HD2D_FACADE_STEPPED_TIER = 0x40000000;
export const HD2D_FACADE_ROW_MASK = 0x3fff;

export const FULLSCREEN_VERTEX = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0),
  );
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0),
  );
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}
`;

export const PRESENT_SHADER = FULLSCREEN_VERTEX + /* wgsl */ `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(sourceTexture));
  let uv = clamp(input.uv, vec2f(0.0), vec2f(0.99999));
  return textureLoad(sourceTexture, clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1), 0);
}
`;

export const CINEMATIC_SHADER = FULLSCREEN_VERTEX + /* wgsl */ `
struct Camera {
  values: vec4f,
  viewport: vec4f,
  world: vec4f,
}
@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var focusDepthTexture: texture_2d<f32>;

fn loadScene(pixel: vec2i, size: vec2i) -> vec3f {
  return textureLoad(sceneTexture, clamp(pixel, vec2i(0), size - 1), 0).rgb;
}

fn luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

fn highlight(color: vec3f) -> vec3f {
  let energy = smoothstep(0.57, 0.90, luminance(color));
  return color * energy;
}

struct FocusSamples {
  color: vec3f,
  bloom: vec3f,
  weight: f32,
}

fn focusSample(pixel: vec2i, centerDepth: f32, size: vec2i) -> FocusSamples {
  let clampedPixel = clamp(pixel, vec2i(0), size - 1);
  let color = textureLoad(sceneTexture, clampedPixel, 0).rgb;
  let depth = textureLoad(focusDepthTexture, clampedPixel, 0).r;
  // Nearby samples on the same projected surface remain eligible, while
  // geometry across a depth discontinuity cannot tint the center fragment.
  let weight = 1.0 - smoothstep(10.0, 34.0, abs(depth - centerDepth));
  return FocusSamples(color, highlight(color), weight);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(sceneTexture));
  let uv = clamp(input.uv, vec2f(0.0), vec2f(0.99999));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1);
  let base = loadScene(pixel, size);
  let centerDepth = textureLoad(focusDepthTexture, pixel, 0).r;
  let renderScale = max(f32(size.x) / 240.0, 1.0);
  let centered = uv * 2.0 - vec2f(1.0);

  // Focus follows physical camera-space depth, not screen position or the
  // nonlinear depth buffer used for raster occlusion. The playable plane at
  // camera height remains crisp as geometry in front of and behind it falls
  // out of focus. Radius scales with output size, describing world detail.
  let focusDistance = abs(centerDepth - camera.values.w);
  let radialDistance = length(centered * vec2f(0.82, 1.0));
  let blurAmount = camera.world.z * max(
    smoothstep(30.0, 118.0, focusDistance),
    0.20 * smoothstep(0.78, 1.15, radialDistance)
  );
  let radius = max(1, i32(ceil(renderScale * (0.75 + 1.35 * blurAmount))));
  let horizontal = vec2i(radius, 0);
  let vertical = vec2i(0, radius);
  let diagonal = vec2i(radius, radius);
  let north = focusSample(pixel - vertical, centerDepth, size);
  let south = focusSample(pixel + vertical, centerDepth, size);
  let west = focusSample(pixel - horizontal, centerDepth, size);
  let east = focusSample(pixel + horizontal, centerDepth, size);
  let northwest = focusSample(pixel - diagonal, centerDepth, size);
  let southeast = focusSample(pixel + diagonal, centerDepth, size);
  let northeast = focusSample(pixel + vec2i(radius, -radius), centerDepth, size);
  let southwest = focusSample(pixel + vec2i(-radius, radius), centerDepth, size);
  let acceptedWeight = north.weight + south.weight + west.weight + east.weight
    + northwest.weight + southeast.weight + northeast.weight + southwest.weight;
  let acceptedColor = north.color * north.weight + south.color * south.weight
    + west.color * west.weight + east.color * east.weight
    + northwest.color * northwest.weight + southeast.color * southeast.weight
    + northeast.color * northeast.weight + southwest.color * southwest.weight;
  // Rejected taps become the center color, so silhouettes and roof lines
  // cannot bleed and the exact center texel always retains a dominant weight.
  let focused = (2.0 * base + acceptedColor + base * (8.0 - acceptedWeight)) / 10.0;
  var color = mix(base, focused, 0.82 * blurAmount);

  // Blur and bloom reuse the same eight accepted ring taps: including the
  // center, this post-process performs only nine scene-color loads.
  let bloom = (north.bloom * north.weight + south.bloom * south.weight
    + west.bloom * west.weight + east.bloom * east.weight
    + northwest.bloom * northwest.weight + southeast.bloom * southeast.weight
    + northeast.bloom * northeast.weight + southwest.bloom * southwest.weight) / 8.0;
  let optical = color;
  color += bloom * 0.23;

  // Soft optical falloff retains the miniature-diorama framing. No grading,
  // split tone, screen grain, or glow stacks on the world-space neutral key.
  let vignetteShape = dot(centered * vec2f(0.82, 1.03), centered * vec2f(0.82, 1.03));
  let vignette = smoothstep(0.30, 1.08, vignetteShape);
  color *= 1.0 - 0.31 * vignette;

  let lit = mix(optical, clamp(color, vec3f(0.0), vec3f(1.0)), camera.values.z);
  return vec4f(clamp(lit, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

export const TERRAIN_SHADER = /* wgsl */ `
struct Camera {
  values: vec4f,
  viewport: vec4f,
  world: vec4f,
  lightTransform: mat4x4f,
}
struct VertexInput {
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) normal: vec3f,
  @location(3) material: f32,
  @location(4) shellAndBase: vec2f,
  @location(5) neutralColor: vec3f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) material: u32,
  @location(3) shadowPosition: vec3f,
  @location(4) cameraDepth: f32,
  @location(5) @interpolate(flat) neutralColor: vec3f,
  @location(6) worldPosition: vec3f,
  @location(7) @interpolate(flat) structureBase: f32,
}
@group(0) @binding(0) var worldTexture: texture_2d<f32>;
@group(0) @binding(1) var pixelSampler: sampler;
@group(0) @binding(2) var<uniform> camera: Camera;
@group(0) @binding(3) var structuralShadowMap: texture_depth_2d;
@group(0) @binding(4) var structuralShadowSampler: sampler_comparison;
@group(0) @binding(5) var structuralAlphaTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  let angle = radians(45.384615 * camera.values.x);
  let sine = sin(angle);
  let cosine = cos(angle);
  let cameraHeight = camera.values.w;
  let zoom = camera.values.y;
  let zoomOut = 0.30 * zoom + 0.76923077 * zoom * zoom * (zoom - 0.35);
  let focal = cameraHeight / (1.0 + zoomOut);
  // Roofs, facades, and terrain must share one camera. Keeping facades aligned
  // in screen space creates a second projection and a visible seam at roofs.
  let viewY = input.position.y * sine - input.position.z * cosine;
  let depth = cameraHeight - input.position.y * cosine - input.position.z * sine;
  let near = camera.viewport.z;
  let far = camera.viewport.w;
  var output: VertexOutput;
  output.position = vec4f(
    input.position.x * focal / (camera.viewport.x * 0.5),
    viewY * focal / (camera.viewport.y * 0.5),
    ((depth - near) / (far - near)) * depth,
    depth,
  );
  output.uv = input.uv;
  output.normal = input.normal;
  output.material = u32(input.material);
  output.neutralColor = input.neutralColor;
  output.worldPosition = input.position;
  output.structureBase = input.shellAndBase.y;
  let lightClip = camera.lightTransform * vec4f(input.position, 1.0);
  output.shadowPosition = vec3f(
    lightClip.x * 0.5 + 0.5,
    0.5 - lightClip.y * 0.5,
    lightClip.z,
  );
  output.cameraDepth = depth;
  return output;
}

const TO_KEY = normalize(vec3f(-0.45, 0.77, -0.45));
const SURFACE_GROUND = 0u;
const SURFACE_WATER = 1u;
const SURFACE_ROOF = 6u;
const MATERIAL_NEUTRAL_BUILDING = 8u;

fn structuralVisibility(position: vec3f, normal: vec3f) -> f32 {
  if (any(position.xy <= vec2f(0.001)) || any(position.xy >= vec2f(0.999))
      || position.z <= 0.0 || position.z >= 1.0) {
    return 1.0;
  }
  let texel = 1.0 / vec2f(textureDimensions(structuralShadowMap));
  let slope = 1.0 - max(dot(normal, TO_KEY), 0.0);
  let reference = position.z - (0.00045 + 0.00115 * slope);
  var visibility = 0.0;
  for (var y = -1; y <= 1; y += 2) {
    for (var x = -1; x <= 1; x += 2) {
      visibility += textureSampleCompareLevel(
        structuralShadowMap, structuralShadowSampler,
        position.xy + vec2f(f32(x), f32(y)) * texel * 0.72,
        reference,
      );
    }
  }
  return visibility * 0.25;
}

struct FragmentOutput {
  @location(0) color: vec4f,
  @location(1) focusDepth: f32,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragmentOutput {
  var base: vec3f;
  if (input.material == MATERIAL_NEUTRAL_BUILDING) {
    // Unauthored closure geometry uses a component-derived material. Do not
    // sample arbitrary atlas pixels that can contain paths, doors, or logos.
    base = input.neutralColor;
    let course = max(0.0, (input.worldPosition.y - input.structureBase) / 8.0);
    let seam = 1.0 - smoothstep(0.025, 0.095, fract(course));
    let tone = select(0.99, 1.01, fract(floor(course) * 0.5) >= 0.5);
    base *= tone * (1.0 - seam * 0.07);
  } else {
    let world = textureSampleLevel(worldTexture, pixelSampler, input.uv, 0.0);
    let structuralAlpha = textureSampleLevel(structuralAlphaTexture, pixelSampler, input.uv, 0.0).r;
    if (input.material == SURFACE_ROOF && structuralAlpha < 0.5) {
      discard;
    }
    if (input.material == 5u && structuralAlpha < 0.5) {
      discard;
    } else {
      base = world.rgb;
    }
  }
  let normal = normalize(input.normal);
  let direct = max(dot(normal, TO_KEY), 0.0);
  let faceLight = 0.70 + 0.39 * direct;
  let visibility = structuralVisibility(input.shadowPosition, normal);
  let receiverDensity = select(1.0, 0.44, input.material == SURFACE_WATER);
  let shadowLight = 1.0 - (1.0 - visibility) * 0.36 * receiverDensity;
  let illumination = faceLight * shadowLight;
  var output: FragmentOutput;
  output.color = vec4f(base * mix(1.0, illumination, camera.values.z), 1.0);
  output.focusDepth = input.cameraDepth;
  // Flat receiver art uses the billboard shader's exact per-pixel BG
  // priority mask for foreground details such as flags. Keeping the opaque
  // receiver at its projected depth would also hide actors behind the nearby
  // ground-colored pixels that surround those details. Water is a flat
  // receiver too: at its real depth it would swallow reflections, which
  // render below their owner's anchor and therefore behind the surface.
  output.depth = select(
    input.position.z, 0.99999,
    input.material == SURFACE_GROUND || input.material == SURFACE_WATER,
  );
  return output;
}
`;

export const STRUCTURAL_SHADOW_SHADER = /* wgsl */ `
struct Camera {
  values: vec4f,
  viewport: vec4f,
  world: vec4f,
  lightTransform: mat4x4f,
}
struct VertexInput {
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(3) material: f32,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) material: u32,
}
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var structuralAlphaTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = camera.lightTransform * vec4f(input.position, 1.0);
  output.uv = input.uv;
  output.material = u32(input.material);
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) {
  if (input.material == 6u) {
    let size = vec2i(textureDimensions(structuralAlphaTexture));
    let pixel = clamp(vec2i(input.uv * vec2f(size)), vec2i(0), size - 1);
    if (textureLoad(structuralAlphaTexture, pixel, 0).r < 0.5) { discard; }
  }
}
`;

export const BILLBOARD_SHADER = /* wgsl */ `
struct VertexInput {
  @location(0) position: vec2f,
  @location(1) uv: vec2f,
  @location(2) depth: f32,
  @location(3) layer: f32,
  @location(4) sourceSize: vec2f,
  @location(5) drawSize: vec2f,
  @location(6) affine: f32,
  @location(7) matrix: vec4f,
  @location(8) maskAtlas: vec2f,
  @location(9) objectInfo: vec2f,
  @location(10) cameraDepth: f32,
  @location(11) screenOrigin: vec2f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) layer: u32,
  @location(2) @interpolate(flat) sourceSize: vec2u,
  @location(3) @interpolate(flat) drawSize: vec2u,
  @location(4) @interpolate(flat) affine: u32,
  @location(5) @interpolate(flat) matrix: vec4i,
  @location(6) maskAtlas: vec2f,
  @location(7) @interpolate(flat) objectInfo: vec2u,
  @location(8) @interpolate(flat) cameraDepth: f32,
  @location(9) @interpolate(flat) screenOrigin: vec2i,
}
@group(0) @binding(0) var objectTexture: texture_2d_array<f32>;
@group(0) @binding(1) var bgPriorityTexture: texture_2d<u32>;
@group(0) @binding(2) var structuralAlphaTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(input.position.x / 120.0 - 1.0, 1.0 - input.position.y / 80.0, input.depth, 1.0);
  output.uv = input.uv;
  output.layer = u32(input.layer);
  output.sourceSize = vec2u(input.sourceSize);
  output.drawSize = vec2u(input.drawSize);
  output.affine = u32(input.affine);
  output.matrix = vec4i(input.matrix);
  output.maskAtlas = input.maskAtlas;
  output.objectInfo = vec2u(input.objectInfo);
  output.cameraDepth = input.cameraDepth;
  output.screenOrigin = vec2i(input.screenOrigin);
  return output;
}

struct FragmentOutput {
  @location(0) color: vec4f,
  @location(1) focusDepth: f32,
  @builtin(frag_depth) depth: f32,
}

fn objectColor(input: VertexOutput) -> vec4f {
  let dest = vec2i(floor(input.uv));
  var source = dest;
  if (input.affine != 0u) {
    let delta = dest - vec2i(input.drawSize) / 2;
    source = vec2i(
      (input.matrix.x * delta.x + input.matrix.y * delta.y) >> 8,
      (input.matrix.z * delta.x + input.matrix.w * delta.y) >> 8
    ) + vec2i(input.sourceSize) / 2;
  }
  if (any(source < vec2i(0)) || any(source >= vec2i(input.sourceSize))) {
    return vec4f(0.0);
  }
  return textureLoad(objectTexture, source, i32(input.layer), 0);
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragmentOutput {
  // Elevated structural art (roofs, gate spans) is extruded, so it keeps the
  // exact flat GBA-space overlap mask. Flat receiver details (flags) render
  // foreshortened on the ground plane, so their mask uses the CPU-inverted
  // ground-plane projection: the receiver pixel actually rendered at this
  // screen location. Mixing them up either bares actors under gate roofs or
  // occludes actors above a flag's drawn art.
  let prioritySize = vec2i(textureDimensions(bgPriorityTexture));
  let flatAtlas = input.screenOrigin + vec2i(floor(input.uv))
    + (prioritySize - vec2i(240, 160)) / 2;
  let flatIn = all(flatAtlas >= vec2i(0)) && all(flatAtlas < prioritySize);
  let structural = flatIn
    && textureLoad(structuralAlphaTexture, flatAtlas, 0).r >= 0.5;
  let atlas = select(vec2i(floor(input.maskAtlas)), flatAtlas, structural);
  let inAtlas = all(atlas >= vec2i(0)) && all(atlas < prioritySize);
  var occluded = false;
  if (inAtlas) {
    let bgPriority = textureLoad(bgPriorityTexture, atlas, 0).r;
    if (bgPriority == 255u) { discard; }
    occluded = bgPriority < input.objectInfo.y;
  }

  let color = objectColor(input);
  if (color.a <= 0.0) { discard; }
  if (occluded) { discard; }
  var output: FragmentOutput;
  output.color = color;
  output.focusDepth = input.cameraDepth;
  output.depth = input.position.z;
  return output;
}
`;
export const CAST_SHADOW_SHADER = /* wgsl */ `
struct Camera {
  values: vec4f,
  viewport: vec4f,
  world: vec4f,
}
struct VertexInput {
  @location(0) ground: vec3f,
  @location(1) uv: vec2f,
  @location(2) layer: f32,
  @location(3) sourceSize: vec2f,
  @location(4) drawSize: vec2f,
  @location(5) affine: f32,
  @location(6) matrix: vec4f,
  @location(7) priority: f32,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) layer: u32,
  @location(2) @interpolate(flat) sourceSize: vec2u,
  @location(3) @interpolate(flat) drawSize: vec2u,
  @location(4) @interpolate(flat) affine: u32,
  @location(5) @interpolate(flat) matrix: vec4i,
  @location(6) ground: vec2f,
  @location(7) @interpolate(flat) priority: u32,
}
@group(0) @binding(0) var objectTexture: texture_2d_array<f32>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var bgPriorityTexture: texture_2d<u32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  let angle = radians(45.384615 * camera.values.x);
  let sine = sin(angle);
  let cosine = cos(angle);
  let cameraHeight = camera.values.w;
  let zoom = camera.values.y;
  let zoomOut = 0.30 * zoom + 0.76923077 * zoom * zoom * (zoom - 0.35);
  let focal = cameraHeight / (1.0 + zoomOut);
  let viewY = input.ground.y * sine - input.ground.z * cosine;
  let depth = cameraHeight - input.ground.y * cosine - input.ground.z * sine;
  let near = camera.viewport.z;
  let far = camera.viewport.w;
  var output: VertexOutput;
  output.position = vec4f(
    input.ground.x * focal / (camera.viewport.x * 0.5),
    viewY * focal / (camera.viewport.y * 0.5),
    (((depth - near) / (far - near)) - 0.00002) * depth,
    depth,
  );
  output.uv = input.uv;
  output.layer = u32(input.layer);
  output.sourceSize = vec2u(input.sourceSize);
  output.drawSize = vec2u(input.drawSize);
  output.affine = u32(input.affine);
  output.matrix = vec4i(input.matrix);
  output.ground = vec2f(input.ground.x, input.ground.z) + camera.viewport.xy * 0.5;
  output.priority = u32(input.priority);
  return output;
}

fn sourceCoordinate(dest: vec2i, input: VertexOutput) -> vec2i {
  if (input.affine == 0u) { return dest; }
  let delta = dest - vec2i(input.drawSize) / 2;
  return vec2i(
    (input.matrix.x * delta.x + input.matrix.y * delta.y) >> 8,
    (input.matrix.z * delta.x + input.matrix.w * delta.y) >> 8
  ) + vec2i(input.sourceSize) / 2;
}

fn objectAlpha(dest: vec2i, input: VertexOutput) -> f32 {
  // Match the billboard's exact visible destination mask before applying the
  // affine matrix. The padded shadow geometry can then soften the outline
  // without revealing source pixels that the real object does not draw.
  if (any(dest < vec2i(0)) || any(dest >= vec2i(input.drawSize))) { return 0.0; }
  let source = sourceCoordinate(dest, input);
  if (any(source < vec2i(0)) || any(source >= vec2i(input.sourceSize))) { return 0.0; }
  return textureLoad(objectTexture, source, i32(input.layer), 0).a;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let prioritySize = vec2i(textureDimensions(bgPriorityTexture));
  let atlasOffset = (prioritySize - vec2i(camera.viewport.xy)) / 2;
  let atlasPixel = vec2i(floor(input.ground)) + atlasOffset;
  if (any(atlasPixel < vec2i(0)) || any(atlasPixel >= prioritySize)) { discard; }
  let receiverPriority = textureLoad(bgPriorityTexture, atlasPixel, 0).r;
  if (receiverPriority == 0xffu || receiverPriority < input.priority) { discard; }

  let dest = vec2i(floor(input.uv));
  let center = objectAlpha(dest, input);
  let cardinal = objectAlpha(dest + vec2i(-1, 0), input)
    + objectAlpha(dest + vec2i(1, 0), input)
    + objectAlpha(dest + vec2i(0, -1), input)
    + objectAlpha(dest + vec2i(0, 1), input);
  let diagonal = objectAlpha(dest + vec2i(-1, -1), input)
    + objectAlpha(dest + vec2i(1, -1), input)
    + objectAlpha(dest + vec2i(-1, 1), input)
    + objectAlpha(dest + vec2i(1, 1), input);
  let farCardinal = objectAlpha(dest + vec2i(-2, 0), input)
    + objectAlpha(dest + vec2i(2, 0), input)
    + objectAlpha(dest + vec2i(0, -2), input)
    + objectAlpha(dest + vec2i(0, 2), input);
  let farDiagonal = objectAlpha(dest + vec2i(-2, -2), input)
    + objectAlpha(dest + vec2i(2, -2), input)
    + objectAlpha(dest + vec2i(-2, 2), input)
    + objectAlpha(dest + vec2i(2, 2), input);
  let silhouette = clamp(center * 0.52 + cardinal * 0.055 + diagonal * 0.020
    + farCardinal * 0.025 + farDiagonal * 0.010, 0.0, 1.0);
  if (silhouette <= 0.005) { discard; }
  return vec4f(1.0, 1.0, 1.0, silhouette);
}
`;

export const CAST_SHADOW_COMPOSITE_SHADER = FULLSCREEN_VERTEX + /* wgsl */ `
struct Camera {
  values: vec4f,
  viewport: vec4f,
  world: vec4f,
}
@group(0) @binding(0) var shadowMask: texture_2d<f32>;
@group(0) @binding(1) var<uniform> camera: Camera;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(shadowMask));
  let pixel = clamp(vec2i(input.uv * vec2f(size)), vec2i(0), size - 1);
  let silhouette = textureLoad(shadowMask, pixel, 0).a;
  if (silhouette <= 0.005) { discard; }
  return vec4f(0.0, 0.0, 0.0, silhouette * 0.460 * camera.values.z);
}
`;

export const UI_SHADER = FULLSCREEN_VERTEX + /* wgsl */ `
@group(0) @binding(0) var uiTexture: texture_2d<f32>;
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(uiTexture));
  let uv = clamp(input.uv, vec2f(0.0), vec2f(0.99999));
  let color = textureLoad(uiTexture, clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1), 0);
  if (color.a < 0.5) { discard; }
  return vec4f(color.rgb, 1.0);
}
`;

// Classic transitions (swirls, shuffles, mosaics, wipes, fades) are exported
// as final = add + weight * world(source) per screen pixel, so the effect
// warps and tints the projected scene instead of the flat frame.
export const SCREEN_EFFECT_SHADER = FULLSCREEN_VERTEX + /* wgsl */ `
@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var effectTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceTexture: texture_2d<i32>;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let sceneSize = vec2i(textureDimensions(sceneTexture));
  let screenSize = vec2i(textureDimensions(effectTexture));
  let scale = max(sceneSize / screenSize, vec2i(1));
  let pixel = vec2i(input.position.xy);
  let screen = clamp(pixel / scale, vec2i(0), screenSize - 1);
  let add = textureLoad(effectTexture, screen, 0).rgb;
  let source = textureLoad(sourceTexture, screen, 0);
  if (source.z <= 0) { return vec4f(add, 1.0); }
  var sample = pixel + (source.xy - screen) * scale;
  if ((source.w & 1) != 0) { sample = source.xy * scale + scale / 2; }
  // Background layers wrap on hardware, so displaced lines wrap too.
  let world = textureLoad(sceneTexture, ((sample % sceneSize) + sceneSize) % sceneSize, 0).rgb;
  return vec4f(min(add + world * (f32(source.z) / 256.0), vec3f(1.0)), 1.0);
}
`;

export const TILE_SIZE = 8;
export const BILLBOARD_DEPTH_BIAS = 2;
export const CAMERA_HEIGHT = 480;
export const CAMERA_TILT_DEGREES = 45.384615;
export const REMOTE_AVATAR_LAYERS = 108;
export const CAMERA_NEAR = 32;
export const CAMERA_FAR = 1024;
export const BILLBOARD_CLEARANCE_TILES = 8;
export const VERTEX_FLOATS = 14;
export const BILLBOARD_VERTEX_FLOATS = 22;
export const CAST_SHADOW_VERTEX_FLOATS = 16;
export const BUILDING_MATERIAL_BYTES_PER_TILE = TILE_SIZE * TILE_SIZE * 5;
export const STRUCTURAL_SHADOW_SIZE = 1024;
export const LIGHT_MAP_SPAN = 1280;
export const LIGHT_DEPTH_SPAN = 1400;
