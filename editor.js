/**
 * @file editor.js
 * @description Stores all mouse/pointer transformations, shape generators, key input handlers, search functions, and geometry mutations.
 */

/**
 * Handles keyboard/menu action to start creating a circle.
 * @param {Object} ctx - Event context.
 */
function handleAddCircleStart(ctx) {
    addShapeAt('circle', state.input.pointerOnSVG.x, state.input.pointerOnSVG.y);
}

/**
 * Handles keyboard/menu action to wrap selected shapes.
 * @param {Object} ctx - Event context.
 */
function handleCreateWrap(ctx) {
    createWrap();
}

/**
 * Handles undo event.
 * @param {Object} ctx - Event context.
 */
function handleUndoAction(ctx) {
    undo();
}

/**
 * Handles redo event.
 * @param {Object} ctx - Event context.
 */
function handleRedoAction(ctx) {
    redo();
}

/**
 * Copies selected and anchored shapes to the internal clipboard.
 * @param {Object} ctx - Event context.
 */
function handleCopy(ctx) {
    const shapeIds = Array.from(new Set([...state.selectedShapeIds, ...(state.anchoredShapeIds || [])]));
    if (shapeIds.length === 0) return;

    const candidateShapeIds = new Set();
    const candidateBezierIds = new Set();

    shapeIds.forEach(sid => {
        const shape = state.shapes[sid];
        if (shape && shape.type !== 'layer') {
            candidateShapeIds.add(sid);
            if (shape.bezierIds) {
                shape.bezierIds.forEach(bid => candidateBezierIds.add(bid));
            }
        }
    });

    const invalidBezierIds = new Set();
    candidateBezierIds.forEach(bid => {
        const bez = state.beziers[bid];
        if (bez && bez.generator && bez.generator.type === 'connector') {
            const { src1, src2 } = bez.generator.params;
            if (!candidateBezierIds.has(src1.bezierId) || !candidateBezierIds.has(src2.bezierId)) {
                invalidBezierIds.add(bid);
            }
        }
    });

    const validShapeIds = [];
    const validBezierIds = new Set();

    candidateShapeIds.forEach(sid => {
        const shape = state.shapes[sid];
        const hasInvalid = shape.bezierIds && shape.bezierIds.some(bid => invalidBezierIds.has(bid));
        if (!hasInvalid) {
            validShapeIds.push(sid);
            if (shape.bezierIds) {
                shape.bezierIds.forEach(bid => validBezierIds.add(bid));
            }
        }
    });

    const copiedShapes = [];
    const copiedBeziers = {};

    validShapeIds.forEach(sid => {
        const shape = state.shapes[sid];
        copiedShapes.push(JSON.parse(JSON.stringify(shape)));
    });

    validBezierIds.forEach(bid => {
        const bez = state.beziers[bid];
        if (bez) {
            copiedBeziers[bid] = JSON.parse(JSON.stringify(bez));
        }
    });

    if (copiedShapes.length > 0) {
        state.clipboard = {
            shapes: copiedShapes,
            beziers: copiedBeziers
        };
    }
}

/**
 * Pastes shape assets stored in clipboard into the active layer.
 * @param {Object} ctx - Event context.
 */
function handlePaste(ctx) {
    if (!state.clipboard || !state.clipboard.shapes || state.clipboard.shapes.length === 0) return;

    const shapeIdMap = {};
    const bezierIdMap = {};

    state.clipboard.shapes.forEach(shape => {
        const newShapeId = generateId('s');
        shapeIdMap[shape.id] = newShapeId;

        if (shape.bezierIds) {
            shape.bezierIds.forEach(bid => {
                if (!bezierIdMap[bid]) {
                    bezierIdMap[bid] = generateId('b');
                }
            });
        }
    });

    const newShapeIds = [];
    const offset = 20;

    for (const oldBid in state.clipboard.beziers) {
        const newBid = bezierIdMap[oldBid];
        const bez = JSON.parse(JSON.stringify(state.clipboard.beziers[oldBid]));
        bez.id = newBid;

        if (bez.generator) {
            if (bez.generator.type === 'arc') {
                const oldShapeId = bez.generator.params.s;
                if (oldShapeId && shapeIdMap[oldShapeId]) {
                    bez.generator.params.s = shapeIdMap[oldShapeId];
                }
            } else if (bez.generator.type === 'connector') {
                const { src1, src2 } = bez.generator.params;
                src1.bezierId = bezierIdMap[src1.bezierId];
                src2.bezierId = bezierIdMap[src2.bezierId];
            }
        }

        state.beziers[newBid] = bez;
    }

    const activeLayerId = state.selectedLayerId;
    const activeLayer = state.shapes[activeLayerId];
    if (!activeLayer || activeLayer.type !== 'layer') return;

    state.clipboard.shapes.forEach(oldShape => {
        const newShapeId = shapeIdMap[oldShape.id];
        const shape = JSON.parse(JSON.stringify(oldShape));
        shape.id = newShapeId;

        if (shape.props) {
            shape.props.x += offset;
            shape.props.y += offset;
        }

        if (shape.bezierIds) {
            shape.bezierIds = shape.bezierIds.map(bid => bezierIdMap[bid]);
        }

        state.shapes[newShapeId] = shape;
        activeLayer.childIds.push(newShapeId);
        newShapeIds.push(newShapeId);

        markShapeDirty(newShapeId);
    });

    state.selectedShapeIds = [];
    state.anchoredShapeIds = newShapeIds;

    resolveBezierDependencies();
    rasterizeInactiveLayers();
    renderCanvas();
    pushHistory();
}

/**
 * Saves current drawing and quits back to gallery view.
 * @param {Object} ctx - Event context.
 */
async function handleQuitToGallery(ctx) {
    if (state.view === 'canvas') {
        await saveDrawing();
        loadGallery();
        switchView('gallery');
    }
}

/**
 * Opens search input panel UI.
 * @param {Object} ctx - Event context.
 */
function handleOpenSearch(ctx) {
    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
    openSearchMode();
}

/**
 * Focuses on next search query result.
 * @param {Object} ctx - Event context.
 */
function handleSearchNext(ctx) {
    if (state.search.results.length > 0) {
        state.search.currentIndex = (state.search.currentIndex + 1) % state.search.results.length;
        applySearchResult();
    }
}

/**
 * Focuses on previous search query result.
 * @param {Object} ctx - Event context.
 */
function handleSearchPrev(ctx) {
    if (state.search.results.length > 0) {
        state.search.currentIndex = (state.search.currentIndex - 1 + state.search.results.length) % state.search.results.length;
        applySearchResult();
    }
}

/**
 * Cycles to previous focused vertex.
 * @param {Object} ctx - Event context.
 */
function handleFocusVertexPrev(ctx) {
    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
    moveVertexFocus(-1);
}

/**
 * Cycles to next focused vertex.
 * @param {Object} ctx - Event context.
 */
function handleFocusVertexNext(ctx) {
    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
    moveVertexFocus(1);
}

/**
 * Shifts vertex focus selection index inside selected wrap shape.
 * @param {number} dir - Movement direction (-1 or 1).
 */
function moveVertexFocus(dir) {
    if (state.selectedShapeIds.length > 0) {
        const shapeId = state.selectedShapeIds[0];
        const shape = state.shapes[shapeId];
        if (shape && shape.name && shape.name.startsWith('wrap') && shape.bezierIds && shape.bezierIds.length > 0) {
            const numHandles = shape.bezierIds.length * 2;
            if (state.focusedVertex === null || state.focusedVertex === undefined) {
                state.focusedVertex = { shapeId, vertexIdx: 0 };
            } else {
                const currIdx = state.focusedVertex.vertexIdx;
                const nextIdx = (currIdx + dir + numHandles) % numHandles;
                state.focusedVertex = { shapeId, vertexIdx: nextIdx };
            }
        }
    }
}

/**
 * Clears current focused vertex pointer.
 * @param {Object} ctx - Event context.
 */
function handleClearVertexFocus(ctx) {
    if (state.focusedVertex) {
        state.focusedVertex = null;
    }
}

/**
 * Toggles anchored shape status or sets pending insert vertex.
 * @param {Object} ctx - Event context.
 * @returns {Object} Configuration settings {pushHistory, needsRender}.
 */
function handleToggleAnchor(ctx) {
    if (state.focusedVertex) {
        state.insertVertexPending = { ...state.focusedVertex };
        return { pushHistory: false, needsRender: false };
    }
    state.selectedShapeIds.forEach(id => {
        const idx = state.anchoredShapeIds.indexOf(id);
        if (idx >= 0) {
            state.anchoredShapeIds.splice(idx, 1);
        } else {
            state.anchoredShapeIds.push(id);
        }
    });
    return { pushHistory: true, needsRender: true };
}

