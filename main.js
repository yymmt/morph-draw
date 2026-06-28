/**
 * MorphDraw - アプリケーション状態
 */
const state = {
    view: 'gallery',
    currentDrawId: null,
    // 【データ管理システムの設計方針】
    // shapes（図形実体）と beziers（ベジェ曲線）をネストさせずにフラットなマップとして
    // 分離・管理しています。これにより以下のメリットが得られます：
    // 1. 依存関係解決 (Dynamic Bezier Network) の高速化: コネクターが他のベジェに依存する際、
    //    ツリーをスキャンせず state.beziers[id] で一瞬で参照・取得・更新が可能です (DAGの再計算最適化)。
    // 2. 履歴管理 (Undo/Redo) の簡素化: フラットな構造なため、状態のシリアライズや将来的な
    //    パッチ（差分）管理が極めてシンプルになります。
    shapes: {}, // ID -> Shape
    beziers: {},  // ID -> Bezier
    scene: [],    // Root level IDs
    zoom: 1,
    rotation: 0,
    pan: { x: 0, y: 0 },
    history: [],
    historyIndex: -1,
    selectedShapeIds: [],
    anchoredShapeIds: [], // アンカーされた図形ID。オレンジ色で表示。
    focusedVertex: null,   // 現在フォーカスされているベジェ端点（調整ハンドル）。構造: { shapeId, vertexIdx } (vertexIdx: 0〜2N-1)
    thicknessEdit: {
        active: false,
        targetT: 0.0,
        editIndex: -1
    },
    dragInfo: null, // { type: 'move'|'pan'|'key-hold'|'drag', ... }
    interaction: {
        mode: null, // 'move', 'scale', 'rotate', 'pan'
        activeKeys: new Set(),
    },
    lastHit: null, // レイヤー操作対象特定用
    lodPrecision: 10, // 編集時10px, 確定時1px
    lastMousePt: null, // 最新のマウス座標
    selectedLayerId: null, // 現在アクティブなレイヤーID
    maxDrawingId: 0, // 既存図面IDの最大値キャッシュ
    drawingName: '', // 現在開いている図面の名前
    search: {
        active: false,
        results: [],
        currentIndex: -1
    },
    patternEdit: {
        active: false,
        selectedCorner: 'TL',
        targetT: 0.0
    },
    command: {
        active: false
    },
    input: {
        keys: {},           // 押されているキーの状態 { 'm': true, ... }
        pointer: { x: 0, y: 0 }, // 最新のマウス座標
        dragStart: null,    // ドラッグ開始時のポインタ座標
        isPointerDown: false, // ポインタが押されているか
        isHoveringMinimap: false // 新規：ミニマップ上にマウスがあるか
    },
    minimap: {
        zoom: 1.0           // 新規：ミニマップのズーム倍率
    },
    webglTextures: {},
    canvas: {
        width: 2000,
        height: 2000,
        underOffscreen: null,
        activeOffscreen: null,
        overOffscreen: null
    }
}; /* state */


function initializeIdCounter() {
    const allIds = [...Object.keys(state.shapes), ...Object.keys(state.beziers)];
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
    if (key === 'controlPoints' || key === 'samplePointByT' || key === 'boundingBox') {
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
    state.canvas.underOffscreen = document.createElement('canvas');
    state.canvas.underOffscreen.width = state.canvas.width;
    state.canvas.underOffscreen.height = state.canvas.height;

    state.canvas.activeOffscreen = document.createElement('canvas');
    state.canvas.activeOffscreen.width = state.canvas.width;
    state.canvas.activeOffscreen.height = state.canvas.height;

    state.canvas.overOffscreen = document.createElement('canvas');
    state.canvas.overOffscreen.width = state.canvas.width;
    state.canvas.overOffscreen.height = state.canvas.height;

    initWebGLPatternRenderer();
}

function resizeOffscreenCanvases() {
    if (state.canvas.underOffscreen) {
        state.canvas.underOffscreen.width = state.canvas.width;
        state.canvas.underOffscreen.height = state.canvas.height;
    }
    if (state.canvas.activeOffscreen) {
        state.canvas.activeOffscreen.width = state.canvas.width;
        state.canvas.activeOffscreen.height = state.canvas.height;
    }
    if (state.canvas.overOffscreen) {
        state.canvas.overOffscreen.width = state.canvas.width;
        state.canvas.overOffscreen.height = state.canvas.height;
    }
}

function initEvents() {
    document.getElementById('btn-new-draw').onclick = () => {
        startNewDrawing();
    }; /* btn-new-draw.onclick */

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

    // 検索入力イベントハンドラ
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.oninput = () => {
            performSearch(searchInput.value);
            applySearchResult();
        };
        searchInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                closeSearchMode(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearchMode(false);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (state.search.results.length > 0) {
                    state.search.currentIndex = (state.search.currentIndex + 1) % state.search.results.length;
                    applySearchResult();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (state.search.results.length > 0) {
                    state.search.currentIndex = (state.search.currentIndex - 1 + state.search.results.length) % state.search.results.length;
                    applySearchResult();
                }
            }
        };
        searchInput.onblur = () => {
            setTimeout(() => {
                if (state.search.active) {
                    closeSearchMode(true);
                }
            }, 200);
        };
    }

    // コマンド入力イベントハンドラ
    const commandInput = document.getElementById('command-input');
    if (commandInput) {
        commandInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                closeCommandMode(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeCommandMode(false);
            }
        };
        commandInput.onblur = () => {
            setTimeout(() => {
                if (state.command.active) {
                    closeCommandMode(false);
                }
            }, 200);
        };
    }

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
        copiedBeziers[bid] = JSON.parse(JSON.stringify(bez));
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

