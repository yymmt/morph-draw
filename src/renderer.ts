/**
 * @file renderer.js
 * @description Controls all drawing/rendering pipeline actions onto 2D contexts, guide structures, layers, and mini-map overlays.
 */

/**
 * Tracks current render coons count for performance debugging.
 * @type {number}
 */
let currentRenderCoonsCount = 0;

/**
 * Cache storage of processed/rendered shape layers.
 * @type {Object<string, Object>}
 */
const shapeRenderCaches = {};

/**
 * Gets or initializes the render cache for a shape.
 * @param {string} shapeId - Target shape ID.
 * @returns {Object} Cache entry object.
 */
function getShapeCache(shapeId) {
    if (!shapeRenderCaches[shapeId]) {
        const canvas = newElm('canvas');
        const ctx = canvas.getContext('2d');
        shapeRenderCaches[shapeId] = { canvas, ctx, isDirty: true, x: 0, y: 0, w: 0, h: 0 };
    }
    return shapeRenderCaches[shapeId];
}

/**
 * Computes bounding render bounds for a shape including its line thickness and padding.
 * @param {string} shapeId - Target shape ID.
 * @returns {Object|null} Bounds object {x, y, w, h} or null if shape has no beziers.
 */
function getShapeRenderBounds(shapeId) {
    const shape = state.shapes[shapeId];
    if (!shape) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (shape.type === 'polyline') {
        if (shape.points) {
            shape.points.forEach(p => {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.y > maxY) maxY = p.y;
            });
        }
    } else if (shape.bezierIds) {
        shape.bezierIds.forEach(bid => {
            const bez = state.beziers[bid];
            if (bez && bez.samplePointByT) {
                Object.values(bez.samplePointByT).forEach(p => {
                    if (p.x < minX) minX = p.x;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.y > maxY) maxY = p.y;
                });
            }
        });
    } else {
        return null;
    }

    if (minX === Infinity) {
        return { x: 0, y: 0, w: state.canvas.width, h: state.canvas.height };
    }

    let maxW = 10;
    if (shape.strokeWidthData && shape.strokeWidthData.length > 0) {
        maxW = Math.max(...shape.strokeWidthData.map(d => d.w));
    }

    const padding = (maxW / 2) + 20;

    const x = Math.floor(minX - padding);
    const y = Math.floor(minY - padding);

    const w = Math.max(1, Math.ceil(maxX + padding) - x);
    const h = Math.max(1, Math.ceil(maxY + padding) - y);

    return { x, y, w, h };
}

/**
 * Marks shape rendering cache dirty to force a redraw.
 * @param {string} shapeId - Target shape ID.
 */
function markShapeDirty(shapeId) {
    const cache = shapeRenderCaches[shapeId];
    if (cache) {
        cache.isDirty = true;
    }
}

/**
 * Marks all shape rendering caches dirty.
 */
function clearAllCaches() {
    for (const id in shapeRenderCaches) {
        shapeRenderCaches[id].isDirty = true;
    }
}

/**
 * Renders the canvas view containing shapes, guides, and mini-map.
 */