/**
 * Toggles active state of line thickness editor.
 * @param {Object} ctx - Event context.
 * @returns {Object} Configuration settings {pushHistory, needsRender}.
 */
function handleToggleThicknessEdit(ctx) {
    if (state.selectedShapeIds.length > 0) {
        state.thicknessEdit.active = !state.thicknessEdit.active;
        if (state.thicknessEdit.active) {
            state.thicknessEdit.targetT = 0.0;
            state.thicknessEdit.editIndex = -1;
            const guide = getDom('#thickness-guide');
            if (guide) guide.classList.remove('hidden');

            if (state.patternEdit.active) {
                state.patternEdit.active = false;
                const patternGuide = getDom('#pattern-guide');
                if (patternGuide) patternGuide.classList.add('hidden');
            }
        } else {
            const guide = getDom('#thickness-guide');
            if (guide) guide.classList.add('hidden');
        }
        return { pushHistory: false, needsRender: true };
    }
    return { pushHistory: false, needsRender: false };
}

/**
 * Toggles border outline rendering style property.
 * @param {Object} ctx - Event context.
 * @returns {Object} Configuration settings {pushHistory, needsRender}.
 */
function handleToggleOutline(ctx) {
    if (state.selectedShapeIds.length > 0) {
        state.selectedShapeIds.forEach(id => {
            const shape = state.shapes[id];
            if (shape && shape.style) {
                shape.style.outline = !shape.style.outline;
                markShapeDirty(id);
            }
        });
        rasterizeInactiveLayers();
        return { pushHistory: true, needsRender: true };
    }
    return { pushHistory: false, needsRender: false };
}

/**
 * Toggles shape fill enabled style property.
 * @param {Object} ctx - Event context.
 * @returns {Object} Configuration settings {pushHistory, needsRender}.
 */
function handleToggleFillEnabled(ctx) {
    if (state.selectedShapeIds.length > 0) {
        state.selectedShapeIds.forEach(id => {
            const shape = state.shapes[id];
            if (shape && shape.style) {
                shape.style.fillEnabled = !shape.style.fillEnabled;
                markShapeDirty(id);
            }
        });
        rasterizeInactiveLayers();
        return { pushHistory: true, needsRender: true };
    }
    return { pushHistory: false, needsRender: false };
}

/**
 * Initiates the line thickness slide/add editor interaction.
 */
function handleWSlideThicknessStart() {
    if (state.selectedShapeIds.length === 0) return;
    const shapeId = state.selectedShapeIds[0];
    const shape = state.shapes[shapeId];
    if (!shape || !shape.strokeWidthData) return;

    const targetT = state.thicknessEdit.targetT;
    let closestIndex = -1;
    let minDiff = 0.05;
    shape.strokeWidthData.forEach((p, idx) => {
        const diff = Math.abs(p.t - targetT);
        if (diff <= minDiff) {
            minDiff = diff;
            closestIndex = idx;
        }
    });

    if (closestIndex >= 0) {
        state.thicknessEdit.editIndex = closestIndex;
    } else {
        const currentW = MDMath.getShapeThickness(shape, targetT);
        const newPoint = { t: targetT, w: currentW };
        shape.strokeWidthData.push(newPoint);
        shape.strokeWidthData.sort((a, b) => a.t - b.t);
        state.thicknessEdit.editIndex = shape.strokeWidthData.indexOf(newPoint);
        markShapeDirty(shapeId);
    }
}

/**
 * Initiates key-hold t parameter thickness data point slider.
 */
function handleTMoveThicknessStart() {
    if (state.selectedShapeIds.length === 0) return;
    const shapeId = state.selectedShapeIds[0];
    const shape = state.shapes[shapeId];
    if (!shape || !shape.strokeWidthData) return;

    const targetT = state.thicknessEdit.targetT;
    let closestIndex = -1;
    let minDiff = Infinity;
    shape.strokeWidthData.forEach((p, idx) => {
        if (p.t === 0 || p.t === 1) return;
        const diff = Math.abs(p.t - targetT);
        if (diff < minDiff) {
            minDiff = diff;
            closestIndex = idx;
        }
    });

    state.thicknessEdit.editIndex = closestIndex;
}

/**
 * Adjusts line thickness position value t dynamically via slider.
 * @param {Object} ctx - Event context.
 */
function handleTSlideThickness(ctx) {
    let nextT = state.thicknessEdit.targetT + ctx.dx * 0.005;
    if (nextT > 1) nextT -= 1;
    if (nextT < 0) nextT += 1;
    state.thicknessEdit.targetT = nextT;
}

/**
 * Mutates thickness width data point.
 * @param {Object} ctx - Event context.
 */
function handleWSlideThickness(ctx) {
    if (state.selectedShapeIds.length === 0) return;
    const shapeId = state.selectedShapeIds[0];
    const shape = state.shapes[shapeId];
    if (!shape || !shape.strokeWidthData) return;

    const editIndex = state.thicknessEdit.editIndex;
    if (editIndex >= 0 && editIndex < shape.strokeWidthData.length) {
        let w = shape.strokeWidthData[editIndex].w - ctx.dy * 0.2;
        w = Math.max(0.1, w);
        shape.strokeWidthData[editIndex].w = w;
        markShapeDirty(shapeId);
        resolveBezierDependencies();
    }
}

/**
 * Mutates thickness position value t.
 * @param {Object} ctx - Event context.
 */
function handleTMoveThickness(ctx) {
    if (state.selectedShapeIds.length === 0) return;
    const shapeId = state.selectedShapeIds[0];
    const shape = state.shapes[shapeId];
    if (!shape || !shape.strokeWidthData) return;

    const editIndex = state.thicknessEdit.editIndex;
    if (editIndex >= 0 && editIndex < shape.strokeWidthData.length) {
        const p = shape.strokeWidthData[editIndex];
        if (p.t === 0 || p.t === 1) return;

        let t = p.t + ctx.dx * 0.005;
        const minT = shape.strokeWidthData[editIndex - 1].t + 0.01;
        const maxT = shape.strokeWidthData[editIndex + 1].t - 0.01;
        t = Math.max(minT, Math.min(maxT, t));

        p.t = t;
        state.thicknessEdit.targetT = t;
        markShapeDirty(shapeId);
        resolveBezierDependencies();
    }
}

/**
 * Deletes closest thickness data node.
 * @param {Object} ctx - Event context.
 * @returns {Object} Action state results.
 */
function handleDeleteThicknessPoint(ctx) {
    if (state.selectedShapeIds.length === 0) return { pushHistory: false, needsRender: false };
    const shapeId = state.selectedShapeIds[0];
    const shape = state.shapes[shapeId];
    if (!shape || !shape.strokeWidthData) return { pushHistory: false, needsRender: false };

    const targetT = state.thicknessEdit.targetT;
    let closestIndex = -1;
    let minDiff = 0.05;
    shape.strokeWidthData.forEach((p, idx) => {
        if (p.t === 0 || p.t === 1) return;
        const diff = Math.abs(p.t - targetT);
        if (diff <= minDiff) {
            minDiff = diff;
            closestIndex = idx;
        }
    });

    if (closestIndex >= 0 && shape.strokeWidthData.length > 2) {
        shape.strokeWidthData.splice(closestIndex, 1);
        markShapeDirty(shapeId);
        resolveBezierDependencies();
        return { pushHistory: true, needsRender: true };
    }
    return { pushHistory: false, needsRender: false };
}

/**
 * Handles start event of transformation mode (move, scale, rotate, etc.).
 * @param {Object} ctx - Event context.
 */
function handleTransformStart(ctx) {
    const key = ctx.detail;
    const isShift = ctx.rawEvent ? ctx.rawEvent.shiftKey : false;

    let desiredMode = null;

    if (state.patternEdit.active) {
        if ((key === 't' || key === 'T') && isShift) {
            desiredMode = 't-move-pattern';
            handleTMovePatternStart();
        } else if (key === 't' || key === 'T') {
            desiredMode = 't-slide-pattern';
        }
    } else if (state.thicknessEdit.active) {
        if ((key === 't' || key === 'T') && isShift) {
            desiredMode = 't-move-thickness';
            handleTMoveThicknessStart();
        } else if (key === 't' || key === 'T') {
            desiredMode = 't-slide-thickness';
        } else if (key === 'w' || key === 'W') {
            desiredMode = 'w-slide-thickness';
            handleWSlideThicknessStart();
        }
    } else {
        const modeMap = { m: 'move', s: 'scale', r: 'rotate', t: 't-slide', d: 'd-dist' };
        desiredMode = modeMap[key] || null;
    }

    if (desiredMode && desiredMode !== state.interaction.mode) {
        const hasTarget = state.selectedShapeIds.length > 0 ||
            (state.focusedVertex && (desiredMode === 't-slide' || desiredMode === 'd-dist')) ||
            (state.thicknessEdit.active && (desiredMode === 't-slide-thickness' || desiredMode === 'w-slide-thickness' || desiredMode === 't-move-thickness')) ||
            (state.patternEdit.active && (desiredMode === 't-slide-pattern' || desiredMode === 't-move-pattern'));
        if (hasTarget) {
            state.dragInfo = {
                start: { ...state.input.pointerOnSVG },
                type: 'key-hold'
            };
            updateTransformPivotToCenter();
        }
        state.interaction.mode = desiredMode;
    }
}

