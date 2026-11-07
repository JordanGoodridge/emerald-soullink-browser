// 3D terrain & building facade mesh builder for WebGpuPresenter.
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

export class terrainBuilderMethods {
  buildTerrain(worldHeights, worldGroundHeights, worldGeometry, worldReceivers, worldFacades, worldPixels,
               worldStructuralAlphaPixels,
               gridOffsetX, gridOffsetY) {
    const originX = gridOffsetX - TILE_SIZE;
    const originY = gridOffsetY - TILE_SIZE;
    const cols = Math.ceil((this.worldWidth - originX) / TILE_SIZE);
    const rows = Math.ceil((this.worldHeight - originY) / TILE_SIZE);
    let unchanged = this.terrainSignature !== null
      && this.terrainCols === cols && this.terrainRows === rows
      && this.terrainOriginX === originX && this.terrainOriginY === originY;
    this.terrainCols = cols;
    this.terrainRows = rows;
    this.terrainOriginX = originX;
    this.terrainOriginY = originY;
    const heights = this.tileHeights;
    const groundHeights = this.tileGroundHeights;
    const geometry = this.tileGeometry;
    const receivers = this.tileReceivers;
    const facades = this.tileFacades;
    let signature = 2166136261;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const pixelX = Math.max(0, Math.min(this.worldWidth - 1, originX + tx * TILE_SIZE + TILE_SIZE / 2));
        const pixelY = Math.max(0, Math.min(this.worldHeight - 1, originY + ty * TILE_SIZE + TILE_SIZE / 2));
        const source = Math.floor(pixelY) * this.worldWidth + Math.floor(pixelX);
        const tile = ty * cols + tx;
        const height = worldHeights[source];
        const groundHeight = worldGroundHeights[source];
        const geometryWord = worldGeometry[source];
        const receiverWord = worldReceivers[source];
        const facadeWord = worldFacades[source];
        if (unchanged && (heights[tile] !== height
            || groundHeights[tile] !== groundHeight || geometry[tile] !== geometryWord
            || receivers[tile] !== receiverWord || facades[tile] !== facadeWord))
          unchanged = false;
        heights[tile] = height;
        groundHeights[tile] = groundHeight;
        geometry[tile] = geometryWord;
        receivers[tile] = receiverWord;
        facades[tile] = facadeWord;
        signature = Math.imul(signature ^ (height & 0xffff), 16777619);
        signature = Math.imul(signature ^ (groundHeight & 0xffff), 16777619);
        signature = Math.imul(signature ^ geometryWord, 16777619);
        signature = Math.imul(signature ^ receiverWord, 16777619);
        signature = Math.imul(signature ^ facadeWord, 16777619);
      }
    }
    signature >>>= 0;
    const syncBuildingMaterialSnapshot = (compareOnly) => {
      const snapshot = this.tileBuildingMaterialPixels;
      let matches = this.terrainMaterialSnapshotValid;
      for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
          const tile = ty * cols + tx;
          const surface = geometry[tile] & HD2D_SURFACE_MASK;
          if (surface !== HD2D_SURFACE_WALL && surface !== HD2D_SURFACE_ROOF) continue;
          const x0 = Math.max(0, Math.min(this.worldWidth - 1, originX + tx * TILE_SIZE));
          const y0 = Math.max(0, Math.min(this.worldHeight - 1, originY + ty * TILE_SIZE));
          const x1 = Math.min(this.worldWidth, x0 + TILE_SIZE);
          const y1 = Math.min(this.worldHeight, y0 + TILE_SIZE);
          const tileSnapshot = tile * BUILDING_MATERIAL_BYTES_PER_TILE;
          for (let localY = 0; localY < TILE_SIZE; localY++) {
            for (let localX = 0; localX < TILE_SIZE; localX++) {
              const px = x0 + localX;
              const py = y0 + localY;
              const sourcePixel = py < y1 && px < x1 ? py * this.worldWidth + px : -1;
              const sourceRgba = sourcePixel * 4;
              const target = tileSnapshot + (localY * TILE_SIZE + localX) * 5;
              const red = sourcePixel >= 0 ? worldPixels[sourceRgba] : 0;
              const green = sourcePixel >= 0 ? worldPixels[sourceRgba + 1] : 0;
              const blue = sourcePixel >= 0 ? worldPixels[sourceRgba + 2] : 0;
              const alpha = sourcePixel >= 0 ? worldPixels[sourceRgba + 3] : 0;
              const structuralAlpha = sourcePixel >= 0
                ? worldStructuralAlphaPixels[sourcePixel] : 0;
              if (compareOnly) {
                if (snapshot[target] !== red || snapshot[target + 1] !== green
                    || snapshot[target + 2] !== blue || snapshot[target + 3] !== alpha
                    || snapshot[target + 4] !== structuralAlpha)
                  matches = false;
              } else {
                snapshot[target] = red;
                snapshot[target + 1] = green;
                snapshot[target + 2] = blue;
                snapshot[target + 3] = alpha;
                snapshot[target + 4] = structuralAlpha;
              }
            }
          }
        }
      }
      if (!compareOnly) this.terrainMaterialSnapshotValid = true;
      return matches;
    };
    const materialsUnchanged = unchanged && syncBuildingMaterialSnapshot(true);
    // Exact sampled-value comparisons make hash collisions harmless. Building
    // closure colors are also derived from atlas RGBA and structural-alpha
    // pixels, so retain the mesh only when those source pixels still match.
    if (unchanged && materialsUnchanged && signature === this.terrainSignature)
      return this.terrainVertexCount;

    let vertexFloatCount = 0;
    let vertexScratch = this.terrainVertexScratch ?? (this.terrainVertexScratch = new Float32Array(this.vertexCapacity / 4));
    const quad = (a, b, c, d, normal, material, shell = 0, base = 0,
                  neutralColor = [0, 0, 0]) => {
      if (vertexFloatCount + 6 * VERTEX_FLOATS > vertexScratch.length) {
        const grown = new Float32Array(vertexScratch.length * 2);
        grown.set(vertexScratch.subarray(0, vertexFloatCount));
        vertexScratch = this.terrainVertexScratch = grown;
      }
      const n0 = normal[0], n1 = normal[1], n2 = normal[2];
      const c0 = neutralColor[0], c1 = neutralColor[1], c2 = neutralColor[2];
      for (const point of [a, b, c, a, c, d]) {
        vertexScratch[vertexFloatCount] = point[0];
        vertexScratch[vertexFloatCount + 1] = point[1];
        vertexScratch[vertexFloatCount + 2] = point[2];
        vertexScratch[vertexFloatCount + 3] = point[3];
        vertexScratch[vertexFloatCount + 4] = point[4];
        vertexScratch[vertexFloatCount + 5] = n0;
        vertexScratch[vertexFloatCount + 6] = n1;
        vertexScratch[vertexFloatCount + 7] = n2;
        vertexScratch[vertexFloatCount + 8] = material;
        vertexScratch[vertexFloatCount + 9] = shell;
        vertexScratch[vertexFloatCount + 10] = base;
        vertexScratch[vertexFloatCount + 11] = c0;
        vertexScratch[vertexFloatCount + 12] = c1;
        vertexScratch[vertexFloatCount + 13] = c2;
        vertexFloatCount += VERTEX_FLOATS;
      }
    };
    const halfW = this.worldWidth / 2;
    const halfH = this.worldHeight / 2;
    const inGrid = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows;
    const heightAt = (x, y) => inGrid(x, y) ? heights[y * cols + x] : 0;
    const geometryAt = (x, y) => inGrid(x, y) ? geometry[y * cols + x] : 0;
    const receiverAt = (x, y) => inGrid(x, y) ? receivers[y * cols + x] : 0;
    const facadeAt = (x, y) => inGrid(x, y) ? facades[y * cols + x] : 0;
    const roofOverhangAt = (x, y) =>
      (facadeAt(x, y) & HD2D_FACADE_ROOF_OVERHANG) !== 0;
    const surfaceAt = (x, y) => geometryAt(x, y) & HD2D_SURFACE_MASK;
    const componentAt = (x, y) => geometryAt(x, y) >> HD2D_COMPONENT_SHIFT;
    const worldX = (x) => originX + x * TILE_SIZE - halfW;
    const worldZ = (y) => originY + y * TILE_SIZE - halfH;
    // Texture anchors must stay identity with the unclamped worldX/worldZ
    // positions. Clamping here dragged any rect that pokes past the atlas
    // edge (every full-width border strip once originX goes negative) east
    // by 8-gridOffsetX pixels and stretched its art, so border tree rows
    // slid horizontally against in-map rows with the sub-course camera
    // phase. Out-of-range coordinates are clamped by the sampler instead,
    // and only affect the off-screen overscan margin.
    const textureU = (x) => (originX + x * TILE_SIZE) / this.worldWidth;
    const textureV = (y) => (originY + y * TILE_SIZE) / this.worldHeight;
    const pixelU = (pixel) => (Math.max(0, Math.min(this.worldWidth - 1, pixel)) + 0.5) / this.worldWidth;
    const pixelV = (pixel) => (Math.max(0, Math.min(this.worldHeight - 1, pixel)) + 0.5) / this.worldHeight;
    const MATERIAL_NEUTRAL_BUILDING = 8;
    const openDeckReceiver = (tx, ty) => {
      const word = receiverAt(tx, ty);
      if ((word & HD2D_RECEIVER_VALID) === 0) return null;
      const sourceX = tx + (((word >> HD2D_RECEIVER_DX_SHIFT) & HD2D_RECEIVER_OFFSET_MASK) - HD2D_RECEIVER_OFFSET_BIAS);
      const sourceY = ty + (((word >> HD2D_RECEIVER_DY_SHIFT) & HD2D_RECEIVER_OFFSET_MASK) - HD2D_RECEIVER_OFFSET_BIAS);
      if (!inGrid(sourceX, sourceY)) return null;
      return [sourceX, sourceY, heightAt(sourceX, sourceY), word & HD2D_SURFACE_MASK];
    };

    // A vertical face is an extrusion of the authored lower surface beside an
    // edge, not a repetition of the elevated top tile. Each physical course
    // consumes the next map tile in the exposed direction. This keeps a cliff
    // or shell perimeter tied to the same source material that is visible at
    // its foot, while retaining one nearest-sampled source tile per 8-unit
    // course. Ordinary terrain follows that source contract; unauthored
    // building closure instead carries a filtered component color and never
    // samples these atlas coordinates.
    const verticalSide = (tx, ty, bottom, height, sourceX, sourceY, dx, dy,
                          normal, material, shell = 0, base = 0,
                          neutralColor = [0, 0, 0]) => {
      if (bottom >= height) return;
      for (let courseBottom = bottom; courseBottom < height; courseBottom += TILE_SIZE) {
        const courseTop = Math.min(height, courseBottom + TILE_SIZE);
        const course = Math.floor((courseBottom - bottom) / TILE_SIZE);
        let courseSourceX = Math.max(0, Math.min(cols - 1, sourceX + dx * (course + 1)));
        let courseSourceY = Math.max(0, Math.min(rows - 1, sourceY + dy * (course + 1)));
        if (surfaceAt(courseSourceX, courseSourceY) === HD2D_SURFACE_WATER) {
          courseSourceX = sourceX;
          courseSourceY = sourceY;
        }
        const u0 = pixelU(originX + courseSourceX * TILE_SIZE);
        const u1 = pixelU(originX + courseSourceX * TILE_SIZE + TILE_SIZE - 1);
        const v0 = pixelV(originY + courseSourceY * TILE_SIZE);
        const v1 = pixelV(originY + courseSourceY * TILE_SIZE + TILE_SIZE - 1);
        if (dy < 0) {
          const z = worldZ(ty);
          quad([worldX(tx + 1),courseBottom,z,u1,v1],
               [worldX(tx),courseBottom,z,u0,v1],
               [worldX(tx),courseTop,z,u0,v0],
               [worldX(tx + 1),courseTop,z,u1,v0],
               normal, material, shell, base, neutralColor);
        } else if (dy > 0) {
          const z = worldZ(ty + 1);
          quad([worldX(tx),courseBottom,z,u0,v0],
               [worldX(tx + 1),courseBottom,z,u1,v0],
               [worldX(tx + 1),courseTop,z,u1,v1],
               [worldX(tx),courseTop,z,u0,v1],
               normal, material, shell, base, neutralColor);
        } else if (dx < 0) {
          const x = worldX(tx);
          quad([x,courseBottom,worldZ(ty),u1,v0],
               [x,courseBottom,worldZ(ty + 1),u1,v1],
               [x,courseTop,worldZ(ty + 1),u0,v1],
               [x,courseTop,worldZ(ty),u0,v0],
               normal, material, shell, base, neutralColor);
        } else {
          const x = worldX(tx + 1);
          quad([x,courseBottom,worldZ(ty + 1),u0,v1],
               [x,courseBottom,worldZ(ty),u0,v0],
               [x,courseTop,worldZ(ty),u1,v0],
               [x,courseTop,worldZ(ty + 1),u1,v1],
               normal, material, shell, base, neutralColor);
        }
      }
    };

    // Semantic terrain caps own height. Without an unambiguous face contract,
    // exposed edges use a continuous cap-edge skirt; neighboring map courses
    // may be buildings, signs, or decorative ground and must not be sampled.
    const terrainSide = (tx, ty, bottom, height, dx, dy, normal, material) => {
      if (bottom >= height) return;
      let faceSourceY = ty;
      let faceWord = receiverAt(tx, ty);
      if (material === HD2D_SURFACE_TERRAIN && dy > 0
          && !(faceWord & HD2D_RECEIVER_TERRAIN_FACE)) {
        while (faceSourceY > 0 && surfaceAt(tx, faceSourceY - 1) === material
            && heightAt(tx, faceSourceY - 1) === height) {
          faceSourceY--;
          faceWord = receiverAt(tx, faceSourceY);
          if (faceWord & HD2D_RECEIVER_TERRAIN_FACE) break;
        }
      }
      const faceDepth = material === HD2D_SURFACE_TERRAIN && dy > 0
        && (faceWord & HD2D_RECEIVER_TERRAIN_FACE)
          ? faceWord & HD2D_RECEIVER_OFFSET_MASK : 0;
      const physicalCourses = Math.ceil((height - bottom) / TILE_SIZE);
      for (let courseTop = height, course = 0; courseTop > bottom;
           courseTop -= TILE_SIZE, course++) {
        const courseBottom = Math.max(bottom, courseTop - TILE_SIZE);
        let u0, u1, v0, v1;
        if (faceDepth && course < faceDepth) {
          const sourceY = faceWord & HD2D_RECEIVER_TERRAIN_FACE_SELF
            ? faceSourceY - faceDepth + 1 + course
            : faceWord & HD2D_RECEIVER_TERRAIN_FACE_SOUTH
              ? faceSourceY + 1 + course
              : faceSourceY - Math.min(faceDepth, physicalCourses) + course;
          if (sourceY < 0 || sourceY >= rows
              || surfaceAt(tx, sourceY) === HD2D_SURFACE_WATER) {
            u0 = textureU(tx); u1 = textureU(tx + 1);
            v0 = textureV(ty); v1 = textureV(ty + 1);
          } else {
            u0 = textureU(tx); u1 = textureU(tx + 1);
            v0 = textureV(sourceY); v1 = textureV(sourceY + 1);
          }
        } else {
          u0 = textureU(tx); u1 = textureU(tx + 1);
          v0 = textureV(ty); v1 = textureV(ty + 1);
        }
        if (dy < 0) {
          const z = worldZ(ty);
          quad([worldX(tx + 1),courseBottom,z,u1,v1],
               [worldX(tx),courseBottom,z,u0,v1],
               [worldX(tx),courseTop,z,u0,v0],
               [worldX(tx + 1),courseTop,z,u1,v0], normal, material);
        } else if (dy > 0) {
          const z = worldZ(ty + 1);
          quad([worldX(tx),courseBottom,z,u0,v1],
               [worldX(tx + 1),courseBottom,z,u1,v1],
               [worldX(tx + 1),courseTop,z,u1,v0],
               [worldX(tx),courseTop,z,u0,v0], normal, material);
        } else if (dx < 0) {
          const x = worldX(tx);
          quad([x,courseBottom,worldZ(ty),u0,v1],
               [x,courseBottom,worldZ(ty + 1),u1,v1],
               [x,courseTop,worldZ(ty + 1),u1,v0],
               [x,courseTop,worldZ(ty),u0,v0], normal, material);
        } else {
          const x = worldX(tx + 1);
          quad([x,courseBottom,worldZ(ty + 1),u0,v1],
               [x,courseBottom,worldZ(ty),u1,v1],
               [x,courseTop,worldZ(ty),u1,v0],
               [x,courseTop,worldZ(ty + 1),u0,v0], normal, material);
        }
      }
    };

    // Merge source-aligned horizontal courses. Roofs merge only when C says
    // they have the same frame-local owner; facade source is never a floor.
    // Wall source rows are removed from the floor, and roof pixels use an
    // authored alpha mask. Put the real receiver beneath EVERY structural
    // tile — merged roof rectangles must not skip theirs, or discarded
    // facade pixels over the footprint reveal the scene clear color as
    // black speckle instead of the ground below the building.
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        if (surfaceAt(tx, ty) !== HD2D_SURFACE_WALL
            && surfaceAt(tx, ty) !== HD2D_SURFACE_ROOF) continue;
        let sourceY = ty + 1;
        while (sourceY < rows
            && (surfaceAt(tx, sourceY) === HD2D_SURFACE_WALL
             || surfaceAt(tx, sourceY) === HD2D_SURFACE_ROOF)
            && (surfaceAt(tx, sourceY) !== HD2D_SURFACE_WALL
             || componentAt(tx, sourceY) === componentAt(tx, ty))) sourceY++;
        sourceY = Math.min(rows - 1, sourceY);
        const ground = groundHeights[ty * cols + tx];
        quad(
          [worldX(tx),ground,worldZ(ty),textureU(tx),textureV(sourceY)],
          [worldX(tx + 1),ground,worldZ(ty),textureU(tx + 1),textureV(sourceY)],
          [worldX(tx + 1),ground,worldZ(ty + 1),textureU(tx + 1),textureV(sourceY + 1)],
          [worldX(tx),ground,worldZ(ty + 1),textureU(tx),textureV(sourceY + 1)],
          [0, 1, 0], surfaceAt(tx, sourceY),
        );
      }
    }

    // Component membership is decoded, never inferred. Every wall source
    // course maps to one physical course on the component's shared front
    // plane. The source mask may be stepped, but it never creates another
    // physical facade plane.
    const components = new Map();
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const id = componentAt(tx, ty);
        if (!id) continue;
        let component = components.get(id);
        if (!component) {
          component = {
            id,
            base: groundHeights[ty * cols + tx],
            roofHeight: -Infinity,
            roofCells: [],
            wallCells: [],
          };
          components.set(id, component);
        }
        component.base = Math.min(component.base, groundHeights[ty * cols + tx]);
        if (surfaceAt(tx, ty) === HD2D_SURFACE_ROOF) {
          component.roofHeight = Math.max(component.roofHeight, heightAt(tx, ty));
          component.roofCells.push([tx, ty]);
        } else if (surfaceAt(tx, ty) === HD2D_SURFACE_WALL) {
          component.wallCells.push([tx, ty]);
        }
      }
    }

    // C marks adjacent facade bands that were attached as tiers of one
    // authored shell. Their staggered roof rows encode top-down perspective,
    // not independent deep footprints, so slide those slabs rigidly to their
    // facades. Standalone buildings retain the continuous stretched shell.
    const steppedComponents = new Set();
    for (const component of components.values()) {
      if (component.roofCells.some(([tx, ty]) =>
          (facadeAt(tx, ty) & HD2D_FACADE_STEPPED_TIER) !== 0)
          || component.wallCells.some(([tx, ty]) =>
          (facadeAt(tx, ty) & HD2D_FACADE_STEPPED_TIER) !== 0))
        steppedComponents.add(component.id);
    }
    // A disconnected roof-art island with no wall beneath it is decorative
    // map art, not another box belonging to the nearby building. Its masked
    // horizontal pixels may remain, but a generated perimeter would turn an
    // otherwise transparent course into a conspicuous neutral cube.
    const roofCellKey = (tx, ty) => `${tx}:${ty}`;
    for (const component of components.values()) {
      const pending = new Set(component.roofCells.map(([tx, ty]) => roofCellKey(tx, ty)));
      component.roofClosureCells = new Set();
      while (pending.size) {
        const first = pending.values().next().value;
        const queue = [first];
        const island = [];
        let supported = false;
        pending.delete(first);
        while (queue.length) {
          const key = queue.pop();
          const [tx, ty] = key.split(':').map(Number);
          island.push(key);
          if (inGrid(tx, ty + 1) && componentAt(tx, ty + 1) === component.id
              && surfaceAt(tx, ty + 1) === HD2D_SURFACE_WALL)
            supported = true;
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const neighbor = roofCellKey(tx + dx, ty + dy);
            if (!pending.delete(neighbor)) continue;
            queue.push(neighbor);
          }
        }
        if (supported)
          for (const key of island) component.roofClosureCells.add(key);
      }
    }

    for (const component of components.values()) {
      component.frontShift = 0;
      component.roofNorthTy = 0;
      component.roofStretch = 1;
      component.slideRoof = steppedComponents.has(component.id);
      if (!Number.isFinite(component.roofHeight)) continue;
      const groups = new Map();
      for (const [tx, ty] of component.wallCells) {
        const word = facadeAt(tx, ty);
        const id = word & 0xffff;
        if (!id) continue;
        let group = groups.get(id);
        if (!group) {
          group = { maxTy: ty, topByColumn: new Map() };
          groups.set(id, group);
        }
        group.maxTy = Math.max(group.maxTy, ty);
        const topTy = group.topByColumn.get(tx);
        if (topTy === undefined || ty < topTy) group.topByColumn.set(tx, ty);
      }
      // A stepped tier can carry columns of different wall depth (a window
      // band beside a cornice column). Each roof column rides on ITS wall
      // column's top so cornices stay flush with the facade instead of
      // overhanging the plaza by the deepest column's shift.
      component.slideShiftByColumn = new Map();
      for (const group of groups.values()) {
        for (const [tx, topTy] of group.topByColumn) {
          const shift = group.maxTy + 1 - topTy;
          component.frontShift = Math.max(component.frontShift, shift);
          component.slideShiftByColumn.set(tx,
            Math.max(component.slideShiftByColumn.get(tx) ?? 0, shift));
        }
      }
      // Sliding a tier's slab rigidly vacates its authored rear rows, and the
      // exposed ground there reads as a hole through the building wherever a
      // sightline clears a lower adjoining tier. Pin each column's authored
      // north edge instead and stretch to the same slid front line. Only the
      // column's southmost contiguous run stretches: a detached island behind
      // it (a Fortree walkway stub under its canopy) keeps the rigid slide,
      // or the stretch would pull it back beneath the art it must stand
      // clear of.
      component.roofSpanByColumn = new Map();
      if (component.slideRoof) {
        const rowsByColumn = new Map();
        for (const [tx, ty] of component.roofCells) {
          let list = rowsByColumn.get(tx);
          if (!list) rowsByColumn.set(tx, list = []);
          list.push(ty);
        }
        for (const [tx, list] of rowsByColumn) {
          list.sort((a, b) => a - b);
          let north = list[list.length - 1];
          for (let i = list.length - 2; i >= 0; i--) {
            if (list[i] !== north - 1) break;
            north = list[i];
          }
          component.roofSpanByColumn.set(tx,
            { north, south: list[list.length - 1] + 1 });
        }
      }
      if (!component.frontShift || !component.roofCells.length) continue;
      let northTy = Infinity;
      let southTy = -Infinity;
      for (const [, ty] of component.roofCells) {
        northTy = Math.min(northTy, ty);
        southTy = Math.max(southTy, ty + 1);
      }
      component.roofNorthTy = northTy;
      if (!component.slideRoof) {
        component.roofStretch = (southTy + component.frontShift - northTy)
          / (southTy - northTy);
      }
    }
    const roofColumnShift = (component, tx) =>
      component.slideShiftByColumn?.get(tx) ?? component.frontShift;
    const roofMapTy = (component, tx, ty) => {
      if (!component.slideRoof)
        return component.roofNorthTy + (ty - component.roofNorthTy) * component.roofStretch;
      const shift = roofColumnShift(component, tx);
      const span = component.roofSpanByColumn?.get(tx);
      if (!shift || !span || span.south <= span.north
          || ty < span.north || ty > span.south) return ty + shift;
      const stretch = (span.south + shift - span.north) / (span.south - span.north);
      return span.north + (ty - span.north) * stretch;
    };
    // Query transformed roof occupancy rather than the source grid when one
    // tier closes against another. Otherwise a tall tier drops its generated
    // side to the ground through the lower roof simply because their authored
    // source rows were staggered to draw the original top-down perspective.
    const physicalRoofColumns = new Map();
    // Rear overhangs participate as covering tops so they can hide a tier seam,
    // but their own closure remains suppressed below.
    for (const component of components.values()) {
      for (const [tx, ty] of component.roofCells) {
        let intervals = physicalRoofColumns.get(tx);
        if (!intervals) {
          intervals = [];
          physicalRoofColumns.set(tx, intervals);
        }
        intervals.push({
          y0: roofMapTy(component, tx, ty),
          y1: roofMapTy(component, tx, ty + 1),
          height: heightAt(tx, ty),
        });
      }
    }
    const physicalRoofHeightAt = (tx, ty) => {
      let height = -Infinity;
      for (const interval of physicalRoofColumns.get(tx) || []) {
        if (ty > interval.y0 && ty < interval.y1)
          height = Math.max(height, interval.height);
      }
      return height;
    };
    const physicalReceiverHeightAt = (tx, ty) => {
      const sourceY = Math.floor(ty);
      const surface = surfaceAt(tx, sourceY);
      // Building source cells have moved onto a facade/roof plane. They are
      // not physical receivers at their old grid position; transformed roof
      // occupancy above is authoritative for those cells.
      return surface === HD2D_SURFACE_ROOF || surface === HD2D_SURFACE_WALL
        ? -Infinity : heightAt(tx, sourceY);
    };

    // A closure reaches the ground beside the building. That ground is lower
    // than the base where the building stands at the edge of a terrace.
    const closureFloor = (component, tx, ty) => {
      const receiver = physicalReceiverHeightAt(tx, ty);
      return Number.isFinite(receiver) ? receiver : component.base;
    };

    if (!this.terrainVisitedScratch || this.terrainVisitedScratch.length < cols * rows) {
      this.terrainVisitedScratch = new Uint8Array(cols * rows);
    }
    const visited = this.terrainVisitedScratch;
    visited.fill(0, 0, cols * rows);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const start = ty * cols + tx;
        if (visited[start]) continue;
        visited[start] = 1;
        if (surfaceAt(tx, ty) === HD2D_SURFACE_WALL) continue;

        const word = geometry[start];
        const height = heights[start];
        const startComponent = surfaceAt(tx, ty) === HD2D_SURFACE_ROOF && componentAt(tx, ty) !== 0
          ? components.get(componentAt(tx, ty)) : null;
        let width = 1;
        while (tx + width < cols) {
          const tile = ty * cols + tx + width;
          if (visited[tile] || geometry[tile] !== word || heights[tile] !== height) break;
          // Per-column stretch breaks physical continuity between source
          // neighbors; a merged rectangle must share one mapping.
          if (startComponent?.slideRoof
              && (roofMapTy(startComponent, tx + width, ty) !== roofMapTy(startComponent, tx, ty)
                || roofMapTy(startComponent, tx + width, ty + 1) !== roofMapTy(startComponent, tx, ty + 1))) break;
          width++;
        }
        let depth = 1;
        depthLoop: while (ty + depth < rows) {
          for (let x = 0; x < width; x++) {
            const tile = (ty + depth) * cols + tx + x;
            if (visited[tile] || geometry[tile] !== word || heights[tile] !== height)
              break depthLoop;
          }
          depth++;
        }
        for (let y = 0; y < depth; y++) {
          for (let x = 0; x < width; x++)
            visited[(ty + y) * cols + tx + x] = 1;
        }
        const shell = surfaceAt(tx, ty) === HD2D_SURFACE_ROOF && componentAt(tx, ty) !== 0;
        if (surfaceAt(tx, ty) === HD2D_SURFACE_OPEN_DECK) {
          for (let y = 0; y < depth; y++) {
            for (let x = 0; x < width; x++) {
              const source = openDeckReceiver(tx + x, ty + y);
              if (!source) continue;
              const [sourceX, sourceY, receiverHeight, receiverSurface] = source;
              quad(
                [worldX(tx + x), receiverHeight, worldZ(ty + y), textureU(sourceX), textureV(sourceY)],
                [worldX(tx + x + 1), receiverHeight, worldZ(ty + y), textureU(sourceX + 1), textureV(sourceY)],
                [worldX(tx + x + 1), receiverHeight, worldZ(ty + y + 1), textureU(sourceX + 1), textureV(sourceY + 1)],
                [worldX(tx + x), receiverHeight, worldZ(ty + y + 1), textureU(sourceX), textureV(sourceY + 1)],
                [0, 1, 0], receiverSurface,
              );
            }
          }
        }
        let topV0 = textureV(ty);
        let topV1 = textureV(ty + depth);
        // Cliff sheets keep their authored face rows on the vertical drop.
        // Sampling those same rows across the plateau top reprints the wall
        // as horizontal stripes.
        if (surfaceAt(tx, ty) === HD2D_SURFACE_TERRAIN) {
          let capY = ty;
          while (capY > 0 && surfaceAt(tx, capY - 1) === HD2D_SURFACE_TERRAIN
              && heightAt(tx, capY - 1) === height) capY--;
          topV0 = textureV(capY);
          topV1 = textureV(capY + 1);
        }
        const roofComponent = shell ? startComponent : null;
        const zTop = worldZ(roofComponent ? roofMapTy(roofComponent, tx, ty) : ty);
        const zBottom = worldZ(roofComponent
          ? roofMapTy(roofComponent, tx, ty + depth) : ty + depth);
        quad(
          [worldX(tx), height, zTop, textureU(tx), topV0],
          [worldX(tx + width), height, zTop, textureU(tx + width), topV0],
          [worldX(tx + width), height, zBottom, textureU(tx + width), topV1],
          [worldX(tx), height, zBottom, textureU(tx), topV1],
          [0, 1, 0], surfaceAt(tx, ty), shell ? 1 : 0, shell ? groundHeights[start] : 0,
        );
      }
    }

    const sameRoof = (x, y, id) => inGrid(x, y)
      && surfaceAt(x, y) === HD2D_SURFACE_ROOF && componentAt(x, y) === id;

    // Build structural colors from pixels recurring across the component's
    // authored tiles. One-off markings cannot enter generated treatment merely
    // by occupying many pixels in a door, logo, or sign tile.
    const recurringColorBuckets = (cells) => {
      const buckets = new Map();
      let contributingCells = 0;
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
        const [tx, ty] = cells[cellIndex];
        const seenInCell = new Set();
        const x0 = Math.max(0, Math.min(this.worldWidth - 1, originX + tx * TILE_SIZE));
        const y0 = Math.max(0, Math.min(this.worldHeight - 1, originY + ty * TILE_SIZE));
        const x1 = Math.min(this.worldWidth, x0 + TILE_SIZE);
        const y1 = Math.min(this.worldHeight, y0 + TILE_SIZE);
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            const offset = (py * this.worldWidth + px) * 4;
            if (worldPixels[offset + 3] < 128) continue;
            // Match the fragments that can actually survive on the generated
            // structure. Roof courses often contain opaque floor or grass
            // underlay beneath sparse cap art; sampling that discarded underlay
            // paints generated side walls with the ground material.
            if (worldStructuralAlphaPixels[py * this.worldWidth + px] < 128) continue;
            const red = worldPixels[offset];
            const green = worldPixels[offset + 1];
            const blue = worldPixels[offset + 2];
            const key = (red >> 4) << 8 | (green >> 4) << 4 | (blue >> 4);
            let bucket = buckets.get(key);
            if (!bucket) {
              bucket = { count: 0, cells: 0, red: 0, green: 0, blue: 0 };
              buckets.set(key, bucket);
            }
            if (!seenInCell.has(key)) {
              seenInCell.add(key);
              bucket.cells++;
            }
            bucket.count++;
            bucket.red += red;
            bucket.green += green;
            bucket.blue += blue;
          }
        }
        if (seenInCell.size) contributingCells++;
      }
      // Transparent courses are holes in the authored shell, not votes against
      // the colors visible in the remaining courses. Counting them in the
      // denominator makes sparse facades fall back to generic gray/roof colors.
      if (!contributingCells) return [];
      const minimumCells = Math.max(1, Math.ceil(contributingCells * 0.55));
      return Array.from(buckets.values())
        .filter((bucket) => bucket.cells >= minimumCells)
        .map((bucket) => {
          const red = bucket.red / bucket.count;
          const green = bucket.green / bucket.count;
          const blue = bucket.blue / bucket.count;
          const maximum = Math.max(red, green, blue);
          const minimum = Math.min(red, green, blue);
          const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
          return {
            ...bucket,
            red,
            green,
            blue,
            luminance,
            chroma: maximum - minimum,
            saturation: maximum > 0 ? (maximum - minimum) / maximum : 0,
          };
        });
    };
    const bucketColor = (bucket) => [bucket.red / 255, bucket.green / 255, bucket.blue / 255];
    const mixColor = (a, b, amount) => a.map((channel, index) => channel * (1 - amount) + b[index] * amount);
    const colorLuminance = (color) => color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
    const liftColorToLuminance = (color, floor) => {
      const luminance = colorLuminance(color);
      if (luminance >= floor || luminance <= 0) return color;
      const scale = floor / luminance;
      return color.map((channel) => Math.min(1, channel * scale));
    };
    const selectRoofColor = (cells, fallback) => {
      const candidates = recurringColorBuckets(cells)
        .filter((bucket) => bucket.count >= 8)
        .sort((a, b) => {
          const scoreA = a.chroma * Math.min(1.25, Math.max(0.35, a.luminance / 112))
            + a.saturation * 24 + Math.log2(a.count + 1) * 3;
          const scoreB = b.chroma * Math.min(1.25, Math.max(0.35, b.luminance / 112))
            + b.saturation * 24 + Math.log2(b.count + 1) * 3;
          return scoreB - scoreA || b.count - a.count || b.cells - a.cells;
        });
      if (!candidates.length) return fallback;
      return liftColorToLuminance(bucketColor(candidates[0]), 0.32);
    };
    const selectSideColor = (cells, roofColor, fallback) => {
      const candidates = recurringColorBuckets(cells)
        // Black outlines and transparent-underlay artifacts recur across many
        // facade courses, but they are edge ink, not the building material.
        // Generated closure sides should follow the recurring body color and
        // roof tint instead of expanding those dark pixels into full slabs.
        .filter((bucket) => bucket.luminance >= 58 || bucket.saturation >= 0.28)
        .sort((a, b) => {
          const scoreA = a.count + a.cells * 18 - Math.abs(a.luminance - 128) * 2
            + a.saturation * 16;
          const scoreB = b.count + b.cells * 18 - Math.abs(b.luminance - 128) * 2
            + b.saturation * 16;
          return scoreB - scoreA;
        });
      if (!candidates.length) return fallback;
      const selected = candidates[0];
      let color = bucketColor(selected);
      color = mixColor(color, roofColor, selected.luminance < 82 ? 0.22 : 0.12);
      return liftColorToLuminance(color, 0.38);
    };
    // 2D facade holes are missing wall surface, not generated sides. Fill them
    // with the wall's most common non-dark field color; do not prefer the
    // mid-tone / roof-tinted closure mix.
    const selectWallBodyColor = (cells, fallback) => {
      const candidates = recurringColorBuckets(cells)
        .filter((bucket) => bucket.luminance >= 90)
        .sort((a, b) => b.count - a.count || b.cells - a.cells);
      if (!candidates.length) return fallback;
      return bucketColor(candidates[0]);
    };
    for (const component of components.values()) {
      const wallCells = component.wallCells.map(([tx, ty]) => [tx, ty]);
      const roofColor = selectRoofColor(component.roofCells, [0.45, 0.45, 0.48]);
      component.sideMaterial = selectSideColor(wallCells, roofColor, roofColor);
      component.wallBody = selectWallBodyColor(wallCells, component.sideMaterial);
    }
    for (const component of components.values()) {
      const groups = new Map();
      for (const [tx, ty] of component.wallCells) {
        // C preserves the facade candidate that authored this course. A
        // component can contain several candidates after roof unioning, and
        // transparent art can disconnect one candidate's source cells, so
        // browser-side connectivity cannot recover the physical wall plane.
        const word = facadeAt(tx, ty);
        const id = word & 0xffff;
        const offset = (word >>> 16) & HD2D_FACADE_ROW_MASK;
        if (!id) continue;
        let group = groups.get(id);
        if (!group) {
          group = { anchorY: ty - offset, cells: [] };
          groups.set(id, group);
        }
        group.cells.push([tx, ty, offset]);
      }
      let top = component.roofHeight;
      if (!Number.isFinite(top)) top = component.base + TILE_SIZE;
      const side = component.wallBody || component.sideMaterial || [0, 0, 0];
      component.wallTopHeightByColumn = new Map();
      for (const group of groups.values()) {
        const maxOffset = Math.max(...group.cells.map(([, , offset]) => offset));
        if (!Number.isFinite(component.roofHeight))
          top = Math.max(top, component.base + (maxOffset + 1) * TILE_SIZE);
        // The wall art's base line is the south edge of the group's bottom
        // source row — where the 2D building meets walkable ground. For a
        // roofed box the physical plane stands there; anchoring it at the
        // top course's north edge instead recesses the front by the whole
        // wall footprint depth. Unroofed sheets (fronts embedded in flat
        // obstacle art like Fortree tree houses) stay at their anchor so
        // they remain attached to the authored art around them.
        const roofed = Number.isFinite(component.roofHeight);
        const frontTy = roofed
          ? Math.max(...group.cells.map(([, ty]) => ty)) + 1
          : group.anchorY;
        const z = worldZ(frontTy);
        for (const [tx, ty, offset] of group.cells) {
          const courseTop = top - offset * TILE_SIZE;
          const courseBottom = courseTop - TILE_SIZE;
          if (courseTop > (component.wallTopHeightByColumn.get(tx) ?? -Infinity))
            component.wallTopHeightByColumn.set(tx, courseTop);
          quad(
            [worldX(tx),courseBottom,z,textureU(tx),textureV(ty + 1)],
            [worldX(tx + 1),courseBottom,z,textureU(tx + 1),textureV(ty + 1)],
            [worldX(tx + 1),courseTop,z,textureU(tx + 1),textureV(ty)],
            [worldX(tx),courseTop,z,textureU(tx),textureV(ty)],
            [0, 0, 1], HD2D_SURFACE_WALL, 1, component.base, side,
          );
        }
      }
      component.roofHeight = Math.max(component.roofHeight, top);
    }

    // Only authored roof cells render horizontally. Copying a roof-edge tile
    // behind every facade rectangle duplicates logos and stretches one strip
    // across stepped or gapped landmark silhouettes.
    for (const component of components.values()) {
      // Close only exposed building perimeter with the same component-derived
      // side treatment. Wall source rows are vertical art, not horizontal
      // footprint, so they must never generate a second closure skin.
      // Closure faces follow the stretched footprint, while interior edges
      // are still decided by source adjacency — the stretch is monotonic,
      // so roof-roof seams stay interior and the south edge lands on the
      // facade plane wherever wall source sits below. Neutral closure never
      // samples the atlas, so the faces are emitted directly at fractional
      // stretched positions instead of through verticalSide's integer grid.
      for (const [tx, ty] of component.roofCells) {
        // A non-blocking rear gable extends the horizontal roof art but not
        // the building footprint below it. Its supported neighbor closes the
        // real shell; dropping this exposed perimeter to ground creates the
        // long side-wall curtains visible beside actors walking behind it.
        // Stretched tier slabs are the exception laterally: their overhang
        // rows are the building's own top-rear courses, physically south of
        // the rear walkway, and leaving their sides open cuts a through-hole
        // above an adjoining lower tier's roof.
        const overhang = roofOverhangAt(tx, ty);
        if ((overhang && !component.slideRoof)
            || !component.roofClosureCells.has(roofCellKey(tx, ty))) continue;
        const height = heightAt(tx, ty);
        const z0 = worldZ(roofMapTy(component, tx, ty));
        const z1 = worldZ(roofMapTy(component, tx, ty + 1));
        const closure = (a, b, c, d, normal) => quad(a, b, c, d, normal,
          MATERIAL_NEUTRAL_BUILDING, 1, component.base, component.sideMaterial);
        for (const dx of [-1, 1]) {
          // Source-adjacent same-roof cells stay interior even when their
          // columns slide by different amounts: the staggered rear sliver is
          // an 8px edge at most, while closing it drops a full-height
          // curtain wherever nothing covers the neighbor's vacated rows.
          if (sameRoof(tx + dx, ty, component.id)) continue;
          if (inGrid(tx + dx, ty) && surfaceAt(tx + dx, ty) === HD2D_SURFACE_WALL
              && componentAt(tx + dx, ty) === component.id) continue;
          const physicalY0 = roofMapTy(component, tx, ty);
          const physicalY1 = roofMapTy(component, tx, ty + 1);
          const cuts = [physicalY0, physicalY1];
          for (const interval of physicalRoofColumns.get(tx + dx) || []) {
            if (interval.y1 <= physicalY0 || interval.y0 >= physicalY1) continue;
            cuts.push(Math.max(physicalY0, interval.y0),
                      Math.min(physicalY1, interval.y1));
          }
          cuts.sort((a, b) => a - b);
          const x = worldX(dx < 0 ? tx : tx + 1);
          for (let index = 0; index + 1 < cuts.length; index++) {
            const segmentY0 = cuts[index];
            const segmentY1 = cuts[index + 1];
            if (segmentY1 - segmentY0 < 1e-6) continue;
            const physicalMidY = (segmentY0 + segmentY1) / 2;
            // Stretched tier slabs cover their full authored footprint, so
            // physical roof occupancy already says where a lower adjoining
            // tier supports this side. A column-wide tier clamp would float
            // the closure above open ground in front of the lower tier.
            let bottom = Math.max(closureFloor(component, tx + dx, physicalMidY),
                                  physicalRoofHeightAt(tx + dx, physicalMidY));
            // A tier running past an abutting tier's front or rear line
            // would drop this side to the ground over the strip beyond that
            // line, cutting a full-height blade beside the neighbor's facade
            // (the Rustboro Gym bay corners). The segment's own edges say
            // which roof just ended there: carry that roof line around the
            // corner. Coverage at or above this tier's height is a
            // same-height rear stagger step whose slab edge needs no
            // curtain at all.
            if (bottom <= component.base) {
              const edge = Math.max(physicalRoofHeightAt(tx + dx, segmentY0 - 1e-3),
                                    physicalRoofHeightAt(tx + dx, segmentY1 + 1e-3));
              if (Number.isFinite(edge)) bottom = Math.max(bottom, Math.min(edge, height));
            }
            if (bottom >= height) continue;
            const segmentZ0 = worldZ(segmentY0);
            const segmentZ1 = worldZ(segmentY1);
            closure([x, bottom, segmentZ0, 0, 0], [x, bottom, segmentZ1, 0, 0],
                    [x, height, segmentZ1, 0, 0], [x, height, segmentZ0, 0, 0],
                    [dx < 0 ? -1 : 1, 0, 0]);
          }
        }
        for (const dy of [-1, 1]) {
          // Overhang rows never close front/back: the rear stays open over
          // the walkway behind, exactly as before stretch.
          if (overhang) continue;
          if (sameRoof(tx, ty + dy, component.id)) continue;
          if (inGrid(tx, ty + dy) && componentAt(tx, ty + dy) === component.id
              && surfaceAt(tx, ty + dy) === HD2D_SURFACE_WALL) {
            // A slab riding a wall column shorter than the tier height (a
            // cornice column beside a deeper window column) still exposes
            // the strip between that wall's top and the slab. Fill it at
            // the facade line; a full-height wall needs nothing.
            const wallTop = component.wallTopHeightByColumn?.get(tx) ?? height;
            // Only seal the course-sized seam a cornice column opens beside
            // a deeper neighbor. A wall top far below the slab is a facade
            // authored against overlapping art; a big neutral quad there
            // reads as a curtain (Lilycove), not a seam fill.
            if (dy < 0 || !component.slideRoof || wallTop >= height
                || height - wallTop > TILE_SIZE) continue;
            closure([worldX(tx), wallTop, z1, 0, 0], [worldX(tx + 1), wallTop, z1, 0, 0],
                    [worldX(tx + 1), height, z1, 0, 0], [worldX(tx), height, z1, 0, 0],
                    [0, 0, 1]);
            continue;
          }
          const edgeY = roofMapTy(component, tx, dy < 0 ? ty : ty + 1);
          const neighborY = edgeY + dy * 1e-3;
          const bottom = Math.max(closureFloor(component, tx, neighborY),
                                  physicalRoofHeightAt(tx, neighborY));
          if (bottom >= height) continue;
          const z = dy < 0 ? z0 : z1;
          closure([worldX(tx), bottom, z, 0, 0], [worldX(tx + 1), bottom, z, 0, 0],
                  [worldX(tx + 1), height, z, 0, 0], [worldX(tx), height, z, 0, 0],
                  [0, 0, dy < 0 ? -1 : 1]);
        }
      }
    }

    // Preserve atlas-edge extrusion for solid non-building materials. Open
    // bridge decks use the lower receiver generated above, not a vertical
    // curtain sampled from water or bridge pixels.
    const ordinaryEdge = (tx, ty, dx, dy) => {
      const surface = surfaceAt(tx, ty);
      const height = heightAt(tx, ty);
      const bottom = heightAt(tx + dx, ty + dy);
      return surface !== HD2D_SURFACE_ROOF && surface !== HD2D_SURFACE_WALL
        && surface !== HD2D_SURFACE_OPEN_DECK && bottom < height
        ? { height, bottom } : null;
    };
    for (const dy of [-1, 1]) {
      for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
          const edge = ordinaryEdge(tx, ty, 0, dy);
          if (!edge) continue;
          terrainSide(tx, ty, edge.bottom, edge.height, 0, dy,
                      [0, 0, dy < 0 ? -1 : 1], surfaceAt(tx, ty));
        }
      }
    }
    for (const dx of [-1, 1]) {
      for (let tx = 0; tx < cols; tx++) {
        for (let ty = 0; ty < rows; ty++) {
          const edge = ordinaryEdge(tx, ty, dx, 0);
          if (!edge) continue;
          terrainSide(tx, ty, edge.bottom, edge.height, dx, 0,
                      [dx < 0 ? -1 : 1, 0, 0], surfaceAt(tx, ty));
        }
      }
    }

    const data = vertexScratch.subarray(0, vertexFloatCount);
    if (data.byteLength > this.vertexCapacity) {
      this.vertexBuffer.destroy();
      this.vertexCapacity = 2 ** Math.ceil(Math.log2(data.byteLength));
      this.vertexBuffer = this.device.createBuffer({ label: 'projected terrain mesh', size: this.vertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    this.device.queue.writeBuffer(this.vertexBuffer, 0, data);
    syncBuildingMaterialSnapshot(false);
    this.terrainSignature = signature;
    this.terrainVertexCount = vertexFloatCount / VERTEX_FLOATS;
    this.terrainRevision++;
    return this.terrainVertexCount;
  }
}
