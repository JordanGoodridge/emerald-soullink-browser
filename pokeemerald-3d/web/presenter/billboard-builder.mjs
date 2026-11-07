// Billboard projection, foot-row measurement, and cast-shadow builder for WebGpuPresenter.
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
} from './constants-and-shaders.mjs';

export class billboardBuilderMethods {
  terrainHeightAt(x, z) {
    const atlasX = x + this.worldWidth / 2;
    const atlasZ = z + this.worldHeight / 2;
    const tileX = Math.floor((atlasX - this.terrainOriginX) / TILE_SIZE);
    const tileZ = Math.floor((atlasZ - this.terrainOriginY) / TILE_SIZE);
    if (tileX < 0 || tileZ < 0 || tileX >= this.terrainCols || tileZ >= this.terrainRows) return 0;
    return this.tileHeights[tileZ * this.terrainCols + tileX];
  }

  terrainGroundHeightAt(x, z) {
    const atlasX = x + this.worldWidth / 2;
    const atlasZ = z + this.worldHeight / 2;
    const tileX = Math.floor((atlasX - this.terrainOriginX) / TILE_SIZE);
    const tileZ = Math.floor((atlasZ - this.terrainOriginY) / TILE_SIZE);
    if (tileX < 0 || tileZ < 0 || tileX >= this.terrainCols || tileZ >= this.terrainRows) return 0;
    return this.tileGroundHeights[tileZ * this.terrainCols + tileX];
  }

  // Camera depth that keeps a billboard in front of raised ground behind its
  // footpoint. Only walkable heights count: a terrace or cliff cap is solid
  // from the ground up, while a gate or roof span over an actor's path is not.
  terrainClearanceDepth(left, right, groundZ, groundHeight, topY, sine, cosine, focal) {
    const footTileZ = Math.floor((groundZ + this.worldHeight / 2 - this.terrainOriginY) / TILE_SIZE);
    const tileX0 = Math.max(0, Math.floor((left + this.worldWidth / 2 - this.terrainOriginX) / TILE_SIZE));
    const tileX1 = Math.min(this.terrainCols - 1,
      Math.floor((right - 1 + this.worldWidth / 2 - this.terrainOriginX) / TILE_SIZE));
    const rise = (this.height / 2 - topY) / focal;
    let clearance = Infinity;
    for (let tileZ = Math.min(footTileZ, this.terrainRows) - 1;
         tileZ >= Math.max(0, footTileZ - BILLBOARD_CLEARANCE_TILES); tileZ--) {
      const z = this.terrainOriginY + (tileZ + 1) * TILE_SIZE - this.worldHeight / 2;
      // The highest point of this tile's south edge still behind the
      // billboard's top row; anything higher is drawn above the actor.
      const covered = (rise * (CAMERA_HEIGHT - z * sine) + z * cosine) / (sine + rise * cosine);
      if (covered <= groundHeight) continue;
      for (let tileX = tileX0; tileX <= tileX1; tileX++) {
        const height = Math.min(covered, this.tileGroundHeights[tileZ * this.terrainCols + tileX]);
        if (height > groundHeight)
          clearance = Math.min(clearance, CAMERA_HEIGHT - height * cosine - z * sine);
      }
    }
    return clearance;
  }

  cameraProjection(x, y, z, tilt, zoom) {
    const angle = CAMERA_TILT_DEGREES * tilt * Math.PI / 180;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const zoomOut = 0.30 * zoom + 0.76923077 * zoom * zoom * (zoom - 0.35);
    const focal = CAMERA_HEIGHT / (1 + zoomOut);
    const viewY = y * sine - z * cosine;
    const depth = CAMERA_HEIGHT - y * cosine - z * sine;
    return {
      x: this.width / 2 + x * focal / depth,
      y: this.height / 2 - viewY * focal / depth,
      scale: focal / depth,
      depth: (depth - CAMERA_NEAR) / (CAMERA_FAR - CAMERA_NEAR),
      cameraDepth: depth,
    };
  }

