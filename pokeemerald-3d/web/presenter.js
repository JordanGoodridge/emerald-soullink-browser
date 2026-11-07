// WebGPU HD-2D & classic presenter lifecycle, pipeline setup, and frame composition.
export {
  HD2D_SURFACE_WATER,
  HD2D_SURFACE_DECK,
  HD2D_SURFACE_TERRAIN,
  HD2D_SURFACE_OBSTACLE,
  HD2D_SURFACE_OPEN_DECK,
  HD2D_SURFACE_MASK,
} from './presenter/constants-and-shaders.mjs';
import {
  HD2D_SURFACE_BITS,
  HD2D_SURFACE_GROUND,
  HD2D_SURFACE_WATER,
  HD2D_SURFACE_DECK,
  HD2D_SURFACE_TERRAIN,
  HD2D_SURFACE_OBSTACLE,
  HD2D_SURFACE_WALL,
  HD2D_SURFACE_ROOF,
  HD2D_SURFACE_OPEN_DECK,
  HD2D_SURFACE_MASK,
  HD2D_COMPONENT_SHIFT,
  HD2D_RECEIVER_VALID,
  HD2D_RECEIVER_TERRAIN_FACE,
  HD2D_RECEIVER_TERRAIN_FACE_SOUTH,
  HD2D_RECEIVER_TERRAIN_FACE_SELF,
  HD2D_RECEIVER_OFFSET_BIAS,
  HD2D_RECEIVER_OFFSET_MASK,
  HD2D_RECEIVER_DX_SHIFT,
  HD2D_RECEIVER_DY_SHIFT,
  HD2D_FACADE_ROOF_OVERHANG,
  HD2D_FACADE_STEPPED_TIER,
  HD2D_FACADE_ROW_MASK,
  FULLSCREEN_VERTEX,
  PRESENT_SHADER,
  CINEMATIC_SHADER,
  TERRAIN_SHADER,
  STRUCTURAL_SHADOW_SHADER,
  BILLBOARD_SHADER,
  CAST_SHADOW_SHADER,
  CAST_SHADOW_COMPOSITE_SHADER,
  UI_SHADER,
  SCREEN_EFFECT_SHADER,
  TILE_SIZE,
  BILLBOARD_DEPTH_BIAS,
  CAMERA_HEIGHT,
  CAMERA_TILT_DEGREES,
  REMOTE_AVATAR_LAYERS,
  CAMERA_NEAR,
  CAMERA_FAR,
  BILLBOARD_CLEARANCE_TILES,
  VERTEX_FLOATS,
  BILLBOARD_VERTEX_FLOATS,
  CAST_SHADOW_VERTEX_FLOATS,
  BUILDING_MATERIAL_BYTES_PER_TILE,
  STRUCTURAL_SHADOW_SIZE,
  LIGHT_MAP_SPAN,
  LIGHT_DEPTH_SPAN,
} from './presenter/constants-and-shaders.mjs';
import { terrainBuilderMethods } from './presenter/terrain-builder.mjs';
import { billboardBuilderMethods } from './presenter/billboard-builder.mjs';

function webGpuUnavailableError() {
  if (globalThis.isSecureContext === false) {
    return new Error(
      'WebGPU requires a secure HTTPS connection; plain HTTP IP addresses are not supported. With Tailscale, run “tailscale serve --bg 8000” on the host and open the HTTPS URL it prints. localhost remains available for local development.',
    );
  }
  return new Error(
    'This browser or device does not provide WebGPU. Update the operating system and use a WebGPU-capable browser.',
  );
}