function renderCanvas() {
    const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    currentRenderCoonsCount = 0;

    const viewport = getDom('#viewport');
    if (viewport) {
        viewport.setAttribute('transform', `translate(${state.pan.x}, ${state.pan.y}) scale(${state.zoom}) rotate(${state.rotation})`);
        viewport.innerHTML = '';
    }

    const borderRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    borderRect.setAttribute('x', 0);
    borderRect.setAttribute('y', 0);
    borderRect.setAttribute('width', state.canvas.width);
    borderRect.setAttribute('height', state.canvas.height);
    borderRect.setAttribute('fill', 'none');
    borderRect.setAttribute('stroke', '#ccc');
    borderRect.setAttribute('stroke-width', 1);
    borderRect.setAttribute('stroke-dasharray', '4,4');
    viewport.appendChild(borderRect);

    const activeLayerId = state.selectedLayerId;
    if (activeLayerId) {
        const activeLayer = state.shapes[activeLayerId];
        if (activeLayer && activeLayer.childIds) {
            activeLayer.childIds.forEach(childId => {
                renderGuides(childId, viewport);
            });
        }
    }

    if (activeLayerId && state.canvas.activeOffscreen) {
        const activeCtx = state.canvas.activeOffscreen.getContext('2d');
        activeCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        drawShapeToCanvasContext(activeCtx, activeLayerId);
    }

    const underCanvas = getDom('#under-canvas');
    const activeCanvas = getDom('#active-canvas');
    const overCanvas = getDom('#over-canvas');
    const draftCanvas = getDom('#draft-canvas');

    drawOffscreenToOnscreen(underCanvas, state.canvas.underOffscreen);
    drawOffscreenToOnscreen(activeCanvas, state.canvas.activeOffscreen);
    drawOffscreenToOnscreen(overCanvas, state.canvas.overOffscreen);
    drawOffscreenToOnscreen(draftCanvas, state.canvas.draftOffscreen);

    renderMinimap();
    renderLayerList();

    const duration = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startTime;
    if (window.__debug__ && typeof window.__debug__.addMeasure === 'function') {
        window.__debug__.addMeasure(duration, currentRenderCoonsCount);
    }
}

/**
 * Draws contents of an offscreen canvas into target onscreen canvas.
 * @param {HTMLCanvasElement} onscreen - Target onscreen canvas.
 * @param {HTMLCanvasElement} offscreen - Source offscreen canvas.
 */
function drawOffscreenToOnscreen(onscreen, offscreen) {
    if (!onscreen) return;
    const ctx = onscreen.getContext('2d');
    const rect = onscreen.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    if (onscreen.width !== Math.floor(rect.width * dpr) || onscreen.height !== Math.floor(rect.height * dpr)) {
        onscreen.width = Math.floor(rect.width * dpr);
        onscreen.height = Math.floor(rect.height * dpr);
    }

    ctx.clearRect(0, 0, onscreen.width, onscreen.height);
    if (!offscreen) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.translate(state.pan.x, state.pan.y);
    ctx.scale(state.zoom, state.zoom);
    ctx.rotate(state.rotation * Math.PI / 180);

    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();
}

/**
 * Renders a shape or recursively renders layers child shapes onto Canvas context.
 * @param {CanvasRenderingContext2D} ctx - Context to render on.
 * @param {string} shapeId - Shape ID to process.
 */
