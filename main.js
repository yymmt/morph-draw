/**
 * MorphDraw - アプリケーション状態
 */
const state = {
    view: 'gallery',
    currentDrawId: null,
    drawingType: 'canvas', // キャンバスの種類 ('canvas' | 'pattern' | 'import_image')
    shapes: {}, // ID -> Shape
    beziers: {},  // ID -> Bezier
    layers: {},   // ID -> Layer
    scene: [],    // Layer IDs in order
    zoom: 1,
    rotation: 0,
    pan: { x: 0, y: 0 },
    history: [],
    historyIndex: -1,
    selectedShapeIds: [],
    transformPivotMode: 'combined', // 'combined' | 'active' | 'individual'
    hoveredPoint: null, // { shapeId, pointIdx } hoverしている接続点
    dragInfo: null, // { type: 'move'|'pan'|'drag', ... }
    interaction: {
        mode: null,
        activeKeys: new Set(),
    },
    lastHit: null,
    lodPrecision: 10,
    lastMousePt: null,
    selectedLayerId: null,
    maxDrawingId: 0,
    drawingName: '',
    search: {
        query: ''
    },
    canvas: {
        width: 2000,
        height: 2000,
        underOffscreen: null,
        activeOffscreen: null,
        overOffscreen: null
    },
    input: {
        keys: {},
        pointer: { x: 0, y: 0 },
        dragStart: null,
        isPointerDown: false,
        isHoveringMinimap: false
    },
    minimap: {
        zoom: 1.0
    },
    webglTextures: {},
    thicknessEdit: {
        active: false,
        targetT: 0.0
    },
    patternEdit: {
        active: false,
        targetT: 0.0
    },
    reset(data) {
        state.shapes = data.shapes || {};
        state.beziers = data.beziers || {};
        state.layers = data.layers || {};
        state.scene = data.scene || [];
        state.selectedShapeIds = data.selectedShapeIds || [];
        state.transformPivotMode = 'combined';
        state.hoveredPoint = null;
        state.interaction.mode = null;
        state.dragInfo = null;
        state.history = [];
        state.historyIndex = -1;
        state.drawingType = 'canvas';
        state.input.keys = {};
        state.input.pointer = { x: 0, y: 0 };
        state.input.dragStart = null;
        state.input.isPointerDown = false;
    }
}; /* state */

function initializeIdCounter() {
    const allIds = [
        ...Object.keys(state.shapes),
        ...Object.keys(state.beziers),
        ...Object.keys(state.layers)
    ];
    const max = Math.max(0, ...allIds.map(id => {
        const m = id?.match(/[0-9]+/);
        return m ? parseInt(m[0], 10) : 0;
    }));
    state.nextIdCounter = max + 1;
}

function generateId(prefix) {
    if (!state.nextIdCounter) state.nextIdCounter = 1;
    const id = `${prefix}${state.nextIdCounter}`;
    state.nextIdCounter++;
    return id;
}

function stateReplacer(key, value) {
    if (key === 'controlPoints' || key === 'samplePointByT' || key === 'boundingBox' || key === 'parentId') {
        return undefined;
    }
    if (typeof value === 'number') {
        return Math.round(value * 10000) / 10000;
    }
    return value;
}

let db; /* IndexedDB インスタンス */

document.addEventListener('DOMContentLoaded', () => {
    initDB();
    initOffscreenCanvases();
    initEvents();
});

function initOffscreenCanvases() {
    const create = () => {
        const c = document.createElement('canvas');
        c.width = state.canvas.width;
        c.height = state.canvas.height;
        return c;
    };
    state.canvas.underOffscreen = create();
    state.canvas.activeOffscreen = create();
    state.canvas.overOffscreen = create();

    WebGLRenderer.init(state.canvas.width, state.canvas.height);
}

function resizeOffscreenCanvases() {
    const resize = (c) => {
        if (c) { c.width = state.canvas.width; c.height = state.canvas.height; }
    };
    resize(state.canvas.underOffscreen);
    resize(state.canvas.activeOffscreen);
    resize(state.canvas.overOffscreen);
    WebGLRenderer.resize(state.canvas.width, state.canvas.height);
}

function loadDrawingTexture(id) {
    return new Promise((resolve) => {
        if (!id) {
            resolve(null);
            return;
        }
        if (WebGLRenderer.textures && WebGLRenderer.textures[id]) {
            resolve(WebGLRenderer.textures[id]);
            return;
        }
        if (id === 'sample' || id === 'brush_sample') {
            resolve(WebGLRenderer.textures ? WebGLRenderer.textures[id] : null);
            return;
        }
        if (!db) {
            resolve(null);
            return;
        }

        try {
            const tx = db.transaction('drawings', 'readonly');
            const store = tx.objectStore('drawings');
            const request = store.get(id);

            request.onsuccess = () => {
                const data = request.result;
                if (data && data.preview) {
                    const img = new Image();
                    let src = '';
                    let isObjectURL = false;

                    if (data.preview instanceof Blob) {
                        src = URL.createObjectURL(data.preview);
                        isObjectURL = true;
                    } else if (typeof data.preview === 'string') {
                        src = data.preview;
                    }

                    img.onload = () => {
                        WebGLRenderer.registerTextureFromImage(id, img);
                        if (isObjectURL) {
                            URL.revokeObjectURL(src);
                        }
                        resolve(WebGLRenderer.textures[id] || null);
                    };

                    img.onerror = () => {
                        if (isObjectURL) {
                            URL.revokeObjectURL(src);
                        }
                        resolve(null);
                    };

                    img.src = src;
                } else {
                    resolve(null);
                }
            };

            request.onerror = () => {
                resolve(null);
            };
        } catch (e) {
            console.warn(`Failed to access drawings database for texture ${id}:`, e);
            resolve(null);
        }
    });
}

function initEvents() {
    const btnNewDraw = document.getElementById('btn-new-draw');
    const newDrawMenu = document.getElementById('new-draw-menu');

    if (btnNewDraw && newDrawMenu) {
        btnNewDraw.onclick = (e) => {
            e.stopPropagation();
            newDrawMenu.classList.toggle('hidden');
        };

        const btnNewCanvas = document.getElementById('btn-new-canvas');
        if (btnNewCanvas) {
            btnNewCanvas.onclick = (e) => {
                newDrawMenu.classList.add('hidden');
                startNewDrawing('canvas');
            };
        }

        const btnNewPattern = document.getElementById('btn-new-pattern');
        if (btnNewPattern) {
            btnNewPattern.onclick = (e) => {
                newDrawMenu.classList.add('hidden');
                startNewDrawing('pattern');
            };
        }

        const btnNewImport = document.getElementById('btn-new-import');
        if (btnNewImport) {
            btnNewImport.onclick = (e) => {
                newDrawMenu.classList.add('hidden');
                importImageFile();
            };
        }

        window.addEventListener('click', () => {
            newDrawMenu.classList.add('hidden');
        });
    }

    document.getElementById('btn-back-gallery').onclick = async () => {
        await saveDrawing();
        loadGallery();
        switchView('gallery');
    }; /* btn-back-gallery.onclick */

    document.getElementById('btn-toggle-minimap').onclick = () => {
        const panel = document.getElementById('minimap-panel');
        panel.classList.toggle('collapsed');
        const icon = document.querySelector('#btn-toggle-minimap i');
        if (icon) {
            const isCollapsed = panel.classList.contains('collapsed');
            icon.className = `bi ${isCollapsed ? 'bi-chevron-double-left' : 'bi-chevron-double-right'}`;
        }
    }; /* btn-toggle-minimap.onclick */

    const svg = document.getElementById('guide-svg');
    const minimapCanvas = document.getElementById('minimap-canvas');

    svg.addEventListener('pointerdown', (e) => {
        const viewport = svg.getElementById('viewport') || svg;
        const startPt = getSVGPoint(e, viewport);
        state.input.isPointerDown = true;
        state.input.dragStart = startPt;

        const target = e.target;
        if (target && target.classList && target.classList.contains('transform-handle')) {
            e.stopPropagation();
            const shapeId = target.getAttribute('data-shape-id') || null;
            let type, corner;
            if (target.classList.contains('scale-handle')) {
                type = 'scale';
                corner = target.getAttribute('data-corner');
            } else if (target.classList.contains('rotate-handle')) {
                type = 'rotate';
            }
            
            let pivot;
            if (state.transformPivotMode === 'individual' && shapeId) {
                const s = state.shapes[shapeId];
                pivot = s && s.props ? { x: s.props.x, y: s.props.y } : startPt;
            } else {
                const pivots = getPivotPoints();
                pivot = pivots.length > 0 ? pivots[0] : startPt;
            }

            state.dragInfo = {
                type: type,
                corner: corner,
                shapeId: shapeId,
                start: { ...startPt },
                last: { ...startPt },
                pivot: pivot,
                initialShapes: JSON.parse(JSON.stringify(state.shapes))
            };
            return;
        }

        handleInputUpdate('pointerdown');
    }); /* svg.pointerdown */

    if (minimapCanvas) {
        minimapCanvas.addEventListener('pointerdown', (e) => {
            state.input.isPointerDown = true;
            // ミニマップ上の pointerdown 時も getSVGPoint で座標変換して dragStart に入れる
            const pt = getSVGPoint(e, svg.getElementById('viewport') || svg);
            state.input.dragStart = pt;
            handleInputUpdate('pointerdown');
        });
    }

    window.addEventListener('pointermove', (e) => {
        const pt = getSVGPoint(e, svg.getElementById('viewport') || svg);
        state.input.pointer = { x: pt.x, y: pt.y };
        state.lastMousePt = { x: pt.x, y: pt.y };
        handleInputUpdate('pointermove');
    }); /* window.pointermove */

    const stop = (e) => {
        state.input.isPointerDown = false;
        state.input.dragStart = null;
        handleInputUpdate('pointerup');
    }; /* stop */
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);

    window.addEventListener('keydown', async e => {
        if (e.repeat) return; // MEMO 左右キーなどはrepeatで連続移動したい気もするが優先度低。
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable)) {
            return;
        }
        state.input.keys[e.key] = true;
        await handleInputUpdate('keydown', e.key, e);
    }); /* window.keydown */

    window.addEventListener('keyup', async e => {
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable)) {
            return;
        }
        state.input.keys[e.key] = false;
        await handleInputUpdate('keyup', e.key, e);
    }); /* window.keyup */

    document.getElementById('btn-toggle-settings').onclick = () => {
        const panel = document.getElementById('settings-panel');
        if (panel) {
            panel.classList.toggle('collapsed');
        }
    };

    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
        btn.onclick = () => {
            const tabName = btn.getAttribute('data-tab');
            switchSettingsTab(tabName);
        };
    });

    const drawNameInput = document.getElementById('input-draw-name');
    if (drawNameInput) {
        drawNameInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                const btn = document.getElementById('btn-save-image-settings');
                if (btn) btn.click();
                drawNameInput.blur();
            }
        };
    }

    const btnSaveImageSettings = document.getElementById('btn-save-image-settings');
    if (btnSaveImageSettings) {
        btnSaveImageSettings.onclick = () => {
            const nameInput = document.getElementById('input-draw-name');
            const widthInput = document.getElementById('input-canvas-width');
            const heightInput = document.getElementById('input-canvas-height');

            let changed = false;

            if (nameInput && nameInput.value.trim() !== '') {
                const newName = nameInput.value.trim();
                if (newName !== state.drawingName) {
                    state.drawingName = newName;
                    changed = true;
                }
            }

            if (widthInput && heightInput) {
                const w = parseInt(widthInput.value, 10);
                const h = parseInt(heightInput.value, 10);
                if (w > 0 && h > 0 && (w !== state.canvas.width || h !== state.canvas.height)) {
                    state.canvas.width = w;
                    state.canvas.height = h;
                    resizeOffscreenCanvases();
                    clearAllCaches();
                    rasterizeInactiveLayers();
                    changed = true;
                }
            }

            if (changed) {
                saveDrawing();
                pushHistory();
                renderCanvas();
            }
        };
    }

    document.getElementById('btn-add-layer').onclick = () => {
        addLayer();
    }; /* btn-add-layer.onclick */

    // レイヤー検索ボックス
    const layerSearch = document.getElementById('layer-search');
    if (layerSearch) {
        layerSearch.oninput = (e) => {
            state.search.query = e.target.value.toLowerCase().trim();
            renderLayerList();
        };
    }

    // 変形ピボットボタン
    const bindPivotBtn = (id, mode) => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.onclick = () => {
                document.querySelectorAll('.pivot-btn-group button').forEach(b => {
                    b.classList.remove('active');
                    b.style.background = '#888';
                });
                btn.classList.add('active');
                btn.style.background = '#2196F3';
                state.transformPivotMode = mode;
                renderCanvas();
            };
        }
    };
    bindPivotBtn('btn-pivot-combined', 'combined');
    bindPivotBtn('btn-pivot-active', 'active');
    bindPivotBtn('btn-pivot-individual', 'individual');

    // ミニマップホバー判定の登録
    if (minimapCanvas) {
        minimapCanvas.addEventListener('mouseenter', () => {
            state.input.isHoveringMinimap = true;
        });
        minimapCanvas.addEventListener('mouseleave', () => {
            state.input.isHoveringMinimap = false;
        });
    }
} /* initEvents */