// pointerdown 時の共通処理
function handlePointerDownStart(ctx) {
    if (state.interaction.mode === null) {
        const hit = findShapeAt(state.input.dragStart);
        state.lastHit = hit;
        if (hit) {
            if (!state.selectedShapeIds.includes(hit.shape.id)) {
                state.selectedShapeIds = [hit.shape.id];
                state.focusedVertex = null; // 図形選択変更時に頂点フォーカスをクリア
            }
        }
    } else {
        state.dragInfo = {
            start: { ...state.input.dragStart },
            type: 'drag'
        };
    }
}

// pointerup 時の共通処理
function handlePointerUpEnd(ctx) {
    let needsRender = false;
    let pushHistory = false;

    if (state.interaction.mode) {
        pushHistory = true;
        needsRender = true;
    } else if (state.dragInfo && !state.lastHit) {
        state.selectedShapeIds = [];
        state.focusedVertex = null; // 頂点フォーカスもクリア
        needsRender = true;
    }
    state.dragInfo = null;
    return { needsRender, pushHistory };
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

// 変形処理: ズーム (メインキャンバス / ミニマップ)
function handleZoom(ctx) {
    const zoomFactor = 1 - ctx.dy * 0.01;

    // MEMO: 将来対応として、ズーム操作中にマウスポインタを固定させたい場合は、pointerdownイベントなどのユーザーインタラクションのコールバック内でPointer Lock API (requestPointerLock) を呼び出して制御することを検討する。
    if (state.input.isHoveringMinimap) {
        // ミニマップのズーム
        state.minimap.zoom = Math.max(0.1, Math.min(10, state.minimap.zoom * zoomFactor));
    } else {
        // メインキャンバスのズーム (ポインタ座標を中心にズーム)
        const oldZoom = state.zoom;
        state.zoom = Math.max(0.1, Math.min(20, state.zoom * zoomFactor));

        // ポインタ座標 (キャンバス座標系)
        const p = state.input.pointer;
        state.pan.x += p.x * (oldZoom - state.zoom);
        state.pan.y += p.y * (oldZoom - state.zoom);
    }
}

// キーボードイベントハンドラ定義
// MEMO この構造(condで実行条件を判定してからfを実行することで、事前に pushHistory, needsRender を決定できる)は気に入っているので、今後ハンドラを追加・修正する際はなるべくこの構造に寄せること。
const keyHandlers = {
    no_mod: {
        x: {
            keydown: [
                {
                    cond: () => state.thicknessEdit.active,
                    f: handleDeleteThicknessPoint, // 太さ編集：データ点削除
                    pushHistory: true,
                    needsRender: true
                },
                {
                    cond: () => {
                        if (!state.focusedVertex) return false;
                        const shape = state.shapes[state.focusedVertex.shapeId];
                        return shape && shape.bezierIds && shape.bezierIds.length > 3;
                    },
                    f: deleteSelectedVertex, // 頂点削除
                    pushHistory: true,
                    needsRender: true
                },
                {
                    cond: () => state.selectedShapeIds.length > 0,
                    f: deleteSelectedShapes, // 図形削除
                    pushHistory: true,
                    needsRender: true
                }
            ]
        },
        c: { keydown: { f: handleAddCircleStart, needsRender: true } }, // 円生成
        w: {
            keydown: [
                {
                    cond: () => state.thicknessEdit.active,
                    f: handleTransformStart, // 太さ編集：ドラッグ変形開始
                    needsRender: true
                },
                {
                    cond: () => !state.thicknessEdit.active,
                    f: handleCreateWrap, // Wrap生成
                    pushHistory: true,
                    needsRender: true
                }
            ],
            keyup: [
                {
                    cond: () => state.thicknessEdit.active,
                    f: handleTransformEnd, // 太さ編集：ドラッグ変形終了
                    pushHistory: true,
                    needsRender: true
                }
            ]
        },
        '?': { keydown: { f: toggleHelpModal } }, // ヘルプ表示トグル
        q: { keydown: { f: handleQuitToGallery } }, // 保存してギャラリーに戻る
        '/': { keydown: { f: handleOpenSearch } }, // 検索モード開始
        ':': { keydown: { f: handleOpenCommand } }, // コマンドモード開始
        n: { keydown: { f: handleSearchNext, needsRender: true } }, // 検索結果・次
        N: { keydown: { f: handleSearchPrev, needsRender: true } }, // 検索結果・前
        ArrowLeft: { keydown: { f: handleFocusVertexPrev, needsRender: true } }, // 頂点フォーカス前へ
        ArrowRight: { keydown: { f: handleFocusVertexNext, needsRender: true } }, // 頂点フォーカス次へ
        Escape: { keydown: { f: handleClearVertexFocus, needsRender: true } }, // 頂点フォーカス解除
        a: { keydown: { f: handleToggleAnchor } }, // アンカートグル / 頂点追加待機
        Enter: { keydown: { f: handleEnterAction } }, // 頂点割り込み接続決定

        m: {
            keydown: { f: handleTransformStart, needsRender: true }, // 移動開始
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true } // 移動終了
        },
        s: {
            keydown: { f: handleTransformStart, needsRender: true }, // 拡大縮小開始
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true } // 拡大縮小終了
        },
        r: {
            keydown: { f: handleTransformStart, needsRender: true }, // 回転開始
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true } // 回転終了
        },
        t: {
            keydown: { f: handleTransformStart, needsRender: true }, // t値（または太さ編集t位置）スライド開始
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true } // t値（または太さ編集t位置）スライド終了
        },
        d: {
            keydown: { f: handleTransformStart, needsRender: true }, // 接線距離d調整開始
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true } // 接線距離d調整終了
        },
        z: {
            keydown: { f: handleTransformStart, needsRender: true }, // ズーム開始
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true } // ズーム終了
        }
    },
    shift: {
        W: { keydown: { f: handleToggleThicknessEdit, needsRender: true } }, // 太さ編集モードトグル
        w: { keydown: { f: handleToggleThicknessEdit, needsRender: true } }, // 太さ編集モードトグル
        S: { keydown: { f: handleToggleOutline, pushHistory: true, needsRender: true } }, // 輪郭トグル
        s: { keydown: { f: handleToggleOutline, pushHistory: true, needsRender: true } }, // 輪郭トグル
        F: { keydown: { f: handleToggleFillEnabled, pushHistory: true, needsRender: true } }, // 塗りトグル
        f: { keydown: { f: handleToggleFillEnabled, pushHistory: true, needsRender: true } }, // 塗りトグル
        P: { keydown: { f: handleTogglePatternEdit, needsRender: true } }, // パターン編集モードトグル
        p: { keydown: { f: handleTogglePatternEdit, needsRender: true } }, // パターン編集モードトグル
        T: {
            keydown: { f: handleTransformStart, needsRender: true }, // 最も近い太さデータt移動開始
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true } // 最も近い太さデータt移動終了
        },
        t: {
            keydown: { f: handleTransformStart, needsRender: true }, // 最も近い太さデータt移動開始
            keyup: { f: handleTransformEnd, pushHistory: true, needsRender: true } // 最も近い太さデータt移動終了
        }
    },
    ctrl: {
        z: { keydown: { f: handleUndoAction, needsRender: true } }, // Undo
        c: { keydown: { f: handleCopy } }, // Copy
        v: { keydown: { f: handlePaste } } // Paste
    },
    ctrl_shift: {
        z: { keydown: { f: handleRedoAction, needsRender: true } } // Redo
    }
};