function drawShapeToCanvasContext(ctx, shapeId) {
    const shape = state.shapes[shapeId];
    if (!shape) return;

    if (shape.type === 'layer' && shape.visible === false) return;

    ctx.save();

    if (shape.type === 'layer') {
        ctx.globalAlpha *= (shape.style?.opacity ?? 1);
        shape.childIds?.forEach(childId => drawShapeToCanvasContext(ctx, childId));
    } else if (shape.bezierIds || shape.type === 'polyline') {
        const cache = getShapeCache(shapeId);
        if (cache.isDirty) {
            const bounds = getShapeRenderBounds(shapeId);
            if (bounds) {
                cache.x = bounds.x;
                cache.y = bounds.y;
                if (cache.canvas.width !== bounds.w || cache.canvas.height !== bounds.h) {
                    cache.canvas.width = bounds.w;
                    cache.canvas.height = bounds.h;
                }
                cache.w = bounds.w;
                cache.h = bounds.h;
            } else {
                cache.x = 0;
                cache.y = 0;
                if (cache.canvas.width !== state.canvas.width || cache.canvas.height !== state.canvas.height) {
                    cache.canvas.width = state.canvas.width;
                    cache.canvas.height = state.canvas.height;
                }
                cache.w = state.canvas.width;
                cache.h = state.canvas.height;
            }

            const cCtx = cache.ctx;
            cCtx.clearRect(0, 0, cache.w, cache.h);
            cCtx.save();
            cCtx.translate(-cache.x, -cache.y);

            const fillEnabled = shape.style?.fillEnabled !== false;
            const outlineEnabled = shape.style?.outline !== false;

            cCtx.globalAlpha = shape.style?.opacity ?? 1;

            if (fillEnabled) {
                cCtx.save();
                cCtx.beginPath();
                if (shape.type === 'polyline') {
                    if (shape.points && shape.points.length > 2) {
                        cCtx.moveTo(shape.points[0].x, shape.points[0].y);
                        for (let i = 1; i < shape.points.length; i++) {
                            cCtx.lineTo(shape.points[i].x, shape.points[i].y);
                        }
                    }
                } else {
                    let first = true;
                    shape.bezierIds.forEach((bid, i) => {
                        const b = state.beziers[bid];
                        if (!b || !b.controlPoints || b.controlPoints.length < 4) return;
                        const v = b.controlPoints.map(cp => cp.v);
                        if (first) {
                            cCtx.moveTo(v[0].x, v[0].y);
                            first = false;
                        } else {
                            cCtx.lineTo(v[0].x, v[0].y);
                        }
                        cCtx.bezierCurveTo(v[1].x, v[1].y, v[2].x, v[2].y, v[3].x, v[3].y);
                    });
                }
                cCtx.closePath();

                let drawn = false;
                if (shape.style?.fillPattern) {
                    currentRenderCoonsCount++;
                    const meshPositions = generateCoonsPatchMesh(shape);
                    if (meshPositions) {
                        const webglCanvas = renderPatternWebGL(meshPositions, shape.style.fillPattern);
                        if (webglCanvas) {
                            cCtx.drawImage(webglCanvas, 0, 0);
                            drawn = true;
                        }
                    }
                }
                if (!drawn) {
                    cCtx.fillStyle = shape.style?.fill || '#000000';
                    cCtx.fill();
                }
                cCtx.restore();
            }

            if (outlineEnabled) {
                let outlineDrawn = false;
                if (shape.style?.strokePattern) {
                    currentRenderCoonsCount++;
                    const meshPositions = generateStrokeCoonsPatchMesh(shape);
                    if (meshPositions) {
                        const webglCanvas = renderPatternWebGL(meshPositions, shape.style.strokePattern);
                        if (webglCanvas) {
                            cCtx.drawImage(webglCanvas, 0, 0);
                            outlineDrawn = true;
                        }
                    }
                }
                if (!outlineDrawn) {
                    const { leftPoints, rightPoints } = MDMath.generateOutlinePathPoints(shape, state.beziers);
                    if (leftPoints.length > 0) {
                        cCtx.beginPath();
                        cCtx.moveTo(leftPoints[0].x, leftPoints[0].y);
                        for (let i = 1; i < leftPoints.length; i++) {
                            cCtx.lineTo(leftPoints[i].x, leftPoints[i].y);
                        }
                        for (let i = rightPoints.length - 1; i >= 0; i--) {
                            cCtx.lineTo(rightPoints[i].x, rightPoints[i].y);
                        }
                        cCtx.closePath();
                        cCtx.fillStyle = shape.style?.fill || '#000000';
                        cCtx.fill();
                    }
                }
            }

            cCtx.restore();
            cache.isDirty = false;
        }

        ctx.drawImage(cache.canvas, cache.x, cache.y);
    }

    ctx.restore();
}

/**
 * Draws active/inactive layers sequentially to offscreen contexts depending on active layer selection order.
 */
function rasterizeInactiveLayers() {
    if (!state.canvas.underOffscreen || !state.canvas.overOffscreen || !state.canvas.activeOffscreen) return;

    const underCtx = state.canvas.underOffscreen.getContext('2d');
    const overCtx = state.canvas.overOffscreen.getContext('2d');
    const activeCtx = state.canvas.activeOffscreen.getContext('2d');

    underCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
    overCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
    activeCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);

    let foundActive = false;

    state.scene.forEach(layerId => {
        const layer = state.shapes[layerId];
        if (!layer) return;

        if (layerId === state.selectedLayerId) {
            foundActive = true;
            drawShapeToCanvasContext(activeCtx, layerId);
        } else {
            const targetCtx = foundActive ? overCtx : underCtx;
            drawShapeToCanvasContext(targetCtx, layerId);
        }
    });
}