/**
 * 共通ヘルパー: モディファイア状態を取得
 */
function getModifierState(rawEvent) {
    if (!rawEvent) return 'no_mod';
    const ctrl = rawEvent.ctrlKey || rawEvent.metaKey;
    const shift = rawEvent.shiftKey;
    if (ctrl && shift) return 'ctrl_shift';
    if (ctrl) return 'ctrl';
    if (shift) return 'shift';
    return 'no_mod';
}

/**
 * 各種キー・ポインタハンドラー関数
 */

// 円の追加
function handleAddCircleStart(ctx) {
    addShapeAt('circle', state.input.pointer.x, state.input.pointer.y);
}

// Wrap（接続ベジェ）の生成
function handleCreateWrap(ctx) {
    createWrap();
}

// Undo
function handleUndoAction(ctx) {
    undo();
}

// Redo
function handleRedoAction(ctx) {
    redo();
}

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
                bez.generator.params.x += offset;
                bez.generator.params.y += offset;
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

// ギャラリーへ戻る（非同期）
async function handleQuitToGallery(ctx) {
    if (state.view === 'canvas') {
        await saveDrawing();
        loadGallery();
        switchView('gallery');
    }
}

// 検索モードの起動
function handleOpenSearch(ctx) {
    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
    openSearchMode();
}

// 検索結果の次を選択
function handleSearchNext(ctx) {
    if (state.search.results.length > 0) {
        state.search.currentIndex = (state.search.currentIndex + 1) % state.search.results.length;
        applySearchResult();
    }
}

// 検索結果の前を選択
function handleSearchPrev(ctx) {
    if (state.search.results.length > 0) {
        state.search.currentIndex = (state.search.currentIndex - 1 + state.search.results.length) % state.search.results.length;
        applySearchResult();
    }
}

// 接続点のフォーカス（前へ）
function handleFocusVertexPrev(ctx) {
    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
    moveVertexFocus(-1);
}

// 接続点のフォーカス（次へ）
function handleFocusVertexNext(ctx) {
    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
    moveVertexFocus(1);
}

// 接続点フォーカスの移動ロジック
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

// 接続点のフォーカス解除
function handleClearVertexFocus(ctx) {
    if (state.focusedVertex) {
        state.focusedVertex = null;
    }
}

// アンカーのトグル、または頂点追加待ち状態への移行
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

// 太さ編集モードのトグル (Shift+w)
function handleToggleThicknessEdit(ctx) {
    if (state.selectedShapeIds.length > 0) {
        state.thicknessEdit.active = !state.thicknessEdit.active;
        if (state.thicknessEdit.active) {
            state.thicknessEdit.targetT = 0.0;
            state.thicknessEdit.editIndex = -1;
            const guide = document.getElementById('thickness-guide');
            if (guide) guide.classList.remove('hidden');

            // Ensure patternEdit is deactivated
            if (state.patternEdit.active) {
                state.patternEdit.active = false;
                const patternGuide = document.getElementById('pattern-guide');
                if (patternGuide) patternGuide.classList.add('hidden');
            }
        } else {
            const guide = document.getElementById('thickness-guide');
            if (guide) guide.classList.add('hidden');
        }
        return { pushHistory: false, needsRender: true };
    }
    return { pushHistory: false, needsRender: false };
}

// 輪郭のトグル (Shift+s)
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

// 塗りのトグル (Shift+f)
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

// 太さ変更ドラッグの開始
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

// データポイント移動ドラッグの開始
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

// targetT のスライド処理
function handleTSlideThickness(ctx) {
    let nextT = state.thicknessEdit.targetT + ctx.dx * 0.005;
    if (nextT > 1) nextT -= 1;
    if (nextT < 0) nextT += 1;
    state.thicknessEdit.targetT = nextT;
}

// 太さ変更処理
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

// データポイント移動処理
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

// データポイントの削除 (x)
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


// 変形開始 (m, s, r, t, d, z 押下時)
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
        const modeMap = { m: 'move', s: 'scale', r: 'rotate', t: 't-slide', d: 'd-dist', z: 'zoom' };
        desiredMode = modeMap[key] || null;
    }

    if (desiredMode && desiredMode !== state.interaction.mode) {
        const hasTarget = desiredMode === 'zoom' ||
            state.selectedShapeIds.length > 0 ||
            (state.focusedVertex && (desiredMode === 't-slide' || desiredMode === 'd-dist')) ||
            (state.thicknessEdit.active && (desiredMode === 't-slide-thickness' || desiredMode === 'w-slide-thickness' || desiredMode === 't-move-thickness')) ||
            (state.patternEdit.active && (desiredMode === 't-slide-pattern' || desiredMode === 't-move-pattern'));
        if (hasTarget) {
            state.dragInfo = {
                start: { ...state.input.pointer },
                type: 'key-hold'
            };
        }
        state.interaction.mode = desiredMode;
    }
}

// 変形終了 (キーリリース時)
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
        const modeMap = { m: 'move', s: 'scale', r: 'rotate', t: 't-slide', d: 'd-dist', z: 'zoom' };
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

function handlePointerDownStart(ctx) {
    const pt = state.input.pointer;
    // 接続点選択モード (pick-point) の場合、hoveredPointを決定
    if (state.interaction.mode === 'pick-point') {
        if (state.hoveredPoint) {
            state.interaction.onPick?.(state.hoveredPoint);
            state.interaction.mode = null;
            state.interaction.onPick = null;
            state.hoveredPoint = null;
            renderCanvas();
        }
        return;
    }

    const hit = findShapeAt(pt);
    state.lastHit = hit;
    if (hit) {
        if (!state.selectedShapeIds.includes(hit.shape.id)) {
            if (ctx.rawEvent && ctx.rawEvent.shiftKey) {
                state.selectedShapeIds.push(hit.shape.id);
            } else {
                state.selectedShapeIds = [hit.shape.id];
            }
        }
        state.dragInfo = {
            type: 'move',
            start: { ...pt },
            last: { ...pt }
        };
    } else {
        // 空白をクリックした場合はドラッグ矩形選択を開始
        state.dragInfo = {
            type: 'marquee',
            start: { ...pt },
            current: { ...pt }
        };
    }
}

function handlePointerUpEnd(ctx) {
    let needsRender = false;
    let pushHistory = false;

    if (state.dragInfo) {
        if (state.dragInfo.type === 'marquee') {
            const pt = state.input.pointer;
            const dx = Math.abs(pt.x - state.dragInfo.start.x);
            const dy = Math.abs(pt.y - state.dragInfo.start.y);
            if (dx < 5 && dy < 5) {
                // 単一クリック扱い
                state.selectedShapeIds = [];
            } else {
                // 矩形選択
                const rect = {
                    x1: state.dragInfo.start.x,
                    y1: state.dragInfo.start.y,
                    x2: pt.x,
                    y2: pt.y
                };
                const hits = findShapesInMarquee(rect);
                state.selectedShapeIds = hits;
                pushHistory = false; // 選択状態のみの変化は履歴に入れない
            }
            needsRender = true;
        } else if (state.dragInfo.type === 'move') {
            pushHistory = true;
            needsRender = true;
        }
    }
    state.dragInfo = null;
    updatePropertiesPanel();
    return { needsRender, pushHistory };
}

function findShapesInMarquee(rect) {
    const minX = Math.min(rect.x1, rect.x2);
    const maxX = Math.max(rect.x1, rect.x2);
    const minY = Math.min(rect.y1, rect.y2);
    const maxY = Math.max(rect.y1, rect.y2);

    const hitIds = [];
    Object.entries(state.shapes).forEach(([sid, shape]) => {
        if (state.layers[sid]) return; // レイヤーは除外

        let isHit = false;
        if (shape.bezierIds) {
            for (const bid of shape.bezierIds) {
                const bez = state.beziers[bid];
                if (bez && bez.samplePointByT) {
                    for (const pt of Object.values(bez.samplePointByT)) {
                        if (pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY) {
                            isHit = true;
                            break;
                        }
                    }
                }
                if (isHit) break;
            }
        }
        if (isHit) {
            hitIds.push(sid);
        }
    });
    return hitIds;
}

// 変形処理: 移動
function handleMove(ctx) {
    const targetIds = Array.from(new Set([...state.selectedShapeIds, ...(state.anchoredShapeIds || [])]));
    if (targetIds.length > 0) {
        moveShapes(targetIds, ctx.dx, ctx.dy);
    }
}

// 変形処理: 拡大縮小
function handleScale(ctx) {
    const targetIds = Array.from(new Set([...state.selectedShapeIds, ...(state.anchoredShapeIds || [])]));
    if (targetIds.length > 0) {
        const bounds = getCombinedBounds(targetIds);
        if (bounds) {
            const scaleFactor = 1 + ctx.dx * 0.01;
            scaleShapes(targetIds, scaleFactor, bounds.cx, bounds.cy);
        }
    }
}

// 変形処理: 回転
function handleRotate(ctx) {
    const targetIds = Array.from(new Set([...state.selectedShapeIds, ...(state.anchoredShapeIds || [])]));
    if (targetIds.length > 0) {
        const bounds = getCombinedBounds(targetIds);
        if (bounds) {
            const angle = ctx.dx * 0.5; // degrees
            rotateShapes(targetIds, angle, bounds.cx, bounds.cy);
        }
    }
}

// 変形処理: t値スライド (頂点スライド)
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

// 変形処理: d値スライド (頂点接線距離)
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

const keyHandlers = {
    no_mod: {
        x: { keydown: { f: deleteSelectedShapes, pushHistory: true, needsRender: true } },
        c: { keydown: { f: handleAddCircleStart, needsRender: true } },
        w: { keydown: { f: handleCreateWrap, pushHistory: true, needsRender: true } },
        '?': { keydown: { f: toggleHelpModal } },
        q: { keydown: { f: handleQuitToGallery } },
        '/': {
            keydown: {
                f: (ctx) => {
                    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
                    const input = document.getElementById('layer-search');
                    if (input) {
                        input.focus();
                        input.select();
                    }
                }
            }
        }
    },
    ctrl: {
        z: { keydown: { f: handleUndoAction, needsRender: true } },
        c: { keydown: { f: handleCopy } },
        v: { keydown: { f: handlePaste } }
    },
    ctrl_shift: {
        z: { keydown: { f: handleRedoAction, needsRender: true } }
    }
};

const modeHandlers = {};