  measureObjectFootRows(objectDescriptors, objectSourceCount, objectEventSpriteFlags,
                        objectSourcePixels) {
    if (!this.objectFootRows || this.objectFootRows.length !== objectEventSpriteFlags.length) {
      this.objectFootRows = new Float32Array(objectEventSpriteFlags.length);
    }
    const footRows = this.objectFootRows;
    footRows.fill(-32768);
    for (let layer = 0; layer < objectSourceCount; layer++) {
      const o = layer * 16;
      const spriteId = objectDescriptors[o + 10];
      if (spriteId < 0 || spriteId >= footRows.length || !objectEventSpriteFlags[spriteId]) continue;
      const screenY = objectDescriptors[o + 2];
      const sourceW = objectDescriptors[o + 5], sourceH = objectDescriptors[o + 6];
      const drawW = objectDescriptors[o + 7], drawH = objectDescriptors[o + 8];
      const affine = objectDescriptors[o + 11];
      const pa = objectDescriptors[o + 12], pb = objectDescriptors[o + 13];
      const pc = objectDescriptors[o + 14], pd = objectDescriptors[o + 15];
      for (let destY = drawH - 1; destY >= 0; destY--) {
        let rowVisible = false;
        for (let destX = 0; destX < drawW; destX++) {
          let sourceX = destX, sourceY = destY;
          if (affine) {
            const deltaX = destX - Math.floor(drawW / 2);
            const deltaY = destY - Math.floor(drawH / 2);
            sourceX = ((pa * deltaX + pb * deltaY) >> 8) + Math.floor(sourceW / 2);
            sourceY = ((pc * deltaX + pd * deltaY) >> 8) + Math.floor(sourceH / 2);
          }
          if (sourceX < 0 || sourceY < 0 || sourceX >= sourceW || sourceY >= sourceH) continue;
          const alpha = objectSourcePixels[((layer * 64 * 64 + sourceY * 64 + sourceX) * 4) + 3];
          if (alpha) { rowVisible = true; break; }
        }
        if (rowVisible) {
          footRows[spriteId] = Math.max(footRows[spriteId], screenY + destY + 1);
          break;
        }
      }
    }
    return footRows;
  }