/**
 * Handles end event of transformation mode (releasing hold key).
 * @param {Object} ctx - Event context.
 * @returns {Object} Action state settings.
 */
function handleTransformEnd(ctx) {
    const key = ctx.detail;
    let mappedMode = null;

    if (state.patternEdit.active) {
        if (key === 't' || key === 'T') {
            if (state.interaction.mode === 't-move-pattern' || state.interaction.mode === 't-slide-pattern') {
                mappedMode = state.interaction.mode;
            }
        }
    } else if (state.thicknessEdit.active) {
        if (key === 't' || key === 'T') {
            if (state.interaction.mode === 't-move-thickness' || state.interaction.mode === 't-slide-thickness') {
                mappedMode = state.interaction.mode;
            }
        } else if (key === 'w' || key === 'W') {
            mappedMode = 'w-slide-thickness';
        }
    } else {
        const modeMap = { t: 't-slide', d: 'd-dist' };
        mappedMode = modeMap[key];
    }

    if (mappedMode && mappedMode === state.interaction.mode) {
        state.interaction.mode = null;
        if (state.dragInfo) {
            state.dragInfo = null;
            rasterizeInactiveLayers();
            return { pushHistory: true, needsRender: true };
        }
    }
    return { pushHistory: false, needsRender: false };
}

/**
 * Handles pointerdown selection logic.
 * @param {Object} ctx - Event context.
 */
function handlePointerDownStart(ctx) {
    if (state.interaction.mode === null) {
        const hit = findShapeAt(state.input.dragStartOnSVG);
        state.lastHit = hit;
        if (hit) {
            if (!state.selectedShapeIds.includes(hit.shape.id)) {
                state.selectedShapeIds = [hit.shape.id];
                state.focusedVertex = null;
                updateTransformPivotToCenter();
            }
        }
    } else {
        state.dragInfo = {
            start: { ...state.input.dragStartOnSVG },
            type: 'drag'
        };
        updateTransformPivotToCenter();
    }
}

/**
 * Resets pointer drag details on pointerup.
 * @param {Object} ctx - Event context.
 * @returns {Object} Action state settings.
 */
function handlePointerUpEnd(ctx) {
    let needsRender = false;
    let pushHistory = false;

    if (state.interaction.mode) {
        pushHistory = true;
        needsRender = true;
    } else if (state.dragInfo && !state.lastHit) {
        state.selectedShapeIds = [];
        state.focusedVertex = null;
        updateTransformPivotToCenter();
        needsRender = true;
    }
    state.dragInfo = null;
    return { needsRender, pushHistory };
}

/**
 * Gets transform active shape list including anchors.
 * @returns {Array<string>}
 */
function getTransformTargetIds() {
    return Array.from(new Set([...state.selectedShapeIds, ...(state.anchoredShapeIds || [])]));
}

/**
 * Computes bounding centers and repositions pivot point dynamically.
 */
function updateTransformPivotToCenter() {
    const targetIds = getTransformTargetIds();
    const bounds = getCombinedBounds(targetIds);
    if (bounds) {
        state.transformPivot = { x: bounds.cx, y: bounds.cy };
    } else {
        state.transformPivot = null;
    }
}

/**
 * Mutates selected items coordinates (Move transformation).
 */
function handleMove() {
    const sVec = getMainCanvasSVGVector();
    transformShapes(getTransformTargetIds(), sVec.dx, sVec.dy, 0, 0, 1, 0);
}

/**
 * Mutates selected items scale (Scale transformation).
 */
function handleScale() {
    const sVec = getMainCanvasSVGVector();
    transformShapes(getTransformTargetIds(), 0, 0, state.transformPivot.x, state.transformPivot.y, 1 + sVec.dx * 0.01, 0);
}

/**
 * Mutates selected items rotation angle (Rotate transformation).
 */
function handleRotate() {
    const sVec = getMainCanvasSVGVector();
    transformShapes(getTransformTargetIds(), 0, 0, state.transformPivot.x, state.transformPivot.y, 1, (sVec.dx * 0.5) * Math.PI / 180);
}

/**
 * Drags and slides selected vertex connecting t value parameters.
 * @param {Object} ctx - Event context.
 */
function handleTSlide(ctx) {
    if (state.focusedVertex) {
        const { shapeId, vertexIdx } = state.focusedVertex;
        const shape = state.shapes[shapeId];
        if (shape && shape.bezierIds && shape.bezierIds.length > 0) {
            const N = shape.bezierIds.length;
            const vIdx = Math.floor((vertexIdx + 1) / 2) % N;
            const idx1 = (vIdx - 1 + N) % N;
            const idx2 = vIdx;

            const bid1 = shape.bezierIds[idx1];
            const bid2 = shape.bezierIds[idx2];
            const bez1 = state.beziers[bid1];
            const bez2 = state.beziers[bid2];

            if (bez1 && bez2 && bez1.generator && bez2.generator && bez1.generator.params && bez2.generator.params) {
                const param1 = bez1.generator.params.src2;
                const param2 = bez2.generator.params.src1;

                if (param1 && param2) {
                    param2.t += ctx.dx * 0.01;

                    const srcBezierId = param2.bezierId;
                    const srcShapeId = Object.keys(state.shapes).find(id => {
                        const s = state.shapes[id];
                        return s.bezierIds && s.bezierIds.includes(srcBezierId);
                    });

                    if (srcShapeId) {
                        const srcShape = state.shapes[srcShapeId];
                        const currentSrcIdx = srcShape.bezierIds.indexOf(srcBezierId);

                        if (currentSrcIdx >= 0) {
                            while (param2.t > 1) {
                                const nextIdx = (currentSrcIdx + 1) % srcShape.bezierIds.length;
                                param2.bezierId = srcShape.bezierIds[nextIdx];
                                param2.t -= 1;
                            }
                            while (param2.t < 0) {
                                const prevIdx = (currentSrcIdx - 1 + srcShape.bezierIds.length) % srcShape.bezierIds.length;
                                param2.bezierId = srcShape.bezierIds[prevIdx];
                                param2.t += 1;
                            }
                        }
                    }

                    param1.bezierId = param2.bezierId;
                    param1.t = param2.t;

                    resolveBezierDependencies();
                }
            }
        }
    }
}

/**
 * Adjusts tension control distance values d1/d2 on active vertex handle.
 * @param {Object} ctx - Event context.
 */
function handleDDist(ctx) {
    if (state.focusedVertex) {
        const { shapeId, vertexIdx } = state.focusedVertex;
        const shape = state.shapes[shapeId];
        if (shape && shape.bezierIds && shape.bezierIds.length > 0) {
            const bezierIdx = Math.floor(vertexIdx / 2) % shape.bezierIds.length;
            const bid = shape.bezierIds[bezierIdx];
            const bez = state.beziers[bid];
            if (bez && bez.generator && bez.generator.params) {
                const delta = ctx.dx * 0.1;
                if (vertexIdx % 2 === 0) {
                    bez.generator.params.d1 += delta;
                } else {
                    bez.generator.params.d2 += delta;
                }
                resolveBezierDependencies();
            }
        }
    }
}

/**
 * Handles zoom factor alterations.
 */
function handleZoom() {
    const zoomFactor = 1 - state.input.deltaY * 0.01;
    if (state.input.hoverOn === 'minimap-canvas') {
        state.minimap.zoom = Math.max(0.1, Math.min(10, state.minimap.zoom * zoomFactor));
    } else {
        const oldZoom = state.zoom;
        state.zoom = Math.max(0.1, Math.min(20, state.zoom * zoomFactor));
        const p = getMainCanvasSVGPoint();
        state.pan.x += p.x * (oldZoom - state.zoom);
        state.pan.y += p.y * (oldZoom - state.zoom);
    }
}

/**
 * Event-routing logic mapping inputs onto JSDoc triggers (legacy fallback).
 * @param {string} event - Event type string.
 * @param {*} detail - Target detail parameter.
 * @param {Event} rawEvent - Raw event instance.
 */