// モードごとのポインタ移動イベントハンドラ定義
const modeHandlers = {
    move: {
        pointermove: { f: handleMove, needsRender: true }
    },
    scale: {
        pointermove: { f: handleScale, needsRender: true }
    },
    rotate: {
        pointermove: { f: handleRotate, needsRender: true }
    },
    't-slide': {
        pointermove: { f: handleTSlide, needsRender: true }
    },
    'd-dist': {
        pointermove: { f: handleDDist, needsRender: true }
    },
    zoom: {
        pointermove: { f: handleZoom, needsRender: true }
    },
    't-slide-thickness': {
        pointermove: { f: handleTSlideThickness, needsRender: true }
    },
    'w-slide-thickness': {
        pointermove: { f: handleWSlideThickness, needsRender: true }
    },
    't-move-thickness': {
        pointermove: { f: handleTMoveThickness, needsRender: true }
    },
    't-slide-pattern': {
        pointermove: { f: handleTSlidePattern, needsRender: true }
    },
    't-move-pattern': {
        pointermove: { f: handleTMovePattern, needsRender: true }
    }
};

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
        bez.controlPoints = bez.generator.type === 'connector'
            ? generatorFunc(state, bez.generator.params)
            : generatorFunc(bez.generator.params);
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

    // ベジェが更新されたため、このベジェを使用するShapeのキャッシュをDirtyにする
    Object.values(state.shapes).forEach(shape => {
        if (shape.bezierIds && shape.bezierIds.includes(id)) {
            markShapeDirty(shape.id);
        }
    });
} /* updateBezier */