async function handleInputUpdate(event, detail, rawEvent) {
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

    // 1. キーイベント (keydown / keyup) のディスパッチ
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
    }
    // 2. ポインタイベント (pointerdown / pointermove / pointerup) のディスパッチ
    else {
        const mode = state.interaction.mode;

        if (event === 'pointerdown') {
            handlePointerDownStart(ctx);
            needsRender = true;
        }

        else if (event === 'pointermove') {
            if (state.dragInfo) {
                const pt = state.input.pointer;
                if (state.dragInfo.type === 'marquee') {
                    state.dragInfo.current = pt;
                    needsRender = true;
                } else if (state.dragInfo.type === 'move') {
                    ctx.dx = pt.x - state.dragInfo.last.x;
                    ctx.dy = pt.y - state.dragInfo.last.y;
                    const targetIds = Array.from(new Set([...state.selectedShapeIds]));
                    if (targetIds.length > 0 && (ctx.dx !== 0 || ctx.dy !== 0)) {
                        moveShapes(targetIds, ctx.dx, ctx.dy);
                        state.dragInfo.last = { ...pt };
                        needsRender = true;
                    }
                } else if (state.dragInfo.type === 'scale') {
                    const pivot = state.dragInfo.pivot;
                    const start = state.dragInfo.start;
                    const dStart = Math.hypot(start.x - pivot.x, start.y - pivot.y);
                    const dCurrent = Math.hypot(pt.x - pivot.x, pt.y - pivot.y);
                    let factor = dStart > 0.1 ? dCurrent / dStart : 1.0;
                    
                    const vStart = { x: start.x - pivot.x, y: start.y - pivot.y };
                    const vCurrent = { x: pt.x - pivot.x, y: pt.y - pivot.y };
                    const dot = vStart.x * vCurrent.x + vStart.y * vCurrent.y;
                    if (dot < 0) {
                        factor = -factor;
                    }

                    const targetIds = state.dragInfo.shapeId ? [state.dragInfo.shapeId] : state.selectedShapeIds;
                    targetIds.forEach(id => {
                        if (state.dragInfo.initialShapes[id]) {
                            state.shapes[id] = JSON.parse(JSON.stringify(state.dragInfo.initialShapes[id]));
                        }
                    });
                    scaleShapes(targetIds, factor, pivot.x, pivot.y);
                    needsRender = true;
                } else if (state.dragInfo.type === 'rotate') {
                    const pivot = state.dragInfo.pivot;
                    const start = state.dragInfo.start;
                    const angleStart = Math.atan2(start.y - pivot.y, start.x - pivot.x);
                    const angleCurrent = Math.atan2(pt.y - pivot.y, pt.x - pivot.x);
                    const angleDiff = (angleCurrent - angleStart) * 180 / Math.PI;

                    const targetIds = state.dragInfo.shapeId ? [state.dragInfo.shapeId] : state.selectedShapeIds;
                    targetIds.forEach(id => {
                        if (state.dragInfo.initialShapes[id]) {
                            state.shapes[id] = JSON.parse(JSON.stringify(state.dragInfo.initialShapes[id]));
                        }
                    });
                    rotateShapes(targetIds, angleDiff, pivot.x, pivot.y);
                    needsRender = true;
                }
            }

            // pick-point モード時の接続点ホバー検出
            if (state.interaction.mode === 'pick-point') {
                const pt = state.input.pointer;
                let closestPt = null;
                let minDist = 15; // 15pxまで吸着

                Object.entries(state.shapes).forEach(([sid, shape]) => {
                    if (shape.points) {
                        shape.points.forEach((p, idx) => {
                            const bez = state.beziers[p.bezierId];
                            if (bez) {
                                const ptReal = MDMath.getPoint(bez, p.t);
                                const dist = Math.hypot(pt.x - ptReal.x, pt.y - ptReal.y);
                                if (dist < minDist) {
                                    minDist = dist;
                                    closestPt = { shapeId: sid, pointIdx: idx };
                                }
                            }
                        });
                    }
                });

                if (closestPt) {
                    if (!state.hoveredPoint || state.hoveredPoint.shapeId !== closestPt.shapeId || state.hoveredPoint.pointIdx !== closestPt.pointIdx) {
                        state.hoveredPoint = closestPt;
                        needsRender = true;
                    }
                } else {
                    if (state.hoveredPoint) {
                        state.hoveredPoint = null;
                        needsRender = true;
                    }
                }
            }
        }

        else if (event === 'pointerup') {
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
} /* handleInputUpdate */

function toggleHelpModal() {
    const panel = document.getElementById('settings-panel');
    if (!panel) return;
    const isCollapsed = panel.classList.contains('collapsed');

    if (isCollapsed) {
        panel.classList.remove('collapsed');
        switchSettingsTab('help');
    } else {
        const activeTab = panel.querySelector('.settings-tab-btn.active');
        if (activeTab && activeTab.getAttribute('data-tab') !== 'help') {
            switchSettingsTab('help');
        } else {
            panel.classList.add('collapsed');
        }
    }
} /* toggleHelpModal */

function switchSettingsTab(tabName) {
    const tabs = document.querySelectorAll('.settings-tab-btn');
    const contents = document.querySelectorAll('.settings-tab-content');

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

function pushHistory() {
    const current = JSON.stringify({
        shapes: state.shapes,
        beziers: state.beziers,
        scene: state.scene,
        anchoredShapeIds: state.anchoredShapeIds,
        focusedVertex: state.focusedVertex,
        selectedShapeIds: state.selectedShapeIds,
        selectedLayerId: state.selectedLayerId
    }, stateReplacer);
    if (state.historyIndex >= 0 && current === state.history[state.historyIndex]) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(current);
    state.historyIndex = state.history.length - 1;
} /* pushHistory */

function undo() {
    if (state.historyIndex <= 0) return;
    state.historyIndex--;
    const data = JSON.parse(state.history[state.historyIndex]);
    state.shapes = data.shapes || data.entities || {};
    state.beziers = data.beziers;
    state.scene = data.scene;
    state.anchoredShapeIds = data.anchoredShapeIds || [];
    state.focusedVertex = data.focusedVertex || null;

    // MEMO: 「選択→移動→Undo」を行った際に選択状態が解除されてしまう問題（履歴記録時の選択状態の保存タイミングのズレ）は将来対応とする。
    state.selectedShapeIds = (data.selectedShapeIds || []).filter(id => state.shapes[id]);
    state.selectedLayerId = data.selectedLayerId && state.shapes[data.selectedLayerId] ? data.selectedLayerId : null;

    resolveBezierDependencies();
    clearAllCaches();
    renderCanvas();
} /* undo */

function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex++;
    const data = JSON.parse(state.history[state.historyIndex]);
    state.shapes = data.shapes || data.entities || {};
    state.beziers = data.beziers;
    state.scene = data.scene;
    state.anchoredShapeIds = data.anchoredShapeIds || [];
    state.focusedVertex = data.focusedVertex || null;
    state.selectedShapeIds = (data.selectedShapeIds || []).filter(id => state.shapes[id]);
    state.selectedLayerId = data.selectedLayerId && state.shapes[data.selectedLayerId] ? data.selectedLayerId : null;

    resolveBezierDependencies();
    clearAllCaches();
    renderCanvas(); /* redo */
} /* redo */

function findClosestSamplePoint(pt) {
    // 表示されているレイヤーに属するShapeのIDを収集
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
        if (!visibleShapeIds.has(sid)) continue; // 非表示レイヤーの図形は選択対象外

        shape.bezierIds.forEach(bid => {
            const b = state.beziers[bid];
            if (!b) return;
            Object.entries(b.samplePointByT).forEach(([tStr, p]) => {
                const d = Math.hypot(p.x - pt.x, p.y - pt.y);
                if (d < minD) { minD = d; closest = { shapeId: sid, bezierId: bid, t: parseFloat(tStr), pt: p }; }
            });
        });
    }
    return closest; /* findClosestSamplePoint */
} /* findClosestSamplePoint */

function findShapeAt(pt) {
    const h = findClosestSamplePoint(pt);
    if (!h) return null;
    const shapeId = Object.keys(state.shapes).find(id => state.shapes[id].bezierIds?.includes(h.bezierId));
    return shapeId ? { shape: state.shapes[shapeId], child: null } : null;
} /* findShapeAt */

function deleteSelectedVertex() {
    if (!state.focusedVertex) return;
    const { shapeId, vertexIdx } = state.focusedVertex;
    deleteVertex(shapeId, vertexIdx);
}

function deleteSelectedShapes() {
    // 各レイヤーからShapeを削除
    state.scene.forEach(layerId => {
        const layer = state.shapes[layerId];
        if (layer && layer.type === 'layer') {
            layer.childIds = layer.childIds.filter(id => !state.selectedShapeIds.includes(id));
        }
    });

    // state.shapes および state.beziers からも削除
    state.selectedShapeIds.forEach(shapeId => {
        const shape = state.shapes[shapeId];
        if (shape) {
            shape.bezierIds?.forEach(bid => delete state.beziers[bid]);
            delete state.shapes[shapeId];
        }
    });

    state.selectedShapeIds = [];
    state.focusedVertex = null; // 頂点フォーカスもクリア
} /* deleteSelectedShapes */

// Enterキーが押された時の処理 (頂点の割り込み追加)
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

    // 新たに挿入された頂点 (ACの終端) にフォーカス
    state.focusedVertex = {
        shapeId: wrapShapeId,
        vertexIdx: bezierIdx * 2 + 1
    };

    resolveBezierDependencies();
}

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
 * Bezier Math & Engine
 */

function updateBezier(id) {
    const bez = state.beziers[id];
    if (!bez || !bez.generator) return;

    const generatorFunc = MDMath.generators[bez.generator.type];
    if (generatorFunc) {
        bez.controlPoints = generatorFunc(state, bez.generator.params, bez);
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
    }; /* sample */
    bez.samplePointByT[0] = MDMath.getPoint(bez, 0);
    sample(0, 1);

    // 4. Update Bounding Box
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
} /* updateBezier */

function resolveBezierDependencies() {
    const visited = new Set(), visiting = new Set(), sorted = [];
    const visit = (id) => {
        if (visited.has(id)) return;
        if (visiting.has(id)) return; // 循環参照の切断
        visiting.add(id);
        const b = state.beziers[id];
        if (!b) return;
        if (b.generator && b.generator.params) {
            const { p1, p2 } = b.generator.params;
            const addDep = (p) => {
                if (p && p.shapeId) {
                    const s = state.shapes[p.shapeId];
                    const pt = s && s.points && s.points[p.pointIdx];
                    if (pt && pt.bezierId) {
                        visit(pt.bezierId);
                    }
                }
            };
            addDep(p1);
            addDep(p2);
        }
        visiting.delete(id);
        visited.add(id); sorted.push(id);
    };
    Object.keys(state.beziers).forEach(visit);
    sorted.forEach(updateBezier);
} /* resolveBezierDependencies */

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

function moveShapes(shapeIds, dx, dy) {
    shapeIds.forEach(id => {
        const shape = state.shapes[id];
        if (shape && shape.props) {
            if (shape.props.x !== undefined) shape.props.x += dx;
            if (shape.props.y !== undefined) shape.props.y += dy;
            markShapeDirty(id);
        }
    });
    resolveBezierDependencies();
}

function scaleShapes(shapeIds, factor, cx, cy) {
    shapeIds.forEach(id => {
        const shape = state.shapes[id];
        if (shape) {
            if (state.transformPivotMode === 'individual') {
                if (shape.props && shape.props.r !== undefined) {
                    shape.props.r *= factor;
                }
            } else {
                if (shape.props) {
                    if (shape.props.x !== undefined) shape.props.x = cx + (shape.props.x - cx) * factor;
                    if (shape.props.y !== undefined) shape.props.y = cy + (shape.props.y - cy) * factor;
                    if (shape.props.r !== undefined) shape.props.r *= factor;
                }
            }
            markShapeDirty(id);
        }
    });
    resolveBezierDependencies();
}

function rotateShapes(shapeIds, angle, cx, cy) {
    const rad = angle * Math.PI / 180;
    const cosVal = Math.cos(rad);
    const sinVal = Math.sin(rad);

    shapeIds.forEach(id => {
        const shape = state.shapes[id];
        if (shape) {
            if (state.transformPivotMode === 'individual') {
                if (shape.props && shape.props.rotation !== undefined) {
                    shape.props.rotation += angle;
                }
            } else {
                if (shape.props) {
                    if (shape.props.x !== undefined && shape.props.y !== undefined) {
                        const dx = shape.props.x - cx;
                        const dy = shape.props.y - cy;
                        shape.props.x = cx + dx * cosVal - dy * sinVal;
                        shape.props.y = cy + dx * sinVal + dy * cosVal;
                    }
                    if (shape.props.rotation !== undefined) {
                        shape.props.rotation += angle;
                    }
                }
            }
            markShapeDirty(id);
        }
    });
    resolveBezierDependencies();
}

function addShapeAt(type, x, y) {
    const id = generateId('s');
    const bIds = [], r = 50;
    if (type === 'circle') {
        for (let i = 0; i < 4; i++) {
            const bId = generateId('b'), a = (i * Math.PI) / 2, na = ((i + 1) * Math.PI) / 2;
            state.beziers[bId] = {
                id: bId,
                parentId: id,
                generator: {
                    type: 'arc',
                    params: { startAngle: a, endAngle: na }
                },
                controlPoints: [], samplePointByT: {}, boundingBox: {}
            };
            bIds.push(bId);
        }
    }
    const count = Object.values(state.shapes).filter(s => s.name && s.name.startsWith(type)).length + 1;
    
    const points = [
        { bezierId: bIds[0], t: 0 },
        { bezierId: bIds[1], t: 0 },
        { bezierId: bIds[2], t: 0 },
        { bezierId: bIds[3], t: 0 },
        { bezierId: bIds[3], t: 1 }
    ];

    const shape = {
        id, 
        type: 'circle', 
        name: `${type} ${count}`, 
        bezierIds: bIds, 
        props: { x, y, r, rotation: 0 },
        style: { fill: '#2196F3', opacity: 0.7, outline: true, fillEnabled: true },
        points: points,
        strokeWidthData: [{ p: 0, w: 10 }, { p: 4, w: 10 }],
        patternCorners: { TL: 0, TR: 1, BR: 2, BL: 3 }
    };
    state.shapes[id] = shape;

    if (state.selectedLayerId && state.layers[state.selectedLayerId]) {
        state.layers[state.selectedLayerId].childIds.push(id);
    } else {
        const firstLayerId = state.scene[0];
        if (firstLayerId && state.layers[firstLayerId]) {
            state.layers[firstLayerId].childIds.push(id);
        }
    }

    resolveBezierDependencies();
    pushHistory();
    renderCanvas();
    updatePropertiesPanel();
    renderLayerList();
}