async function handleInputUpdate_old(event, detail, rawEvent) {
    let needsRender = false;
    let shouldPushHistory = false;

    const modifier = getModifierState(rawEvent);
    const ctx = {
        event,
        detail,
        rawEvent,
        dx: 0,
        dy: 0
    };

    if (event === 'keydown' || event === 'keyup') {
        let handlerGroup = keyHandlers[modifier]?.[detail];
        if (!handlerGroup && modifier === 'shift') {
            handlerGroup = keyHandlers['no_mod']?.[detail];
        }
        const rawConfigs = handlerGroup?.[event];
        if (rawConfigs) {
            const configs = Array.isArray(rawConfigs) ? rawConfigs : [rawConfigs];
            for (const config of configs) {
                const conditionMet = !config.cond || config.cond(ctx);
                if (conditionMet && config.f) {
                    if (rawEvent && typeof rawEvent.preventDefault === 'function') {
                        rawEvent.preventDefault();
                    }
                    const res = await config.f(ctx);
                    if (config.needsRender || (res && res.needsRender)) needsRender = true;
                    if (config.pushHistory || (res && res.pushHistory)) shouldPushHistory = true;
                    break;
                }
            }
        }
    } else {
        const mode = state.interaction.mode;

        if (event === 'pointerdown') {
            handlePointerDownStart(ctx);
            needsRender = true;
        } else if (event === 'pointermove') {
            if (state.dragInfo) {
                const pt = state.input.pointerOnSVG;
                ctx.dx = pt.x - state.dragInfo.start.x;
                ctx.dy = pt.y - state.dragInfo.start.y;

                if (ctx.dx !== 0 || ctx.dy !== 0) {
                    const config = modeHandlers[mode]?.pointermove;
                    if (config && config.f) {
                        await config.f(ctx);
                        state.dragInfo.start = { ...pt };
                        if (config.needsRender) needsRender = true;
                        if (config.pushHistory) shouldPushHistory = true;
                    }
                }
            }
        } else if (event === 'pointerup') {
            const res = handlePointerUpEnd(ctx);
            if (res.needsRender) needsRender = true;
            if (res.pushHistory) shouldPushHistory = true;
        }
    }

    if (shouldPushHistory) {
        pushHistory();
    }
    if (needsRender) {
        renderCanvas();
    }
}

/**
 * Core event action dispatcher updating system configurations on interactions.
 * @param {Event} event - Raw pointer, key or wheel event.
 */
async function handleInputUpdate(event) {
    const viewKey = `view_${state.view}`;

    let interaction;
    if (event.type === 'wheel' && state.input.modifier === 'ctrl') {
        interaction = interactionMap[viewKey]?.ctrl_wheel;
    }

    const clickMap = interactionMap[viewKey]?.click_selector;
    if (event.type === 'click' && clickMap) {
        for (const selector in clickMap) {
            const matchedEl = event.target.closest(selector);
            if (matchedEl) {
                interaction = clickMap[selector];
                event.preventDefault();
                event.stopPropagation();
                break;
            }
        }
    }

    const movePressMap = interactionMap[viewKey]?.pointermove_while_key_press;
    if (event.type === 'pointermove' && movePressMap) {
        for (const key in movePressMap) {
            if (state.input.keys[key] || state.input.keys[key.toUpperCase()]) {
                interaction = movePressMap[key];
                break;
            }
        }
    }

    if (event.type === 'keydown' && movePressMap && movePressMap[event.key]) {
        updateTransformPivotToCenter();
    }

    if (event.type === 'keyup' && movePressMap) {
        const key = event.key.toLowerCase();
        const config = movePressMap[key] || movePressMap[key.toUpperCase()];
        if (config && typeof config.keyup === 'function') {
            config.keyup();
        }
        if (state.pushHistoryOnKeyUp) {
            state.pushHistoryOnKeyUp = false;
            pushHistory();
        }
    }

    if (interaction && typeof interaction.f === 'function') {
        await interaction.f();
    }
    if (interaction?.pushHistory) {
        pushHistory();
    }
    if (interaction?.needsRender) {
        renderCanvas();
    }
    if (interaction?.pushHistoryOnKeyUp) {
        state.pushHistoryOnKeyUp = true;
    }
}

/**
 * Toggles display status of active helper modal layouts.
 */
function toggleHelpModal() {
    const panel = getDom('#settings-panel');
    if (!panel) return;
    const isCollapsed = panel.classList.contains('collapsed');

    if (isCollapsed) {
        panel.classList.remove('collapsed');
        switchSettingsTab('help');
    } else {
        const activeTab = getDomOf(panel, '.settings-tab-btn.active');
        if (activeTab && activeTab.getAttribute('data-tab') !== 'help') {
            switchSettingsTab('help');
        } else {
            panel.classList.add('collapsed');
        }
    }
}

/**
 * Switches tab content panels within the settings drawer view.
 * @param {string} tabName - Target tab identifier.
 */