  buildProjectedShadows(objectDescriptors, objectSourceCount, objectEventSpriteFlags,
                        objectFootRows) {
    const groups = new Map();
    for (let layer = 0; layer < objectSourceCount; layer++) {
      const o = layer * 16;
      const spriteId = objectDescriptors[o + 10];
      if (spriteId < 0 || spriteId >= objectEventSpriteFlags.length || !objectEventSpriteFlags[spriteId]) continue;
      const footY = objectFootRows[spriteId];
      if (footY <= -32768) continue;
      const descriptorAnchorY = objectDescriptors[o + 4];
      let group = groups.get(spriteId);
      if (!group) {
        group = { anchorX: objectDescriptors[o + 3], anchorY: footY, descriptorAnchorY,
          priority: objectDescriptors[o + 9] };
        groups.set(spriteId, group);
      } else {
        if (descriptorAnchorY > group.descriptorAnchorY) {
          group.anchorX = objectDescriptors[o + 3];
          group.descriptorAnchorY = descriptorAnchorY;
        }
        group.priority = Math.min(group.priority, objectDescriptors[o + 9]);
      }
    }

    const vertices = [];
    const vertex = (ground, u, v, layer, sourceW, sourceH, drawW, drawH, affine, pa, pb, pc, pd, priority) =>
      vertices.push(ground.x, ground.y, ground.z, u, v, layer, sourceW, sourceH, drawW, drawH,
                    affine, pa, pb, pc, pd, priority);
    for (let layer = 0; layer < objectSourceCount; layer++) {
      const o = layer * 16;
      const spriteId = objectDescriptors[o + 10];
      const group = groups.get(spriteId);
      if (!group) continue;
      const screenX = objectDescriptors[o + 1], screenY = objectDescriptors[o + 2];
      const sourceW = objectDescriptors[o + 5], sourceH = objectDescriptors[o + 6];
      const drawW = objectDescriptors[o + 7], drawH = objectDescriptors[o + 8];
      const affine = objectDescriptors[o + 11];
      const pa = objectDescriptors[o + 12], pb = objectDescriptors[o + 13];
      const pc = objectDescriptors[o + 14], pd = objectDescriptors[o + 15];
      const project = (u, v) => {
        // Sink the lowest opaque sprite row into the receiver plane so the
        // silhouette begins under the entity instead of after a raster gap.
        const height = Math.max(0, group.anchorY - (screenY + v) - 1);
        // Match the structural northwest key: elevated sprite pixels project
        // along the same southeast light ray as roofs and cliffs.
        const x = group.anchorX - this.width / 2 + (screenX - group.anchorX + u) + height * 0.584;
        const z = group.anchorY - this.height / 2 + height * 0.584;
        return { x, y: this.terrainGroundHeightAt(x, z), z };
      };
      // Leave a three-source-pixel apron around every projected component so
      // the wide alpha penumbra can cross tile and subsprite boundaries instead
      // of being clipped to each OAM rectangle.
      const u0 = -3, v0 = -3, u1 = drawW + 3;
      // Stop the component that owns the feet exactly at the shared foot row.
      // Extending its padded quad past that row would make interpolation lift
      // the last opaque sprite pixels away from the cast-shadow base.
      const footV = Math.max(0, group.anchorY - screenY);
      const v1 = Math.min(drawH + 3, footV);
      if (v1 <= v0) continue;
      const p00 = project(u0, v0), p10 = project(u1, v0);
      const p11 = project(u1, v1), p01 = project(u0, v1);
      for (const point of [
        [p00,u0,v0], [p10,u1,v0], [p11,u1,v1],
        [p00,u0,v0], [p11,u1,v1], [p01,u0,v1],
      ]) vertex(point[0], point[1], point[2], layer, sourceW, sourceH, drawW, drawH, affine, pa, pb, pc, pd, group.priority);
    }

    const data = new Float32Array(vertices);
    if (data.byteLength > this.castShadowVertexCapacity) {
      this.castShadowVertexBuffer.destroy();
      this.castShadowVertexCapacity = 2 ** Math.ceil(Math.log2(data.byteLength));
      this.castShadowVertexBuffer = this.device.createBuffer({ label: 'projected sprite shadow geometry', size: this.castShadowVertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (data.byteLength) this.device.queue.writeBuffer(this.castShadowVertexBuffer, 0, data);
    return data.length / CAST_SHADOW_VERTEX_FLOATS;
  }

  buildFrameLayers(finalPixels, layerPixels, objectIds, objectPixels, objectPriorities,
                   objectDescriptors, objectEventSpriteFlags, objectSourceCount, tilt, zoom, screenEffects,
                   remoteActors = []) {
    this.uiPixels.fill(0);
    const head = this.objectPixelHead ?? (this.objectPixelHead = new Int32Array(128));
    const next = this.objectPixelNext ?? (this.objectPixelNext = new Int32Array(layerPixels.length));
    head.fill(-1);
    let hasUiPlane = false;
    for (let index = 0; index < layerPixels.length; index++) {
      if (!screenEffects && (layerPixels[index] & 0x01) !== 0) {
        hasUiPlane = true;
        const o = index * 4;
        this.uiPixels[o] = finalPixels[o];
        this.uiPixels[o + 1] = finalPixels[o + 1];
        this.uiPixels[o + 2] = finalPixels[o + 2];
        this.uiPixels[o + 3] = 255;
      }
      const id = objectIds[index];
      if (id < 128) {
        next[index] = head[id];
        head[id] = index;
      }
    }

    const objectTouchesUi = (x, y, width, height) => {
      const x0 = Math.max(0, x), y0 = Math.max(0, y);
      const x1 = Math.min(this.width, x + width), y1 = Math.min(this.height, y + height);
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++)
        if (layerPixels[py * this.width + px] & 0x01) return true;
      return false;
    };
    if (hasUiPlane) {
      for (let id = 0; id < 128; id++) {
        if (objectPriorities[id] !== 0) continue;
        for (let source = head[id]; source !== -1; source = next[source]) {
          const src = source * 4;
          this.uiPixels[src] = objectPixels[src];
          this.uiPixels[src + 1] = objectPixels[src + 1];
          this.uiPixels[src + 2] = objectPixels[src + 2];
          this.uiPixels[src + 3] = objectPixels[src + 3];
        }
      }
    }

    // The engine exports the owning Sprite slot for each OAM entry. All
    // subsprites from one engine sprite share a foot-row projection without
    // accidentally joining touching actors or weather tiles.
    if (!this.groupAnchorY || this.groupAnchorY.length !== objectEventSpriteFlags.length) {
      this.groupAnchorY = new Int32Array(objectEventSpriteFlags.length);
    }
    const groupAnchorY = this.groupAnchorY;
    groupAnchorY.fill(-32768);
    for (let index = 0; index < objectSourceCount; index++) {
      const o = index * 16;
      const spriteId = objectDescriptors[o + 10];
      if (spriteId < 0 || spriteId >= groupAnchorY.length) continue;
      groupAnchorY[spriteId] = Math.max(groupAnchorY[spriteId], objectDescriptors[o + 4]);
    }

    const order = Array.from({ length: objectSourceCount }, (_, index) => index);
    order.sort((a, b) => {
      const ao = a * 16, bo = b * 16;
      return objectDescriptors[bo + 9] - objectDescriptors[ao + 9]
        || objectDescriptors[bo] - objectDescriptors[ao];
    });
    const normalVertices = [];
    const vertex = (vertices, x, y, u, v, depth, layer, sourceW, sourceH, drawW, drawH,
                    affine, pa, pb, pc, pd, atlasX, atlasY, oamId, priority, cameraDepth,
                    screenX, screenY) =>
      vertices.push(x, y, u, v, depth, layer, sourceW, sourceH, drawW, drawH,
                    affine, pa, pb, pc, pd, atlasX, atlasY, oamId, priority, cameraDepth,
                    screenX, screenY);
    const angle = CAMERA_TILT_DEGREES * tilt * Math.PI / 180;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const zoomOut = 0.30 * zoom + 0.76923077 * zoom * zoom * (zoom - 0.35);
    const focal = CAMERA_HEIGHT / (1 + zoomOut);
    for (const layer of order) {
      const o = layer * 16;
      const oamId = objectDescriptors[o];
      const screenX = objectDescriptors[o + 1];
      const screenY = objectDescriptors[o + 2];
      const anchorX = objectDescriptors[o + 3];
      const spriteId = objectDescriptors[o + 10];
      const anchorY = spriteId < groupAnchorY.length ? groupAnchorY[spriteId] : objectDescriptors[o + 4];
      const sourceW = objectDescriptors[o + 5];
      const sourceH = objectDescriptors[o + 6];
      const drawW = objectDescriptors[o + 7];
      const drawH = objectDescriptors[o + 8];
      const priority = objectDescriptors[o + 9];
      const affine = objectDescriptors[o + 11];
      const pa = objectDescriptors[o + 12], pb = objectDescriptors[o + 13];
      const pc = objectDescriptors[o + 14], pd = objectDescriptors[o + 15];
      if (hasUiPlane && priority === 0 && objectTouchesUi(screenX, screenY, drawW, drawH)) continue;

      const groundX = anchorX - this.width / 2;
      const groundZ = anchorY - this.height / 2;
      const groundHeight = this.terrainGroundHeightAt(groundX, groundZ);
      const projected = this.cameraProjection(groundX, groundHeight, groundZ, tilt, zoom);
      const x0 = projected.x + (screenX - anchorX) * projected.scale;
      const x1 = x0 + drawW * projected.scale;
      const y0 = projected.y + (screenY - anchorY) * projected.scale;
      const y1 = y0 + drawH * projected.scale;
      // Invert the ground-plane projection at each corner: the BG priority
      // mask must test the receiver pixel rendered at the corner's screen
      // position, not the flat GBA overlap, or foreground details such as
      // flags occlude actors above their foreshortened art.
      const maskPoint = (px, py) => {
        const vy = this.height / 2 - py;
        const denominator = vy * sine - cosine * focal;
        if (Math.abs(denominator) < 1e-6)
          return [px - this.width / 2 + this.worldWidth / 2, py - this.height / 2 + this.worldHeight / 2];
        const z = (vy * (CAMERA_HEIGHT - groundHeight * cosine) - groundHeight * sine * focal) / denominator;
        const depth = CAMERA_HEIGHT - groundHeight * cosine - z * sine;
        return [(px - this.width / 2) * depth / focal + this.worldWidth / 2, z + this.worldHeight / 2];
      };
      const extra = [layer, sourceW, sourceH, drawW, drawH, affine, pa, pb, pc, pd];
      const tail = [oamId, priority, projected.cameraDepth, screenX, screenY];
      // Sprite source height is screen-space art, not literal world height.
      // Keep the whole camera-facing billboard at its gameplay footpoint
      // depth so a projected roof occludes the actor after they pass behind
      // it, rather than letting high source rows pierce through the roof. The
      // small camera-ward bias preserves coplanar facade/deck ties in front.
      // Raised ground behind the footpoint (a terrace face behind an actor
      // at its foot or mid-jump off a ledge) is still pulled in front of.
      const clearance = this.terrainClearanceDepth(
        screenX - this.width / 2, screenX + drawW - this.width / 2,
        groundZ, groundHeight, y0, sine, cosine, focal);
      const spriteDepth = Math.min(0.9999, Math.max(0.0002,
        (Math.min(projected.cameraDepth, clearance) - BILLBOARD_DEPTH_BIAS - CAMERA_NEAR)
        / (CAMERA_FAR - CAMERA_NEAR)));
      for (const point of [
        [x0,y0,0,0], [x1,y0,drawW,0], [x1,y1,drawW,drawH],
        [x0,y0,0,0], [x1,y1,drawW,drawH], [x0,y1,0,drawH],
      ]) vertex(normalVertices, point[0], point[1], point[2], point[3],
                spriteDepth, ...extra,
                ...maskPoint(point[0], point[1]), ...tail);
    }

    const normalVertexCount = normalVertices.length / BILLBOARD_VERTEX_FLOATS;
    const remoteStart = normalVertices.length;
    const projectedActors = [];
    for (let index = 0; index < remoteActors.length; index++) {
      const actor = remoteActors[index];
      if (!actor || !Number.isFinite(actor.screenX) || !Number.isFinite(actor.screenY)) continue;
      if (!Number.isInteger(actor.layer) || actor.layer < 0) continue;

      const drawW = 16;
      const drawH = 32;
      const anchorX = actor.screenX;
      const anchorY = actor.screenY;
      const groundX = anchorX - this.width / 2;
      const groundZ = anchorY - this.height / 2;
      const groundHeight = this.terrainGroundHeightAt(groundX, groundZ);
      const projected = this.cameraProjection(groundX, groundHeight, groundZ, tilt, zoom);
      const x0 = projected.x - (drawW / 2) * projected.scale;
      const x1 = x0 + drawW * projected.scale;
      const y0 = projected.y - drawH * projected.scale;
      const y1 = projected.y;
      if (x1 < -32 || x0 > this.width + 32 || y1 < -64 || y0 > this.height + 64) continue;

      const maskPoint = (px, py) => {
        const vy = this.height / 2 - py;
        const denominator = vy * sine - cosine * focal;
        if (Math.abs(denominator) < 1e-6)
          return [px - this.width / 2 + this.worldWidth / 2, py - this.height / 2 + this.worldHeight / 2];
        const z = (vy * (CAMERA_HEIGHT - groundHeight * cosine) - groundHeight * sine * focal) / denominator;
        const depth = CAMERA_HEIGHT - groundHeight * cosine - z * sine;
        return [(px - this.width / 2) * depth / focal + this.worldWidth / 2, z + this.worldHeight / 2];
      };
      const clearance = this.terrainClearanceDepth(
        x0 - this.width / 2, x1 - this.width / 2,
        groundZ, groundHeight, y0, sine, cosine, focal);
      const spriteDepth = Math.min(0.9999, Math.max(0.0002,
        (Math.min(projected.cameraDepth, clearance) - BILLBOARD_DEPTH_BIAS - CAMERA_NEAR)
        / (CAMERA_FAR - CAMERA_NEAR)));
      const u0 = actor.hFlip ? drawW : 0;
      const u1 = actor.hFlip ? 0 : drawW;
      // Expose the projected head/foot geometry for every visible peer so the
      // shell can anchor name tags and battle badges in the same screen space
      // the billboard is drawn in, rather than the flat field-pixel offset.
      projectedActors.push({
        playerId: actor.playerId,
        x: (x0 + x1) / 2,
        y: y0,
        footY: projected.y,
        marker: actor.marker ?? null,
      });
      const extra = [actor.layer, drawW, drawH, drawW, drawH, 0, 0, 0, 0, 0];
      const tail = [0, 2, projected.cameraDepth, x0, y0];
      for (const point of [
        [x0, y0, u0, 0], [x1, y0, u1, 0], [x1, y1, u1, drawH],
        [x0, y0, u0, 0], [x1, y1, u1, drawH], [x0, y1, u0, drawH],
      ]) vertex(normalVertices, point[0], point[1], point[2], point[3],
                spriteDepth, ...extra,
                ...maskPoint(point[0], point[1]), ...tail);
    }

    const data = new Float32Array(normalVertices);
    if (data.byteLength > this.billboardVertexCapacity) {
      this.billboardVertexBuffer.destroy();
      this.billboardVertexCapacity = 2 ** Math.ceil(Math.log2(data.byteLength));
      this.billboardVertexBuffer = this.device.createBuffer({ label: 'high-resolution billboard quads', size: this.billboardVertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (data.byteLength) this.device.queue.writeBuffer(this.billboardVertexBuffer, 0, data);
    const remoteVertexCount = (normalVertices.length - remoteStart) / BILLBOARD_VERTEX_FLOATS;
    this.lastRemoteActors = projectedActors;
    this.lastRemoteBadges = projectedActors
      .filter((entry) => entry.marker)
      .map(({ playerId, x, y, marker }) => ({ playerId, x, y, marker }));
    return { normalVertexCount, remoteVertexCount };
  }
}