function resolveBezierDependencies() {
    // 1. すべての wrap Shape について、隣接するベジェの共有端点 (src1 と src2) を同期する (Option A)
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
                        // param2 (src1) を代表の正として param1 (src2) を同期する
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
        if (visiting.has(id)) return; // 循環参照の切断
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
        if (shape && shape.bezierIds) {
            shape.bezierIds.forEach(bid => {
                const bez = state.beziers[bid];
                if (bez && bez.generator && bez.generator.type === 'arc') {
                    bez.generator.params.x += dx;
                    bez.generator.params.y += dy;
                }
            });
            markShapeDirty(id);
        }
    });
    resolveBezierDependencies();
}

function scaleShapes(shapeIds, factor, cx, cy) {
    shapeIds.forEach(id => {
        const shape = state.shapes[id];
        if (shape && shape.bezierIds) {
            shape.bezierIds.forEach(bid => {
                const bez = state.beziers[bid];
                if (bez && bez.generator && bez.generator.type === 'arc') {
                    const params = bez.generator.params;
                    params.x = cx + (params.x - cx) * factor;
                    params.y = cy + (params.y - cy) * factor;
                    params.r *= factor;
                }
            });
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
        if (shape && shape.bezierIds) {
            shape.bezierIds.forEach(bid => {
                const bez = state.beziers[bid];
                if (bez && bez.generator && bez.generator.type === 'arc') {
                    const params = bez.generator.params;
                    const dx = params.x - cx;
                    const dy = params.y - cy;
                    params.x = cx + dx * cosVal - dy * sinVal;
                    params.y = cy + dx * sinVal + dy * cosVal;
                    params.startAngle += rad;
                    params.endAngle += rad;
                }
            });
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
                generator: {
                    type: 'arc',
                    params: { x, y, r, startAngle: a, endAngle: na }
                },
                controlPoints: [], samplePointByT: {}, boundingBox: {}
            };
            bIds.push(bId);
        }
    }
    const count = Object.values(state.shapes).filter(s => s.name && s.name.startsWith(type)).length + 1;
    const shape = {
        id, type: 'bezier-group', name: `${type} ${count}`, bezierIds: bIds, props: { x, y },
        style: { fill: '#2196F3', opacity: 0.7, outline: true, fillEnabled: true },
        strokeWidthData: [{ t: 0, w: 10 }, { t: 1, w: 10 }],
        childIds: []
    };
    state.shapes[id] = shape;

    // アクティブレイヤーに追加
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
} /* addShapeAt */

function createWrap() {
    // 【保留事項】
    // 将来的に 3 つ以上の複数図形の Wrap や、すでに Wrap された図形同士をさらに Wrap する階層化への対応を見据えています。
    // 現状は 2 つの図形選択に固定したロジックとなっていますが、次のステップにて 3 点以上の Wrap 生成や、
    // 生成後の頂点（ベジェ本数）の増減編集機能の設計・実装を行う予定のため、ここは一旦修正を保留とします。
    const targets = Array.from(new Set([...state.anchoredShapeIds, ...state.selectedShapeIds]));
    if (targets.length < 2) {
        return;
    }
    const [id1, id2] = targets;
    const shape1 = state.shapes[id1], shape2 = state.shapes[id2];
    if (!shape1 || !shape2) return;

    // 接続元の図形から接続点のベジェIDを選定する
    // 【接続点選定に関する設計方針】
    // 円同士に限らず様々な図形（すでにwrapされた図形など）に対応するため、ここでは幾何学的な接線計算は行わず、
    // 接続対象の図形の bezierIds[0] の t=0 (上側) と bezierIds[Math.min(2, bezierIds.length-1)] の t=0 (下側) を
    // 固定的に結ぶシンプルなロジックとします。
    // ※ 左右に並んだ円以外のケースでは、初期生成時の形状が「パッと見でwrapっぽくない交差した形」に見える場合がありますが、
    //   後からユーザーがスライド操作等で手動微調整することを前提とする（Hello Neighbor的アプローチ）ため、これを許容します。
    const src1_up_bezier = shape1.bezierIds[0];
    const src1_down_bezier = shape1.bezierIds[Math.min(2, shape1.bezierIds.length - 1)];
    const src2_up_bezier = shape2.bezierIds[0];
    const src2_down_bezier = shape2.bezierIds[Math.min(2, shape2.bezierIds.length - 1)];

    const wrapId = generateId('s');
    const bIds = [];

    // 4本の接続ベジェを生成（時計回りの環状ループになるように順次接続）
    // 1. 上側接続線: shape1_up -> shape2_up
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

    // 2. 右側代替線: shape2_up -> shape2_down (shape2の側面に重なる線)
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

    // 3. 下側接続線: shape2_down -> shape1_down
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

    // 4. 左側代替線: shape1_down -> shape1_up (shape1の側面に重なる線)
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

    // 新しい wrap Shape オブジェクトを作成
    const wrapCount = Object.values(state.shapes).filter(s => s.name && s.name.startsWith('wrap')).length + 1;
    const wrapShape = {
        id: wrapId,
        type: 'bezier-group',
        name: `wrap ${wrapCount}`,
        bezierIds: bIds,
        props: { x: 0, y: 0 },
        style: { fill: '#2196F3', opacity: 0.5, outline: true, fillEnabled: true }, // 半透明の青で塗りつぶす
        strokeWidthData: [{ t: 0, w: 10 }, { t: 1, w: 10 }],
        childIds: []
    };
    state.shapes[wrapId] = wrapShape;

    // アクティブレイヤーに追加
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

    // キャンバス全体の境界線を viewport の背景として自動描画
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

    // activeLayerId に属するShapeのガイド線をメインのSVGに描画
    const activeLayerId = state.selectedLayerId;
    if (activeLayerId) {
        const activeLayer = state.shapes[activeLayerId];
        if (activeLayer && activeLayer.childIds) {
            activeLayer.childIds.forEach(childId => {
                renderGuides(childId, viewport);
            });
        }
    }

    // アクティブレイヤーをリアルタイムに activeOffscreen に描画
    if (activeLayerId && state.canvas.activeOffscreen) {
        const activeCtx = state.canvas.activeOffscreen.getContext('2d');
        activeCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        drawShapeToCanvasContext(activeCtx, activeLayerId);
    }

    // under-canvas / active-canvas / over-canvas にそれぞれ対応するオフスクリーンから 1:1 で転写
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

    // SVG viewport の scale/rotate/pan と同期
    ctx.translate(state.pan.x, state.pan.y);
    ctx.scale(state.zoom, state.zoom);
    ctx.rotate(state.rotation * Math.PI / 180);

    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();
}

function drawShapeToCanvasContext(ctx, shapeId) {
    const shape = state.shapes[shapeId];
    if (!shape) return;

    if (shape.type === 'layer' && shape.visible === false) return;

    ctx.save();

    if (shape.type === 'layer') {
        ctx.globalAlpha *= (shape.style?.opacity ?? 1);
        shape.childIds?.forEach(childId => drawShapeToCanvasContext(ctx, childId));
    } else if (shape.bezierIds) {
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

// --- Pattern Edit Mode Handlers & Helpers ---

function getParamDistance(tA, tB) {
    const diff = Math.abs(tA - tB);
    return Math.min(diff, 1.0 - diff);
}

// パターン編集モードのトグル (Shift+p)
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
            // Ensure thicknessEdit is deactivated
            if (state.thicknessEdit.active) {
                state.thicknessEdit.active = false;
                const thicknessGuide = document.getElementById('thickness-guide');
                if (thicknessGuide) thicknessGuide.classList.add('hidden');
            }

            // Auto-initialize corners if not present
            if (!shape.patternCorners) {
                initPatternCorners(shape);
            }

            // Find closest corner to targetT (0.0) initially
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

            const guide = document.getElementById('pattern-guide');
            if (guide) guide.classList.remove('hidden');
        } else {
            const guide = document.getElementById('pattern-guide');
            if (guide) guide.classList.add('hidden');
        }
        return { pushHistory: false, needsRender: true };
    }
    return { pushHistory: false, needsRender: false };
}