/**
 * Renders the mini-map visualization canvas overlay.
 */
function renderMinimap() {
    const canvas = getDom('#minimap-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const activeLayerId = state.selectedLayerId;
    if (activeLayerId && state.canvas.activeOffscreen) {
        const activeCtx = state.canvas.activeOffscreen.getContext('2d');
        activeCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        drawShapeToCanvasContext(activeCtx, activeLayerId);
    }

    const baseScale = Math.min(canvas.width / state.canvas.width, canvas.height / state.canvas.height);
    const zoomScale = baseScale * state.minimap.zoom;

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(zoomScale, zoomScale);
    ctx.translate(-state.canvas.width / 2, -state.canvas.height / 2);

    if (state.canvas.underOffscreen) ctx.drawImage(state.canvas.underOffscreen, 0, 0);
    if (state.canvas.activeOffscreen) ctx.drawImage(state.canvas.activeOffscreen, 0, 0);
    if (state.canvas.overOffscreen) ctx.drawImage(state.canvas.overOffscreen, 0, 0);
    if (state.canvas.draftOffscreen) ctx.drawImage(state.canvas.draftOffscreen, 0, 0);

    ctx.restore();
}

/**
 * Renders SVG guide shapes, points, selected/anchored frames, and mode-dependent indicators.
 * @param {string} id - Target shape ID.
 * @param {SVGElement} container - Target SVG container.
 */
function renderGuides(id, container) {
    const shape = state.shapes[id];
    if (!shape) return;

    if (shape.type === 'layer' && shape.visible === false) return;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    const addLine = (x1, y1, x2, y2, strokeColor, strokeWidth, isDashed = false) => {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x1); line.setAttribute('y1', y1);
        line.setAttribute('x2', x2); line.setAttribute('y2', y2);
        line.setAttribute('stroke', strokeColor);
        line.setAttribute('stroke-width', strokeWidth);
        if (isDashed) {
            line.setAttribute('stroke-dasharray', '2,2');
        }
        g.appendChild(line);
    };

    const addCircle = (cx, cy, r, fillColor, strokeColor, strokeWidth = 1.5) => {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
        c.setAttribute('fill', fillColor);
        c.setAttribute('stroke', strokeColor);
        c.setAttribute('stroke-width', strokeWidth);
        g.appendChild(c);
    };

    if (shape.bezierIds) {
        const guidePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const v = i => state.beziers[shape.bezierIds[i]].controlPoints.map(cp => cp.v);
        const ps = (vArr, j) => `${vArr[j].x},${vArr[j].y}`;
        const d = `M ${ps(v(0), 0)} ` + shape.bezierIds.map((bid, i) => `C ${ps(v(i), 1)} ${ps(v(i), 2)} ${ps(v(i), 3)}`).join(' ') + ' Z';

        guidePath.setAttribute('d', d);
        guidePath.setAttribute('fill', 'none');

        const isSelected = state.selectedShapeIds.includes(shape.id);
        const isAnchored = state.anchoredShapeIds?.includes(shape.id);
        let strokeColor = ((shape.style && shape.style.fill) || '#2196F3') + '44';
        let strokeWidth = 0.5;
        if (isSelected) {
            strokeColor = '#ffeb3b';
            strokeWidth = 1.5;
        } else if (isAnchored) {
            strokeColor = '#ff9800';
            strokeWidth = 1.5;
        }
        guidePath.setAttribute('stroke', strokeColor);
        guidePath.setAttribute('stroke-width', strokeWidth);
        g.appendChild(guidePath);

        if (state.focusedVertex && state.focusedVertex.shapeId === shape.id) {
            const { vertexIdx } = state.focusedVertex;
            if (shape.bezierIds && shape.bezierIds.length > 0) {
                const bezierIdx = Math.floor(vertexIdx / 2) % shape.bezierIds.length;
                const bid = shape.bezierIds[bezierIdx];
                const b = state.beziers[bid];
                if (b && b.controlPoints && b.controlPoints.length >= 4) {
                    const isStart = (vertexIdx % 2 === 0);
                    const vertexPt = b.controlPoints[isStart ? 0 : 3].v;
                    const cpPt = b.controlPoints[isStart ? 1 : 2].v;

                    addLine(vertexPt.x, vertexPt.y, cpPt.x, cpPt.y, '#ff9800', 1.5, true);
                    addCircle(cpPt.x, cpPt.y, 4, 'white', '#ff9800', 1.5);
                    addCircle(vertexPt.x, vertexPt.y, 8, 'none', '#ff9800', 1.5);
                    addCircle(vertexPt.x, vertexPt.y, 4, '#ff9800', '#ff9800', 0);
                }
            }
        }

        if (state.thicknessEdit.active && state.selectedShapeIds.includes(shape.id)) {
            if (shape.strokeWidthData) {
                shape.strokeWidthData.forEach((ptData) => {
                    const { p, nx, ny } = MDMath.getShapePointAndNormal(shape, ptData.t, state.beziers);
                    const r = ptData.w / 2;

                    addLine(p.x - nx * r, p.y - ny * r, p.x + nx * r, p.y + ny * r, '#ffeb3b', 2);
                    addCircle(p.x, p.y, 4, 'white', '#ffeb3b', 1.5);
                });
            }

            const targetT = state.thicknessEdit.targetT;
            const { p, nx, ny } = MDMath.getShapePointAndNormal(shape, targetT, state.beziers);
            const w = MDMath.getShapeThickness(shape, targetT);
            const r = w / 2;

            addLine(p.x - nx * r, p.y - ny * r, p.x + nx * r, p.y + ny * r, '#f44336', 2.5);
            addCircle(p.x, p.y, 6, 'none', '#f44336', 1.5);
            addCircle(p.x, p.y, 3, '#f44336', '#f44336', 0);
        }

        if (state.patternEdit.active && state.selectedShapeIds.includes(shape.id)) {
            if (shape.patternCorners) {
                ['TL', 'TR', 'BR', 'BL'].forEach((key) => {
                    const tCorner = shape.patternCorners[key];
                    if (tCorner === undefined) return;

                    const p = getShapePoint(shape, tCorner);
                    const isSelected = (state.patternEdit.selectedCorner === key);

                    addCircle(p.x, p.y, isSelected ? 7 : 5, isSelected ? '#2196F3' : 'white', '#2196F3', 2);

                    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    text.setAttribute('x', p.x + 8);
                    text.setAttribute('y', p.y + 4);
                    text.setAttribute('fill', '#2196F3');
                    text.setAttribute('font-size', '10px');
                    text.setAttribute('font-weight', 'bold');
                    text.textContent = key;
                    g.appendChild(text);
                });
            }

            if (state.patternEdit.active && state.selectedShapeIds.includes(shape.id)) {
                const targetT = state.patternEdit.targetT;
                const p = getShapePoint(shape, targetT);

                addCircle(p.x, p.y, 6, 'none', '#f44336', 1.5);
                addCircle(p.x, p.y, 3, '#f44336', '#f44336', 0);
            }
        }
    }
    container.appendChild(g);
}

(window as any).renderCanvas = renderCanvas;
(window as any).clearAllCaches = clearAllCaches;
(window as any).getShapeCache = getShapeCache;
(window as any).getShapeRenderBounds = getShapeRenderBounds;
(window as any).markShapeDirty = markShapeDirty;
(window as any).drawShapeToCanvasContext = drawShapeToCanvasContext;
(window as any).rasterizeInactiveLayers = rasterizeInactiveLayers;
(window as any).renderMinimap = renderMinimap;
(window as any).renderGuides = renderGuides;