class WebGpuPresenter {
  static async create(canvas, width, height, worldWidth, worldHeight, scale, onFailure) {
    if (!navigator.gpu) throw webGpuUnavailableError();
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU is available, but no compatible graphics adapter was found.');
    const device = await adapter.requestDevice();
    try {
      return new WebGpuPresenter(canvas, width, height, worldWidth, worldHeight, scale, adapter, device, onFailure);
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  constructor(canvas, width, height, worldWidth, worldHeight, scale, adapter, device, onFailure) {
    Object.assign(this, { canvas, width, height, worldWidth, worldHeight, adapter, device });
    this.disposed = false;
    this.failure = null;
    this.onFailure = onFailure;
    this.uncapturedErrorHandler = (event) => {
      if (this.disposed) return;
      event.preventDefault();
      const detail = event.error?.message || String(event.error || 'unknown WebGPU error');
      this.reportFailure('uncaptured error', new Error(`WebGPU reported an uncaptured error: ${detail}`));
    };
    this.context = canvas.getContext('webgpu');
    if (!this.context) throw new Error('WebGPU canvas context is unavailable');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.finalTexture = this.createTexture('canonical frame', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    this.worldTexture = this.createTexture('overscan world atlas', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, worldWidth, worldHeight);
    this.structuralAlphaTexture = this.createTexture('authored structural alpha', 'r8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, worldWidth, worldHeight);
    this.objectTexture = device.createTexture({
      label: 'independent OAM source layers', size: { width: 64, height: 64, depthOrArrayLayers: 128 },
      format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.remoteAvatarTexture = device.createTexture({
      label: 'remote player avatar layers',
      size: { width: 64, height: 64, depthOrArrayLayers: REMOTE_AVATAR_LAYERS },
      format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.remoteAvatarRevision = -1;
    this.remoteAvatarLayers = 0;
    this.remoteAvatarPixels = null;
    this.bgPriorityTexture = this.createTexture('world BG priority', 'r8uint', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, worldWidth, worldHeight);
    this.uiTexture = this.createTexture('flat BG0 interface', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    this.screenEffectTexture = this.createTexture('screen effect overlay', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    this.screenEffectSourceTexture = this.createTexture('screen effect world sources', 'rgba16sint', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    this.sceneWidth = width * scale;
    this.sceneHeight = height * scale;
    this.sceneTexture = this.createTexture('high-resolution 3D scene', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, this.sceneWidth, this.sceneHeight);
    this.castShadowTexture = this.createTexture('unified projected shadow mask', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, this.sceneWidth, this.sceneHeight);
    this.gradedTexture = this.createTexture('cinematic graded scene', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, this.sceneWidth, this.sceneHeight);
    this.depthTexture = this.createTexture('high-resolution 3D depth', 'depth24plus', GPUTextureUsage.RENDER_ATTACHMENT, this.sceneWidth, this.sceneHeight);
    this.focusDepthTexture = this.createTexture('physical camera focus depth', 'r32float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, this.sceneWidth, this.sceneHeight);
    this.structuralShadowTexture = this.createTexture(
      'world-anchored structural shadow map', 'depth32float',
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      STRUCTURAL_SHADOW_SIZE, STRUCTURAL_SHADOW_SIZE,
    );
    this.cameraBuffer = device.createBuffer({ label: '3D camera, optics, and lighting', size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.vertexCapacity = 1024 * 1024;
    this.vertexBuffer = device.createBuffer({ label: 'projected terrain mesh', size: this.vertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.billboardVertexCapacity = 64 * 1024;
    this.billboardVertexBuffer = device.createBuffer({ label: 'high-resolution billboard quads', size: this.billboardVertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.castShadowVertexCapacity = 64 * 1024;
    this.castShadowVertexBuffer = device.createBuffer({ label: 'projected sprite shadow geometry', size: this.castShadowVertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.uiPixels = new Uint8Array(width * height * 4);
    this.objectPixels = Array.from({ length: 128 }, () => []);
    this.objectPixelHead = new Int32Array(128);
    this.objectPixelNext = new Int32Array(width * height);
    this.groupAnchorY = new Int32Array(128);
    this.objectFootRows = new Float32Array(128);
    this.billboardScratch = new Float32Array(this.billboardVertexCapacity / 4);
    this.castShadowScratch = new Float32Array(this.castShadowVertexCapacity / 4);
    this.terrainVertexScratch = new Float32Array(this.vertexCapacity / 4);
    this.cameraValuesScratch = new Float32Array(28);
    this.lightTransformScratch = new Float32Array(16);
    this.structuralShadowLightTransform = new Float32Array(16);
    this.structuralShadowLightTransformValid = false;
    const terrainTileCapacity = (Math.ceil(worldWidth / TILE_SIZE) + 2) * (Math.ceil(worldHeight / TILE_SIZE) + 2);
    this.tileHeights = new Float32Array(terrainTileCapacity);
    this.tileGroundHeights = new Float32Array(terrainTileCapacity);
    this.tileGeometry = new Uint16Array(terrainTileCapacity);
    this.tileReceivers = new Uint16Array(terrainTileCapacity);
    this.tileFacades = new Uint32Array(terrainTileCapacity);
    this.tileBuildingMaterialPixels = new Uint8Array(
      terrainTileCapacity * BUILDING_MATERIAL_BYTES_PER_TILE,
    );
    this.terrainCols = 0;
    this.terrainRows = 0;
    this.terrainOriginX = 0;
    this.terrainOriginY = 0;
    this.terrainSignature = null;
    this.terrainMaterialSnapshotValid = false;
    this.terrainVertexCount = 0;
    this.terrainRevision = 0;
    this.structuralShadowTerrainRevision = -1;
    this.sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', mipmapFilter: 'nearest' });
    this.structuralShadowSampler = device.createSampler({
      compare: 'less-equal', magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
    this.createPipelines();
    this.resize(scale);
    device.addEventListener('uncapturederror', this.uncapturedErrorHandler);
    device.lost.then((info) => {
      if (this.disposed) return;
      const reason = info.reason && info.reason !== 'unknown' ? ` (${info.reason})` : '';
      const detail = info.message ? `: ${info.message}` : '';
      this.reportFailure('device lost', new Error(`WebGPU device was lost${reason}${detail}`));
    });
  }

  reportFailure(kind, error) {
    if (this.failure || this.disposed) return;
    this.failure = { kind, error };
    this.onFailure?.(this, error, kind);
  }

  createTexture(label, format, usage, width = this.width, height = this.height) {
    return this.device.createTexture({ label, size: [width, height], format, usage });
  }

  createLightTransform(worldPixelOriginX, worldPixelOriginY) {
    // Light travels toward the southeast. Keeping the orthographic projection
    // square and snapping its center to whole shadow texels makes the map
    // world-anchored while the overscan atlas follows the camera.
    const length = Math.hypot(0.45, 0.77, 0.45);
    const forward = [0.45 / length, -0.77 / length, 0.45 / length];
    const right = [Math.SQRT1_2, 0, -Math.SQRT1_2];
    const up = [
      forward[1] * right[2] - forward[2] * right[1],
      forward[2] * right[0] - forward[0] * right[2],
      forward[0] * right[1] - forward[1] * right[0],
    ];
    const centerX = worldPixelOriginX + this.worldWidth / 2;
    const centerZ = worldPixelOriginY + this.worldHeight / 2;
    const texelWorldSize = LIGHT_MAP_SPAN / STRUCTURAL_SHADOW_SIZE;
    const centerU = right[0] * centerX + right[2] * centerZ;
    const centerV = up[0] * centerX + up[2] * centerZ;
    const snappedU = Math.round(centerU / texelWorldSize) * texelWorldSize;
    const snappedV = Math.round(centerV / texelWorldSize) * texelWorldSize;
    const xyScale = 2 / LIGHT_MAP_SPAN;
    const depthScale = 1 / LIGHT_DEPTH_SPAN;
    const out = this.lightTransformScratch ?? (this.lightTransformScratch = new Float32Array(16));
    out[0] = right[0] * xyScale;
    out[1] = up[0] * xyScale;
    out[2] = forward[0] * depthScale;
    out[3] = 0;
    out[4] = right[1] * xyScale;
    out[5] = up[1] * xyScale;
    out[6] = forward[1] * depthScale;
    out[7] = 0;
    out[8] = right[2] * xyScale;
    out[9] = up[2] * xyScale;
    out[10] = forward[2] * depthScale;
    out[11] = 0;
    out[12] = (centerU - snappedU) * xyScale;
    out[13] = (centerV - snappedV) * xyScale;
    out[14] = 0.5;
    out[15] = 1;
    return out;
  }

  createPipelines() {
    const { device } = this;
    const terrainModule = device.createShaderModule({ label: 'projected terrain shader', code: TERRAIN_SHADER });
    this.terrainPipeline = device.createRenderPipeline({
      label: 'depth-tested projected terrain', layout: 'auto',
      vertex: {
        module: terrainModule, entryPoint: 'vertexMain',
        buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x2' },
          { shaderLocation: 2, offset: 20, format: 'float32x3' },
          { shaderLocation: 3, offset: 32, format: 'float32' },
          { shaderLocation: 4, offset: 36, format: 'float32x2' },
          { shaderLocation: 5, offset: 44, format: 'float32x3' },
        ] }],
      },
      fragment: { module: terrainModule, entryPoint: 'fragmentMain', targets: [
        { format: 'rgba8unorm' }, { format: 'r32float' },
      ] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.terrainBindGroup = device.createBindGroup({
      layout: this.terrainPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.worldTexture.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.cameraBuffer } },
        { binding: 3, resource: this.structuralShadowTexture.createView() },
        { binding: 4, resource: this.structuralShadowSampler },
        { binding: 5, resource: this.structuralAlphaTexture.createView() },
      ],
    });

    const structuralShadowModule = device.createShaderModule({
      label: 'structural shadow map shader', code: STRUCTURAL_SHADOW_SHADER,
    });
    this.structuralShadowPipeline = device.createRenderPipeline({
      label: 'terrain and building structural shadow map', layout: 'auto',
      vertex: {
        module: structuralShadowModule, entryPoint: 'vertexMain',
        buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x2' },
          { shaderLocation: 3, offset: 32, format: 'float32' },
        ] }],
      },
      fragment: { module: structuralShadowModule, entryPoint: 'fragmentMain', targets: [] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.structuralShadowBindGroup = device.createBindGroup({
      layout: this.structuralShadowPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: this.structuralAlphaTexture.createView() },
      ],
    });

    const castShadowModule = device.createShaderModule({ label: 'projected sprite shadow shader', code: CAST_SHADOW_SHADER });
    this.castShadowPipeline = device.createRenderPipeline({
      label: 'receiver-masked projected sprite shadows', layout: 'auto',
      vertex: {
        module: castShadowModule, entryPoint: 'vertexMain',
        buffers: [{ arrayStride: CAST_SHADOW_VERTEX_FLOATS * 4, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x2' },
          { shaderLocation: 2, offset: 20, format: 'float32' },
          { shaderLocation: 3, offset: 24, format: 'float32x2' },
          { shaderLocation: 4, offset: 32, format: 'float32x2' },
          { shaderLocation: 5, offset: 40, format: 'float32' },
          { shaderLocation: 6, offset: 44, format: 'float32x4' },
          { shaderLocation: 7, offset: 60, format: 'float32' },
        ] }],
      },
      fragment: { module: castShadowModule, entryPoint: 'fragmentMain', targets: [{
        format: 'rgba8unorm',
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
        },
      }] },
      primitive: { topology: 'triangle-list' },
      // A projected silhouette lands on its receiver plane. Testing against the
      // structural depth buffer keeps silhouettes whose ground landing point is
      // hidden behind extruded geometry from printing onto roofs and facades.
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    });
    this.castShadowBindGroup = device.createBindGroup({
      layout: this.castShadowPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.objectTexture.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: { buffer: this.cameraBuffer } },
        { binding: 2, resource: this.bgPriorityTexture.createView() },
      ],
    });

    const castShadowCompositeModule = device.createShaderModule({ label: 'projected shadow composite shader', code: CAST_SHADOW_COMPOSITE_SHADER });
    this.castShadowCompositePipeline = device.createRenderPipeline({
      label: 'unified projected shadow composite', layout: 'auto',
      vertex: { module: castShadowCompositeModule, entryPoint: 'vertexMain' },
      fragment: { module: castShadowCompositeModule, entryPoint: 'fragmentMain', targets: [{
        format: 'rgba8unorm',
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }] },
      primitive: { topology: 'triangle-list' },
    });

    const billboardModule = device.createShaderModule({ label: 'entity billboard shader', code: BILLBOARD_SHADER });
    const billboardVertex = {
      module: billboardModule, entryPoint: 'vertexMain',
      buffers: [{ arrayStride: BILLBOARD_VERTEX_FLOATS * 4, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x2' },
        { shaderLocation: 2, offset: 16, format: 'float32' },
        { shaderLocation: 3, offset: 20, format: 'float32' },
        { shaderLocation: 4, offset: 24, format: 'float32x2' },
        { shaderLocation: 5, offset: 32, format: 'float32x2' },
        { shaderLocation: 6, offset: 40, format: 'float32' },
        { shaderLocation: 7, offset: 44, format: 'float32x4' },
        { shaderLocation: 8, offset: 60, format: 'float32x2' },
        { shaderLocation: 9, offset: 68, format: 'float32x2' },
        { shaderLocation: 10, offset: 76, format: 'float32' },
        { shaderLocation: 11, offset: 80, format: 'float32x2' },
      ] }],
    };
    const billboardBlend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    this.billboardPipeline = device.createRenderPipeline({
      label: 'depth-tested upright entity billboards', layout: 'auto',
      vertex: billboardVertex,
      fragment: { module: billboardModule, entryPoint: 'fragmentMain', targets: [{
        format: 'rgba8unorm', blend: billboardBlend,
      }, { format: 'r32float' }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    this.billboardBindGroup = device.createBindGroup({
      layout: this.billboardPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.objectTexture.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: this.bgPriorityTexture.createView() },
        { binding: 2, resource: this.structuralAlphaTexture.createView() },
      ],
    });
    this.remoteBillboardBindGroup = device.createBindGroup({
      layout: this.billboardPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.remoteAvatarTexture.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: this.bgPriorityTexture.createView() },
        { binding: 2, resource: this.structuralAlphaTexture.createView() },
      ],
    });
    const cinematicModule = device.createShaderModule({ label: 'cinematic HD-2D shader', code: CINEMATIC_SHADER });
    this.cinematicPipeline = device.createRenderPipeline({
      label: 'cinematic bloom, focus, and vignette', layout: 'auto',
      vertex: { module: cinematicModule, entryPoint: 'vertexMain' },
      fragment: { module: cinematicModule, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });

    const uiModule = device.createShaderModule({ label: 'flat interface shader', code: UI_SHADER });
    this.uiPipeline = device.createRenderPipeline({
      label: 'flat BG0 interface overlay', layout: 'auto',
      vertex: { module: uiModule, entryPoint: 'vertexMain' },
      fragment: { module: uiModule, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.uiBindGroup = device.createBindGroup({ layout: this.uiPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.uiTexture.createView() }] });

    const presentModule = device.createShaderModule({ label: 'nearest presentation shader', code: PRESENT_SHADER });
    this.presentPipeline = device.createRenderPipeline({
      label: 'nearest presentation pipeline', layout: 'auto',
      vertex: { module: presentModule, entryPoint: 'vertexMain' },
      fragment: { module: presentModule, entryPoint: 'fragmentMain', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    const screenEffectModule = device.createShaderModule({ label: 'screen effect composite shader', code: SCREEN_EFFECT_SHADER });
    this.screenEffectPipeline = device.createRenderPipeline({
      label: 'screen effect composite over the projected scene', layout: 'auto',
      vertex: { module: screenEffectModule, entryPoint: 'vertexMain' },
      fragment: { module: screenEffectModule, entryPoint: 'fragmentMain', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    const layout = this.presentPipeline.getBindGroupLayout(0);
    this.presentLayout = layout;
    this.finalBindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: this.finalTexture.createView() }] });
    this.rebuildSceneBindGroups();
  }

  rebuildSceneBindGroups() {
    this.castShadowCompositeBindGroup = this.device.createBindGroup({
      layout: this.castShadowCompositePipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.castShadowTexture.createView() },
        { binding: 1, resource: { buffer: this.cameraBuffer } },
      ],
    });
    this.cinematicBindGroup = this.device.createBindGroup({
      layout: this.cinematicPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.sceneTexture.createView() },
        { binding: 1, resource: { buffer: this.cameraBuffer } },
        { binding: 2, resource: this.focusDepthTexture.createView() },
      ],
    });
    this.scenePresentBindGroup = this.device.createBindGroup({
      layout: this.presentLayout, entries: [{ binding: 0, resource: this.gradedTexture.createView() }],
    });
    this.screenEffectBindGroup = this.device.createBindGroup({
      layout: this.screenEffectPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.gradedTexture.createView() },
        { binding: 1, resource: this.screenEffectTexture.createView() },
        { binding: 2, resource: this.screenEffectSourceTexture.createView() },
      ],
    });
  }

  get kind() { return 'webgpu-3d'; }

  resize(scale) {
    if (this.disposed) return;
    this.scale = scale;
    const width = this.width * scale;
    const height = this.height * scale;
    this.canvas.width = width;
    this.canvas.height = height;
    if (this.sceneWidth !== width || this.sceneHeight !== height) {
      this.sceneTexture.destroy();
      this.castShadowTexture.destroy();
      this.gradedTexture.destroy();
      this.depthTexture.destroy();
      this.focusDepthTexture.destroy();
      this.sceneWidth = width;
      this.sceneHeight = height;
      this.sceneTexture = this.createTexture('high-resolution 3D scene', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, width, height);
      this.castShadowTexture = this.createTexture('unified projected shadow mask', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, width, height);
      this.gradedTexture = this.createTexture('cinematic graded scene', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, width, height);
      this.depthTexture = this.createTexture('high-resolution 3D depth', 'depth24plus', GPUTextureUsage.RENDER_ATTACHMENT, width, height);
      this.focusDepthTexture = this.createTexture('physical camera focus depth', 'r32float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, width, height);
      this.rebuildSceneBindGroups();
    }
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  }

  writeTexture(texture, pixels, width = this.width, height = this.height, bytesPerPixel = 4) {
    this.device.queue.writeTexture({ texture }, pixels, { bytesPerRow: width * bytesPerPixel, rowsPerImage: height }, { width, height });
  }

  writeObjectSources(pixels, count) {
    if (!count) return;
    const bytes = count * 64 * 64 * 4;
    this.device.queue.writeTexture(
      { texture: this.objectTexture }, pixels.subarray(0, bytes),
      { bytesPerRow: 64 * 4, rowsPerImage: 64 },
      { width: 64, height: 64, depthOrArrayLayers: count },
    );
  }

  writeRemoteAvatars(pixels, layers, revision) {
    if (!pixels || !layers) return;
    if (this.remoteAvatarPixels === pixels
        && this.remoteAvatarLayers === layers
        && this.remoteAvatarRevision === revision) return;
    const count = Math.min(layers, REMOTE_AVATAR_LAYERS);
    const bytes = count * 64 * 64 * 4;
    this.device.queue.writeTexture(
      { texture: this.remoteAvatarTexture }, pixels.subarray(0, bytes),
      { bytesPerRow: 64 * 4, rowsPerImage: 64 },
      { width: 64, height: 64, depthOrArrayLayers: count },
    );
    this.remoteAvatarPixels = pixels;
    this.remoteAvatarLayers = count;
    this.remoteAvatarRevision = revision;
  }

  present({ finalPixels, worldPixels, worldStructuralAlphaPixels, worldHeightPixels, worldGroundHeightPixels, worldGeometryPixels, worldReceiverPixels, worldFacadePixels, worldGridOffsetX, worldGridOffsetY, worldPixelOriginX, worldPixelOriginY, layerPixels, objectIds, bgPriorities, objectSourcePixels, objectDescriptors, objectEventSpriteFlags, objectSourceCount, objectPixels, objectPriorities, screenEffectPixels, screenEffectSources, enhanced, screenEffects, shading, perspective, zoom, optics, remoteActors = [], remoteAvatarPixels = null, remoteAvatarLayers = 0, remoteAvatarRevision = 0 }) {
    const encoder = this.device.createCommandEncoder({ label: 'pokeemerald frame encoder' });
    let presentPipeline = this.presentPipeline;
    let presentBindGroup = this.finalBindGroup;
    // Projected peer anchors are recomputed every enhanced frame; a classic
    // frame below must not leave stale positions behind.
    this.lastRemoteActors = [];
    this.lastRemoteBadges = [];
    if (enhanced) {
      this.writeTexture(this.worldTexture, worldPixels, this.worldWidth, this.worldHeight);
      this.writeTexture(this.structuralAlphaTexture, worldStructuralAlphaPixels, this.worldWidth, this.worldHeight, 1);
      this.writeRemoteAvatars(remoteAvatarPixels, remoteAvatarLayers, remoteAvatarRevision);
      const vertexCount = this.buildTerrain(
        worldHeightPixels, worldGroundHeightPixels, worldGeometryPixels, worldReceiverPixels, worldFacadePixels, worldPixels,
        worldStructuralAlphaPixels,
        worldGridOffsetX, worldGridOffsetY,
      );
      const billboardVertexCounts = this.buildFrameLayers(
        finalPixels, layerPixels, objectIds, objectPixels, objectPriorities,
        objectDescriptors, objectEventSpriteFlags, objectSourceCount, perspective, zoom, screenEffects,
        remoteActors,
      );
      this.lastRemoteActorCount = billboardVertexCounts.remoteVertexCount / 6;
      this.lastRemoteVertexCount = billboardVertexCounts.remoteVertexCount;
      const objectFootRows = this.measureObjectFootRows(objectDescriptors, objectSourceCount, objectEventSpriteFlags, objectSourcePixels);
      const castShadowVertexCount = this.buildProjectedShadows(objectDescriptors, objectSourceCount, objectEventSpriteFlags, objectFootRows);
      this.writeObjectSources(objectSourcePixels, objectSourceCount);
      this.writeTexture(this.bgPriorityTexture, bgPriorities, this.worldWidth, this.worldHeight, 1);
      this.writeTexture(this.uiTexture, this.uiPixels);
      const lightTransform = this.createLightTransform(worldPixelOriginX, worldPixelOriginY);
      const cameraValues = this.cameraValuesScratch;
      cameraValues[0] = perspective;
      cameraValues[1] = zoom;
      cameraValues[2] = shading;
      cameraValues[3] = CAMERA_HEIGHT;
      cameraValues[4] = this.width;
      cameraValues[5] = this.height;
      cameraValues[6] = CAMERA_NEAR;
      cameraValues[7] = CAMERA_FAR;
      cameraValues[8] = worldPixelOriginX;
      cameraValues[9] = worldPixelOriginY;
      cameraValues[10] = optics;
      cameraValues[11] = 0;
      cameraValues.set(lightTransform, 12);
      this.device.queue.writeBuffer(this.cameraBuffer, 0, cameraValues);

      let lightTransformUnchanged = this.structuralShadowLightTransformValid;
      if (lightTransformUnchanged) {
        for (let i = 0; i < 16; i++) {
          if (lightTransform[i] !== this.structuralShadowLightTransform[i]) {
            lightTransformUnchanged = false;
            break;
          }
        }
      }
      if (this.structuralShadowTerrainRevision !== this.terrainRevision || !lightTransformUnchanged) {
        const structuralShadowPass = encoder.beginRenderPass({
          label: 'world-anchored structural shadow map pass',
          colorAttachments: [],
          depthStencilAttachment: {
            view: this.structuralShadowTexture.createView(),
            depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
          },
        });
        structuralShadowPass.setPipeline(this.structuralShadowPipeline);
        structuralShadowPass.setBindGroup(0, this.structuralShadowBindGroup);
        structuralShadowPass.setVertexBuffer(0, this.vertexBuffer);
        structuralShadowPass.draw(vertexCount);
        structuralShadowPass.end();
        this.structuralShadowTerrainRevision = this.terrainRevision;
        this.structuralShadowLightTransform.set(lightTransform);
        this.structuralShadowLightTransformValid = true;
      }

      const terrainPass = encoder.beginRenderPass({
        label: 'depth-tested projected terrain pass',
        colorAttachments: [
          { view: this.sceneTexture.createView(), clearValue: { r: 0.08, g: 0.15, b: 0.18, a: 1 }, loadOp: 'clear', storeOp: 'store' },
          { view: this.focusDepthTexture.createView(), clearValue: { r: CAMERA_FAR, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        ],
        depthStencilAttachment: { view: this.depthTexture.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      terrainPass.setPipeline(this.terrainPipeline); terrainPass.setBindGroup(0, this.terrainBindGroup); terrainPass.setVertexBuffer(0, this.vertexBuffer); terrainPass.draw(vertexCount); terrainPass.end();

      const castShadowPass = encoder.beginRenderPass({
        label: 'unified projected shadow mask pass',
        colorAttachments: [{ view: this.castShadowTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: this.depthTexture.createView(), depthReadOnly: true },
      });
      castShadowPass.setPipeline(this.castShadowPipeline); castShadowPass.setBindGroup(0, this.castShadowBindGroup); castShadowPass.setVertexBuffer(0, this.castShadowVertexBuffer); castShadowPass.draw(castShadowVertexCount); castShadowPass.end();

      const castShadowCompositePass = encoder.beginRenderPass({
        label: 'unified projected shadow composite pass',
        colorAttachments: [{ view: this.sceneTexture.createView(), loadOp: 'load', storeOp: 'store' }],
      });
      castShadowCompositePass.setPipeline(this.castShadowCompositePipeline); castShadowCompositePass.setBindGroup(0, this.castShadowCompositeBindGroup); castShadowCompositePass.draw(3); castShadowCompositePass.end();

      const billboardPass = encoder.beginRenderPass({
        label: 'upright billboard pass',
        colorAttachments: [
          { view: this.sceneTexture.createView(), loadOp: 'load', storeOp: 'store' },
          { view: this.focusDepthTexture.createView(), loadOp: 'load', storeOp: 'store' },
        ],
        depthStencilAttachment: { view: this.depthTexture.createView(), depthLoadOp: 'load', depthStoreOp: 'store' },
      });
      billboardPass.setPipeline(this.billboardPipeline);
      billboardPass.setBindGroup(0, this.billboardBindGroup);
      billboardPass.setVertexBuffer(0, this.billboardVertexBuffer);
      billboardPass.draw(billboardVertexCounts.normalVertexCount);
      if (billboardVertexCounts.remoteVertexCount > 0) {
        billboardPass.setBindGroup(0, this.remoteBillboardBindGroup);
        billboardPass.draw(
          billboardVertexCounts.remoteVertexCount, 1,
          billboardVertexCounts.normalVertexCount,
        );
      }
      billboardPass.end();

      // Apply shared focus-depth optics to the complete world scene so actors
      // integrate with terrain instead of appearing pasted over the diorama.
      const cinematicPass = encoder.beginRenderPass({
        label: 'cinematic HD-2D scene post-process',
        colorAttachments: [{ view: this.gradedTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      });
      cinematicPass.setPipeline(this.cinematicPipeline); cinematicPass.setBindGroup(0, this.cinematicBindGroup); cinematicPass.draw(3); cinematicPass.end();

      if (screenEffects) {
        this.writeTexture(this.screenEffectTexture, screenEffectPixels);
        this.writeTexture(this.screenEffectSourceTexture, screenEffectSources, this.width, this.height, 8);
        presentPipeline = this.screenEffectPipeline;
        presentBindGroup = this.screenEffectBindGroup;
      } else {
        const uiPass = encoder.beginRenderPass({ label: 'flat interface pass', colorAttachments: [{ view: this.gradedTexture.createView(), loadOp: 'load', storeOp: 'store' }] });
        uiPass.setPipeline(this.uiPipeline); uiPass.setBindGroup(0, this.uiBindGroup); uiPass.draw(3); uiPass.end();
        presentBindGroup = this.scenePresentBindGroup;
      }
    } else {
      this.writeTexture(this.finalTexture, finalPixels);
    }

    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(presentPipeline); pass.setBindGroup(0, presentBindGroup); pass.draw(3); pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  async ready() { await this.device.queue.onSubmittedWorkDone(); }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.device.removeEventListener('uncapturederror', this.uncapturedErrorHandler);
    this.context.unconfigure();
    for (const resource of [this.finalTexture,this.worldTexture,this.structuralAlphaTexture,this.objectTexture,this.remoteAvatarTexture,this.bgPriorityTexture,this.uiTexture,this.screenEffectTexture,this.screenEffectSourceTexture,this.sceneTexture,this.castShadowTexture,this.gradedTexture,this.depthTexture,this.focusDepthTexture,this.structuralShadowTexture,this.vertexBuffer,this.billboardVertexBuffer,this.castShadowVertexBuffer,this.cameraBuffer]) resource.destroy();
    this.device.destroy();
  }

  simulateDeviceLoss() {
    if (this.disposed) throw new Error('cannot lose a disposed WebGPU presenter');
    this.device.destroy();
    return this.device.lost;
  }
}

export async function createPresenter({ canvas, width, height, worldWidth, worldHeight, scale, onFailure }) {
  return WebGpuPresenter.create(canvas, width, height, worldWidth, worldHeight, scale, onFailure);
}


for (const Mixin of [terrainBuilderMethods, billboardBuilderMethods]) {
  for (const key of Object.getOwnPropertyNames(Mixin.prototype)) {
    if (key !== 'constructor') WebGpuPresenter.prototype[key] = Mixin.prototype[key];
  }
}
export { WebGpuPresenter };