function switchSettingsTab(tabName) {
    const tabs = getDoms('.settings-tab-btn');
    const contents = getDoms('.settings-tab-content');

    tabs.forEach(btn => {
        if (btn.getAttribute('data-tab') === tabName) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    contents.forEach(content => {
        if (content.id === `tab-${tabName}`) {
            content.classList.add('active');
        } else {
            content.classList.remove('active');
        }
    });
}

/**
 * Locates closest sample point on visible canvas geometries to a click position.
 * @param {Object} pt - The target mouse/click coordinate {x, y}.
 * @returns {Object|null} Nearest vertex record details or null.
 */
function findClosestSamplePoint(pt) {
    const visibleShapeIds = new Set();
    state.scene.forEach(layerId => {
        const layer = state.shapes[layerId];
        if (layer && layer.type === 'layer' && layer.visible !== false) {
            layer.childIds?.forEach(id => visibleShapeIds.add(id));
        }
    });

    let closest = null, minD = 25;
    for (const [sid, shape] of Object.entries(state.shapes)) {
        if (!shape.bezierIds) continue;
        if (!visibleShapeIds.has(sid)) continue;

        shape.bezierIds.forEach(bid => {
            const b = state.beziers[bid];
            if (!b) return;
            Object.entries(b.samplePointByT).forEach(([tStr, p]) => {
                const d = Math.hypot(p.x - pt.x, p.y - pt.y);
                if (d < minD) { minD = d; closest = { shapeId: sid, bezierId: bid, t: parseFloat(tStr), pt: p }; }
            });
        });
    }
    return closest;
}

/**
 * Finds shape element positioned at target click coordinate.
 * @param {Object} pt - Bounding click coordinate {x, y}.
 * @returns {Object|null} Matching shape wrapper record or null.
 */
function findShapeAt(pt) {
    const h = findClosestSamplePoint(pt);
    if (!h) return null;
    const shapeId = Object.keys(state.shapes).find(id => state.shapes[id].bezierIds?.includes(h.bezierId));
    return shapeId ? { shape: state.shapes[shapeId], child: null } : null;
}

/**
 * Triggers focused vertex delete sequences.
 */
function deleteSelectedVertex() {
    if (!state.focusedVertex) return;
    const { shapeId, vertexIdx } = state.focusedVertex;
    deleteVertex(shapeId, vertexIdx);
}

/**
 * Removes selected shapes from active layers and deletes their beziers references.
 */
function deleteSelectedShapes() {
    state.scene.forEach(layerId => {
        const layer = state.shapes[layerId];
        if (layer && layer.type === 'layer') {
            layer.childIds = layer.childIds.filter(id => !state.selectedShapeIds.includes(id));
        }
    });

    state.selectedShapeIds.forEach(shapeId => {
        const shape = state.shapes[shapeId];
        if (shape) {
            shape.bezierIds?.forEach(bid => delete state.beziers[bid]);
            delete state.shapes[shapeId];
        }
    });

    state.selectedShapeIds = [];
    state.focusedVertex = null;
}

/**
 * Confirms vertex insertion sequences on active shape.
 * @returns {Object} Configuration settings {pushHistory, needsRender}.
 */
function handleEnterAction() {
    if (state.insertVertexPending) {
        const pending = state.insertVertexPending;
        state.insertVertexPending = null;
        const targetShapeId = state.selectedShapeIds[0];
        if (targetShapeId && targetShapeId !== pending.shapeId) {
            insertVertex(pending.shapeId, pending.vertexIdx, targetShapeId);
            return { pushHistory: true, needsRender: true };
        }
    }
    return { pushHistory: false, needsRender: false };
}

/**
 * Inserts a connector vertex node splitting the wrap shape boundary bezier.
 * @param {string} wrapShapeId - Bounding wrap shape ID.
 * @param {number} vertexIdx - Target vertex index splitting.
 * @param {string} targetShapeId - Inner target shape connector.
 */
function insertVertex(wrapShapeId, vertexIdx, targetShapeId) {
    const wrapShape = state.shapes[wrapShapeId];
    const targetShape = state.shapes[targetShapeId];
    if (!wrapShape || !targetShape || !targetShape.bezierIds || targetShape.bezierIds.length === 0) return;

    const N = wrapShape.bezierIds.length;
    const bezierIdx = Math.floor(vertexIdx / 2) % N;
    const bidAB = wrapShape.bezierIds[bezierIdx];
    const bezAB = state.beziers[bidAB];
    if (!bezAB) return;

    const bidAC = generateId('b');
    const bidCB = generateId('b');

    state.beziers[bidAC] = {
        id: bidAC,
        generator: {
            type: 'connector',
            params: {
                src1: { ...bezAB.generator.params.src1 },
                src2: { bezierId: targetShape.bezierIds[0], t: 0 },
                d1: bezAB.generator.params.d1,
                d2: 0.1
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };

    state.beziers[bidCB] = {
        id: bidCB,
        generator: {
            type: 'connector',
            params: {
                src1: { bezierId: targetShape.bezierIds[0], t: 0 },
                src2: { ...bezAB.generator.params.src2 },
                d1: 0.1,
                d2: bezAB.generator.params.d2
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };

    delete state.beziers[bidAB];
    wrapShape.bezierIds.splice(bezierIdx, 1, bidAC, bidCB);

    state.focusedVertex = {
        shapeId: wrapShapeId,
        vertexIdx: bezierIdx * 2 + 1
    };

    resolveBezierDependencies();
}

/**
 * Removes connector vertex node merging neighboring beziers inside wrap shape.
 * @param {string} wrapShapeId - Bounding wrap shape ID.
 * @param {number} vertexIdx - Target vertex index to merge.
 */
function deleteVertex(wrapShapeId, vertexIdx) {
    const shape = state.shapes[wrapShapeId];
    if (!shape || !shape.bezierIds || shape.bezierIds.length <= 3) return;

    const N = shape.bezierIds.length;
    const vIdx = Math.floor((vertexIdx + 1) / 2) % N;

    const idx1 = (vIdx - 1 + N) % N;
    const idx2 = vIdx;

    const bidDA = shape.bezierIds[idx1];
    const bidAE = shape.bezierIds[idx2];
    const bezDA = state.beziers[bidDA];
    const bezAE = state.beziers[bidAE];

    if (!bezDA || !bezAE) return;

    const bidDE = generateId('b');
    state.beziers[bidDE] = {
        id: bidDE,
        generator: {
            type: 'connector',
            params: {
                src1: { ...bezDA.generator.params.src1 },
                src2: { ...bezAE.generator.params.src2 },
                d1: bezDA.generator.params.d1,
                d2: bezAE.generator.params.d2
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };

    delete state.beziers[bidDA];
    delete state.beziers[bidAE];

    if (idx1 < idx2) {
        shape.bezierIds.splice(idx1, 2, bidDE);
    } else {
        shape.bezierIds.splice(idx2, 1);
        const newIdx1 = shape.bezierIds.indexOf(bidDA);
        shape.bezierIds.splice(newIdx1, 1, bidDE);
    }

    const newIdx = shape.bezierIds.indexOf(bidDE);
    state.focusedVertex = {
        shapeId: wrapShapeId,
        vertexIdx: newIdx * 2
    };

    resolveBezierDependencies();
}

/**
 * Computes control points, coordinates lookup caches and bounding box boundaries for a bezier.
 * @param {string} id - Bezier ID to recalculate.
 */
function updateBezier(id) {
    const bez = state.beziers[id];
    if (!bez || !bez.generator) return;

    const generatorFunc = MDMath.generators[bez.generator.type];
    if (generatorFunc) {
        if (bez.generator.type === 'arc') {
            const parentShape = state.shapes[bez.generator.params.s];
            const props = parentShape?.props || { x: 0, y: 0, r: 50, a: 0 };
            const resolvedParams = {
                x: props.x,
                y: props.y,
                r: props.r !== undefined ? props.r : 50,
                a: props.a !== undefined ? props.a : 0,
                i: bez.generator.params.i || 0
            };
            bez.controlPoints = generatorFunc(resolvedParams);
        } else {
            bez.controlPoints = generatorFunc(state, bez.generator.params);
        }
    }

    if (!bez.controlPoints || bez.controlPoints.length < 4) return;

    bez.samplePointByT = {};
    const sample = (t1, t2) => {
        const p1 = MDMath.getPoint(bez, t1), p2 = MDMath.getPoint(bez, t2);
        if (Math.hypot(p1.x - p2.x, p1.y - p2.y) > state.lodPrecision) {
            const mid = (t1 + t2) / 2;
            sample(t1, mid);
            sample(mid, t2);
        } else {
            bez.samplePointByT[t2] = p2;
        }
    };
    bez.samplePointByT[0] = MDMath.getPoint(bez, 0);
    sample(0, 1);

    const pts = Object.values(bez.samplePointByT);
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    bez.boundingBox = {
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys)
    };

    Object.values(state.shapes).forEach(shape => {
        if (shape.bezierIds && shape.bezierIds.includes(id)) {
            markShapeDirty(shape.id);
        }
    });
}

/**
 * Loops and resolves dependent connector beziers ordering, matching endpoints coordinates.
 */
function resolveBezierDependencies() {
    Object.values(state.shapes).forEach(shape => {
        if (shape && shape.name && shape.name.startsWith('wrap') && shape.bezierIds && shape.bezierIds.length > 0) {
            const N = shape.bezierIds.length;
            for (let i = 0; i < N; i++) {
                const bid1 = shape.bezierIds[(i - 1 + N) % N];
                const bid2 = shape.bezierIds[i];
                if (bid1 === bid2) continue;
                const bez1 = state.beziers[bid1];
                const bez2 = state.beziers[bid2];
                if (bez1 && bez2 && bez1.generator && bez2.generator && bez1.generator.params && bez2.generator.params) {
                    const param1 = bez1.generator.params.src2;
                    const param2 = bez2.generator.params.src1;
                    if (param1 && param2) {
                        if (param1.bezierId !== param2.bezierId || param1.t !== param2.t) {
                            param1.bezierId = param2.bezierId;
                            param1.t = param2.t;
                        }
                    }
                }
            }
        }
    });

    const visited = new Set(), visiting = new Set(), sorted = [];
    const visit = (id) => {
        if (visited.has(id)) return;
        if (visiting.has(id)) return;
        visiting.add(id);
        const b = state.beziers[id];
        if (!b) return;
        if (b.generator && b.generator.params) {
            const { src1, src2 } = b.generator.params;
            if (src1 && src1.bezierId) visit(src1.bezierId);
            if (src2 && src2.bezierId) visit(src2.bezierId);
        }
        visiting.delete(id);
        visited.add(id); sorted.push(id);
    };
    Object.keys(state.beziers).forEach(visit);
    sorted.forEach(updateBezier);
}

/**
 * Calculates combined bounding box boundaries for listed shapes.
 * @param {Array<string>} shapeIds - Shape IDs collection.
 * @returns {Object|null} Bounding box details or null.
 */
function getCombinedBounds(shapeIds) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let hasValid = false;

    shapeIds.forEach(id => {
        const shape = state.shapes[id];
        if (!shape || !shape.bezierIds) return;
        shape.bezierIds.forEach(bid => {
            const bez = state.beziers[bid];
            if (bez && bez.boundingBox && bez.boundingBox.w !== undefined) {
                const box = bez.boundingBox;
                minX = Math.min(minX, box.x);
                maxX = Math.max(maxX, box.x + box.w);
                minY = Math.min(minY, box.y);
                maxY = Math.max(maxY, box.y + box.h);
                hasValid = true;
            }
        });
    });

    if (!hasValid) return null;
    return {
        x: minX,
        y: minY,
        w: maxX - minX,
        h: maxY - minY,
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2
    };
}

/**
 * Translates, rotates or scales multiple shape positions in editor view.
 * @param {Array<string>} shapeIds - Target shape IDs list.
 * @param {number} dx - Translate delta x.
 * @param {number} dy - Translate delta y.
 * @param {number} cx - Transformation pivot center x.
 * @param {number} cy - Transformation pivot center y.
 * @param {number} factor - Scale factor multiplier.
 * @param {number} angleRad - Rotation angle in radians.
 */
function transformShapes(shapeIds, dx, dy, cx, cy, factor, angleRad) {
    if (!shapeIds || shapeIds.length === 0) return;
    shapeIds.forEach(id => {
        const shape = state.shapes[id];
        if (shape && shape.bezierIds) {
            if (shape.props) {
                MDMath.transformCircle(shape.props, cx, cy, angleRad, factor);
                shape.props.x += dx;
                shape.props.y += dy;
            }
            markShapeDirty(id);
        }
    });
    resolveBezierDependencies();
}

/**
 * Instantiates new shapes (e.g., circles) under active layer workspace.
 * @param {string} type - Shape descriptor tag (e.g., 'circle').
 * @param {number} x - Target center x coordinate.
 * @param {number} y - Target center y coordinate.
 */
function addShapeAt(type, x, y) {
    const id = generateId('s');
    const bIds = [], r = 50;
    if (type === 'circle') {
        for (let i = 0; i < 4; i++) {
            const bId = generateId('b');
            state.beziers[bId] = {
                id: bId,
                generator: {
                    type: 'arc',
                    params: { s: id, i }
                },
                controlPoints: [], samplePointByT: {}, boundingBox: {}
            };
            bIds.push(bId);
        }
    }
    const count = Object.values(state.shapes).filter(s => s.name && s.name.startsWith(type)).length + 1;
    const shape = {
        id, type: 'bezier-group', name: `${type} ${count}`, bezierIds: bIds, props: { x, y, r: type === 'circle' ? r : undefined, a: type === 'circle' ? 0 : undefined },
        style: { fill: '#2196F3', opacity: 0.7, outline: true, fillEnabled: true },
        strokeWidthData: [{ t: 0, w: 10 }, { t: 1, w: 10 }],
        childIds: []
    };
    state.shapes[id] = shape;

    if (state.selectedLayerId && state.shapes[state.selectedLayerId]) {
        state.shapes[state.selectedLayerId].childIds.push(id);
    } else {
        const firstLayerId = state.scene[0];
        if (firstLayerId && state.shapes[firstLayerId]) {
            state.shapes[firstLayerId].childIds.push(id);
        }
    }

    resolveBezierDependencies();
    pushHistory();
    renderCanvas();
}

/**
 * Automatically creates wrap boundary shapes connecting multiple anchored or selected items.
 */
function createWrap() {
    const targets = Array.from(new Set([...state.anchoredShapeIds, ...state.selectedShapeIds]));
    if (targets.length < 2) {
        return;
    }
    const [id1, id2] = targets;
    const shape1 = state.shapes[id1], shape2 = state.shapes[id2];
    if (!shape1 || !shape2) return;

    const src1_up_bezier = shape1.bezierIds[0];
    const src1_down_bezier = shape1.bezierIds[Math.min(2, shape1.bezierIds.length - 1)];
    const src2_up_bezier = shape2.bezierIds[0];
    const src2_down_bezier = shape2.bezierIds[Math.min(2, shape2.bezierIds.length - 1)];

    const wrapId = generateId('s');
    const bIds = [];

    const bId1 = generateId('b');
    state.beziers[bId1] = {
        id: bId1,
        generator: {
            type: 'connector',
            params: {
                src1: { bezierId: src1_up_bezier, t: 0 },
                src2: { bezierId: src2_up_bezier, t: 0 },
                d1: 0.1, d2: 0.1
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId1);

    const bId2 = generateId('b');
    state.beziers[bId2] = {
        id: bId2,
        generator: {
            type: 'connector',
            params: {
                src1: { bezierId: src2_up_bezier, t: 0 },
                src2: { bezierId: src2_down_bezier, t: 0 },
                d1: 0.1, d2: 0.1
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId2);

    const bId3 = generateId('b');
    state.beziers[bId3] = {
        id: bId3,
        generator: {
            type: 'connector',
            params: {
                src1: { bezierId: src2_down_bezier, t: 0 },
                src2: { bezierId: src1_down_bezier, t: 0 },
                d1: 0.1, d2: 0.1
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId3);

    const bId4 = generateId('b');
    state.beziers[bId4] = {
        id: bId4,
        generator: {
            type: 'connector',
            params: {
                src1: { bezierId: src1_down_bezier, t: 0 },
                src2: { bezierId: src1_up_bezier, t: 0 },
                d1: 0.1, d2: 0.1
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId4);

    const wrapCount = Object.values(state.shapes).filter(s => s.name && s.name.startsWith('wrap')).length + 1;
    const wrapShape = {
        id: wrapId,
        type: 'bezier-group',
        name: `wrap ${wrapCount}`,
        bezierIds: bIds,
        props: { x: 0, y: 0 },
        style: { fill: '#2196F3', opacity: 0.5, outline: true, fillEnabled: true },
        strokeWidthData: [{ t: 0, w: 10 }, { t: 1, w: 10 }],
        childIds: []
    };
    state.shapes[wrapId] = wrapShape;

    if (state.selectedLayerId && state.shapes[state.selectedLayerId]) {
        state.shapes[state.selectedLayerId].childIds.push(wrapId);
    } else {
        const firstLayerId = state.scene[0];
        if (firstLayerId && state.shapes[firstLayerId]) {
            state.shapes[firstLayerId].childIds.push(wrapId);
        }
    }

    resolveBezierDependencies();
    pushHistory();
    renderCanvas();
}

/**
 * Computes shortest cyclic parameter distance on shape boundaries.
 * @param {number} tA - Start t parameter.
 * @param {number} tB - End t parameter.
 * @returns {number} Distance.
 */
function getParamDistance(tA, tB) {
    const diff = Math.abs(tA - tB);
    return Math.min(diff, 1.0 - diff);
}

/**
 * Toggles pattern layout editor.
 * @param {Object} ctx - Event context.
 * @returns {Object} Configuration settings.
 */
function handleTogglePatternEdit(ctx) {
    if (state.selectedShapeIds.length > 0) {
        const shapeId = state.selectedShapeIds[0];
        const shape = state.shapes[shapeId];
        if (!shape || !shape.bezierIds || !shape.style || !shape.style.fillPattern) {
            return { pushHistory: false, needsRender: false };
        }

        state.patternEdit.active = !state.patternEdit.active;
        if (state.patternEdit.active) {
            state.patternEdit.targetT = 0.0;
            if (state.thicknessEdit.active) {
                state.thicknessEdit.active = false;
                const thicknessGuide = getDom('#thickness-guide');
                if (thicknessGuide) thicknessGuide.classList.add('hidden');
            }

            if (!shape.patternCorners) {
                initPatternCorners(shape);
            }

            let closestCorner = 'TL';
            let minDist = Infinity;
            ['TL', 'TR', 'BR', 'BL'].forEach(key => {
                const tCorner = shape.patternCorners[key];
                if (tCorner !== undefined) {
                    const dist = getParamDistance(0.0, tCorner);
                    if (dist < minDist) {
                        minDist = dist;
                        closestCorner = key;
                    }
                }
            });
            state.patternEdit.selectedCorner = closestCorner;

            const guide = getDom('#pattern-guide');
            if (guide) guide.classList.remove('hidden');
        } else {
            const guide = getDom('#pattern-guide');
            if (guide) guide.classList.add('hidden');
        }
        return { pushHistory: false, needsRender: true };
    }
    return { pushHistory: false, needsRender: false };
}

/**
 * Slides active target pattern corner positions.
 * @param {Object} ctx - Event context.
 */
function handleTSlidePattern(ctx) {
    let nextT = state.patternEdit.targetT + ctx.dx * 0.005;
    nextT = ((nextT % 1) + 1) % 1;
    state.patternEdit.targetT = nextT;

    if (state.selectedShapeIds.length > 0) {
        const shapeId = state.selectedShapeIds[0];
        const shape = state.shapes[shapeId];
        if (shape && shape.patternCorners) {
            let closestCorner = 'TL';
            let minDist = Infinity;
            ['TL', 'TR', 'BR', 'BL'].forEach(key => {
                const tCorner = shape.patternCorners[key];
                if (tCorner !== undefined) {
                    const dist = getParamDistance(nextT, tCorner);
                    if (dist < minDist) {
                        minDist = dist;
                        closestCorner = key;
                    }
                }
            });
            state.patternEdit.selectedCorner = closestCorner;
        }
    }
}

/**
 * Initiates target corner relocation movements.
 */
function handleTMovePatternStart() {
    if (state.selectedShapeIds.length === 0) return;
    const shapeId = state.selectedShapeIds[0];
    const shape = state.shapes[shapeId];
    if (!shape || !shape.patternCorners) return;

    const targetT = state.patternEdit.targetT;
    let closestCorner = 'TL';
    let minDist = Infinity;
    ['TL', 'TR', 'BR', 'BL'].forEach(key => {
        const tCorner = shape.patternCorners[key];
        if (tCorner !== undefined) {
            const dist = getParamDistance(targetT, tCorner);
            if (dist < minDist) {
                minDist = dist;
                closestCorner = key;
            }
        }
    });
    state.patternEdit.selectedCorner = closestCorner;
}

/**
 * Mutates selected pattern corner position parameter.
 * @param {Object} ctx - Event context.
 */
function handleTMovePattern(ctx) {
    if (state.selectedShapeIds.length === 0) return;
    const shapeId = state.selectedShapeIds[0];
    const shape = state.shapes[shapeId];
    if (!shape || !shape.patternCorners) return;

    const key = state.patternEdit.selectedCorner;
    if (!key) return;

    let t = shape.patternCorners[key] + ctx.dx * 0.005;
    t = ((t % 1) + 1) % 1;
    shape.patternCorners[key] = t;
    state.patternEdit.targetT = t;
    markShapeDirty(shapeId);
    resolveBezierDependencies();
}

/**
 * Triggers command mode interface panel.
 */
function openCommandMode() {
    state.command.active = true;
    const bar = getDom('#command-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    const input = getDom('#command-input');
    input.value = '';
    input.focus();
}

/**
 * Confirms or aborts active command configurations.
 * @param {boolean} [confirm=true] - Action validation flag.
 */
function closeCommandMode(confirm = true) {
    state.command.active = false;
    const bar = getDom('#command-bar');
    if (bar) bar.classList.add('hidden');

    const input = getDom('#command-input');
    if (input) {
        if (confirm) {
            executeCommand(input.value);
        }
        input.blur();
    }
}

/**
 * Keyboard trigger handler opening command input mode.
 * @param {Object} ctx - Event context.
 * @returns {Object} Action state results.
 */
function handleOpenCommand(ctx) {
    if (isFocusEditable()) return { needsRender: false };
    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
    openCommandMode();
    return { needsRender: false };
}

/**
 * Processes terminal command parameters (e.g. fillpattern or strokepattern).
 * @param {string} cmdStr - Command query details.
 */
function executeCommand(cmdStr) {
    const parts = cmdStr.trim().split(/\s+/);
    if (parts.length === 0) return;
    const command = parts[0];
    if (command === 'fillpattern') {
        const patternName = parts[1];
        if (!patternName || patternName === 'none' || patternName === 'clear') {
            if (state.selectedShapeIds.length > 0) {
                state.selectedShapeIds.forEach(shapeId => {
                    const shape = state.shapes[shapeId];
                    if (shape) {
                        if (shape.style) {
                            delete shape.style.fillPattern;
                            markShapeDirty(shapeId);
                        }
                    }
                });
                rasterizeInactiveLayers();
                renderCanvas();
                pushHistory();
            }
        } else {
            loadDrawingTexture(patternName).then(texture => {
                if (!texture) {
                    console.warn(`Could not load pattern texture for ID "${patternName}"`);
                    return;
                }
                if (state.selectedShapeIds.length > 0) {
                    state.selectedShapeIds.forEach(shapeId => {
                        const shape = state.shapes[shapeId];
                        if (shape && shape.bezierIds) {
                            if (!shape.style) shape.style = {};
                            shape.style.fillPattern = patternName;
                            initPatternCorners(shape);
                            markShapeDirty(shapeId);
                        }
                    });
                    rasterizeInactiveLayers();
                    renderCanvas();
                    pushHistory();
                }
            });
        }
    } else if (command === 'strokepattern') {
        const patternName = parts[1];
        if (!patternName || patternName === 'none' || patternName === 'clear') {
            if (state.selectedShapeIds.length > 0) {
                state.selectedShapeIds.forEach(shapeId => {
                    const shape = state.shapes[shapeId];
                    if (shape) {
                        if (shape.style) {
                            delete shape.style.strokePattern;
                            markShapeDirty(shapeId);
                        }
                    }
                });
                rasterizeInactiveLayers();
                renderCanvas();
                pushHistory();
            }
        } else {
            loadDrawingTexture(patternName).then(texture => {
                if (!texture) {
                    console.warn(`Could not load stroke pattern texture for ID "${patternName}"`);
                    return;
                }
                if (state.selectedShapeIds.length > 0) {
                    state.selectedShapeIds.forEach(shapeId => {
                        const shape = state.shapes[shapeId];
                        if (shape && shape.bezierIds) {
                            if (!shape.style) shape.style = {};
                            shape.style.strokePattern = patternName;
                            markShapeDirty(shapeId);
                        }
                    });
                    rasterizeInactiveLayers();
                    renderCanvas();
                    pushHistory();
                }
            });
        }
    }
}

/**
 * Triggers search entry bar.
 */
function openSearchMode() {
    state.search.active = true;
    const bar = getDom('#search-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    const input = getDom('#search-input');
    input.value = '';
    input.focus();
    state.search.results = [];
    state.search.currentIndex = -1;
}

/**
 * Closes search input mode.
 * @param {boolean} [confirm=true] - Action validation flag.
 */
function closeSearchMode(confirm = true) {
    state.search.active = false;
    const bar = getDom('#search-bar');
    if (bar) bar.classList.add('hidden');

    const input = getDom('#search-input');
    if (input) input.blur();
}

/**
 * Filters database shapes and layers matching search parameters.
 * @param {string} query - Target search pattern.
 */
function performSearch(query) {
    const q = query.toLowerCase().trim();
    if (!q) {
        state.search.results = [];
        state.search.currentIndex = -1;
        return;
    }

    const results = [];

    state.scene.forEach(layerId => {
        const layer = state.shapes[layerId];
        if (!layer || layer.type !== 'layer') return;

        if (layer.name.toLowerCase().includes(q)) {
            results.push({
                type: 'layer',
                id: layerId,
                name: layer.name,
                dispName: `レイヤー: ${layer.name}`
            });
        }

        layer.childIds.forEach(shapeId => {
            const shape = state.shapes[shapeId];
            if (!shape) return;

            let matches = false;
            let shapeName = shape.name || shape.type;

            if (shape.id.toLowerCase().includes(q) ||
                shape.type.toLowerCase().includes(q) ||
                (shape.name && shape.name.toLowerCase().includes(q))) {
                matches = true;
            }

            if (shape.bezierIds) {
                const generators = shape.bezierIds.map(bid => state.beziers[bid]?.generator?.type).filter(Boolean);
                if (generators.some(gen => gen.toLowerCase().includes(q))) {
                    matches = true;
                }
            }

            if (matches) {
                results.push({
                    type: 'shape',
                    id: shapeId,
                    layerId: layerId,
                    name: shapeName,
                    dispName: `図形 (${shapeName}): ${shapeId.substring(0, 8)}`
                });
            }
        });
    });

    state.search.results = results;
    if (results.length > 0) {
        state.search.currentIndex = 0;
    } else {
        state.search.currentIndex = -1;
    }
}

/**
 * Focuses active selections onto highlighted search match.
 */
function applySearchResult() {
    const results = state.search.results;
    const index = state.search.currentIndex;
    if (index < 0 || index >= results.length) return;

    state.focusedVertex = null;
    const current = results[index];
    if (current.type === 'layer') {
        state.selectedLayerId = current.id;
        state.selectedShapeIds = [];
    } else if (current.type === 'shape') {
        state.selectedLayerId = current.layerId;
        state.selectedShapeIds = [current.id];
    }
    renderCanvas();
}

/**
 * Handles converting the raw draft strokes on the canvas into structural polyline shapes when pressing 'p'.
 * @param {Object} ctx - Event context.
 */
function handleConvertRasterToPolyline(ctx) {
    if (!state.draftStrokes || state.draftStrokes.length === 0) {
        if (state.currentDraftStroke && state.currentDraftStroke.length > 2) {
            if (!state.draftStrokes) state.draftStrokes = [];
            state.draftStrokes.push(state.currentDraftStroke);
            state.currentDraftStroke = null;
        }
    }
    if (!state.draftStrokes || state.draftStrokes.length === 0) return;

    let splitSegments = [];
    state.draftStrokes.forEach(stroke => {
        const segs = splitStrokeByCorners(stroke);
        splitSegments.push(...segs);
    });

    const groups = groupSegments(splitSegments, 35, 45);

    let count = 0;

    groups.forEach(group => {
        let avgPath = averageSegmentGroup(group);
        if (avgPath.length < 2) return;

        const startPt = avgPath[0];
        const endPt = avgPath[avgPath.length - 1];
        const gap = Math.hypot(startPt.x - endPt.x, startPt.y - endPt.y);
        const isClosed = gap < 45 && avgPath.length > 8;

        if (isClosed) {
            avgPath.push({ x: startPt.x, y: startPt.y });
        }

        const id = generateId('s');
        const shapeName = `polyline ${Object.values(state.shapes).filter(s => s.type === 'polyline').length + 1}`;
        const shape = {
            id,
            type: 'polyline',
            name: shapeName,
            points: avgPath,
            isClosed: isClosed,
            style: {
                fill: '#10b981',
                opacity: 0.7,
                outline: true,
                fillEnabled: isClosed
            },
            childIds: []
        };

        state.shapes[id] = shape;

        if (state.selectedLayerId && state.shapes[state.selectedLayerId]) {
            state.shapes[state.selectedLayerId].childIds.push(id);
        } else {
            const firstLayerId = state.scene[0];
            if (firstLayerId && state.shapes[firstLayerId]) {
                state.shapes[firstLayerId].childIds.push(id);
            }
        }
        count++;
    });

    if (count > 0) {
        console.log("変換しました");
    }

    state.draftStrokes = [];
    state.currentDraftStroke = null;

    if (state.canvas.draftOffscreen) {
        const draftCtx = state.canvas.draftOffscreen.getContext('2d');
        draftCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
    }
}

/**
 * Splits a stroke into segments at sharp curvature points.
 * @param {Array<{x:number, y:number}>} stroke - Sequence of points.
 * @returns {Array<Array<{x:number, y:number}>>}
 */
function splitStrokeByCorners(stroke) {
    if (stroke.length < 6) return [stroke];
    const segments = [];
    let currentSegment = [stroke[0], stroke[1]];

    const lookAhead = 3;
    for (let i = 2; i < stroke.length - lookAhead; i++) {
        const dx1 = stroke[i].x - stroke[i-2].x;
        const dy1 = stroke[i].y - stroke[i-2].y;
        const len1 = Math.hypot(dx1, dy1);

        const dx2 = stroke[i+lookAhead].x - stroke[i].x;
        const dy2 = stroke[i+lookAhead].y - stroke[i].y;
        const len2 = Math.hypot(dx2, dy2);

        if (len1 > 1.5 && len2 > 1.5) {
            const cosTheta = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
            if (cosTheta < 0.6) {
                currentSegment.push(stroke[i]);
                segments.push(currentSegment);
                currentSegment = [stroke[i]];
                i += lookAhead;
            }
        }
        currentSegment.push(stroke[i]);
    }
    for (let i = stroke.length - lookAhead; i < stroke.length; i++) {
        if (i >= 0 && !currentSegment.includes(stroke[i])) {
            currentSegment.push(stroke[i]);
        }
    }
    if (currentSegment.length > 1) {
        segments.push(currentSegment);
    }
    return segments.filter(s => s.length >= 2);
}

/**
 * Calculates the minimum distance between two segments.
 * @param {Array<{x:number, y:number}>} seg1 - First segment.
 * @param {Array<{x:number, y:number}>} seg2 - Second segment.
 * @returns {number}
 */
function getMinDistanceBetweenSegments(seg1, seg2) {
    let minDist = Infinity;
    const step1 = Math.max(1, Math.floor(seg1.length / 8));
    const step2 = Math.max(1, Math.floor(seg2.length / 8));
    for (let i = 0; i < seg1.length; i += step1) {
        for (let j = 0; j < seg2.length; j += step2) {
            const dist = Math.hypot(seg1[i].x - seg2[j].x, seg1[i].y - seg2[j].y);
            if (dist < minDist) minDist = dist;
        }
    }
    return minDist;
}

/**
 * Gets the unit direction vector and length of a segment.
 * @param {Array<{x:number, y:number}>} seg - Path segment.
 * @returns {{x:number, y:number, len:number}}
 */
function getSegmentDirection(seg) {
    const dx = seg[seg.length - 1].x - seg[0].x;
    const dy = seg[seg.length - 1].y - seg[0].y;
    const len = Math.hypot(dx, dy);
    return len > 0 ? { x: dx / len, y: dy / len, len } : { x: 0, y: 0, len: 0 };
}

/**
 * Groups close and parallel stroke segments.
 * @param {Array<Array<{x:number, y:number}>>} segments - List of segments.
 * @param {number} distThresh - Distance threshold.
 * @param {number} maxAngleDiffDeg - Max angle threshold in degrees.
 * @returns {Array<Array<Array<{x:number, y:number}>>>}
 */
function groupSegments(segments, distThresh, maxAngleDiffDeg) {
    let groups = segments.map(s => [s]);
    let merged = true;

    const cosAngleThresh = Math.cos(maxAngleDiffDeg * Math.PI / 180);

    while (merged) {
        merged = false;
        for (let i = 0; i < groups.length; i++) {
            for (let j = i + 1; j < groups.length; j++) {
                let shouldMerge = false;

                for (let seg1 of groups[i]) {
                    for (let seg2 of groups[j]) {
                        if (getMinDistanceBetweenSegments(seg1, seg2) < distThresh) {
                            const dir1 = getSegmentDirection(seg1);
                            const dir2 = getSegmentDirection(seg2);

                            if (dir1.len < 10 || dir2.len < 10) {
                                shouldMerge = true;
                                break;
                            }

                            const dotProduct = Math.abs(dir1.x * dir2.x + dir1.y * dir2.y);
                            if (dotProduct >= cosAngleThresh) {
                                shouldMerge = true;
                                break;
                            }
                        }
                    }
                    if (shouldMerge) break;
                }

                if (shouldMerge) {
                    groups[i].push(...groups[j]);
                    groups.splice(j, 1);
                    merged = true;
                    break;
                }
            }
            if (merged) break;
        }
    }
    return groups;
}

/**
 * Resamples a path to a target number of points.
 * @param {Array<{x:number, y:number}>} path - Path to resample.
 * @param {number} targetN - Target number of points.
 * @returns {Array<{x:number, y:number}>}
 */
function resamplePath(path, targetN) {
    if (path.length === 0) return [];
    if (path.length === 1) {
        const pts = [];
        for (let i = 0; i < targetN; i++) pts.push({ ...path[0] });
        return pts;
    }

    const dists = [0];
    for (let i = 1; i < path.length; i++) {
        dists.push(dists[i-1] + Math.hypot(path[i].x - path[i-1].x, path[i].y - path[i-1].y));
    }
    const totalLen = dists[dists.length - 1];

    const resampled = [];
    for (let i = 0; i < targetN; i++) {
        const t = i / (targetN - 1);
        const targetDist = t * totalLen;

        let idx = 0;
        while (idx < dists.length - 2 && dists[idx + 1] < targetDist) {
            idx++;
        }

        const d0 = dists[idx];
        const d1 = dists[idx + 1];
        const frac = (d1 - d0) > 0.001 ? (targetDist - d0) / (d1 - d0) : 0;

        const p0 = path[idx];
        const p1 = path[idx + 1];

        resampled.push({
            x: p0.x * (1 - frac) + p1.x * frac,
            y: p0.y * (1 - frac) + p1.y * frac
        });
    }
    return resampled;
}

/**
 * Averages a group of stroke segments using arc-length resampling.
 * @param {Array<Array<{x:number, y:number}>>} group - Group of segments.
 * @returns {Array<{x:number, y:number}>}
 */
function averageSegmentGroup(group) {
    if (group.length === 1) return smoothPath(group[0], 2);

    let refSeg = group[0];
    let maxLen = 0;
    const getPathLength = (path) => {
        let len = 0;
        for (let i = 1; i < path.length; i++) {
            len += Math.hypot(path[i].x - path[i-1].x, path[i].y - path[i-1].y);
        }
        return len;
    };

    group.forEach(seg => {
        const len = getPathLength(seg);
        if (len > maxLen) {
            maxLen = len;
            refSeg = seg;
        }
    });

    const N = Math.max(10, refSeg.length);
    const resampledGroup = [];
    const refDir = getSegmentDirection(refSeg);

    group.forEach(seg => {
        const segDir = getSegmentDirection(seg);
        let finalSeg = [...seg];

        if (refDir.x * segDir.x + refDir.y * segDir.y < 0) {
            finalSeg.reverse();
        }
        resampledGroup.push(resamplePath(finalSeg, N));
    });

    const averaged = [];
    for (let i = 0; i < N; i++) {
        let sumX = 0;
        let sumY = 0;
        resampledGroup.forEach(rSeg => {
            sumX += rSeg[i].x;
            sumY += rSeg[i].y;
        });
        averaged.push({ x: sumX / resampledGroup.length, y: sumY / resampledGroup.length });
    }

    return smoothPath(averaged, 3);
}

/**
 * Applies Laplacian smoothing to a path.
 * @param {Array<{x:number, y:number}>} path - Path to smooth.
 * @param {number} [iterations=2] - Number of smoothing iterations.
 * @returns {Array<{x:number, y:number}>}
 */
function smoothPath(path, iterations = 2) {
    if (path.length < 3) return path;
    let pts = [...path];
    for (let iter = 0; iter < iterations; iter++) {
        const nextPts = [];
        nextPts.push(pts[0]);
        for (let i = 1; i < pts.length - 1; i++) {
            nextPts.push({
                x: pts[i].x * 0.65 + (pts[i-1].x + pts[i+1].x) * 0.175,
                y: pts[i].y * 0.65 + (pts[i-1].y + pts[i+1].y) * 0.175
            });
        }
        nextPts.push(pts[pts.length - 1]);
        pts = nextPts;
    }
    return pts;
}