// targetT のスライド処理
function handleTSlidePattern(ctx) {
    let nextT = state.patternEdit.targetT + ctx.dx * 0.005;
    nextT = ((nextT % 1) + 1) % 1;
    state.patternEdit.targetT = nextT;

    // Automatically find the closest corner to highlight/select
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

// 選択中の角の parameter 移動開始
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

// 選択中の角の parameter 移動処理
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

// コマンド処理
function openCommandMode() {
    state.command.active = true;
    const bar = document.getElementById('command-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    const input = document.getElementById('command-input');
    input.value = '';
    input.focus();
}

function closeCommandMode(confirm = true) {
    state.command.active = false;
    const bar = document.getElementById('command-bar');
    if (bar) bar.classList.add('hidden');

    const input = document.getElementById('command-input');
    if (input) {
        if (confirm) {
            executeCommand(input.value);
        }
        input.blur();
    }
}

function handleOpenCommand(ctx) {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return { needsRender: false };
    if (ctx.rawEvent) ctx.rawEvent.preventDefault();
    openCommandMode();
    return { needsRender: false };
}

function executeCommand(cmdStr) {
    const parts = cmdStr.trim().split(/\s+/);
    if (parts.length === 0) return;
    const command = parts[0];
    if (command === 'fillpattern') {
        const patternName = parts[1];
        if (patternName === 'sample') {
            if (state.selectedShapeIds.length > 0) {
                state.selectedShapeIds.forEach(shapeId => {
                    const shape = state.shapes[shapeId];
                    if (shape && shape.bezierIds) {
                        if (!shape.style) shape.style = {};
                        shape.style.fillPattern = 'sample';
                        initPatternCorners(shape);
                        markShapeDirty(shapeId);
                    }
                });
                rasterizeInactiveLayers();
                renderCanvas();
                pushHistory();
            }
        } else if (!patternName || patternName === 'none' || patternName === 'clear') {
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
        }
    } else if (command === 'strokepattern') {
        const patternName = parts[1];
        if (patternName === 'brush_sample') {
            if (state.selectedShapeIds.length > 0) {
                state.selectedShapeIds.forEach(shapeId => {
                    const shape = state.shapes[shapeId];
                    if (shape && shape.bezierIds) {
                        if (!shape.style) shape.style = {};
                        shape.style.strokePattern = 'brush_sample';
                        markShapeDirty(shapeId);
                    }
                });
                rasterizeInactiveLayers();
                renderCanvas();
                pushHistory();
            }
        } else if (!patternName || patternName === 'none' || patternName === 'clear') {
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
        }
    }
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

    // アクティブレイヤーを一時的に activeOffscreen にラスタライズ
    const activeLayerId = state.selectedLayerId;
    if (activeLayerId && state.canvas.activeOffscreen) {
        const activeCtx = state.canvas.activeOffscreen.getContext('2d');
        activeCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        drawShapeToCanvasContext(activeCtx, activeLayerId);
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

        // 頂点選択モード（キーボード駆動のフォーカス調整中）の UI 表示
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

                    // 1. 調整中の制御線（点線：オレンジ）
                    addLine(vertexPt.x, vertexPt.y, cpPt.x, cpPt.y, '#ff9800', 1.5, true);

                    // 2. 調整中の制御点（小円：オレンジ枠・白塗り）
                    addCircle(cpPt.x, cpPt.y, 4, 'white', '#ff9800', 1.5);

                    // 3. 調整中の頂点（強調表示：オレンジ色の二重円）
                    addCircle(vertexPt.x, vertexPt.y, 8, 'none', '#ff9800', 1.5);
                    addCircle(vertexPt.x, vertexPt.y, 4, '#ff9800', '#ff9800', 0);
                }
            }
        }

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

            // (b) 現在狙っている targetT のインジケータ
            const targetT = state.thicknessEdit.targetT;
            const { p, nx, ny } = MDMath.getShapePointAndNormal(shape, targetT, state.beziers);
            const w = MDMath.getShapeThickness(shape, targetT);
            const r = w / 2;

            // 現在の幅を示す線 (赤)
            addLine(p.x - nx * r, p.y - ny * r, p.x + nx * r, p.y + ny * r, '#f44336', 2.5);
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

    // 1. アスペクト比を保持して 512x512 以内のサイズになるようテンポラリ Canvas のサイズを算出
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

    // アクティブレイヤーを最新状態で activeOffscreen に描画
    const activeLayerId = state.selectedLayerId;
    if (activeLayerId && state.canvas.activeOffscreen) {
        const activeCtx = state.canvas.activeOffscreen.getContext('2d');
        activeCtx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        drawShapeToCanvasContext(activeCtx, activeLayerId);
    }

    // under, active, over の各オフスクリーンを重ねて縮小描画
    [state.canvas.underOffscreen, state.canvas.activeOffscreen, state.canvas.overOffscreen].forEach(offscreen => {
        if (offscreen) {
            tempCtx.drawImage(offscreen, 0, 0, offscreen.width, offscreen.height, 0, 0, thumbW, thumbH);
        }
    });

    // Canvas から PNG Blob を生成
    const previewBlob = await new Promise((resolve) => {
        tempCanvas.toBlob((blob) => resolve(blob), 'image/png');
    });

    const tx = db.transaction('drawings', 'readwrite');
    const store = tx.objectStore('drawings');
    const cleaned = JSON.parse(JSON.stringify({
        shapes: state.shapes,
        beziers: state.beziers,
        scene: state.scene
    }, stateReplacer));

    await store.put({
        id: state.currentDrawId,
        name: state.drawingName || 'Untitled',
        shapes: cleaned.shapes,
        beziers: cleaned.beziers,
        scene: cleaned.scene,
        canvas: { width: state.canvas.width, height: state.canvas.height }, // キャンバスサイズを保存
        preview: previewBlob, // Blob オブジェクトを直接保存
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
    const list = document.getElementById('gallery-list');

    // 古いオブジェクトURLを解放してメモリリークを防ぐ
    activeGalleryUrls.forEach(url => URL.revokeObjectURL(url));
    activeGalleryUrls = [];

    list.innerHTML = '';
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
                <span>${item.name || ('Drawing ' + item.id)}</span>
                <button class="btn-card-delete" data-id="${item.id}"><i class="bi bi-trash"></i></button>
            </div>
        `; /* card.innerHTML */
        card.onclick = () => openDrawing(item.id);
        card.querySelector('.btn-card-delete').onclick = (e) => deleteDrawing(item.id, e);
        list.appendChild(card);
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
        state.drawingName = data.name || `Drawing ${data.id}`;
        const nameInput = document.getElementById('input-draw-name');
        if (nameInput) {
            nameInput.value = state.drawingName;
        }
        state.shapes = data.shapes || {};
        state.beziers = data.beziers || {};
        state.scene = data.scene || [];

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

        // 依存関係とキャッシュデータの再計算
        resolveBezierDependencies();
        clearAllCaches();

        rasterizeInactiveLayers();
        renderCanvas();
        pushHistory();
        switchView('canvas');
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

function startNewDrawing() {
    state.maxDrawingId++;
    state.currentDrawId = `d${state.maxDrawingId}`;
    state.drawingName = `Drawing ${state.currentDrawId}`;
    const nameInput = document.getElementById('input-draw-name');
    if (nameInput) {
        nameInput.value = state.drawingName;
    }
    state.shapes = {};
    state.beziers = {};
    state.scene = [];
    state.selectedShapeIds = [];
    state.anchoredShapeIds = [];
    state.zoom = 1;
    state.rotation = 0;
    state.pan = { x: 0, y: 0 };
    state.history = [];
    state.historyIndex = -1;
    state.nextIdCounter = 1;

    // キャンバスサイズの初期化と UI 同期
    state.canvas.width = 800;
    state.canvas.height = 600;
    const widthInput = document.getElementById('input-canvas-width');
    const heightInput = document.getElementById('input-canvas-height');
    if (widthInput && heightInput) {
        widthInput.value = 800;
        heightInput.value = 600;
    }
    resizeOffscreenCanvases();

    // デフォルトレイヤーの作成
    const layerId = generateId('l');
    state.shapes[layerId] = {
        id: layerId,
        type: 'layer',
        name: 'Layer 1',
        childIds: [],
        style: { opacity: 1 },
        visible: true,
        locked: false
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
    const count = state.scene.filter(sid => state.shapes[sid]?.type === 'layer').length + 1;
    state.shapes[id] = {
        id,
        type: 'layer',
        name: `Layer ${count}`,
        childIds: [],
        style: { opacity: 1 },
        visible: true,
        locked: false
    };
    state.scene.push(id);
    state.selectedLayerId = id;
    rasterizeInactiveLayers();
    renderCanvas();
    pushHistory();
} /* addLayer */

function deleteLayer(layerId) {
    const layer = state.shapes[layerId];
    if (!layer || layer.type !== 'layer') return;

    const layerCount = state.scene.filter(sid => state.shapes[sid]?.type === 'layer').length;
    if (layerCount <= 1) {
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
    delete state.shapes[layerId];
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

    [...state.scene].reverse().forEach(layerId => {
        const layer = state.shapes[layerId];
        if (!layer || layer.type !== 'layer') return;

        const item = document.createElement('div');
        item.className = `layer-item${state.selectedLayerId === layerId ? ' active' : ''}${layer.visible ? '' : ' hidden-layer'}`;

        item.innerHTML = `
            <div class="layer-info">
                <span class="layer-visibility-btn"><i class="bi ${layer.visible ? 'bi-eye' : 'bi-eye-slash'}"></i></span>
                <input class="layer-name-input" type="text" value="${layer.name}">
            </div>
            <div class="layer-controls">
                <button class="layer-control-btn btn-layer-delete"><i class="bi bi-trash"></i></button>
            </div>
        `; /* item.innerHTML */

        // 選択イベント
        item.onclick = (e) => {
            if (e.target.closest('input') || e.target.closest('button') || e.target.closest('.layer-visibility-btn')) return;
            state.selectedLayerId = layerId;
            state.selectedShapeIds = []; // レイヤー切替時に図形選択をクリア
            state.focusedVertex = null;  // 頂点フォーカスもクリア
            rasterizeInactiveLayers();
            renderCanvas();
        };

        // 表示・非表示トグル
        item.querySelector('.layer-visibility-btn').onclick = (e) => {
            e.stopPropagation();
            layer.visible = !layer.visible;
            rasterizeInactiveLayers();
            renderCanvas();
            pushHistory();
        };

        // 名前編集
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

        // 削除
        item.querySelector('.btn-layer-delete').onclick = (e) => {
            e.stopPropagation();
            deleteLayer(layerId);
        };

        list.appendChild(item);
    });
} /* renderLayerList */

function openSearchMode() {
    state.search.active = true;
    const bar = document.getElementById('search-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    const input = document.getElementById('search-input');
    input.value = '';
    input.focus();
    state.search.results = [];
    state.search.currentIndex = -1;
}

function closeSearchMode(confirm = true) {
    state.search.active = false;
    const bar = document.getElementById('search-bar');
    if (bar) bar.classList.add('hidden');

    const input = document.getElementById('search-input');
    if (input) input.blur();
}

function performSearch(query) {
    const q = query.toLowerCase().trim();
    if (!q) {
        state.search.results = [];
        state.search.currentIndex = -1;
        return;
    }

    const results = [];

    // レイヤーをスキャン
    state.scene.forEach(layerId => {
        const layer = state.shapes[layerId];
        if (!layer || layer.type !== 'layer') return;

        // レイヤー自体のマッチ (name)
        if (layer.name.toLowerCase().includes(q)) {
            results.push({
                type: 'layer',
                id: layerId,
                name: layer.name,
                dispName: `レイヤー: ${layer.name}`
            });
        }

        // レイヤー内の子Shapeをスキャン
        layer.childIds.forEach(shapeId => {
            const shape = state.shapes[shapeId];
            if (!shape) return;

            let matches = false;
            let shapeName = shape.name || shape.type;

            // IDやtype、nameでのマッチ
            if (shape.id.toLowerCase().includes(q) ||
                shape.type.toLowerCase().includes(q) ||
                (shape.name && shape.name.toLowerCase().includes(q))) {
                matches = true;
            }

            // ベジェ曲線のジェネレータタイプでのマッチ
            if (shape.bezierIds) {
                const generators = shape.bezierIds.map(bid => state.beziers[bid]?.generator?.type).filter(Boolean);
                if (generators.some(g => g.toLowerCase().includes(q))) {
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

function applySearchResult() {
    const results = state.search.results;
    const index = state.search.currentIndex;
    if (index < 0 || index >= results.length) return;

    state.focusedVertex = null; // 検索による図形選択変更時に頂点フォーカスをクリア
    const current = results[index];
    if (current.type === 'layer') {
        state.selectedLayerId = current.id;
        state.selectedShapeIds = []; // レイヤー選択時は図形選択をクリア
    } else if (current.type === 'shape') {
        state.selectedLayerId = current.layerId; // 図形を含むレイヤーをアクティブに
        state.selectedShapeIds = [current.id];   // 図形を選択
    }
    renderCanvas();
}

/* EOF */