function createWrap() {
    const targets = Array.from(new Set([...state.selectedShapeIds]));
    if (targets.length < 2) return;
    const [id1, id2] = targets;
    const shape1 = state.shapes[id1], shape2 = state.shapes[id2];
    if (!shape1 || !shape2) return;

    const pt1_up_idx = 0;
    const pt1_down_idx = Math.min(2, (shape1.points?.length ?? 1) - 1);
    const pt2_up_idx = 0;
    const pt2_down_idx = Math.min(2, (shape2.points?.length ?? 1) - 1);

    const wrapId = generateId('s');
    const bIds = [];

    const bId1 = generateId('b');
    state.beziers[bId1] = {
        id: bId1,
        parentId: wrapId,
        generator: {
            type: 'connector',
            params: {
                p1: { shapeId: id1, pointIdx: pt1_up_idx, d: 2.0 },
                p2: { shapeId: id2, pointIdx: pt2_up_idx, d: 2.0 }
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId1);

    const bId2 = generateId('b');
    state.beziers[bId2] = {
        id: bId2,
        parentId: wrapId,
        generator: {
            type: 'connector',
            params: {
                p1: { shapeId: id2, pointIdx: pt2_up_idx, d: 0.1 },
                p2: { shapeId: id2, pointIdx: pt2_down_idx, d: 0.1 }
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId2);

    const bId3 = generateId('b');
    state.beziers[bId3] = {
        id: bId3,
        parentId: wrapId,
        generator: {
            type: 'connector',
            params: {
                p1: { shapeId: id2, pointIdx: pt2_down_idx, d: 2.0 },
                p2: { shapeId: id1, pointIdx: pt1_down_idx, d: 2.0 }
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId3);

    const bId4 = generateId('b');
    state.beziers[bId4] = {
        id: bId4,
        parentId: wrapId,
        generator: {
            type: 'connector',
            params: {
                p1: { shapeId: id1, pointIdx: pt1_down_idx, d: 0.1 },
                p2: { shapeId: id1, pointIdx: pt1_up_idx, d: 0.1 }
            }
        },
        controlPoints: [], samplePointByT: {}, boundingBox: {}
    };
    bIds.push(bId4);

    const wrapCount = Object.values(state.shapes).filter(s => s.name && s.name.startsWith('wrap')).length + 1;
    
    const points = [
        { bezierId: bIds[0], t: 0 },
        { bezierId: bIds[1], t: 0 },
        { bezierId: bIds[2], t: 0 },
        { bezierId: bIds[3], t: 0 },
        { bezierId: bIds[3], t: 1 }
    ];

    const wrapShape = {
        id: wrapId,
        type: 'wrap',
        name: `wrap ${wrapCount}`,
        bezierIds: bIds,
        props: {},
        style: { fill: '#2196F3', opacity: 0.5, outline: true, fillEnabled: true },
        points: points,
        strokeWidthData: [{ p: 0, w: 10 }, { p: 4, w: 10 }],
        patternCorners: { TL: 0, TR: 1, BR: 2, BL: 3 }
    };
    state.shapes[wrapId] = wrapShape;

    if (state.selectedLayerId && state.layers[state.selectedLayerId]) {
        state.layers[state.selectedLayerId].childIds.push(wrapId);
    } else {
        const firstLayerId = state.scene[0];
        if (firstLayerId && state.layers[firstLayerId]) {
            state.layers[firstLayerId].childIds.push(wrapId);
        }
    }

    resolveBezierDependencies();
    pushHistory();
    renderCanvas();
    updatePropertiesPanel();
    renderLayerList();
} /* createWrap */
let currentRenderCoonsCount = 0;

const shapeRenderCaches = {}; // shapeId -> { canvas, ctx, isDirty, x, y, w, h }

function getShapeCache(shapeId) {
    if (!shapeRenderCaches[shapeId]) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        shapeRenderCaches[shapeId] = { canvas, ctx, isDirty: true, x: 0, y: 0, w: 0, h: 0 };
    }
    return shapeRenderCaches[shapeId];
}

function getShapeRenderBounds(shapeId) {
    const shape = state.shapes[shapeId];
    if (!shape || !shape.bezierIds) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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

    if (minX === Infinity) {
        return { x: 0, y: 0, w: state.canvas.width, h: state.canvas.height };
    }

    // 線の太さの最大値を取得（余白計算用）
    let maxW = 10;
    if (shape.strokeWidthData && shape.strokeWidthData.length > 0) {
        maxW = Math.max(...shape.strokeWidthData.map(d => d.w));
    }

    // 余白（最大の太さの半分 + 安全パディング 20px）
    const padding = (maxW / 2) + 20;

    const x = Math.floor(minX - padding);
    const y = Math.floor(minY - padding);

    // 最小サイズは 1px にクリップ（ゼロサイズによる canvas エラー防止）
    const w = Math.max(1, Math.ceil(maxX + padding) - x);
    const h = Math.max(1, Math.ceil(maxY + padding) - y);

    return { x, y, w, h };
}

function markShapeDirty(shapeId) {
    const cache = shapeRenderCaches[shapeId];
    if (cache) {
        cache.isDirty = true;
    }
}

function clearAllCaches() {
    for (const id in shapeRenderCaches) {
        shapeRenderCaches[id].isDirty = true;
    }
}

function renderCanvas() {
    const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    currentRenderCoonsCount = 0;

    const svg = document.getElementById('guide-svg');
    if (!svg) return;
    svg.innerHTML = `<g id="viewport" transform="translate(${state.pan.x}, ${state.pan.y}) scale(${state.zoom}) rotate(${state.rotation})"></g>`;
    const viewport = document.getElementById('viewport');

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
        const activeLayer = state.layers[activeLayerId];
        if (activeLayer && activeLayer.childIds) {
            activeLayer.childIds.forEach(childId => {
                renderGuides(childId, viewport);
            });
        }
    }

    if (activeLayerId && state.canvas.activeOffscreen) {
        const activeCtx = state.canvas.activeOffscreen.getContext('2d');
        activeCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        drawLayerToCanvasContext(activeCtx, activeLayerId);
    }

    // ドラッグ選択 marquee の描画
    if (state.dragInfo && state.dragInfo.type === 'marquee') {
        const pt1 = state.dragInfo.start;
        const pt2 = state.dragInfo.current;
        const marqueeRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        marqueeRect.setAttribute('x', Math.min(pt1.x, pt2.x));
        marqueeRect.setAttribute('y', Math.min(pt1.y, pt2.y));
        marqueeRect.setAttribute('width', Math.abs(pt1.x - pt2.x));
        marqueeRect.setAttribute('height', Math.abs(pt1.y - pt2.y));
        marqueeRect.setAttribute('fill', 'rgba(33, 150, 243, 0.1)');
        marqueeRect.setAttribute('stroke', '#2196F3');
        marqueeRect.setAttribute('stroke-width', '1');
        marqueeRect.setAttribute('stroke-dasharray', '4,4');
        viewport.appendChild(marqueeRect);
    }

    // 変形ハンドルの描画
    renderTransformHandles(viewport);

    // 変形ピボットの描画
    const pivots = getPivotPoints();
    pivots.forEach(p => {
        const lineH = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        lineH.setAttribute('x1', p.x - 8);
        lineH.setAttribute('y1', p.y);
        lineH.setAttribute('x2', p.x + 8);
        lineH.setAttribute('y2', p.y);
        lineH.setAttribute('stroke', '#ff5722');
        lineH.setAttribute('stroke-width', '1.5');
        
        const lineV = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        lineV.setAttribute('x1', p.x);
        lineV.setAttribute('y1', p.y - 8);
        lineV.setAttribute('x2', p.x);
        lineV.setAttribute('y2', p.y + 8);
        lineV.setAttribute('stroke', '#ff5722');
        lineV.setAttribute('stroke-width', '1.5');
        
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', p.x);
        circle.setAttribute('cy', p.y);
        circle.setAttribute('r', 3);
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', '#ff5722');
        circle.setAttribute('stroke-width', '1');

        viewport.appendChild(lineH);
        viewport.appendChild(lineV);
        viewport.appendChild(circle);
    });

    // pick-point モードでの全接続点の表示
    if (state.interaction.mode === 'pick-point') {
        Object.entries(state.shapes).forEach(([sid, shape]) => {
            if (shape.points) {
                shape.points.forEach((p, idx) => {
                    const bez = state.beziers[p.bezierId];
                    if (bez) {
                        const pt = MDMath.getPoint(bez, p.t);
                        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                        c.setAttribute('cx', pt.x);
                        c.setAttribute('cy', pt.y);
                        c.setAttribute('r', 4);
                        c.setAttribute('fill', 'rgba(200, 200, 200, 0.6)');
                        c.setAttribute('stroke', '#999');
                        c.setAttribute('stroke-width', '1');
                        viewport.appendChild(c);
                    }
                });
            }
        });
    }

    // hoveredPoint のハイライト表示
    if (state.hoveredPoint) {
        const shape = state.shapes[state.hoveredPoint.shapeId];
        const pt = shape?.points?.[state.hoveredPoint.pointIdx];
        const bez = pt && state.beziers[pt.bezierId];
        if (bez) {
            const ptReal = MDMath.getPoint(bez, pt.t);
            const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            c.setAttribute('cx', ptReal.x);
            c.setAttribute('cy', ptReal.y);
            c.setAttribute('r', 6);
            c.setAttribute('fill', 'rgba(255, 82, 82, 0.8)');
            c.setAttribute('stroke', '#ff5252');
            c.setAttribute('stroke-width', '2');
            viewport.appendChild(c);
        }
    }

    const underCanvas = document.getElementById('under-canvas');
    const activeCanvas = document.getElementById('active-canvas');
    const overCanvas = document.getElementById('over-canvas');

    drawOffscreenToOnscreen(underCanvas, state.canvas.underOffscreen);
    drawOffscreenToOnscreen(activeCanvas, state.canvas.activeOffscreen);
    drawOffscreenToOnscreen(overCanvas, state.canvas.overOffscreen);

    renderMinimap();
    renderLayerList();

    const duration = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startTime;
    if (window.__debug__ && typeof window.__debug__.addMeasure === 'function') {
        window.__debug__.addMeasure(duration, currentRenderCoonsCount);
    }
} /* renderCanvas */

function getPivotPoints() {
    const targetIds = state.selectedShapeIds;
    if (targetIds.length === 0) return [];

    if (state.transformPivotMode === 'individual') {
        return targetIds.map(id => {
            const shape = state.shapes[id];
            if (shape && shape.props && shape.props.x !== undefined) {
                return { x: shape.props.x, y: shape.props.y };
            }
            return null;
        }).filter(Boolean);
    } else if (state.transformPivotMode === 'active') {
        const activeId = targetIds[targetIds.length - 1];
        const shape = state.shapes[activeId];
        if (shape && shape.props && shape.props.x !== undefined) {
            return [{ x: shape.props.x, y: shape.props.y }];
        }
        const bounds = getCombinedBounds(targetIds);
        return bounds ? [{ x: bounds.cx, y: bounds.cy }] : [];
    } else {
        const bounds = getCombinedBounds(targetIds);
        return bounds ? [{ x: bounds.cx, y: bounds.cy }] : [];
    }
}

function renderTransformHandles(viewport) {
    if (state.selectedShapeIds.length === 0) return;
    if (state.interaction.mode === 'pick-point') return;

    const padding = 8;
    const drawBoxHandles = (bounds, shapeId = null) => {
        if (!bounds) return;
        const x1 = bounds.x - padding;
        const y1 = bounds.y - padding;
        const w1 = bounds.w + padding * 2;
        const h1 = bounds.h + padding * 2;

        // 破線枠
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', x1);
        rect.setAttribute('y', y1);
        rect.setAttribute('width', w1);
        rect.setAttribute('height', h1);
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', '#2196F3');
        rect.setAttribute('stroke-width', '1');
        rect.setAttribute('stroke-dasharray', '3,3');
        viewport.appendChild(rect);

        // 四隅のスケールハンドル
        const corners = [
            { name: 'TL', x: x1, y: y1, cursor: 'nwse-resize' },
            { name: 'TR', x: x1 + w1, y: y1, cursor: 'nesw-resize' },
            { name: 'BR', x: x1 + w1, y: y1 + h1, cursor: 'nwse-resize' },
            { name: 'BL', x: x1, y: y1 + h1, cursor: 'nesw-resize' }
        ];

        corners.forEach(c => {
            const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            handle.setAttribute('x', c.x - 3);
            handle.setAttribute('y', c.y - 3);
            handle.setAttribute('width', '6');
            handle.setAttribute('height', '6');
            handle.setAttribute('fill', 'white');
            handle.setAttribute('stroke', '#2196F3');
            handle.setAttribute('stroke-width', '1');
            handle.setAttribute('class', 'transform-handle scale-handle');
            handle.setAttribute('data-corner', c.name);
            if (shapeId) {
                handle.setAttribute('data-shape-id', shapeId);
            }
            handle.style.cursor = c.cursor;
            viewport.appendChild(handle);
        });

        // 回転ノブへの縦線
        const cx = x1 + w1 / 2;
        const cy = y1;
        const ry = cy - 20;

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', cx);
        line.setAttribute('y1', cy);
        line.setAttribute('x2', cx);
        line.setAttribute('y2', ry);
        line.setAttribute('stroke', '#2196F3');
        line.setAttribute('stroke-width', '1');
        viewport.appendChild(line);

        // 回転ノブ
        const knob = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        knob.setAttribute('cx', cx);
        knob.setAttribute('cy', ry);
        knob.setAttribute('r', '4');
        knob.setAttribute('fill', '#2196F3');
        knob.setAttribute('stroke', 'white');
        knob.setAttribute('stroke-width', '1');
        knob.setAttribute('class', 'transform-handle rotate-handle');
        if (shapeId) {
            knob.setAttribute('data-shape-id', shapeId);
        }
        knob.style.cursor = 'grab';
        viewport.appendChild(knob);
    };

    if (state.transformPivotMode === 'individual') {
        state.selectedShapeIds.forEach(id => {
            const bounds = getCombinedBounds([id]);
            drawBoxHandles(bounds, id);
        });
    } else if (state.transformPivotMode === 'active') {
        const activeId = state.selectedShapeIds[state.selectedShapeIds.length - 1];
        const bounds = getCombinedBounds([activeId]);
        drawBoxHandles(bounds, activeId);
    } else {
        const bounds = getCombinedBounds(state.selectedShapeIds);
        drawBoxHandles(bounds, null);
    }
}

function drawOffscreenToOnscreen(onscreen, offscreen) { // MEMO: [ASK] そもそも onscreen と offscreen を分けているのって、チラつき防止のため？ onscreen を 1つの canvas にして offscreen 3枚からの WebGL での転写にすると速かったりする？
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

    // SVG viewport の scale/rotate/pan と同期
    ctx.translate(state.pan.x, state.pan.y);
    ctx.scale(state.zoom, state.zoom);
    ctx.rotate(state.rotation * Math.PI / 180);

    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();
}

function drawLayerToCanvasContext(ctx, layerId) {
    const layer = state.layers[layerId];
    if (!layer || layer.visible === false) return;

    ctx.save();
    ctx.globalAlpha *= (layer.style?.opacity ?? 1);
    layer.childIds?.forEach(childId => drawShapeToCanvasContext(ctx, childId));
    ctx.restore();
}

function drawShapeToCanvasContext(ctx, shapeId) {
    const shape = state.shapes[shapeId];
    if (!shape) return;

    ctx.save();

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
            cCtx.closePath();

            let drawn = false;
            if (shape.style?.fillPattern) {
                currentRenderCoonsCount++;
                const meshPositions = generateCoonsPatchMesh(shape, state.beziers);
                if (meshPositions) {
                    const webglCanvas = WebGLRenderer.renderPattern(meshPositions, shape.style.fillPattern, state.canvas.width, state.canvas.height);
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
                const meshPositions = generateStrokeCoonsPatchMesh(shape, state.beziers);
                if (meshPositions) {
                    const webglCanvas = WebGLRenderer.renderPattern(meshPositions, shape.style.strokePattern, state.canvas.width, state.canvas.height);
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
    ctx.restore();
}

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
        const layer = state.layers[layerId];
        if (!layer) return;

        if (layerId === state.selectedLayerId) {
            foundActive = true;
            drawLayerToCanvasContext(activeCtx, layerId);
        } else {
            const targetCtx = foundActive ? overCtx : underCtx;
            drawLayerToCanvasContext(targetCtx, layerId);
        }
    });
}

function renderMinimap() {
    const canvas = document.getElementById('minimap-canvas');
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
        drawLayerToCanvasContext(activeCtx, activeLayerId);
    }

    // キャンバス全体がミニマップにフィットする基本スケールを算出
    const baseScale = Math.min(canvas.width / state.canvas.width, canvas.height / state.canvas.height);
    const zoomScale = baseScale * state.minimap.zoom;

    ctx.save();
    // ミニマップキャンバスの中心を基準にズームを適用
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(zoomScale, zoomScale);
    ctx.translate(-state.canvas.width / 2, -state.canvas.height / 2);

    // 各オフスクリーンを重ねて転写
    if (state.canvas.underOffscreen) ctx.drawImage(state.canvas.underOffscreen, 0, 0);
    if (state.canvas.activeOffscreen) ctx.drawImage(state.canvas.activeOffscreen, 0, 0);
    if (state.canvas.overOffscreen) ctx.drawImage(state.canvas.overOffscreen, 0, 0);

    ctx.restore();
}

function renderGuides(id, container) {
    const shape = state.shapes[id];
    if (!shape) return;

    // レイヤー非表示時のスキップ
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
        // 3. ガイド線
        const guidePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const v = i => state.beziers[shape.bezierIds[i]].controlPoints.map(cp => cp.v);
        const ps = (vArr, j) => `${vArr[j].x},${vArr[j].y}`;
        const d = `M ${ps(v(0), 0)} ` + shape.bezierIds.map((bid, i) => `C ${ps(v(i), 1)} ${ps(v(i), 2)} ${ps(v(i), 3)}`).join(' ') + ' Z';

        guidePath.setAttribute('d', d);
        guidePath.setAttribute('fill', 'none');

        const isSelected = state.selectedShapeIds.includes(shape.id);
        const isAnchored = state.anchoredShapeIds?.includes(shape.id);
        let strokeColor = ((shape.style && shape.style.fill) || '#2196F3') + '44'; // 薄い半透明
        let strokeWidth = 0.5;
        if (isSelected) {
            strokeColor = '#ffeb3b'; // 黄色
            strokeWidth = 1.5;
        } else if (isAnchored) {
            strokeColor = '#ff9800'; // オレンジ
            strokeWidth = 1.5;
        }
        guidePath.setAttribute('stroke', strokeColor);
        guidePath.setAttribute('stroke-width', strokeWidth);
        g.appendChild(guidePath);

        // 4. 太さ編集モードのインジケータ表示
        if (state.thicknessEdit.active && state.selectedShapeIds.includes(shape.id)) {
            // (a) 既存データポイントの描画
            if (shape.strokeWidthData) {
                shape.strokeWidthData.forEach((ptData) => {
                    const { p, nx, ny } = MDMath.getShapePointAndNormal(shape, ptData.t, state.beziers);
                    const r = ptData.w / 2;

                    // 幅を示す線 (黄色)
                    addLine(p.x - nx * r, p.y - ny * r, p.x + nx * r, p.y + ny * r, '#ffeb3b', 2);
                    // 座標点 (黄色円)
                    addCircle(p.x, p.y, 4, 'white', '#ffeb3b', 1.5);
                });
            }
            // 狙う位置の点 (赤色二重円)
            addCircle(p.x, p.y, 6, 'none', '#f44336', 1.5);
            addCircle(p.x, p.y, 3, '#f44336', '#f44336', 0);
        }

        // 5. パターン編集モードのインジケータ表示
        if (state.patternEdit.active && state.selectedShapeIds.includes(shape.id)) {
            // (a) 4隅の既存位置を描画
            if (shape.patternCorners) {
                ['TL', 'TR', 'BR', 'BL'].forEach((key) => {
                    const tCorner = shape.patternCorners[key];
                    if (tCorner === undefined) return;

                    const p = getShapePoint(shape, tCorner);
                    const isSelected = (state.patternEdit.selectedCorner === key);

                    // 青色ハンドル円
                    addCircle(p.x, p.y, isSelected ? 7 : 5, isSelected ? '#2196F3' : 'white', '#2196F3', 2);

                    // ラベル（TL, TR, BR, BL）
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

            // (b) 現在狙っている targetT のインジケータ (赤色二重円)
            const targetT = state.patternEdit.targetT;
            const p = getShapePoint(shape, targetT);

            addCircle(p.x, p.y, 6, 'none', '#f44336', 1.5);
            addCircle(p.x, p.y, 3, '#f44336', '#f44336', 0);
        }
    } /* shape.bezierIds */
    container.appendChild(g);
}

function getSVGPoint(e, element) {
    const svg = document.getElementById('guide-svg');
    const el = element || svg;
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    return p.matrixTransform(el.getScreenCTM().inverse());
} /* getSVGPoint */

function initDB() {
    const request = indexedDB.open('morph-draw-db', 1);
    request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('drawings')) {
            db.createObjectStore('drawings', { keyPath: 'id' });
        }
    }; /* onupgradeneeded */
    request.onsuccess = (e) => { db = e.target.result; loadGallery(); };
} /* initDB */

function switchView(viewId) {
    state.view = viewId;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewId}`).classList.add('active');
} /* switchView */

async function saveDrawing() {
    if (!state.currentDrawId || !db) return;

    const baseW = state.canvas.width || 800;
    const baseH = state.canvas.height || 600;
    const scale = Math.min(512 / baseW, 512 / baseH);
    const thumbW = Math.round(baseW * scale);
    const thumbH = Math.round(baseH * scale);

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = thumbW;
    tempCanvas.height = thumbH;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.clearRect(0, 0, thumbW, thumbH);

    const activeLayerId = state.selectedLayerId;
    if (activeLayerId && state.canvas.activeOffscreen) {
        const activeCtx = state.canvas.activeOffscreen.getContext('2d');
        activeCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        drawLayerToCanvasContext(activeCtx, activeLayerId);
    }

    [state.canvas.underOffscreen, state.canvas.activeOffscreen, state.canvas.overOffscreen].forEach(offscreen => {
        if (offscreen) {
            tempCtx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, 0, 0, thumbW, thumbH);
        }
    });

    const previewBlob = await new Promise((resolve) => {
        tempCanvas.toBlob((blob) => resolve(blob), 'image/png');
    });

    const tx = db.transaction('drawings', 'readwrite');
    const store = tx.objectStore('drawings');
    const cleaned = JSON.parse(JSON.stringify({
        shapes: state.shapes,
        beziers: state.beziers,
        layers: state.layers,
        scene: state.scene
    }, stateReplacer));

    await store.put({
        id: state.currentDrawId,
        name: state.drawingName || 'Untitled',
        type: state.drawingType || 'canvas',
        shapes: cleaned.shapes,
        beziers: cleaned.beziers,
        layers: cleaned.layers,
        scene: cleaned.scene,
        canvas: { width: state.canvas.width, height: state.canvas.height },
        preview: previewBlob,
        updatedAt: Date.now()
    });
} /* saveDrawing */

function loadGallery() {
    if (!db) return;
    const tx = db.transaction('drawings', 'readonly');
    const store = tx.objectStore('drawings');
    const request = store.getAll();
    request.onsuccess = () => {
        const drawings = request.result;
        let max = 0;
        for (const d of drawings) {
            if (d.id && d.id.startsWith('d')) {
                const num = parseInt(d.id.substring(1), 10);
                if (!isNaN(num) && num > max) max = num;
            }
        }
        state.maxDrawingId = max;
        renderGalleryGrid(drawings);
    };
} /* loadGallery */

let activeGalleryUrls = [];

function renderGalleryGrid(items) {
    const listCanvas = document.getElementById('gallery-list-canvas');
    const listPattern = document.getElementById('gallery-list-pattern');
    const listImport = document.getElementById('gallery-list-import');

    // 古いオブジェクトURLを解放してメモリリークを防ぐ
    activeGalleryUrls.forEach(url => URL.revokeObjectURL(url));
    activeGalleryUrls = [];

    if (listCanvas) listCanvas.innerHTML = '';
    if (listPattern) listPattern.innerHTML = '';
    if (listImport) listImport.innerHTML = '';

    items.sort((a, b) => b.updatedAt - a.updatedAt).forEach(item => {
        const card = document.createElement('div');
        card.className = 'gallery-card';

        let imgSrc = '';
        if (item.preview) {
            if (item.preview instanceof Blob) {
                imgSrc = URL.createObjectURL(item.preview);
                activeGalleryUrls.push(imgSrc);
            } else {
                // 過去データ（Base64/SVG文字列）との後方互換性維持
                imgSrc = item.preview;
            }
        }

        card.innerHTML = `
            <div class="card-preview">
                ${imgSrc ? `<img src="${imgSrc}" alt="preview">` : ''}
            </div>
            <div class="card-info">
                <div class="card-title-group">
                    <span class="card-name">${item.name || ('Drawing ' + item.id)}</span>
                    <span class="card-id-badge">${item.id}</span>
                </div>
                <button class="btn-card-delete" data-id="${item.id}"><i class="bi bi-trash"></i></button>
            </div>
        `; /* card.innerHTML */

        const type = item.type || 'canvas';
        if (type === 'import_image') {
            card.style.cursor = 'default';
        } else {
            card.onclick = () => openDrawing(item.id);
        }

        const deleteBtn = card.querySelector('.btn-card-delete');
        if (deleteBtn) {
            deleteBtn.onclick = (e) => deleteDrawing(item.id, e);
        }

        if (type === 'pattern' && listPattern) {
            listPattern.appendChild(card);
        } else if (type === 'import_image' && listImport) {
            listImport.appendChild(card);
        } else if (listCanvas) {
            listCanvas.appendChild(card);
        }
    }); /* items.forEach */
} /* renderGalleryGrid */

async function deleteDrawing(id, e) {
    e.stopPropagation();
    if (!confirm('このお絵かきを削除しますか？')) return;
    const tx = db.transaction('drawings', 'readwrite');
    const store = tx.objectStore('drawings');
    await store.delete(id);
    loadGallery();
} /* deleteDrawing */

function openDrawing(id) {
    const tx = db.transaction('drawings', 'readonly');
    const store = tx.objectStore('drawings');
    const request = store.get(id);
    request.onsuccess = () => {
        const data = request.result;
        state.currentDrawId = data.id;
        state.drawingType = data.type || 'canvas';
        state.drawingName = data.name || `Drawing ${data.id}`;
        const nameInput = document.getElementById('input-draw-name');
        if (nameInput) {
            nameInput.value = state.drawingName;
        }
        state.shapes = data.shapes || {};
        state.beziers = data.beziers || {};
        state.layers = data.layers || {};
        state.scene = data.scene || [];

        // レイヤーが無い場合、初期レイヤーを作成（後方互換）
        if (Object.keys(state.layers).length === 0) {
            const defaultLayerId = generateId('l');
            state.layers[defaultLayerId] = {
                id: defaultLayerId,
                name: 'Layer 1',
                childIds: Object.keys(state.shapes).filter(sid => !sid.startsWith('l')),
                visible: true,
                style: { opacity: 1 }
            };
            state.scene = [defaultLayerId];
        }

        // ベジェの親 ID 紐付けを逆算して格納
        Object.entries(state.shapes).forEach(([sid, shape]) => {
            if (shape.bezierIds) {
                shape.bezierIds.forEach(bid => {
                    if (state.beziers[bid]) {
                        state.beziers[bid].parentId = sid;
                    }
                });
            }
        });

        // 履歴の初期化
        state.history = [];
        state.historyIndex = -1;

        // キャンバスサイズ設定の復元と UI 同期
        if (data.canvas) {
            state.canvas.width = data.canvas.width || 800;
            state.canvas.height = data.canvas.height || 600;
        } else {
            state.canvas.width = 800;
            state.canvas.height = 600;
        }
        const widthInput = document.getElementById('input-canvas-width');
        const heightInput = document.getElementById('input-canvas-height');
        if (widthInput && heightInput) {
            widthInput.value = state.canvas.width;
            heightInput.value = state.canvas.height;
        }
        resizeOffscreenCanvases();

        migrateDrawingData(state.shapes);

        // IDカウンタの初期化
        initializeIdCounter();

        // アクティブなレイヤーを設定
        state.selectedLayerId = state.scene[0];

        // 依存パターンテクスチャの事前ロード
        const textureIdsToLoad = new Set();
        Object.values(state.shapes).forEach(shape => {
            if (shape && shape.style) {
                if (shape.style.fillPattern) textureIdsToLoad.add(shape.style.fillPattern);
                if (shape.style.strokePattern) textureIdsToLoad.add(shape.style.strokePattern);
            }
        });

        const loadPromises = Array.from(textureIdsToLoad).map(id => loadDrawingTexture(id));
        Promise.all(loadPromises).then(() => {
            resolveBezierDependencies();
            clearAllCaches();
            rasterizeInactiveLayers();
            renderCanvas();
            pushHistory();
            switchView('canvas');
        });
    }; /* onsuccess */
} /* openDrawing */

function migrateDrawingData(shapes) {
    Object.values(shapes).forEach(shape => {
        if (shape && shape.type === 'bezier-group') {
            if (shape.style) {
                if (shape.style.outline === undefined) shape.style.outline = true;
                if (shape.style.fillEnabled === undefined) shape.style.fillEnabled = true;
            } else {
                shape.style = { fill: '#2196F3', opacity: 0.7, outline: true, fillEnabled: true };
            }
            if (!shape.strokeWidthData) {
                shape.strokeWidthData = [{ t: 0, w: 10 }, { t: 1, w: 10 }];
            }
        }
    });
}

function resizeImageToBlob(file, maxWidth, maxHeight) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const tempCanvas = document.createElement('canvas');
                let w = img.width;
                let h = img.height;
                const scale = Math.min(maxWidth / w, maxHeight / h);
                const thumbW = Math.round(w * scale);
                const thumbH = Math.round(h * scale);

                tempCanvas.width = thumbW;
                tempCanvas.height = thumbH;
                const ctx = tempCanvas.getContext('2d');
                ctx.drawImage(img, 0, 0, thumbW, thumbH);
                tempCanvas.toBlob((blob) => {
                    resolve(blob);
                }, 'image/png');
            };
            img.onerror = () => resolve(null);
            img.src = event.target.result;
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

function importImageFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png, image/jpeg';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const previewBlob = await resizeImageToBlob(file, 512, 512);
        if (!previewBlob) return;

        state.maxDrawingId++;
        const newId = `d${state.maxDrawingId}`;
        const name = file.name;

        const img = await new Promise((resolve) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => resolve(null);
            i.src = URL.createObjectURL(file);
        });

        const width = img ? img.width : 800;
        const height = img ? img.height : 600;
        if (img) URL.revokeObjectURL(img.src);

        const tx = db.transaction('drawings', 'readwrite');
        const store = tx.objectStore('drawings');

        await store.put({
            id: newId,
            name: name,
            type: 'import_image',
            shapes: {},
            beziers: {},
            scene: [],
            canvas: { width, height },
            preview: previewBlob,
            updatedAt: Date.now()
        });

        loadGallery();
    };
    input.click();
}

function startNewDrawing(type = 'canvas') {
    state.maxDrawingId++;
    state.currentDrawId = `d${state.maxDrawingId}`;
    state.drawingType = type;
    if (type === 'pattern') {
        state.drawingName = `Pattern ${state.currentDrawId}`;
    } else {
        state.drawingName = `Drawing ${state.currentDrawId}`;
    }
    const nameInput = document.getElementById('input-draw-name');
    if (nameInput) {
        nameInput.value = state.drawingName;
    }
    state.shapes = {};
    state.beziers = {};
    state.layers = {};
    state.scene = [];
    state.selectedShapeIds = [];
    state.zoom = 1;
    state.rotation = 0;
    state.pan = { x: 0, y: 0 };
    state.history = [];
    state.historyIndex = -1;
    state.nextIdCounter = 1;

    state.canvas.width = 800;
    state.canvas.height = 600;
    const widthInput = document.getElementById('input-canvas-width');
    const heightInput = document.getElementById('input-canvas-height');
    if (widthInput && heightInput) {
        widthInput.value = 800;
        heightInput.value = 600;
    }
    resizeOffscreenCanvases();

    const layerId = generateId('l');
    state.layers[layerId] = {
        id: layerId,
        name: 'Layer 1',
        childIds: [],
        style: { opacity: 1 },
        visible: true
    };
    state.scene = [layerId];
    state.selectedLayerId = layerId;

    clearAllCaches();
    rasterizeInactiveLayers();
    renderCanvas();
    pushHistory();
    switchView('canvas');
} /* startNewDrawing */

function addLayer() {
    const id = generateId('l');
    const count = state.scene.length + 1;
    state.layers[id] = {
        id,
        name: `Layer ${count}`,
        childIds: [],
        style: { opacity: 1 },
        visible: true
    };
    state.scene.push(id);
    state.selectedLayerId = id;
    rasterizeInactiveLayers();
    renderCanvas();
    pushHistory();
} /* addLayer */

function deleteLayer(layerId) {
    const layer = state.layers[layerId];
    if (!layer) return;

    if (state.scene.length <= 1) {
        return;
    }

    if (!confirm(`レイヤー「${layer.name}」と内包するすべての図形を削除しますか？`)) return;

    // レイヤー内の子Shapeを削除
    layer.childIds.forEach(shapeId => {
        const shape = state.shapes[shapeId];
        if (shape) {
            shape.bezierIds?.forEach(bid => delete state.beziers[bid]);
            delete state.shapes[shapeId];
        }
    });

    // レイヤー自身を削除
    delete state.layers[layerId];
    state.scene = state.scene.filter(id => id !== layerId);

    // 選択レイヤーの更新
    if (state.selectedLayerId === layerId) {
        state.selectedLayerId = state.scene[state.scene.length - 1];
    }

    rasterizeInactiveLayers();
    renderCanvas();
    pushHistory();
} /* deleteLayer */

function renderLayerList() {
    const list = document.getElementById('layer-list');
    if (!list) return;
    list.innerHTML = '';

    const query = state.search.query || '';

    [...state.scene].reverse().forEach(layerId => {
        const layer = state.layers[layerId];
        if (!layer) return;

        const childShapes = layer.childIds.map(id => state.shapes[id]).filter(Boolean);
        const matchedShapes = childShapes.filter(shape => {
            if (!query) return true;
            return shape.id.toLowerCase().includes(query) || (shape.name && shape.name.toLowerCase().includes(query));
        });

        const layerMatches = query && layer.name.toLowerCase().includes(query);
        if (query && matchedShapes.length === 0 && !layerMatches) {
            return;
        }

        const item = document.createElement('div');
        item.className = `layer-item${state.selectedLayerId === layerId ? ' active' : ''}${layer.visible ? '' : ' hidden-layer'}`;
        item.style.flexDirection = 'column';
        item.style.alignItems = 'stretch';
        item.style.padding = '4px 8px';

        item.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
                <div class="layer-info" style="display:flex; align-items:center; gap:6px;">
                    <span class="layer-visibility-btn" style="cursor:pointer;"><i class="bi ${layer.visible ? 'bi-eye' : 'bi-eye-slash'}"></i></span>
                    <input class="layer-name-input" type="text" value="${layer.name}" style="font-weight:600; border:none; background:transparent; width:100px;">
                </div>
                <div class="layer-controls">
                    <button class="layer-control-btn btn-layer-delete"><i class="bi bi-trash"></i></button>
                </div>
            </div>
            <div class="layer-shapes-list" style="margin-left: 16px; margin-top: 4px; display:flex; flex-direction:column; gap:2px;"></div>
        `;

        item.addEventListener('click', (e) => {
            if (e.target.closest('input') || e.target.closest('button') || e.target.closest('.layer-visibility-btn') || e.target.closest('.shape-item-row')) return;
            state.selectedLayerId = layerId;
            state.selectedShapeIds = [];
            rasterizeInactiveLayers();
            renderCanvas();
            updatePropertiesPanel();
            renderLayerList();
        });

        item.querySelector('.layer-visibility-btn').onclick = (e) => {
            e.stopPropagation();
            layer.visible = !layer.visible;
            rasterizeInactiveLayers();
            renderCanvas();
            pushHistory();
            renderLayerList();
        };

        const input = item.querySelector('.layer-name-input');
        input.onblur = () => {
            if (input.value.trim() !== '') {
                layer.name = input.value.trim();
                pushHistory();
            } else {
                input.value = layer.name;
            }
        };
        input.onkeydown = (e) => {
            if (e.key === 'Enter') input.blur();
        };

        item.querySelector('.btn-layer-delete').onclick = (e) => {
            e.stopPropagation();
            deleteLayer(layerId);
            renderLayerList();
        };

        const shapesListDiv = item.querySelector('.layer-shapes-list');
        matchedShapes.forEach(shape => {
            const shapeRow = document.createElement('div');
            shapeRow.className = 'shape-item-row';
            const isSelected = state.selectedShapeIds.includes(shape.id);
            shapeRow.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 4px 6px;
                background: ${isSelected ? '#e3f2fd' : 'transparent'};
                border-radius: 4px;
                font-size: 11px;
                color: #555;
                cursor: pointer;
                border: 1px solid ${isSelected ? '#2196F3' : 'transparent'};
            `;

            shapeRow.innerHTML = `
                <span style="font-weight: 500;">${shape.name || shape.type}</span>
                <span style="font-size: 9px; color: #999; font-family: monospace;">${shape.id}</span>
            `;

            shapeRow.onclick = (e) => {
                e.stopPropagation();
                if (e.shiftKey || e.ctrlKey || e.metaKey) {
                    if (isSelected) {
                        state.selectedShapeIds = state.selectedShapeIds.filter(id => id !== shape.id);
                    } else {
                        state.selectedShapeIds.push(shape.id);
                    }
                } else {
                    state.selectedShapeIds = [shape.id];
                }
                state.selectedLayerId = layerId;
                renderCanvas();
                updatePropertiesPanel();
                renderLayerList();
            };

            shapesListDiv.appendChild(shapeRow);
        });

        list.appendChild(item);
    });
} /* renderLayerList */

function updatePropertiesPanel() {
    const container = document.getElementById('properties-container');
    if (!container) return;

    if (state.selectedShapeIds.length === 0) {
        container.innerHTML = `<p style="color: #999; font-style: italic; text-align: center; margin-top: 20px;">要素を選択してください</p>`;
        return;
    }

    const activeId = state.selectedShapeIds[state.selectedShapeIds.length - 1];
    const shape = state.shapes[activeId];
    if (!shape) {
        container.innerHTML = `<p style="color: #999; font-style: italic; text-align: center; margin-top: 20px;">要素を選択してください</p>`;
        return;
    }

    let html = '';

    html += `
        <div class="prop-group">
            <span class="prop-label">ID: ${shape.id} (Type: ${shape.type})</span>
            <input type="text" id="prop-name" class="prop-input" value="${shape.name || ''}" placeholder="名前">
        </div>
    `;

    if (shape.props) {
        html += `<div style="border-top:1px solid #eee; margin-top:8px; padding-top:8px;"><strong>幾何プロパティ</strong></div>`;
        const hasX = shape.props.x !== undefined;
        const hasY = shape.props.y !== undefined;
        
        if (hasX && hasY) {
            html += `
                <div class="prop-group" style="margin-top:6px;">
                    <span class="prop-label">位置 (X, Y)</span>
                    <div class="prop-row" style="align-items: center; gap: 8px;">
                        <div style="display:flex; flex-direction:column; gap:4px; flex:1;">
                            <div style="display:flex; align-items:center; gap:4px;">
                                <span style="font-size:10px; color:#666; width:12px;">X</span>
                                <input type="number" id="prop-val-x" class="prop-input" value="${Math.round(shape.props.x * 100) / 100}" style="font-size:11px; padding:2px 4px;">
                            </div>
                            <div style="display:flex; align-items:center; gap:4px;">
                                <span style="font-size:10px; color:#666; width:12px;">Y</span>
                                <input type="number" id="prop-val-y" class="prop-input" value="${Math.round(shape.props.y * 100) / 100}" style="font-size:11px; padding:2px 4px;">
                            </div>
                        </div>
                        <div class="prop-drag-2d-pad" id="prop-drag-2d-pad" style="width:40px; height:40px; border:1px solid #ccc; border-radius:4px; background:#fafafa; cursor:move; display:flex; justify-content:center; align-items:center; flex-shrink:0;" title="ドラッグで位置調整">
                            <i class="bi bi-arrows-move" style="font-size:12px; color:#888;"></i>
                        </div>
                    </div>
                </div>
            `;
        }

        Object.entries(shape.props).forEach(([key, val]) => {
            if ((key === 'x' || key === 'y') && hasX && hasY) return;
            html += `
                <div class="prop-group" style="margin-top:6px;">
                    <span class="prop-label">${key}</span>
                    <div class="prop-row">
                        <input type="number" id="prop-val-${key}" class="prop-input" value="${Math.round(val * 100) / 100}">
                        <button class="prop-drag-btn" data-prop="${key}" title="ドラッグで調整"><i class="bi bi-arrows-move"></i></button>
                    </div>
                </div>
            `;
        });
    }

    if (shape.style) {
        html += `<div style="border-top:1px solid #eee; margin-top:8px; padding-top:8px;"><strong>スタイル</strong></div>`;
        html += `
            <div class="prop-row" style="margin-top:6px; justify-content:space-between;">
                <label style="display:flex; align-items:center; gap:4px; font-size:11px;">
                    <input type="checkbox" id="prop-fill-enabled" ${shape.style.fillEnabled ? 'checked' : ''}> 塗りつぶし
                </label>
                <label style="display:flex; align-items:center; gap:4px; font-size:11px;">
                    <input type="checkbox" id="prop-outline-enabled" ${shape.style.outline ? 'checked' : ''}> 輪郭線
                </label>
            </div>
            <div class="prop-group" style="margin-top:6px;">
                <span class="prop-label">色</span>
                <div class="prop-row">
                    <input type="color" id="prop-fill-color" class="prop-input" value="${shape.style.fill || '#2196F3'}" style="padding:0; height:24px; border:none; cursor:pointer;">
                </div>
            </div>
            <div class="prop-group" style="margin-top:6px;">
                <span class="prop-label">不透明度 (${Math.round((shape.style.opacity ?? 1) * 100)}%)</span>
                <input type="range" id="prop-opacity" class="prop-input" min="0" max="1" step="0.05" value="${shape.style.opacity ?? 1}">
            </div>
            <div class="prop-group" style="margin-top:6px;">
                <span class="prop-label">パターンテクスチャ</span>
                <div class="prop-row">
                    <input type="text" id="prop-fill-pattern" class="prop-input" value="${shape.style.fillPattern || ''}" readonly placeholder="パターンなし">
                    <button class="prop-action-btn" id="btn-select-pattern" title="パターン選択"><i class="bi bi-images"></i></button>
                    ${shape.style.fillPattern ? `<button class="prop-action-btn" id="btn-clear-pattern" title="解除"><i class="bi bi-x-lg"></i></button>` : ''}
                </div>
            </div>
        `;
    }

    if (shape.points) {
        html += `
            <div style="border-top:1px solid #eee; margin-top:8px; padding-top:8px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <strong>接続点 (points)</strong>
                    <button class="small-btn" id="btn-add-point" style="padding: 2px 4px; font-size:10px;"><i class="bi bi-plus"></i> 追加</button>
                </div>
            </div>
            <div style="margin-top:6px; max-height: 120px; overflow-y:auto; padding-right:4px;">
        `;
        shape.points.forEach((pt, idx) => {
            html += `
                <div class="prop-list-item" data-idx="${idx}">
                    <span style="font-size:10px; color:#666;">#${idx}: t=${Math.round(pt.t * 100) / 100}</span>
                    <div style="display:flex; gap:4px; align-items:center;">
                        <button class="prop-drag-btn small-btn" data-pt-idx="${idx}" title="t値をドラッグ調整" style="padding:2px 4px; font-size:10px;"><i class="bi bi-arrows-move"></i></button>
                        <button class="prop-action-btn small-btn btn-change-bezier" data-pt-idx="${idx}" title="ベジェ変更" style="padding:2px 4px; font-size:10px;"><i class="bi bi-link"></i></button>
                        <button class="prop-action-btn small-btn btn-delete-point" data-pt-idx="${idx}" style="padding:2px 4px; font-size:10px; background:#ff5252; color:#fff;"><i class="bi bi-trash"></i></button>
                    </div>
                </div>
            `;
        });
        html += `</div>`;
    }

    if (shape.strokeWidthData) {
        html += `
            <div style="border-top:1px solid #eee; margin-top:8px; padding-top:8px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <strong>太さデータ</strong>
                    <button class="small-btn" id="btn-add-thickness" style="padding: 2px 4px; font-size:10px;"><i class="bi bi-plus"></i> 追加</button>
                </div>
            </div>
            <div style="margin-top:6px; max-height: 120px; overflow-y:auto; padding-right:4px;">
        `;
        shape.strokeWidthData.forEach((sd, idx) => {
            html += `
                <div class="prop-list-item" data-idx="${idx}">
                    <span style="font-size:10px; color:#666;">p=${sd.p}, w=${sd.w}</span>
                    <div style="display:flex; gap:4px; align-items:center;">
                        <button class="prop-drag-btn small-btn" data-thick-idx="${idx}" data-thick-type="p" title="位置pをドラッグ調整" style="padding:2px 4px; font-size:10px;">p</button>
                        <button class="prop-drag-btn small-btn" data-thick-idx="${idx}" data-thick-type="w" title="太さwをドラッグ調整" style="padding:2px 4px; font-size:10px;">w</button>
                        <button class="prop-action-btn small-btn btn-delete-thick" data-thick-idx="${idx}" style="padding:2px 4px; font-size:10px; background:#ff5252; color:#fff;"><i class="bi bi-trash"></i></button>
                    </div>
                </div>
            `;
        });
        html += `</div>`;
    }

    if (shape.patternCorners) {
        html += `
            <div style="border-top:1px solid #eee; margin-top:8px; padding-top:8px;"><strong>パターン角接続点 (インデックス)</strong></div>
            <div style="margin-top:6px; display:grid; grid-template-columns:1fr 1fr; gap:6px;">
        `;
        ['TL', 'TR', 'BR', 'BL'].forEach(corner => {
            const pIdx = shape.patternCorners[corner] ?? 0;
            html += `
                <div class="prop-group">
                    <span class="prop-label">${corner}</span>
                    <div class="prop-row">
                        <input type="number" id="prop-corner-${corner}" class="prop-input" value="${pIdx}" style="padding:2px 4px;">
                        <button class="prop-drag-btn" data-corner="${corner}" style="padding:2px 4px;"><i class="bi bi-arrows-move"></i></button>
                    </div>
                </div>
            `;
        });
        html += `</div>`;
    }

    const activeElementId = document.activeElement ? document.activeElement.id : null;
    const selectionStart = document.activeElement ? document.activeElement.selectionStart : null;
    const selectionEnd = document.activeElement ? document.activeElement.selectionEnd : null;

    container.innerHTML = html;

    if (activeElementId) {
        const activeEl = document.getElementById(activeElementId);
        if (activeEl) {
            activeEl.focus();
            if (selectionStart !== null && selectionEnd !== null && activeEl.setSelectionRange) {
                try { activeEl.setSelectionRange(selectionStart, selectionEnd); } catch(err){}
            }
        }
    }

    const nameInput = document.getElementById('prop-name');
    if (nameInput) {
        nameInput.oninput = () => {
            shape.name = nameInput.value;
            renderLayerList();
        };
        nameInput.onchange = () => {
            pushHistory();
        };
    }

    if (shape.props) {
        Object.keys(shape.props).forEach(key => {
            const inputEl = document.getElementById(`prop-val-${key}`);
            if (inputEl) {
                inputEl.oninput = () => {
                    let val = parseFloat(inputEl.value);
                    if (isNaN(val)) val = 0;
                    shape.props[key] = val;
                    markShapeDirty(shape.id);
                    resolveBezierDependencies();
                    clearAllCaches();
                    renderCanvas();
                };
                inputEl.onchange = () => {
                    pushHistory();
                };
            }
        });
    }

    const drag2DPad = document.getElementById('prop-drag-2d-pad');
    if (drag2DPad) {
        drag2DPad.onmousedown = (e) => {
            handleValueDrag2D(e, (dx, dy) => {
                if (shape.props.x !== undefined) shape.props.x += dx;
                if (shape.props.y !== undefined) shape.props.y += dy;
                markShapeDirty(shape.id);
            });
        };
    }

    container.querySelectorAll('.prop-drag-btn[data-prop]').forEach(btn => {
        const prop = btn.getAttribute('data-prop');
        btn.onmousedown = (e) => {
            handleValueDrag(e, (dx) => {
                let step = 1;
                if (prop === 'rotation') step = 0.5;
                if (prop === 'r') step = 0.5;
                shape.props[prop] = (shape.props[prop] ?? 0) + dx * step;
                if (prop === 'r') shape.props[prop] = Math.max(1, shape.props[prop]);
            });
        };
    });

    const fillCheck = document.getElementById('prop-fill-enabled');
    if (fillCheck) {
        fillCheck.onchange = () => {
            shape.style.fillEnabled = fillCheck.checked;
            pushHistory();
            renderCanvas();
        };
    }
    const outlineCheck = document.getElementById('prop-outline-enabled');
    if (outlineCheck) {
        outlineCheck.onchange = () => {
            shape.style.outline = outlineCheck.checked;
            pushHistory();
            renderCanvas();
        };
    }
    const fillColor = document.getElementById('prop-fill-color');
    if (fillColor) {
        fillColor.oninput = () => {
            shape.style.fill = fillColor.value;
            markShapeDirty(shape.id);
            renderCanvas();
        };
        fillColor.onchange = () => {
            pushHistory();
        };
    }
    const opacityRange = document.getElementById('prop-opacity');
    if (opacityRange) {
        opacityRange.oninput = () => {
            shape.style.opacity = parseFloat(opacityRange.value);
            const label = opacityRange.closest('.prop-group')?.querySelector('.prop-label');
            if (label) {
                label.textContent = `不透明度 (${Math.round((shape.style.opacity ?? 1) * 100)}%)`;
            }
            markShapeDirty(shape.id);
            renderCanvas();
        };
        opacityRange.onchange = () => {
            pushHistory();
        };
    }

    const btnSelectPattern = document.getElementById('btn-select-pattern');
    if (btnSelectPattern) {
        btnSelectPattern.onclick = () => {
            showTexturePicker((textureId) => {
                shape.style.fillPattern = textureId;
                pushHistory();
                renderCanvas();
                updatePropertiesPanel();
            });
        };
    }
    const btnClearPattern = document.getElementById('btn-clear-pattern');
    if (btnClearPattern) {
        btnClearPattern.onclick = () => {
            shape.style.fillPattern = undefined;
            pushHistory();
            renderCanvas();
            updatePropertiesPanel();
        };
    }

    container.querySelectorAll('.prop-drag-btn[data-pt-idx]').forEach(btn => {
        const ptIdx = parseInt(btn.getAttribute('data-pt-idx'), 10);
        btn.onmousedown = (e) => {
            handleValueDrag(e, (dx) => {
                const pt = shape.points[ptIdx];
                if (pt) {
                    pt.t = Math.max(0, Math.min(1, pt.t + dx * 0.005));
                }
            });
        };
    });

    container.querySelectorAll('.prop-list-item[data-idx]').forEach(item => {
        const idx = parseInt(item.getAttribute('data-idx'), 10);
        item.onmouseenter = () => {
            state.hoveredPoint = { shapeId: shape.id, pointIdx: idx };
            renderCanvas();
        };
        item.onmouseleave = () => {
            state.hoveredPoint = null;
            renderCanvas();
        };
    });

    container.querySelectorAll('.btn-change-bezier[data-pt-idx]').forEach(btn => {
        const ptIdx = parseInt(btn.getAttribute('data-pt-idx'), 10);
        btn.onclick = () => {
            state.interaction.mode = 'pick-point';
            state.interaction.onPick = (picked) => {
                const targetPoint = state.shapes[picked.shapeId]?.points?.[picked.pointIdx];
                if (targetPoint && shape.points[ptIdx]) {
                    shape.points[ptIdx].bezierId = targetPoint.bezierId;
                    shape.points[ptIdx].t = targetPoint.t;
                    pushHistory();
                    resolveBezierDependencies();
                    renderCanvas();
                    updatePropertiesPanel();
                }
            };
            renderCanvas();
        };
    });

    container.querySelectorAll('.btn-delete-point[data-pt-idx]').forEach(btn => {
        const ptIdx = parseInt(btn.getAttribute('data-pt-idx'), 10);
        btn.onclick = () => {
            if (shape.points.length <= 1) return;
            shape.points.splice(ptIdx, 1);
            pushHistory();
            resolveBezierDependencies();
            renderCanvas();
            updatePropertiesPanel();
        };
    });

    const btnAddPoint = document.getElementById('btn-add-point');
    if (btnAddPoint) {
        btnAddPoint.onclick = () => {
            const lastBezId = shape.bezierIds[shape.bezierIds.length - 1];
            shape.points.push({ bezierId: lastBezId, t: 1.0 });
            pushHistory();
            resolveBezierDependencies();
            renderCanvas();
            updatePropertiesPanel();
        };
    }

    container.querySelectorAll('.prop-drag-btn[data-thick-idx]').forEach(btn => {
        const thickIdx = parseInt(btn.getAttribute('data-thick-idx'), 10);
        const type = btn.getAttribute('data-thick-type');
        btn.onmousedown = (e) => {
            handleValueDrag(e, (dx) => {
                const sd = shape.strokeWidthData[thickIdx];
                if (sd) {
                    if (type === 'p') {
                        sd.p = Math.max(0, Math.min(shape.points.length - 1, sd.p + dx * 0.05));
                    } else if (type === 'w') {
                        sd.w = Math.max(0, sd.w + dx * 0.2);
                    }
                }
            });
        };
    });

    container.querySelectorAll('.btn-delete-thick[data-thick-idx]').forEach(btn => {
        const thickIdx = parseInt(btn.getAttribute('data-thick-idx'), 10);
        btn.onclick = () => {
            if (shape.strokeWidthData.length <= 1) return;
            shape.strokeWidthData.splice(thickIdx, 1);
            pushHistory();
            resolveBezierDependencies();
            renderCanvas();
            updatePropertiesPanel();
        };
    });

    const btnAddThickness = document.getElementById('btn-add-thickness');
    if (btnAddThickness) {
        btnAddThickness.onclick = () => {
            shape.strokeWidthData.push({ p: Math.floor(shape.points.length / 2), w: 10 });
            pushHistory();
            resolveBezierDependencies();
            renderCanvas();
            updatePropertiesPanel();
        };
    }

    if (shape.patternCorners) {
        ['TL', 'TR', 'BR', 'BL'].forEach(corner => {
            const inputEl = document.getElementById(`prop-corner-${corner}`);
            if (inputEl) {
                inputEl.oninput = () => {
                    let val = parseInt(inputEl.value, 10);
                    if (isNaN(val)) val = 0;
                    const num = shape.points ? shape.points.length : 0;
                    if (num > 0) {
                        shape.patternCorners[corner] = Math.max(0, Math.min(num - 1, val));
                    }
                    markShapeDirty(shape.id);
                    resolveBezierDependencies();
                    clearAllCaches();
                    renderCanvas();
                };
                inputEl.onchange = () => {
                    pushHistory();
                    updatePropertiesPanel();
                };
            }
        });
    }

    container.querySelectorAll('.prop-drag-btn[data-corner]').forEach(btn => {
        const corner = btn.getAttribute('data-corner');
        btn.onmousedown = (e) => {
            handleValueDrag(e, (dx) => {
                const num = shape.points ? shape.points.length : 0;
                if (num > 0) {
                    shape.patternCorners[corner] = Math.max(0, Math.min(num - 1, Math.round((shape.patternCorners[corner] ?? 0) + dx * 0.05)));
                }
            });
        };
    });
} /* updatePropertiesPanel */

function handleValueDrag(e, callback) {
    e.preventDefault();
    const el = e.currentTarget;
    
    el.requestPointerLock = el.requestPointerLock || el.mozRequestPointerLock;
    if (el.requestPointerLock) {
        el.requestPointerLock();
    }

    let isReleased = false;
    const onMouseMove = (moveEvent) => {
        if (isReleased) return;
        const dx = moveEvent.movementX || 0;
        callback(dx);
        resolveBezierDependencies();
        clearAllCaches();
        renderCanvas();
    };

    const cleanup = () => {
        if (isReleased) return;
        isReleased = true;
        if (document.exitPointerLock && document.pointerLockElement === el) {
            document.exitPointerLock();
        }
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', cleanup);
        document.removeEventListener('pointerup', cleanup);
        document.removeEventListener('pointerlockchange', onLockChange);
        pushHistory();
        renderCanvas();
        updatePropertiesPanel();
    };

    const onLockChange = () => {
        if (document.pointerLockElement !== el) {
            cleanup();
        }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', cleanup);
    document.addEventListener('pointerup', cleanup);
    document.addEventListener('pointerlockchange', onLockChange);
} /* handleValueDrag */

function handleValueDrag2D(e, callback) {
    e.preventDefault();
    const el = e.currentTarget;
    
    el.requestPointerLock = el.requestPointerLock || el.mozRequestPointerLock;
    if (el.requestPointerLock) {
        el.requestPointerLock();
    }

    let isReleased = false;
    const onMouseMove = (moveEvent) => {
        if (isReleased) return;
        const dx = moveEvent.movementX || 0;
        const dy = moveEvent.movementY || 0;
        callback(dx, dy);
        resolveBezierDependencies();
        clearAllCaches();
        renderCanvas();
    };

    const cleanup = () => {
        if (isReleased) return;
        isReleased = true;
        if (document.exitPointerLock && document.pointerLockElement === el) {
            document.exitPointerLock();
        }
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', cleanup);
        document.removeEventListener('pointerup', cleanup);
        document.removeEventListener('pointerlockchange', onLockChange);
        pushHistory();
        renderCanvas();
        updatePropertiesPanel();
    };

    const onLockChange = () => {
        if (document.pointerLockElement !== el) {
            cleanup();
        }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', cleanup);
    document.addEventListener('pointerup', cleanup);
    document.addEventListener('pointerlockchange', onLockChange);
} /* handleValueDrag2D */

function showTexturePicker(onSelect) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); display: flex; justify-content: center;
        align-items: center; z-index: 2000;
    `;

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.cssText = `
        background: #fff; border-radius: 8px; width: 80%; max-width: 400px;
        display: flex; flex-direction: column; padding: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;

    content.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <h3 style="margin:0; font-size:16px;">パターンテクスチャを選択</h3>
            <button class="modal-close-btn" style="border:none; background:transparent; font-size:20px; cursor:pointer;">&times;</button>
        </div>
        <div class="texture-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); gap:8px; max-height:300px; overflow-y:auto; padding:8px 0;">
            <div class="texture-card" data-id="sample" style="border:1px solid #ddd; border-radius:4px; padding:4px; cursor:pointer; text-align:center;">
                <img src="image/sample.png" style="width:100%; height:45px; object-fit:contain;">
                <span style="font-size:9px; display:block;">sample</span>
            </div>
            <div class="texture-card" data-id="brush_sample" style="border:1px solid #ddd; border-radius:4px; padding:4px; cursor:pointer; text-align:center;">
                <img src="image/brush_sample.png" style="width:100%; height:45px; object-fit:contain;">
                <span style="font-size:9px; display:block;">brush_sample</span>
            </div>
        </div>
    `;

    if (db) {
        const tx = db.transaction('drawings', 'readonly');
        const store = tx.objectStore('drawings');
        const request = store.getAll();
        request.onsuccess = () => {
            const drawings = request.result;
            const grid = content.querySelector('.texture-grid');
            drawings.forEach(d => {
                if (d.type === 'pattern' || d.type === 'canvas') {
                    const card = document.createElement('div');
                    card.className = 'texture-card';
                    card.setAttribute('data-id', d.id);
                    card.style.cssText = `border:1px solid #ddd; border-radius:4px; padding:4px; cursor:pointer; text-align:center;`;
                    
                    let imgSrc = 'image/sample.png';
                    if (d.preview) {
                        if (d.preview instanceof Blob) {
                            imgSrc = URL.createObjectURL(d.preview);
                        } else {
                            imgSrc = d.preview;
                        }
                    }

                    card.innerHTML = `
                        <img src="${imgSrc}" style="width:100%; height:45px; object-fit:contain;">
                        <span style="font-size:9px; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${d.name}</span>
                    `;
                    grid.appendChild(card);
                }
            });

            content.querySelectorAll('.texture-card').forEach(card => {
                card.onclick = () => {
                    const tid = card.getAttribute('data-id');
                    onSelect(tid);
                    document.body.removeChild(overlay);
                };
            });
        };
    }

    content.querySelector('.modal-close-btn').onclick = () => {
        document.body.removeChild(overlay);
    };

    overlay.appendChild(content);
    document.body.appendChild(overlay);
} /* showTexturePicker */

/* EOF */
